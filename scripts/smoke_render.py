#!/usr/bin/env python3
"""End-to-end smoke test against a running HitGO instance.

Waits for preprocessing of the first batch, saves a spec with a trim, two image
sticker layers, a looping video sticker (when one is available) and two output
variants on its first video, renders, and prints the job results. Also checks the
output duration, since a looping sticker must not stretch the clip. When a video
sticker with its own audio track is available, that layer mixes its audio in
(mix_audio) and the output must carry an audio stream. When an audio asset is
available, the source track is muted and that asset is looped as BGM over the
whole clip (edit_spec.audio), which must again yield an audio stream of the
post-trim length.
No dependencies beyond the standard library.

Usage: smoke_render.py <base_url> <access_code>
"""
import json
import sys
import time
import urllib.error
import urllib.request

base = sys.argv[1].rstrip("/")
headers = {"Content-Type": "application/json", "Cookie": f"hitgo_access={sys.argv[2]}"}


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, method=method, data=data, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"null")


status, batches = call("GET", "/api/batches")
assert status == 200, batches
batch = batches[0]
print("batch", batch["id"], batch["status_counts"])

for _ in range(90):
    videos = call("GET", f"/api/batches/{batch['id']}")[1]["videos"]
    if all(v["status"] != "preparing" for v in videos):
        break
    time.sleep(2)
print("video statuses", [v["status"] for v in videos])
for v in videos[:2]:
    sprite = v["sprite"] and (v["sprite"]["count"], v["sprite"]["tile_width"], v["sprite"]["tile_height"])
    print(" ", v["name"], v["width"], v["height"], v["duration"], v["fps"], v["has_audio"], sprite)
print("failed:", [(v["name"], v["error"]) for v in videos if v["status"] == "failed"])

stickers = call("GET", "/api/assets?type=sticker")[1]
print("stickers", [(a["name"], a.get("kind", "image"), a.get("status", "ready"), a["width"], a["height"]) for a in stickers])

# Video stickers are preprocessed asynchronously; wait for them before building a spec.
for _ in range(60):
    if all(a.get("status", "ready") != "preparing" for a in stickers):
        break
    time.sleep(2)
    stickers = call("GET", "/api/assets?type=sticker")[1]
failed = [(a["name"], a.get("error")) for a in stickers if a.get("status") == "failed"]
if failed:
    print("sticker preprocessing failed:", failed)
ready = [a for a in stickers if a.get("status", "ready") == "ready"]
video_stickers = [a for a in ready if a.get("kind") == "video"]
print("video stickers", [(a["name"], a.get("duration"), a.get("has_alpha"), a.get("has_audio")) for a in video_stickers])
# Prefer one with audio so the sticker-audio mix (mix_audio) is exercised too.
video_stickers.sort(key=lambda a: a.get("has_audio") is not True)
mix_audio = bool(video_stickers) and video_stickers[0].get("has_audio") is True

audio_assets = call("GET", "/api/assets?type=audio")[1]
for _ in range(60):
    if all(a.get("status", "ready") != "preparing" for a in audio_assets):
        break
    time.sleep(2)
    audio_assets = call("GET", "/api/assets?type=audio")[1]
audio_assets = [a for a in audio_assets if a.get("status", "ready") == "ready" and a.get("duration")]
print("audio assets", [(a["name"], a.get("duration")) for a in audio_assets])
use_bgm = bool(audio_assets)
if not use_bgm:
    print("no audio asset available — skipping the BGM part of the smoke test")

video = videos[0]
layers = [
    {"id": "l_1", "type": "sticker", "asset_id": ready[0]["id"], "anchor": "top-left",
     "margin": [0.08, 0.12], "width": 0.35, "rotate": -8, "opacity": 0.9, "t": [0, 5]},
    {"id": "l_2", "type": "sticker", "asset_id": ready[2 % len(ready)]["id"], "anchor": "bottom-center",
     "margin": [0, 0.25], "width": 0.5, "rotate": 0, "opacity": 1, "t": "all"},
]
if video_stickers:
    # Looping video sticker whose window outlives the clip: proves the output is not stretched.
    layers.append(
        {"id": "l_3", "type": "sticker", "asset_id": video_stickers[0]["id"], "anchor": "center",
         "margin": [0, 0], "width": 0.4, "rotate": 0, "opacity": 1, "t": "all", "playback": "loop",
         "mix_audio": mix_audio}
    )
    if not mix_audio:
        print("no video sticker with audio — skipping the sticker-audio part of the smoke test")
else:
    print("no video sticker available — skipping the video-layer part of the smoke test")

spec = {
    "spec_version": 1,
    "trim": {"remove": [[2.0, 4.0]]},
    "layers": layers,
    "outputs": [
        {"variant_key": "9x16", "aspect": "9:16", "fill": "blur"},
        {"variant_key": "1x1", "aspect": "1:1", "fill": "crop",
         "crop": {"x": 0.1, "y": 0.2, "w": 0.6, "h": 0.6},
         "layer_overrides": {"l_1": {"margin": [0.04, 0.04]}}},
    ],
}
if use_bgm:
    # Muted source + looping BGM with a fade-out: the classic "replace the sound" edit.
    spec["audio"] = {
        "source_volume": 0,
        "tracks": [{"id": "au_bgm", "asset_id": audio_assets[0]["id"], "role": "bgm", "t": "all",
                    "volume": 0.6, "loop": True, "fade_out": 1}],
    }
status, resp = call("PUT", f"/api/videos/{video['id']}/spec", {"edit_spec": spec})
print("put spec", status, "ok" if status == 200 else resp)

status, jobs = call("POST", "/api/render", {"video_ids": [video["id"]]})
if status == 409:
    # A previous run is still active for this video: follow those jobs instead.
    jobs = [j for j in call("GET", f"/api/batches/{batch['id']}/jobs")[1]
            if j["video_id"] == video["id"] and j["status"] in ("queued", "running")]
    print("render 409 → following", len(jobs), "active jobs")
elif status in (200, 201):
    print("render", status, [(j["variant_key"], j["status"]) for j in jobs])
else:
    print("render", status, jobs)
    sys.exit(1)

ids = ",".join(j["id"] for j in jobs)
t0 = time.time()
while True:
    jobs = call("GET", f"/api/jobs?ids={ids}")[1]
    if all(j["status"] in ("done", "failed") for j in jobs):
        break
    time.sleep(2)
print(f"finished in {time.time() - t0:.0f}s")
for j in jobs:
    print(" ", j["variant_key"], j["status"], j["progress"], j["output"], (j["error"] or "")[:800])

# A looping video sticker must not stretch the output past the post-trim duration.
post_duration = round(video["duration"] - 2.0, 1)
for j in jobs:
    if j["status"] == "done" and abs(j["output"]["duration"] - post_duration) > 0.3:
        print(f"unexpected duration for {j['variant_key']}: "
              f"{j['output']['duration']} (expected ~{post_duration})")
        sys.exit(1)

if mix_audio or use_bgm:
    for j in jobs:
        if j["status"] == "done" and j["output"]["codec"] != "h264/aac":
            print("mixed audio missing from", j["variant_key"], j["output"])
            sys.exit(1)

expected = {"9x16": (1080, 1920), "1x1": (1080, 1080)}
for j in jobs:
    if j["status"] == "done" and (j["output"]["width"], j["output"]["height"]) != expected[j["variant_key"]]:
        print("unexpected output size for", j["variant_key"], j["output"])
        sys.exit(1)
if all(j["status"] == "done" for j in jobs):
    print("callback:", json.dumps(jobs[0]["callback"], ensure_ascii=False)[:280])
else:
    sys.exit(1)
