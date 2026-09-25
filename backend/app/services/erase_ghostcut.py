"""GhostCut (鬼手剪辑 / zhaoli) implementation of the erase provider (contract §6, HIG-38).

The vendor pulls the source over HTTP, runs its own OCR inside the regions we mark, inpaints
the text away and publishes the result on its CDN. Everything is asynchronous: submit returns
a project id, and ``poll`` reports progress until a result URL appears.

Verified against the live API on 2026-09-20; the published documentation is login-gated, so the
shapes below come from real requests and are worth keeping accurate:

    auth     POST JSON with headers AppKey and AppSign, where
             AppSign = md5(md5(request_body) + AppSecret)
    submit   /v-w-c/gateway/ve/work/fast
             {urls, uid, outUserId, needChineseOcclude, resolution, videoInpaintMasks}
             → {"code":1000,"body":{"idProject":249807732,"dataList":[{"id":…,"url":…}]}}
    status   /v-w-c/gateway/ve/work/status  {"idProjects":[…]}
             → body.content[0] with processStatus (0 running, 1 success), processProgress,
               errorDetail, and videoUrl once it is done
    billing  the status row carries paidPoint (1.0 for a three-second clip)

``videoInpaintMasks`` is a **JSON string**, not a nested object, and its regions are four
normalised corner points:

    [{"type":"remove_only_ocr","start":0,"end":99999,
      "region":[[x0,y0],[x1,y0],[x1,y1],[x0,y1]]}]

Every region is marked for the whole clip rather than for the block's own time range. That is
not laziness: ``remove_only_ocr`` means "erase the text this region *contains*", so outside the
time the text is on screen there is nothing to erase and the picture is left alone. Marking the
whole clip also removes any dependence on whether ``start`` / ``end`` count seconds or frames —
the one thing the vendor's public material does not say and a live test cannot settle.
"""

from __future__ import annotations

import hashlib
import json
import logging
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from app.services.erase import EraseError, EraseProgress, EraseRegion

log = logging.getLogger(__name__)

SUBMIT_PATH = "/v-w-c/gateway/ve/work/fast"
STATUS_PATH = "/v-w-c/gateway/ve/work/status"

OK_CODE = 1000
# processStatus in a status row. Anything else is the vendor still working on it.
STATUS_SUCCESS = 1
STATUS_FAILED = {2, 3, 4, -1}

# 2 selects the supplied regions; model quality is selected separately by extraOptions.
OCCLUDE_REGIONS = 2

# The vendor's own sentinel for "the whole clip" (it appears in their published example).
WHOLE_CLIP_END = 99999

REQUEST_TIMEOUT = 60
DOWNLOAD_TIMEOUT = 600


def sign(body: bytes, app_secret: str) -> str:
    """AppSign = md5(md5(body) + AppSecret)."""
    return hashlib.md5((hashlib.md5(body).hexdigest() + app_secret).encode()).hexdigest()


def masks_payload(regions: list[EraseRegion]) -> str:
    """Our boxes → the vendor's ``videoInpaintMasks`` JSON string."""
    masks = []
    for region in regions:
        b = region.box
        x0, y0 = round(float(b["x"]), 4), round(float(b["y"]), 4)
        x1, y1 = round(min(1.0, x0 + float(b["w"])), 4), round(min(1.0, y0 + float(b["h"])), 4)
        masks.append(
            {
                "type": "remove_only_ocr",
                "start": 0,
                "end": WHOLE_CLIP_END,
                "region": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
            }
        )
    return json.dumps(masks, separators=(",", ":"))


# The vendor re-encodes at the resolution it is told to. It does not upscale, but it will
# happily downscale, so the tier is picked from the source rather than fixed: a 1080p creative
# must not come back at 720p just because that was the default in a config file.
RESOLUTION_TIERS = ((480, "480p"), (720, "720p"), (1080, "1080p"))


def resolution_for(height: int | None) -> str:
    """Smallest tier that still holds a frame this tall; 1080p is the vendor's ceiling."""
    for limit, name in RESOLUTION_TIERS:
        if height and height <= limit:
            return name
    return RESOLUTION_TIERS[-1][1]


def inpaint_model(regions: list[EraseRegion]) -> str | None:
    """Use the best supported region model without violating its count/area limits."""
    if len(regions) == 1:
        box = regions[0].box
        area = min(1.0, float(box["w"])) * min(1.0, float(box["h"]))
        if area < 0.2 - 1e-6:
            return "advanced"
        if area < 0.4 - 1e-6:
            return "advanced_large_box"
    if 1 <= len(regions) <= 10:
        return "advanced_lite"
    return None  # Basic handles more than ten regions.


def submit_payload(public_url: str, regions: list[EraseRegion], resolution: str, uid: str) -> dict[str, Any]:
    payload = {
        "urls": [public_url],
        "uid": uid,
        "outUserId": uid,
        "needChineseOcclude": OCCLUDE_REGIONS,
        "videoInpaintLang": "all",
        "resolution": resolution,
        "videoInpaintMasks": masks_payload(regions),
    }
    model = inpaint_model(regions)
    if model:
        payload["extraOptions"] = json.dumps({"extra_inpaint_config": {"model": model}}, separators=(",", ":"))
    return payload


def vendor_status_text(row: dict[str, Any]) -> str:
    """The vendor's own word on a running job, for the editor: "处理中（状态 0）" at least."""
    state = row.get("processStatus")
    description = (row.get("processStatusEnum") or {}).get("description")
    progress = row.get("progress")
    text = str(description) if description else "处理中"
    if isinstance(progress, (int, float)) and 0 < progress <= 100:
        text += f" {progress:g}%"
    return f"{text}（状态 {state}）" if state is not None else text


@dataclass
class GhostCutErase:
    """Calls the vendor over plain HTTP; no SDK to install."""

    name: str = "ghostcut"
    base_url: str = ""
    app_key: str = ""
    app_secret: str = ""
    # Empty = choose from the source height at submit time (see ``resolution_for``).
    resolution: str = ""
    uid: str = "hitgo"
    # Set by the caller so error messages can name the video; not sent to the vendor.
    video_id: str = ""
    video_height: int = 0
    calls: list[tuple[str, dict[str, Any]]] = field(default_factory=list)

    def _post(self, path: str, payload: dict[str, Any], what: str) -> dict[str, Any]:
        body = json.dumps(payload).encode()
        request = urllib.request.Request(
            self.base_url.rstrip("/") + path,
            data=body,
            method="POST",
            headers={
                "Content-Type": "application/json",
                "AppKey": self.app_key,
                "AppSign": sign(body, self.app_secret),
            },
        )
        self.calls.append((path, payload))
        try:
            with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT) as response:
                raw = response.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            raise EraseError(f"{what}失败（HTTP {exc.code}）") from exc
        except Exception as exc:  # noqa: BLE001  transport errors of every shape
            raise EraseError(f"{what}失败：{exc}") from exc
        try:
            data = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise EraseError(f"{what}失败：返回的不是 JSON（{raw[:200]}）") from exc
        # The vendor answers HTTP 200 for business errors too, so the code is the real check.
        if data.get("code") != OK_CODE:
            raise EraseError(f"{what}失败：{data.get('msg') or '未知原因'}（code {data.get('code')}）")
        return data

    def submit(self, source: Path, public_url: str | None, regions: list[EraseRegion], duration: float) -> str:
        if not public_url:
            # The vendor fetches the file itself; there is nothing to upload from here.
            raise EraseError("擦除供应商需要一个可公网访问的源片地址，但没有拿到")
        if not self.app_key or not self.app_secret:
            raise EraseError("没有配置 GHOSTCUT_APP_KEY / GHOSTCUT_APP_SECRET")
        resolution = self.resolution or resolution_for(self.video_height)
        data = self._post(SUBMIT_PATH, submit_payload(public_url, regions, resolution, self.uid), "提交擦除")
        project = (data.get("body") or {}).get("idProject")
        if project is None:
            raise EraseError("提交擦除失败：返回里没有任务 id")
        return str(project)

    def poll(self, task_id: str) -> EraseProgress:
        data = self._post(STATUS_PATH, {"idProjects": [int(task_id)]}, "查询擦除进度")
        content = (data.get("body") or {}).get("content") or []
        if not content:
            # The vendor forgot the job, or it was removed on their side.
            return EraseProgress(status="failed", error="擦除任务在供应商那边查不到了")
        row = content[0]
        state = row.get("processStatus")
        if state == STATUS_SUCCESS:
            url = row.get("videoUrl")
            if not url:
                return EraseProgress(status="failed", error="供应商报告成功但没有返回成片地址")
            return EraseProgress(status="done", url=str(url))
        if state in STATUS_FAILED:
            detail = row.get("errorDetail") or ((row.get("processStatusEnum") or {}).get("description")) or "未知原因"
            return EraseProgress(status="failed", error=f"供应商擦除失败：{detail}")
        return EraseProgress(status="running", detail=vendor_status_text(row))

    def fetch(self, task_id: str, progress: EraseProgress, dst: Path) -> None:
        if not progress.url:
            raise EraseError("没有可下载的擦除结果地址")
        dst.parent.mkdir(parents=True, exist_ok=True)
        try:
            with urllib.request.urlopen(progress.url, timeout=DOWNLOAD_TIMEOUT) as response, dst.open("wb") as out:
                while chunk := response.read(1 << 20):
                    out.write(chunk)
        except Exception as exc:  # noqa: BLE001
            dst.unlink(missing_ok=True)
            raise EraseError(f"下载擦除结果失败：{exc}") from exc
