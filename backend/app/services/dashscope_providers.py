"""Alibaba DashScope (百炼) implementations of the localization providers.

Every ``dashscope`` import is inside a method on purpose: the SDK is only needed by the
worker when a localization actually runs, and tests must never touch it or the network.

    ASR  paraformer-realtime-v2  Recognition(...).call(local wav) → sentences with ms timestamps
    MT   qwen-mt-plus            Generation.call(translation_options={source_lang, target_lang, terms})
    TTS  cosyvoice-v3-flash      SpeechSynthesizer(model, voice, WAV 22.05 kHz mono).call(text) → bytes
         qwen3-tts-flash         MultiModalConversation.call(text, voice, language_type) → wav URL → bytes
    HL   qwen-plus               Generation.call(system prompt + copy) → JSON array of phrases (HIG-50)
    CLONE  voice-enrollment      VoiceEnrollmentService.create_voice(target_model, prefix, url) → voice_id (HIG-58)
"""

from __future__ import annotations

import logging
import time
import urllib.error
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings
from app.services.highlight import parse_phrase_json
from app.services.localize import CLONE_VOICE_PREFIX, MT_DOMAINS, AsrResult, LocalizeError, Providers, language_type_for, tts_api_for

log = logging.getLogger(__name__)

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


@dataclass
class DashScopeTts:
    api_key: str
    model: str

    def synthesize(self, text: str, voice: str, speech_rate: float = 1.0, *, model: str | None = None, lang: str | None = None) -> bytes:
        model = model or self.model
        if tts_api_for(model) == "qwen3":
            return self._synthesize_qwen3(text, voice, model, lang)
        return self._synthesize_tts_v2(text, voice, speech_rate, model)

    def _synthesize_tts_v2(self, text: str, voice: str, speech_rate: float, model: str) -> bytes:
        """CosyVoice / Qwen-Audio-TTS: WebSocket synthesizer, bytes back, speech_rate honoured."""
        dashscope = _import_dashscope()
        from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer  # noqa: PLC0415

        dashscope.api_key = self.api_key
        rate = max(0.5, min(2.0, float(speech_rate)))  # the vendor's documented range

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
        try:
            with urllib.request.urlopen(url, timeout=60) as resp:  # noqa: S310 - vendor-issued https URL
                data = resp.read()
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            raise LocalizeError(f"下载合成音频失败：{exc}") from exc
        if not data:
            raise LocalizeError(f"合成失败（音色 {voice}）：音频为空")
        return data


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
        mt=DashScopeTranslate(api_key=key, model=cfg.localize_mt_model),
        tts=DashScopeTts(api_key=key, model=cfg.localize_tts_model),
        highlight=DashScopeHighlight(api_key=key, model=cfg.highlight_model),
        clone=DashScopeVoiceClone(api_key=key),
    )
