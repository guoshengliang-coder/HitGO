"""Alibaba DashScope (百炼) implementations of the localization providers.

Every ``dashscope`` import is inside a method on purpose: the SDK is only needed by the
worker when a localization actually runs, and tests must never touch it or the network.

    ASR  paraformer-realtime-v2  Recognition(...).call(local wav) → sentences with ms timestamps
    MT   qwen-mt-plus            Generation.call(translation_options={source_lang, target_lang, terms})
    TTS  cosyvoice-v3-flash      SpeechSynthesizer(model, voice, WAV 22.05 kHz mono).call(text) → bytes
         qwen3-tts-flash         MultiModalConversation.call(text, voice, language_type) → wav URL → bytes
         MiniMax/speech-2.8-hd   BaseApi.call(input={text, voice_setting, audio_setting}) → hex wav (HIG-59;
                                 same multimodal-generation endpoint as qwen3-tts, but the parameters live
                                 inside ``input``, which MultiModalConversation.call cannot express — it puts
                                 anything beyond text / voice / language_type into ``parameters``.
                                 Only in cn-beijing, which is dashscope's default endpoint anyway.)
    HL   qwen-plus               Generation.call(system prompt + copy) → JSON array of phrases (HIG-50)
    CLONE  voice-enrollment      VoiceEnrollmentService.create_voice(target_model, prefix, url) → voice_id (HIG-58)
    OCR  qwen-vl-max-latest      MultiModalConversation.call(local image + prompt) → JSON boxes (HIG-38)
"""

from __future__ import annotations

import base64
import binascii
import json
import logging
import re
import threading
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings
from app.services.highlight import parse_phrase_json
from app.services.screentext import DetectedText
from app.services.localize import CLONE_VOICE_PREFIX, MT_DOMAINS, AsrResult, LocalizeError, Providers, language_boost_for, language_type_for, tts_api_for

log = logging.getLogger(__name__)

# MiniMax is metered at 20 RPM (its model card), while dubbing synthesizes cues back to back at
# roughly 40/min — so it would hit the limit steadily and only get through on retry backoff. Pace
# the calls instead of walking into the wall: this is per worker process, so with several workers
# the real rate is a multiple of it; raising the account's RPM quota is the other half of the fix.
MINIMAX_MIN_INTERVAL = 3.1
_minimax_last_call = 0.0
_minimax_gate = threading.Lock()

RETRY_ATTEMPTS = 3
RETRY_BACKOFF = (1.0, 2.0, 4.0)
RETRYABLE_STATUS = {429, 500, 502, 503, 504}


def _status(result: Any) -> int | None:
    code = getattr(result, "status_code", None)
    try:
        return int(code) if code is not None else None
    except (TypeError, ValueError):
        return None


def _message(result: Any) -> str:
    return str(getattr(result, "message", "") or getattr(result, "code", "") or "百炼未返回原因")


def _with_retry(what: str, call: Callable[[], Any]) -> Any:
    """Run ``call`` up to three times on 429 / 5xx (or a transport error) with backoff."""
    last: Any = None
    for attempt in range(RETRY_ATTEMPTS):
        try:
            result = call()
        except Exception as exc:  # noqa: BLE001 - transport errors are retried, then surfaced
            last = exc
            log.warning("%s attempt %d raised: %s", what, attempt + 1, exc)
        else:
            status = _status(result)
            if status is None or status == 200:
                return result
            last = result
            if status not in RETRYABLE_STATUS:
                raise LocalizeError(f"{what}失败（{status}）：{_message(result)}")
            log.warning("%s attempt %d got %s: %s", what, attempt + 1, status, _message(result))
        if attempt + 1 < RETRY_ATTEMPTS:
            time.sleep(RETRY_BACKOFF[attempt])
    if isinstance(last, Exception):
        raise LocalizeError(f"{what}失败：{last}") from last
    raise LocalizeError(f"{what}失败（{_status(last)}）：{_message(last)}")


def _minimax_pace() -> None:
    """Block until ``MINIMAX_MIN_INTERVAL`` has passed since this process's last MiniMax call."""
    global _minimax_last_call  # noqa: PLW0603 - one gate per worker process
    with _minimax_gate:
        wait = _minimax_last_call + MINIMAX_MIN_INTERVAL - time.monotonic()
        if wait > 0:
            time.sleep(wait)
        _minimax_last_call = time.monotonic()


def _clamp_rate(speech_rate: float) -> float:
    """The vendor's documented range, shared by cosyvoice ``speech_rate`` and MiniMax ``speed``."""
    return max(0.5, min(2.0, float(speech_rate)))


def _download_audio(url: str, voice: str) -> bytes:
    """Fetch a vendor-issued audio URL (qwen3-tts always, MiniMax when it answers with one)."""
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 - vendor-issued https URL
            data = resp.read()
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise LocalizeError(f"下载合成音频失败：{exc}") from exc
    if not data:
        raise LocalizeError(f"合成失败（音色 {voice}）：音频为空")
    return bytes(data)


# MiniMax wants wav explicitly (the vendor default is mp3) at the same 22.05 kHz mono as cosyvoice.
# Getting this wrong fails late and confusingly: localize.wav_duration reads the RIFF header with
# ``wave.open``, so a non-wav clip measures 0 seconds and surfaces as "第 N 段合成结果为空".
MINIMAX_AUDIO_SETTING = {"format": "wav", "sample_rate": 22050, "channel": 1}


def _minimax_input(text: str, voice: str, speech_rate: float, lang: str | None, emotion: str | None) -> dict[str, Any]:
    """The ``input`` object of one MiniMax synthesis request (百炼 MiniMax 同步语音合成 API 参考)."""
    voice_setting: dict[str, Any] = {
        "voice_id": voice,
        "speed": _clamp_rate(speech_rate),
        "language_boost": language_boost_for(lang),
    }
    if emotion:
        voice_setting["emotion"] = emotion
    return {
        # "action" and "stream" are in the console's own curl sample for this model card; the API
        # reference page leaves them out. Send them the way the console does.
        "action": "tts",
        "stream": False,
        "text": text,
        "voice_setting": voice_setting,
        "audio_setting": dict(MINIMAX_AUDIO_SETTING),
        "output_format": "hex",
    }


def _minimax_decode(value: str) -> bytes | None:
    """``output.data.audio`` as bytes: hex per the docs, base64 tolerated in case the gateway switches."""
    try:
        return bytes.fromhex(value)
    except ValueError:
        pass
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        return None


def _minimax_audio_bytes(result: Any, voice: str) -> bytes:
    """Pull the wav out of a MiniMax response, whichever shape it arrives in.

    The documented answer is ``output.data.audio`` as a hex string, but ``output_format`` can also
    yield a URL, and ``output`` comes back as a dict from some SDK versions and as an object from
    others — so every step accepts both and the failures are explicit. A clip that is not RIFF is
    rejected here rather than left for ``wav_duration`` to silently measure as 0 seconds.
    """
    output = getattr(result, "output", None)
    if output is None and isinstance(result, dict):
        output = result.get("output")

    def field(obj: Any, name: str) -> Any:
        if isinstance(obj, dict):
            return obj.get(name)
        return getattr(obj, name, None)

    base_resp = field(output, "base_resp")
    vendor_status = field(base_resp, "status_code") if base_resp is not None else None
    if vendor_status not in (None, 0):
        raise LocalizeError(f"合成失败（音色 {voice}）：{field(base_resp, 'status_msg') or vendor_status}")

    audio = field(field(output, "data"), "audio") if field(output, "data") is not None else field(output, "audio")
    if audio is not None and not isinstance(audio, str):
        for key in ("url", "data", "hex", "audio"):
            found = field(audio, key)
            if isinstance(found, str) and found:
                audio = found
                break
    if not isinstance(audio, str) or not audio:
        keys = sorted(output.keys()) if isinstance(output, dict) else sorted(vars(output)) if output is not None else []
        raise LocalizeError(f"合成失败（音色 {voice}）：百炼没有返回音频（output 字段：{keys}）")

    data = _download_audio(audio, voice) if audio.startswith("http") else _minimax_decode(audio)
    if not data:
        raise LocalizeError(f"合成失败（音色 {voice}）：音频为空或无法解码")
    if not data.startswith(b"RIFF"):
        raise LocalizeError(f"合成失败（音色 {voice}）：返回的不是 wav（前 4 字节 {data[:4]!r}），检查 audio_setting.format")
    return data


def _import_dashscope() -> Any:
    try:
        import dashscope  # noqa: PLC0415
    except ImportError as exc:
        raise LocalizeError("这个 worker 没有安装 dashscope SDK") from exc
    return dashscope


@dataclass
class DashScopeAsr:
    api_key: str
    model: str

    def transcribe(self, wav: Path, lang: str | None) -> AsrResult:
        dashscope = _import_dashscope()
        from dashscope.audio.asr import Recognition  # noqa: PLC0415

        dashscope.api_key = self.api_key
        extra: dict[str, Any] = {}
        if lang:
            extra["language_hints"] = [lang]  # omitted = let the model detect the language

        def call() -> Any:
            recognition = Recognition(model=self.model, format="wav", sample_rate=16000, callback=None, **extra)
            return recognition.call(str(wav))

        result = _with_retry("听写", call)
        sentences = result.get_sentence() or []
        if isinstance(sentences, dict):
            sentences = [sentences]
        detected = None
        for sent in sentences:
            if isinstance(sent, dict) and sent.get("language"):
                detected = str(sent["language"])
                break
        return AsrResult(sentences=[dict(s) for s in sentences if isinstance(s, dict)], lang=detected)


@dataclass
class DashScopeTranslate:
    api_key: str
    model: str
    # Default keeps the standalone diagnostic script and any external construction compatible.
    script_model: str = "qwen-plus"

    def translate(self, text: str, source: str, target: str, terms: list[dict[str, str]]) -> str:
        dashscope = _import_dashscope()
        from dashscope import Generation  # noqa: PLC0415

        dashscope.api_key = self.api_key
        options: dict[str, Any] = {"source_lang": source, "target_lang": target, "domains": MT_DOMAINS}
        clean_terms = [
            {"source": str(t.get("source", "")).strip(), "target": str(t.get("target", "")).strip()}
            for t in terms
            if t.get("source") and t.get("target")
        ]
        if clean_terms:
            options["terms"] = clean_terms

        def call() -> Any:
            return Generation.call(
                api_key=self.api_key,
                model=self.model,
                messages=[{"role": "user", "content": text}],
                result_format="message",
                translation_options=options,
            )

        result = _with_retry("翻译", call)
        try:
            return str(result.output.choices[0].message.content)
        except (AttributeError, IndexError, KeyError, TypeError) as exc:
            raise LocalizeError("翻译结果为空") from exc

    def localize_for_speech(
        self,
        sources: list[str],
        translations: list[str],
        target: str,
        terms: list[dict[str, str]],
        target_seconds: list[float],
    ) -> list[str]:
        """Rewrite literal MT as natural spoken copy while preserving cue numbering (HIG-73)."""
        dashscope = _import_dashscope()
        from dashscope import Generation  # noqa: PLC0415

        dashscope.api_key = self.api_key
        term_text = "；".join(f"{t.get('source')} → {t.get('target')}" for t in terms if t.get("source") and t.get("target")) or "无"
        rows = "\n".join(
            f"{i}. 原文：{src}\n直译：{translated}\n目标时长：{seconds:.2f} 秒"
            for i, (src, translated, seconds) in enumerate(zip(sources, translations, target_seconds, strict=True), start=1)
        )
        system = (
            "你是专业影视配音本地化编剧。把直译改写为目标语言里自然、口语化、便于 TTS 朗读的台词；"
            "准确保留原意、事实、语气和术语，不添加新信息。按目标语言习惯重组语序，展开容易误读的数字、缩写和符号，"
            "用自然标点控制停顿和重音。每句尽量匹配给定时长，不用生硬堆词，不输出 SSML、注音、解释或引号。"
            "必须逐行输出与输入相同数量、相同顺序的编号，格式严格为“1. 台词”。"
        )

        def call() -> Any:
            return Generation.call(
                api_key=self.api_key,
                model=self.script_model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": f"目标语言：{target}\n术语：{term_text}\n\n{rows}"},
                ],
                result_format="message",
            )

        result = _with_retry("口播本地化", call)
        try:
            raw = str(result.output.choices[0].message.content)
        except (AttributeError, IndexError, KeyError, TypeError) as exc:
            raise LocalizeError("口播本地化结果为空") from exc
        from app.services.localize import parse_numbered_block  # noqa: PLC0415

        parsed = parse_numbered_block(raw, len(sources))
        if parsed is None:
            raise LocalizeError("口播本地化没有按句返回")
        return parsed


@dataclass
class DashScopeTts:
    api_key: str
    model: str

    def synthesize(self, text: str, voice: str, speech_rate: float = 1.0, *, model: str | None = None, lang: str | None = None, emotion: str | None = None) -> bytes:
        model = model or self.model
        api = tts_api_for(model)
        if api == "minimax":
            return self._synthesize_minimax(text, voice, speech_rate, model, lang, emotion)
        if api == "qwen3":
            return self._synthesize_qwen3(text, voice, model, lang)
        return self._synthesize_tts_v2(text, voice, speech_rate, model)

    def _synthesize_tts_v2(self, text: str, voice: str, speech_rate: float, model: str) -> bytes:
        """CosyVoice / Qwen-Audio-TTS: WebSocket synthesizer, bytes back, speech_rate honoured."""
        dashscope = _import_dashscope()
        from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer  # noqa: PLC0415

        dashscope.api_key = self.api_key
        rate = _clamp_rate(speech_rate)

        def call() -> Any:
            # A synthesizer instance is single-use: new one per call.
            synthesizer = SpeechSynthesizer(
                model=model, voice=voice, format=AudioFormat.WAV_22050HZ_MONO_16BIT, speech_rate=rate
            )
            audio = synthesizer.call(text)
            if not audio:
                response = synthesizer.get_response() if hasattr(synthesizer, "get_response") else None
                raise LocalizeError(f"合成失败（音色 {voice}）：{response or '百炼未返回音频'}")
            return audio

        return bytes(_with_retry("合成", call))

    def _synthesize_qwen3(self, text: str, voice: str, model: str, lang: str | None) -> bytes:
        """Qwen3-TTS: HTTP call, the wav comes back as a 24-hour URL that we download at once."""
        dashscope = _import_dashscope()
        from dashscope import MultiModalConversation  # noqa: PLC0415

        dashscope.api_key = self.api_key
        language_type = language_type_for(lang) if lang else "Auto"

        def call() -> Any:
            return MultiModalConversation.call(
                api_key=self.api_key, model=model, text=text, voice=voice, language_type=language_type, stream=False
            )

        result = _with_retry("合成", call)
        url = None
        try:
            audio = result.output.audio
            url = audio.get("url") if isinstance(audio, dict) else getattr(audio, "url", None)
        except AttributeError:
            url = None
        if not url:
            raise LocalizeError(f"合成失败（音色 {voice}）：百炼未返回音频地址")
        return _download_audio(url, voice)

    def _synthesize_minimax(self, text: str, voice: str, speech_rate: float, model: str, lang: str | None, emotion: str | None) -> bytes:
        """MiniMax hosted on DashScope: hex wav back, ``speed`` honoured (HIG-59).

        Goes through ``BaseApi.call`` rather than ``MultiModalConversation.call`` because the
        parameters have to sit inside ``input`` and that wrapper only puts text / voice /
        language_type there — everything else it hands to ``add_parameters``, i.e. ``parameters``.
        ``BaseApi`` is the same official SDK entry point MultiModalConversation itself calls, so
        auth, the endpoint and the ``status_code`` that ``_with_retry`` reads all still apply.
        """
        dashscope = _import_dashscope()
        from dashscope.client.base_api import BaseApi  # noqa: PLC0415

        dashscope.api_key = self.api_key
        payload = _minimax_input(text, voice, speech_rate, lang, emotion)

        def call() -> Any:
            _minimax_pace()
            return BaseApi.call(
                model=model,
                input=payload,
                task_group="aigc",
                task="multimodal-generation",
                function="generation",
                api_key=self.api_key,
            )

        return _minimax_audio_bytes(_with_retry("合成", call), voice)


HIGHLIGHT_PROMPT = (
    "你是短视频投放文案的排版助手。用户给你一段口播文案，请挑出其中最值得在画面上放大、变色强调的"
    "{n} 个以内的短词组：日期、时间、数字、金额、百分比、倍数，以及承载核心卖点或结论的关键名词 / 说法。"
    "每个词组必须逐字照抄原文（不要改写、不要加标点、不要合并不相邻的字），长度尽量在 2–12 个字，"
    "按在原文中出现的先后排列，互不重叠。只输出一个 JSON 字符串数组，不要任何解释、编号或代码块。"
)


@dataclass
class DashScopeHighlight:
    api_key: str
    model: str

    def pick(self, text: str, max_phrases: int) -> list[str]:
        dashscope = _import_dashscope()
        from dashscope import Generation  # noqa: PLC0415

        dashscope.api_key = self.api_key
        prompt = HIGHLIGHT_PROMPT.format(n=max_phrases)

        def call() -> Any:
            return Generation.call(
                api_key=self.api_key,
                model=self.model,
                messages=[{"role": "system", "content": prompt}, {"role": "user", "content": text}],
                result_format="message",
            )

        result = _with_retry("重点词挑选", call)
        try:
            raw = str(result.output.choices[0].message.content)
        except (AttributeError, IndexError, KeyError, TypeError) as exc:
            raise LocalizeError("重点词结果为空") from exc
        phrases = parse_phrase_json(raw)
        if not phrases and raw.strip():
            log.warning("highlight model %s did not return a JSON array: %.200s", self.model, raw)
        return phrases[:max_phrases]


@dataclass
class DashScopeVoiceClone:
    """Voice cloning (HIG-58): a sample URL the vendor fetches itself → a reusable voice id.

    The sample must be reachable from the public internet, which is why it is served through
    ``/media`` with a read ticket rather than uploaded here. The voice is bound to
    ``target_model`` and cannot be used with any other one.
    """

    api_key: str

    def create(self, sample_url: str, model: str) -> str:
        import dashscope  # noqa: PLC0415
        from dashscope.audio.tts_v2 import VoiceEnrollmentService  # noqa: PLC0415

        dashscope.api_key = self.api_key
        service = VoiceEnrollmentService()

        def call() -> Any:
            return service.create_voice(target_model=model, prefix=CLONE_VOICE_PREFIX, url=sample_url)

        result = _with_retry("音色复刻", call)
        # The SDK returns the id directly; older/other shapes carry it on the response object.
        voice_id = result if isinstance(result, str) else getattr(result, "voice_id", None) or _voice_id_from(result)
        if not voice_id:
            raise LocalizeError(f"音色复刻没有返回音色 id：{result!r:.200}")
        return str(voice_id)


def _voice_id_from(result: Any) -> str | None:
    output = getattr(result, "output", None)
    if isinstance(output, dict):
        return output.get("voice_id")
    return getattr(output, "voice_id", None)


def make_providers(cfg: Settings) -> Providers:
    key = cfg.dashscope_api_key
    return Providers(
        asr=DashScopeAsr(api_key=key, model=cfg.localize_asr_model),
        mt=DashScopeTranslate(api_key=key, model=cfg.localize_mt_model, script_model=cfg.localize_script_model),
        tts=DashScopeTts(api_key=key, model=cfg.localize_tts_model),
        highlight=DashScopeHighlight(api_key=key, model=cfg.highlight_model),
        clone=DashScopeVoiceClone(api_key=key),
    )


# --- on-screen text detection (HIG-38) --------------------------------------

SCREEN_TEXT_PROMPT = (
    "识别这张视频截图里后期叠加在画面上的文字（硬字幕、标题、角标、价格牌、提示语、免责声明）。"
    "画面里本来就存在的实物文字（招牌、路牌、商品包装、衣服印字、手机界面里的内容）不要输出。"
    "只输出一个 JSON 数组，不要任何解释或 Markdown 代码块。"
    "每一项形如 {\"text\": \"文字内容\", \"bbox_2d\": [x1, y1, x2, y2]}，"
    "bbox_2d 是这行文字外接矩形的左上角和右下角坐标。"
    "同一行文字合并成一项，不同行分开。没有叠加文字时输出 []。"
)

_JSON_ARRAY = re.compile(r"\[.*\]", re.S)

# How a model family writes ``bbox_2d`` (verified on real ad frames, 2026-09-21):
#   qwen3-vl-*          corners on a 0–1000 grid, independent of the image size
#   qwen-vl-* (2.5)     corners in pixels of the image as the model saw it
# The original prompt asked for unit [x, y, w, h]; no model honoured that consistently (qwen-vl-max
# returned unit corners, qwen-vl-plus mixed pixel corners with pixel sizes), so every box that came
# back was misread. Asking for the grounding format the models were trained on fixes the source.
SCALE_GRID = "grid1000"
SCALE_PIXELS = "pixels"
SCALE_UNIT = "unit"


def bbox_scale_for(model: str) -> str:
    return SCALE_GRID if model.lower().startswith("qwen3") else SCALE_PIXELS


def _unit_box(values: list[float], scale: str, size: tuple[int, int] | None) -> dict[str, float] | None:
    """``bbox_2d`` corners → a unit ``{x, y, w, h}``; ``None`` when it cannot be placed."""
    x1, y1, x2, y2 = values
    if scale == SCALE_PIXELS and max(values) <= 1.0:
        scale = SCALE_UNIT  # a 2.5 model that followed an older prompt and answered in ratios
    if scale == SCALE_GRID:
        sx = sy = 1000.0
    elif scale == SCALE_PIXELS:
        if not size or size[0] <= 0 or size[1] <= 0:
            return None
        sx, sy = float(size[0]), float(size[1])
    else:
        sx = sy = 1.0
    x1, x2 = sorted((x1 / sx, x2 / sx))
    y1, y2 = sorted((y1 / sy, y2 / sy))
    x1, y1 = max(x1, 0.0), max(y1, 0.0)
    x2, y2 = min(x2, 1.0), min(y2, 1.0)
    if x2 <= x1 or y2 <= y1:
        return None
    return {"x": x1, "y": y1, "w": x2 - x1, "h": y2 - y1}


def parse_detection_json(raw: str, *, scale: str = SCALE_GRID, size: tuple[int, int] | None = None) -> list[DetectedText]:
    """Model output → detections; anything malformed is skipped rather than failing the frame.

    The model occasionally wraps the array in prose or a code fence even when told not to, so
    the first bracketed span is extracted before parsing. A frame that yields nothing usable is
    simply a frame without text — one bad frame must not sink a whole detection run.

    ``bbox_2d`` corners are converted with ``scale`` (see ``bbox_scale_for``); ``size`` is the
    frame's pixel size, needed only for pixel coordinates. The legacy ``box`` key keeps its unit
    ``[x, y, w, h]`` meaning.
    """
    text = (raw or "").strip()
    if not text:
        return []
    match = _JSON_ARRAY.search(text)
    if not match:
        return []
    try:
        items = json.loads(match.group(0))
    except json.JSONDecodeError:
        log.warning("screen text detection did not parse as JSON")
        return []
    if not isinstance(items, list):
        return []
    out: list[DetectedText] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        content = str(item.get("text") or "").strip()
        corners = item.get("bbox_2d")
        legacy = item.get("box")
        raw_box = corners if corners is not None else legacy
        if not content or not isinstance(raw_box, (list, tuple)) or len(raw_box) != 4:
            continue
        try:
            values = [float(v) for v in raw_box]
        except (TypeError, ValueError):
            continue
        if corners is not None:
            unit = _unit_box(values, scale, size)
            if unit is None:
                continue
        else:
            x, y, w, h = values
            if w <= 0 or h <= 0:
                continue
            unit = {"x": x, "y": y, "w": w, "h": h}
        confidence = item.get("confidence")
        try:
            score = float(confidence) if confidence is not None else None
        except (TypeError, ValueError):
            score = None
        out.append(DetectedText(text=content, box=unit, confidence=score))
    return out


def _image_size(path: Path) -> tuple[int, int] | None:
    try:
        from PIL import Image  # noqa: PLC0415

        with Image.open(path) as im:
            return im.size
    except Exception:  # noqa: BLE001  only pixel-coordinate models need it; they skip the frame
        return None


def _message_text(result: Any) -> str:
    """The assistant's text out of a MultiModalConversation result."""
    try:
        content = result.output.choices[0].message.content
    except (AttributeError, IndexError, KeyError, TypeError):
        return ""
    if isinstance(content, str):
        return content
    parts: list[str] = []
    for piece in content or []:
        if isinstance(piece, dict) and piece.get("text"):
            parts.append(str(piece["text"]))
        elif isinstance(piece, str):
            parts.append(piece)
    return "\n".join(parts)


@dataclass
class DashScopeScreenText:
    """Vision model over one sampled frame at a time (contract §6, HIG-38).

    One frame per call rather than a batch: the coordinates have to come back per image, and a
    batched prompt makes the model mix frames up far more often than it saves calls.
    """

    api_key: str
    model: str
    timeout_seconds: int = 60

    def detect(self, frame: Path, hint_lang: str | None) -> list[DetectedText]:
        dashscope = _import_dashscope()
        from dashscope import MultiModalConversation  # noqa: PLC0415

        dashscope.api_key = self.api_key
        prompt = SCREEN_TEXT_PROMPT
        if hint_lang:
            prompt += f"画面文字的语言大概率是 {hint_lang}。"
        messages = [{"role": "user", "content": [{"image": frame.resolve().as_uri()}, {"text": prompt}]}]

        def call() -> Any:
            # Without a request timeout the SDK waits 300 s per attempt, so one stalled frame
            # (× three retries) could eat the whole task budget.
            return MultiModalConversation.call(
                api_key=self.api_key, model=self.model, messages=messages, request_timeout=self.timeout_seconds
            )

        result = _with_retry("画面文字识别", call)
        return parse_detection_json(_message_text(result), scale=bbox_scale_for(self.model), size=_image_size(frame))
