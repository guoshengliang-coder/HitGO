"""Alibaba DashScope (百炼) implementations of the localization providers.

Every ``dashscope`` import is inside a method on purpose: the SDK is only needed by the
worker when a localization actually runs, and tests must never touch it or the network.

    ASR  paraformer-realtime-v2  Recognition(...).call(local wav) → sentences with ms timestamps
    MT   qwen-mt-plus            Generation.call(translation_options={source_lang, target_lang, terms})
    TTS  cosyvoice-v3-flash      SpeechSynthesizer(model, voice, WAV 22.05 kHz mono).call(text) → bytes
"""

from __future__ import annotations

import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.config import Settings
from app.services.localize import MT_DOMAINS, AsrResult, LocalizeError, Providers

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

    def synthesize(self, text: str, voice: str, speech_rate: float = 1.0) -> bytes:
        dashscope = _import_dashscope()
        from dashscope.audio.tts_v2 import AudioFormat, SpeechSynthesizer  # noqa: PLC0415

        dashscope.api_key = self.api_key
        rate = max(0.5, min(2.0, float(speech_rate)))  # the vendor's documented range

        def call() -> Any:
            # A synthesizer instance is single-use: new one per call.
            synthesizer = SpeechSynthesizer(
                model=self.model, voice=voice, format=AudioFormat.WAV_22050HZ_MONO_16BIT, speech_rate=rate
            )
            audio = synthesizer.call(text)
            if not audio:
                response = synthesizer.get_response() if hasattr(synthesizer, "get_response") else None
                raise LocalizeError(f"合成失败（音色 {voice}）：{response or '百炼未返回音频'}")
            return audio

        return bytes(_with_retry("合成", call))


def make_providers(cfg: Settings) -> Providers:
    key = cfg.dashscope_api_key
    return Providers(
        asr=DashScopeAsr(api_key=key, model=cfg.localize_asr_model),
        mt=DashScopeTranslate(api_key=key, model=cfg.localize_mt_model),
        tts=DashScopeTts(api_key=key, model=cfg.localize_tts_model),
    )
