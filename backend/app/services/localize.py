"""Localization: one transcript template, one dubbed version per target language (contract §1 / §3 / §6).

Runs on the default worker queue — every heavy step is a network call to Alibaba DashScope
(``dashscope_providers``), so it never touches torch or the separator image. The pure
helpers (argv builders, cue bookkeeping, placement planning) stay unit-testable without
ffmpeg or the vendor SDK; the ``Fake*`` providers let the whole lifecycle run in tests.

Pipeline (``run_localization``), driven by ``Video.localization.pending``:
    source.mp4 → ffmpeg → 16 kHz mono wav → ASR → transcript.cues (source timeline, seconds)
    per target language:
        transcript texts → MT (one numbered block, per-sentence fallback) → version.cues
        each translated cue → TTS → wav clip → placed at the cue's source start (atempo ≤ max)
        clips → ffmpeg amix over a silent bed → {asset_id}.m4a → Asset(source = derived, stem = dubbed)
"""

from __future__ import annotations

import copy
import io
import logging
import re
import shutil
import subprocess
import sys
import wave
from array import array
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from celery.exceptions import SoftTimeLimitExceeded
from sqlalchemy.orm import Session

from app import ids
from app.config import Settings, settings
from app.db import iso, utcnow
from app.models import (
    ASSET_AUDIO,
    ASSET_READY,
    ASSET_SOURCE_DERIVED,
    LOC_DONE,
    LOC_FAILED,
    LOC_QUEUED,
    LOC_RUNNING,
    Asset,
    Video,
)
from app.services import media_ticket, storage
from app.services.highlight import HighlightProvider, RuleHighlight

log = logging.getLogger(__name__)

ASR_SAMPLE_RATE = 16000
MIX_SAMPLE_RATE = 44100
VOICE_EXT = "m4a"
VOICE_BITRATE = "192k"
VOICE_LOUDNESS_FILTER = "loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100"
MAX_CUES = 400
STAGE_TRANSLATE = "translate"
STAGE_TTS = "tts"
STAGE_MIX = "mix"
STEM_DUBBED = "dubbed"
AUTO = "auto"
# Voice cloning (HIG-58). A cloned voice is bound to the model it was created against, and
# that model only speaks these languages (help.aliyun.com/zh/model-studio/cosyvoice-clone-api,
# checked 2026-09-18 for cosyvoice-v3-flash: Mandarin and its dialects incl. Cantonese, plus
# en / fr / de / ja / ko / ru / pt / th / id / vi). Spanish, Italian and Arabic are not in it.
CLONE_MODEL_LANGS = ("zh", "yue", "en", "fr", "de", "ja", "ko", "ru", "pt", "th", "id", "vi")
CLONE_VOICE_PREFIX = "hitgo"
# The vendor wants 10–20 seconds of clean speech, at least 16 kHz, at most 10 MB.
CLONE_SAMPLE_MIN_SECONDS = 10.0
CLONE_SAMPLE_MAX_SECONDS = 20.0
SAMPLE_FROM_VOCALS = "vocals"
SAMPLE_FROM_SOURCE = "source"
# CosyVoice speech_rate range; a clip longer than its slot is re-synthesized faster before atempo.
MAX_SPEECH_RATE = 2.0
# HIG-73 conservative picture retiming. A result outside this range falls back to the historical
# source timeline instead of making the picture look unnaturally fast / slow.
ADAPTIVE_VIDEO_SPEED_MIN = 0.8
ADAPTIVE_VIDEO_SPEED_MAX = 1.25
MT_DOMAINS = (
    "Voice-over script for a short marketing video. Translate naturally and concisely so that "
    "each numbered line, when spoken aloud, takes about as long as the source line."
)


class LocalizeError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# languages and voices
# ---------------------------------------------------------------------------

# code → label (UI), mt_name (Qwen-MT wants English full names), asr (Paraformer v2 can
# transcribe it), font_hint (subtitle font the frontend should prefer).
LANGS: dict[str, dict[str, Any]] = {
    "zh": {"label": "中文", "mt_name": "Chinese", "asr": True, "font_hint": "Noto Sans SC"},
    "en": {"label": "英语", "mt_name": "English", "asr": True, "font_hint": "Noto Sans SC"},
    "ja": {"label": "日语", "mt_name": "Japanese", "asr": True, "font_hint": "Noto Sans JP"},
    "ko": {"label": "韩语", "mt_name": "Korean", "asr": True, "font_hint": "Noto Sans KR"},
    "yue": {"label": "粤语", "mt_name": "Cantonese", "asr": True, "font_hint": "Noto Sans SC"},
    "de": {"label": "德语", "mt_name": "German", "asr": True, "font_hint": "Noto Sans SC"},
    "fr": {"label": "法语", "mt_name": "French", "asr": True, "font_hint": "Noto Sans SC"},
    "ru": {"label": "俄语", "mt_name": "Russian", "asr": True, "font_hint": "Noto Sans SC"},
    "pt": {"label": "葡萄牙语", "mt_name": "Portuguese", "asr": False, "font_hint": "Noto Sans SC"},
    "th": {"label": "泰语", "mt_name": "Thai", "asr": False, "font_hint": "Noto Sans Thai"},
    "id": {"label": "印尼语", "mt_name": "Indonesian", "asr": False, "font_hint": "Noto Sans SC"},
    # Noto Sans SC has no vietnamese subset (its precomposed ế ộ ữ would fall back), so Vietnamese
    # asks for the Latin Noto instead — it became a selectable target language in HIG-59.
    "vi": {"label": "越南语", "mt_name": "Vietnamese", "asr": False, "font_hint": "Noto Sans"},
    "es": {"label": "西班牙语", "mt_name": "Spanish", "asr": False, "font_hint": "Noto Sans SC"},
    "it": {"label": "意大利语", "mt_name": "Italian", "asr": False, "font_hint": "Noto Sans SC"},
    "ar": {"label": "阿拉伯语", "mt_name": "Arabic", "asr": False, "font_hint": "Noto Sans Arabic", "rtl": True},
}

# Which DashScope API a TTS model goes through. CosyVoice / Qwen-Audio-TTS use the
# tts_v2 SpeechSynthesizer (has speech_rate); Qwen3-TTS uses MultiModalConversation and
# returns a URL (no speech_rate: the atempo step covers overruns).
QWEN3_TTS_PREFIX = "qwen3-tts"
# Qwen3-TTS language_type values; anything else is sent as "Auto".
QWEN3_TTS_LANGUAGE_TYPES = {"zh": "Chinese", "en": "English", "de": "German", "it": "Italian", "pt": "Portuguese", "es": "Spanish", "ja": "Japanese", "ko": "Korean", "fr": "French", "ru": "Russian"}
# MiniMax hosted on DashScope (HIG-59). Same multimodal-generation endpoint as qwen3-tts, but the
# parameters sit in input.voice_setting / input.audio_setting, so it needs its own request shape.
# Matched case-insensitively: a hand-typed LOCALIZE_VOICES=th=x@minimax/speech-2.8-hd would
# otherwise fall through to tts_v2 and fail with a confusing WebSocket error.
MINIMAX_TTS_PREFIX = "minimax/"
# language_boost values (help.aliyun.com/zh/model-studio/minimax-synchronous-speech-synthesis-api,
# checked 2026-09-18). Deliberately NOT merged with QWEN3_TTS_LANGUAGE_TYPES: the vocabularies
# differ (th / vi / ar exist only here), Cantonese is the comma-bearing "Chinese,Yue", and the
# fallback spelling differs ("auto" vs "Auto"). One table per API, like tts_api_for itself.
MINIMAX_LANGUAGE_BOOST = {"zh": "Chinese", "yue": "Chinese,Yue", "en": "English", "ja": "Japanese", "ko": "Korean", "de": "German", "fr": "French", "ru": "Russian", "pt": "Portuguese", "th": "Thai", "id": "Indonesian", "vi": "Vietnamese", "es": "Spanish", "it": "Italian", "ar": "Arabic"}
# Which vendor a voice comes from, as GET /api/localize/options reports it (contract §3 ``provider``).
VOICE_PROVIDERS = {"tts_v2": "aliyun", "qwen3": "aliyun", "minimax": "minimax"}
# Characters per synthesis request, per API. MiniMax allows 10,000 but recommends streaming above
# 3,000; a long request also risks the Celery soft limit and costs a whole segment on retry.
TTS_MAX_CHARS = {"tts_v2": 500, "qwen3": 500, "minimax": 2000}


def tts_api_for(model: str) -> str:
    """``"minimax"``, ``"qwen3"`` (MultiModalConversation, URL result) or ``"tts_v2"`` (SpeechSynthesizer bytes)."""
    if model.casefold().startswith(MINIMAX_TTS_PREFIX):
        return "minimax"
    return "qwen3" if model.startswith(QWEN3_TTS_PREFIX) else "tts_v2"


def supports_speech_rate(model: str) -> bool:
    """Whether the model honours ``speech_rate``; MiniMax calls it ``speed``, same 0.5–2 range."""
    return tts_api_for(model) in ("tts_v2", "minimax")


def language_type_for(lang: str) -> str:
    return QWEN3_TTS_LANGUAGE_TYPES.get(lang, "Auto")


def language_boost_for(lang: str | None) -> str:
    """MiniMax ``voice_setting.language_boost``; anything unlisted is sent as ``"auto"``."""
    return MINIMAX_LANGUAGE_BOOST.get(lang or "", "auto")


def voice_provider(model: str) -> str:
    return VOICE_PROVIDERS[tts_api_for(model)]


def max_tts_chars(model: str) -> int:
    return TTS_MAX_CHARS[tts_api_for(model)]

GENDERS = ("female", "male", "neutral")


def _v(id_: str, label: str, gender: str, style: str, model: str | None = None) -> dict[str, str]:
    """One voice-table entry: ``{id, label, gender, style[, model]}``."""
    entry = {"id": id_, "label": label, "gender": gender, "style": style}
    if model:
        entry["model"] = model
    return entry


def _mv(voice: str, label: str, gender: str, style: str, emotion: str | None = None) -> dict[str, str]:
    """One MINIMAX_VOICES entry (HIG-59); ``model`` is stamped on later by :func:`voice_table`.

    ``voice`` is the vendor's voice_id. With ``emotion`` the entry becomes an "emotion variant" of
    that same voice and gets its own ``id`` (``"<voice>~<emotion>"``), because voice ids must stay
    unique within a language; ``~`` is RFC 3986 unreserved, so it is safe in the preview URL and in
    a filename, and it is not ``@`` (which LOCALIZE_VOICES already uses to mean "model").
    """
    entry = {"id": f"{voice}~{emotion}" if emotion else voice, "voice": voice,
             "label": label, "gender": gender, "style": style}
    if emotion:
        entry["emotion"] = emotion
    return entry


# cosyvoice-v3-flash voices per language (help.aliyun.com/zh/model-studio/cosyvoice-voice-list;
# ids and 特质 checked against the page on 2026-09-17, HIG-42). The first entry is the default and
# must stay put: existing videos synthesize with it when no voice is stored. ``label`` is the name,
# ``style`` the vendor's one-line character, ``gender`` groups the picker (``neutral`` = child /
# character voices, shown as 特色). Chinese is a curated ad-copy set, not the vendor's full 60+.
# Thai / Vietnamese / Arabic have no entry here; MINIMAX_VOICES below is what makes them selectable.
_BASE_VOICES: dict[str, list[dict[str, str]]] = {
    "zh": [
        _v("longxiaochun_v3", "龙小淳", "female", "知性积极"),
        _v("longcheng_v3", "龙橙", "male", "智慧青年"),
        _v("loongbella_v3", "Bella", "female", "精准干练"),
        _v("longxiaoxia_v3", "龙小夏", "female", "沉稳权威"),
        _v("longanran_v3", "龙安燃", "female", "活泼质感·直播"),
        _v("longanxuan_v3", "龙安宣", "female", "经典直播"),
        _v("longyingxiao_v3", "龙应笑", "female", "清甜推销"),
        _v("longanwen_v3", "龙安温", "female", "优雅知性"),
        _v("longanli_v3", "龙安莉", "female", "利落从容"),
        _v("longyingmu_v3", "龙应沐", "female", "优雅知性"),
        _v("longyumi_v3", "YUMI", "female", "正经青年"),
        _v("longanhuan_v3", "龙安欢", "female", "欢脱元气"),
        _v("longhua_v3", "龙华", "female", "元气甜美"),
        _v("longwan_v3", "龙婉", "female", "细腻柔声"),
        _v("longyue_v3", "龙悦", "female", "温暖磁性"),
        _v("longyuan_v3", "龙媛", "female", "温暖治愈"),
        _v("longmiao_v3", "龙妙", "female", "抑扬顿挫·有声书"),
        _v("longanrou_v3", "龙安柔", "female", "温柔闺蜜"),
        _v("longanya_v3", "龙安雅", "female", "高雅气质"),
        _v("longanqin_v3", "龙安亲", "female", "亲和活泼"),
        _v("longfei_v3", "龙飞", "male", "热血磁性"),
        _v("longshuo_v3", "龙硕", "male", "博才干练·新闻"),
        _v("longshu_v3", "龙书", "male", "沉稳青年·新闻"),
        _v("longanlang_v3", "龙安朗", "male", "清爽利落"),
        _v("longanyun_v3", "龙安昀", "male", "居家暖男"),
        _v("longanzhi_v3", "龙安智", "male", "睿智轻熟"),
        _v("longze_v3", "龙泽", "male", "温暖元气"),
        _v("longtian_v3", "龙天", "male", "磁性理智"),
        _v("longsanshu_v3", "龙三叔", "male", "沉稳质感·有声书"),
        _v("longyichen_v3", "龙逸尘", "male", "洒脱活力"),
        _v("longlaotie_v3", "龙老铁", "male", "东北直率"),
        _v("longjielidou_v3", "龙杰力豆", "neutral", "阳光顽皮男童"),
        _v("longhouge_v3", "龙猴哥", "neutral", "经典猴哥"),
        _v("longjiqi_v3", "龙机器", "neutral", "呆萌机器人"),
    ],
    "en": [
        _v("loongabby_v3", "Abby", "female", "美式"),
        _v("loongandy_v3", "Andy", "male", "美式"),
        _v("loongemily_v3", "Emily", "female", "英式"),
        _v("loongeric_v3", "Eric", "male", "英式"),
        _v("loongannie_v3", "Annie", "female", "美式"),
        _v("loongava_v3", "Ava", "female", "美式"),
        _v("loongbeth_v3", "Beth", "female", "美式"),
        _v("loongbetty_v3", "Betty", "female", "美式"),
        _v("loongcally_v3", "Cally", "female", "美式"),
        _v("loongcindy_v3", "Cindy", "female", "美式"),
        _v("loongdonna_v3", "Donna", "female", "美式"),
        _v("loongdavid_v3", "David", "male", "美式"),
        _v("loongluna_v3", "Luna", "female", "英式"),
        _v("loongluca_v3", "Luca", "male", "英式"),
    ],
    "ja": [
        _v("loongtomoka_v3", "Tomoka", "female", "日语"),
        _v("loongtomoya_v3", "Tomoya", "male", "日语"),
        _v("loongyuuna_v3", "Yuuna", "female", "年轻"),
        _v("loongyuuma_v3", "Yuuma", "male", "年轻"),
        _v("loongriko_v3", "Riko", "female", "二次元"),
    ],
    "ko": [
        _v("loongkyong_v3", "Kyong", "female", "韩语"),
        _v("loongjihun_v3", "Jihun", "male", "韩语"),
    ],
    "yue": [
        _v("longjiaxin_v3", "龙嘉欣", "female", "优雅"),
        _v("longanyue_v3", "龙安粤", "male", "欢脱"),
        _v("longjiayi_v3", "龙嘉怡", "female", "知性"),
    ],
    "id": [
        _v("loongindah_v3", "Indah", "female", "印尼"),
    ],
    # Spanish / Portuguese / French (and German / Italian / Russian) have no CosyVoice system
    # voice; Qwen3-TTS-Flash's voices speak all ten of its languages (voice list page, 2026-09-16).
    **{
        lang: [
            _v("Cherry", "Cherry", "female", "亲切", "qwen3-tts-flash"),
            _v("Serena", "Serena", "female", "温柔", "qwen3-tts-flash"),
            _v("Ethan", "Ethan", "male", "阳光", "qwen3-tts-flash"),
        ]
        for lang in ("es", "pt", "fr", "de", "it", "ru")
    },
}
# Voices without a "model" key belong to the configured default (LOCALIZE_TTS_MODEL, cosyvoice-v3-flash).
# MiniMax system voices reachable through DashScope (HIG-59; ids and names from MiniMax's official
# System Voice ID List, platform.minimax.io/docs/faq/system-voice-id, checked 2026-09-18). The
# vendor publishes 327 ids across 24 languages; this is a curated subset per language (male / female
# / character coverage, no duplicate character, holiday novelty voices such as Santa_Claus left out)
# rather than the full list, so the picker stays usable — the same choice CapCut makes.
# ``style`` is ours (the vendor has no equivalent column); ``label`` translates the vendor's name.
# These entries carry no "model": voice_table() stamps MINIMAX_TTS_MODEL on them, so the whole
# family can be switched to turbo, or removed entirely, from the environment.
# ids are NOT [A-Za-z0-9_]: they contain spaces, ASCII and full-width parentheses and hyphens
# ("Chinese (Mandarin)_Mature_Woman", "Cantonese_ProfessionalHost（F)", "French_Female_News Anchor").
# An "<id>~<emotion>" entry is the same vendor voice with voice_setting.emotion pinned — that is how
# emotion is offered (picked from the list, as in CapCut), so there is no separate emotion control.
MINIMAX_VOICES: dict[str, list[dict[str, str]]] = {
    "zh": [
        _mv("Chinese (Mandarin)_News_Anchor", "新闻女声", "female", "新闻播报"),
        _mv("Chinese (Mandarin)_Sweet_Lady", "甜美女声", "female", "甜美亲和"),
        _mv("Chinese (Mandarin)_Warm_Bestie", "温暖闺蜜", "female", "温暖闺蜜"),
        _mv("Chinese (Mandarin)_Wise_Women", "阅历姐姐", "female", "阅历知性"),
        _mv("Chinese (Mandarin)_Warm_Girl", "温暖少女", "female", "温暖少女"),
        _mv("Chinese (Mandarin)_Reliable_Executive", "沉稳高管", "male", "沉稳高管"),
        _mv("Chinese (Mandarin)_Male_Announcer", "播报男声", "male", "播报男声"),
        _mv("Chinese (Mandarin)_Gentleman", "温润男声", "male", "温润男声"),
        _mv("Chinese (Mandarin)_Radio_Host", "电台男主播", "male", "电台主播"),
        _mv("Chinese (Mandarin)_Sincere_Adult", "真诚青年", "male", "真诚青年"),
        _mv("Chinese (Mandarin)_Cute_Spirit", "憨憨萌兽", "neutral", "憨萌角色"),
        _mv("lovely_girl", "萌萌女童", "neutral", "萌趣女童"),
        _mv("Chinese (Mandarin)_Sweet_Lady", "甜美女声·欢快", "female", "甜美亲和", emotion="happy"),
        _mv("Chinese (Mandarin)_News_Anchor", "新闻女声·平稳", "female", "新闻播报", emotion="calm"),
        _mv("Chinese (Mandarin)_Reliable_Executive", "沉稳高管·欢快", "male", "沉稳高管", emotion="happy"),
    ],
    "en": [
        _mv("English_Graceful_Lady", "Graceful Lady", "female", "优雅女声"),
        _mv("Serene_Woman", "Serene Woman", "female", "沉静女声"),
        _mv("Attractive_Girl", "Attractive Girl", "female", "明亮女声"),
        _mv("English_Whispering_girl", "Whispering Girl", "female", "轻声耳语"),
        _mv("English_Trustworthy_Man", "Trustworthy Man", "male", "可信男声"),
        _mv("English_Diligent_Man", "Diligent Man", "male", "干练男声"),
        _mv("English_Gentle-voiced_man", "Gentle-voiced Man", "male", "温和男声"),
        _mv("English_Aussie_Bloke", "Aussie Bloke", "male", "澳洲口音"),
        _mv("English_Graceful_Lady", "Graceful Lady·欢快", "female", "优雅女声", emotion="happy"),
        _mv("English_Trustworthy_Man", "Trustworthy Man·平稳", "male", "可信男声", emotion="calm"),
    ],
    "ja": [
        _mv("Japanese_KindLady", "Kind Lady", "female", "亲切女声"),
        _mv("Japanese_CalmLady", "Calm Lady", "female", "沉静女声"),
        _mv("Japanese_DependableWoman", "Dependable Woman", "female", "可靠女声"),
        _mv("Japanese_GracefulMaiden", "Graceful Maiden", "female", "优雅少女"),
        _mv("Japanese_IntellectualSenior", "Intellectual Senior", "male", "知性前辈"),
        _mv("Japanese_GentleButler", "Gentle Butler", "male", "温和管家"),
        _mv("Japanese_OptimisticYouth", "Optimistic Youth", "male", "开朗青年"),
        _mv("Japanese_InnocentBoy", "Innocent Boy", "neutral", "清澈少年"),
    ],
    "ko": [
        _mv("Korean_ReliableSister", "Reliable Sister", "female", "可靠姐姐"),
        _mv("Korean_CalmLady", "Calm Lady", "female", "沉静女声"),
        _mv("Korean_SoothingLady", "Soothing Lady", "female", "舒缓女声"),
        _mv("Korean_FriendlyBigSister", "Friendly Big Sister", "female", "亲切大姐"),
        _mv("Korean_CaringWoman", "Caring Woman", "female", "体贴女声"),
        _mv("Korean_CalmGentleman", "Calm Gentleman", "male", "沉稳绅士"),
        _mv("Korean_IntellectualMan", "Intellectual Man", "male", "知性男声"),
        _mv("Korean_ReliableYouth", "Reliable Youth", "male", "可靠青年"),
    ],
    "yue": [
        _mv("Cantonese_ProfessionalHost（F)", "专业女主持", "female", "专业主持"),
        _mv("Cantonese_GentleLady", "温柔女声", "female", "温柔女声"),
        _mv("Cantonese_KindWoman", "善良女声", "female", "亲和女声"),
        _mv("Cantonese_CuteGirl", "可爱女孩", "female", "可爱女孩"),
        _mv("Cantonese_ProfessionalHost（M)", "专业男主持", "male", "专业主持"),
        _mv("Cantonese_PlayfulMan", "活泼男声", "male", "活泼男声"),
    ],
    "id": [
        _mv("Indonesian_CalmWoman", "Calm Woman", "female", "沉静女声"),
        _mv("Indonesian_ConfidentWoman", "Confident Woman", "female", "自信女声"),
        _mv("Indonesian_GentleGirl", "Gentle Girl", "female", "温柔女声"),
        _mv("Indonesian_SweetGirl", "Sweet Girl", "female", "甜美女声"),
        _mv("Indonesian_CaringMan", "Caring Man", "male", "亲和男声"),
        _mv("Indonesian_ReservedYoungMan", "Reserved Young Man", "male", "内敛青年"),
    ],
    "es": [
        _mv("Spanish_SereneWoman", "Serene Woman", "female", "沉静女声"),
        _mv("Spanish_ConfidentWoman", "Confident Woman", "female", "自信女声"),
        _mv("Spanish_SophisticatedLady", "Sophisticated Lady", "female", "优雅女声"),
        _mv("Spanish_ThoughtfulLady", "Thoughtful Lady", "female", "娓娓女声"),
        _mv("Spanish_Narrator", "Narrator", "male", "解说男声"),
        _mv("Spanish_RationalMan", "Rational Man", "male", "理性男声"),
        _mv("Spanish_ReliableMan", "Reliable Man", "male", "可靠男声"),
        _mv("Spanish_Steadymentor", "Steady Mentor", "male", "沉稳讲述"),
    ],
    "pt": [
        _mv("Portuguese_ConfidentWoman", "Confident Woman", "female", "自信女声"),
        _mv("Portuguese_SereneWoman", "Serene Woman", "female", "沉静女声"),
        _mv("Portuguese_GentleTeacher", "Gentle Teacher", "female", "温和讲述"),
        _mv("Portuguese_ThoughtfulLady", "Thoughtful Lady", "female", "娓娓女声"),
        _mv("Portuguese_Narrator", "Narrator", "male", "解说男声"),
        _mv("Portuguese_ReliableMan", "Reliable Man", "male", "可靠男声"),
        _mv("Portuguese_RationalMan", "Rational Man", "male", "理性男声"),
        _mv("Portuguese_Steadymentor", "Steady Mentor", "male", "沉稳讲述"),
    ],
    "fr": [
        _mv("French_FemaleAnchor", "Female Anchor", "female", "女主播"),
        _mv("French_Female_News Anchor", "News Anchor", "female", "新闻女声"),
        _mv("French_MovieLeadFemale", "Movie Lead Female", "female", "电影女主"),
        _mv("French_MaleNarrator", "Male Narrator", "male", "解说男声"),
        _mv("French_Male_Speech_New", "Level-Headed Man", "male", "沉稳男声"),
    ],
    "de": [
        _mv("German_SweetLady", "Sweet Lady", "female", "甜美女声"),
        _mv("German_FriendlyMan", "Friendly Man", "male", "亲和男声"),
        _mv("German_PlayfulMan", "Playful Man", "male", "活泼男声"),
    ],
    "it": [
        _mv("Italian_BraveHeroine", "Brave Heroine", "female", "英气女声"),
        _mv("Italian_DiligentLeader", "Diligent Leader", "male", "干练男声"),
        _mv("Italian_Narrator", "Narrator", "male", "解说男声"),
        _mv("Italian_WanderingSorcerer", "Wandering Sorcerer", "neutral", "游吟角色"),
    ],
    "ru": [
        _mv("Russian_BrightHeroine", "Bright Queen", "female", "明亮女声"),
        _mv("Russian_AmbitiousWoman", "Ambitious Woman", "female", "进取女声"),
        _mv("Russian_ReliableMan", "Reliable Man", "male", "可靠男声"),
        _mv("Russian_AttractiveGuy", "Attractive Guy", "male", "有魅力男声"),
        _mv("Russian_HandsomeChildhoodFriend", "Handsome Childhood Friend", "male", "清朗青年"),
    ],
    # Thai / Vietnamese / Arabic have no CosyVoice or Qwen3-TTS voice at all, so these entries are
    # what makes them selectable as target languages (voice_table drops a language with no voices).
    # The vendor only publishes 4 / 1 / 2 ids for them; all are taken.
    "th": [
        _mv("Thai_female_1_sample1", "泰语女声 1", "female", "自信女声"),
        _mv("Thai_female_2_sample2", "泰语女声 2", "female", "活力女声"),
        _mv("Thai_male_1_sample8", "泰语男声 1", "male", "沉静男声"),
        _mv("Thai_male_2_sample2", "泰语男声 2", "male", "亲和男声"),
    ],
    "vi": [
        _mv("Vietnamese_kindhearted_girl", "越南语女声", "female", "亲切女声"),
    ],
    "ar": [
        _mv("Arabic_CalmWoman", "Calm Woman", "female", "沉静女声"),
        _mv("Arabic_FriendlyGuy", "Friendly Guy", "male", "亲和男声"),
    ],
}


def _merge_voices(base: dict[str, list[dict[str, str]]], extra: dict[str, list[dict[str, str]]]) -> dict[str, list[dict[str, str]]]:
    """``base`` with ``extra`` appended per language; a language only in ``extra`` keeps its order.

    Appending (never inserting) is what keeps "the first voice of each language is the default"
    true for every language that already had one — existing videos synthesize with it when no
    voice is stored (contract §3). ``base`` is not modified.
    """
    out = {lang: list(voices) for lang, voices in base.items()}
    for lang, voices in extra.items():
        out.setdefault(lang, []).extend(voices)
    return out


DEFAULT_VOICES: dict[str, list[dict[str, str]]] = _merge_voices(_BASE_VOICES, MINIMAX_VOICES)


def source_langs() -> list[dict[str, str]]:
    """``auto`` plus every language the ASR model can transcribe (contract §3 options)."""
    out = [{"code": AUTO, "label": "自动识别"}]
    out += [{"code": code, "label": info["label"]} for code, info in LANGS.items() if info["asr"]]
    return out


def parse_voice_overrides(raw: str) -> dict[str, dict[str, str]]:
    """``LOCALIZE_VOICES="ko=loongkyong_v3,ar=loongmary@qwen-audio-3.0-tts-flash"`` → {lang: {id[, model]}}.

    ``@model`` names the TTS model the voice belongs to (defaults to LOCALIZE_TTS_MODEL). Junk is ignored.
    """
    out: dict[str, dict[str, str]] = {}
    for item in (raw or "").split(","):
        if "=" not in item:
            continue
        lang, voice = (p.strip() for p in item.split("=", 1))
        model = ""
        if "@" in voice:
            voice, model = (p.strip() for p in voice.split("@", 1))
        if lang in LANGS and voice:
            out[lang] = {"id": voice, **({"model": model} if model else {})}
    return out


def voice_table(cfg: Settings | None = None) -> dict[str, list[dict[str, str]]]:
    """Voices per target language: defaults with the env override moved to (or added at) the front.

    Each entry is ``{id, label[, gender, style, model, voice, emotion]}``; no ``model`` = the
    configured default TTS model. ``voice`` (the vendor's id, when it differs from ``id``) and
    ``emotion`` are MiniMax-only and never leave the backend. Env-added voices carry no gender /
    style (the picker lists them ungrouped).
    """
    cfg = cfg or settings
    table = {lang: list(voices) for lang, voices in _BASE_VOICES.items()}
    if cfg.minimax_tts_model:
        # The MiniMax entries carry no model of their own, so stamp the configured one on here.
        # An empty MINIMAX_TTS_MODEL leaves them out entirely: th / vi / ar then have no voices and
        # drop out of target_langs, i.e. the whole family is switched off from the environment.
        stamped = {lang: [{**v, "model": cfg.minimax_tts_model} for v in voices] for lang, voices in MINIMAX_VOICES.items()}
        table = _merge_voices(table, stamped)
    for lang, override in parse_voice_overrides(cfg.localize_voices).items():
        voice = override["id"]
        voices = [v for v in table.get(lang, []) if v["id"] != voice]
        known = next((v for v in table.get(lang, []) if v["id"] == voice), None)
        entry = dict(known) if known else {"id": voice, "label": voice}
        if override.get("model"):
            entry["model"] = override["model"]
        table[lang] = [entry, *voices]
    return {lang: table[lang] for lang in LANGS if table.get(lang)}


def voice_model(lang: str, voice: str, table: dict[str, list[dict[str, str]]] | None = None, cfg: Settings | None = None) -> str:
    """The TTS model a voice belongs to (contract §6): its own ``model`` or LOCALIZE_TTS_MODEL."""
    cfg = cfg or settings
    table = table if table is not None else voice_table(cfg)
    entry = next((v for v in table.get(lang, []) if v["id"] == voice), None)
    return str((entry or {}).get("model") or cfg.localize_tts_model)


def voice_spec(lang: str, voice: str, table: dict[str, list[dict[str, str]]] | None = None, cfg: Settings | None = None) -> dict[str, Any]:
    """What it takes to synthesize one voice-table id: ``{voice, model, emotion}``.

    ``voice`` here is the id the API speaks (contract §3), which for a MiniMax emotion variant is
    ``"<vendor id>~<emotion>"``; the returned ``voice`` is always the vendor's own id.
    """
    cfg = cfg or settings
    table = table if table is not None else voice_table(cfg)
    entry = next((v for v in table.get(lang, []) if v["id"] == voice), None) or {}
    return {
        "voice": str(entry.get("voice") or voice),
        "model": str(entry.get("model") or cfg.localize_tts_model),
        "emotion": entry.get("emotion") or None,
    }


def voice_out(lang: str, voice: dict[str, str], cfg: Settings | None = None) -> dict[str, Any]:
    """One ``voices[]`` element of ``GET /api/localize/options`` (contract §3): id, label, gender,
    style, whether its model honours ``speech_rate`` (cosyvoice and MiniMax yes, qwen3-tts no) and
    which vendor it comes from. The model name, the vendor id and the emotion stay in the backend."""
    cfg = cfg or settings
    model = str(voice.get("model") or cfg.localize_tts_model)
    return {
        "id": voice["id"],
        "label": voice["label"],
        "gender": voice.get("gender"),
        "style": voice.get("style"),
        "speech_rate": supports_speech_rate(model),
        "provider": voice_provider(model),
    }


def clone_supported(lang: str, cfg: Settings | None = None) -> bool:
    """Whether ``lang`` can be spoken by a cloned voice (contract §3 ``clone``, HIG-58).

    The clone is bound to ``LOCALIZE_TTS_MODEL``; a language whose own voice belongs to a
    different model can still be cloned, as long as the clone's model speaks it.

    The ``tts_v2`` test below is deliberately spelled out rather than written as
    ``supports_speech_rate(...)``: the two were equivalent until MiniMax arrived (HIG-59), and
    reusing that helper here would report ``clone: true`` for anyone who points
    LOCALIZE_TTS_MODEL at a MiniMax model, which cannot enrol a cloned voice at all.
    """
    cfg = cfg or settings
    return lang in CLONE_MODEL_LANGS and tts_api_for(cfg.localize_tts_model) == "tts_v2"


def target_langs(cfg: Settings | None = None) -> list[dict[str, Any]]:
    return [
        {
            "code": lang,
            "label": LANGS[lang]["label"],
            "rtl": bool(LANGS[lang].get("rtl")),
            "clone": clone_supported(lang, cfg),
            "voices": [voice_out(lang, v, cfg) for v in voices],
        }
        for lang, voices in voice_table(cfg).items()
    ]


def enabled(cfg: Settings | None = None) -> bool:
    cfg = cfg or settings
    return cfg.localize_provider == "fake" or bool(cfg.dashscope_api_key)


def options_out(cfg: Settings | None = None) -> dict[str, Any]:
    """Body of ``GET /api/localize/options`` (contract §3)."""
    return {"enabled": enabled(cfg), "source_langs": source_langs(), "target_langs": target_langs(cfg)}


def resolve_voice(lang: str, requested: str | None, table: dict[str, list[dict[str, str]]] | None = None) -> str:
    """The voice to synthesize ``lang`` with: the requested one (must be offered) or the default."""
    table = table if table is not None else voice_table()
    voices = table.get(lang) or []
    if not voices:
        raise ValueError(f"{LANGS.get(lang, {}).get('label', lang)} 还没有可用的音色")
    if requested is None or requested == "":
        return voices[0]["id"]
    if not any(v["id"] == requested for v in voices):
        raise ValueError(f"音色 {requested} 不适用于{LANGS[lang]['label']}")
    return requested


def mt_name(code: str) -> str:
    """Language code → the English name Qwen-MT wants; ``auto`` passes through."""
    if code == AUTO:
        return AUTO
    return str(LANGS[code]["mt_name"])


# ---------------------------------------------------------------------------
# pure helpers
# ---------------------------------------------------------------------------


def _fmt(v: float) -> str:
    s = f"{v:.3f}".rstrip("0").rstrip(".")
    return s if s not in ("", "-0") else "0"


def extract_args(src: Path, dst: Path, ffmpeg_bin: str | None = None) -> list[str]:
    """Source audio → 16 kHz mono PCM wav, what the ASR model wants."""
    return [
        ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-i", str(src),
        "-vn", "-map", "0:a:0",
        "-ac", "1", "-ar", str(ASR_SAMPLE_RATE), "-c:a", "pcm_s16le",
        str(dst),
    ]  # fmt: skip


def plan_voice_sample(
    cues: list[dict[str, Any]],
    min_seconds: float = CLONE_SAMPLE_MIN_SECONDS,
    max_seconds: float = CLONE_SAMPLE_MAX_SECONDS,
) -> dict[str, float] | None:
    """A window of the source timeline to clone the speaker's voice from (HIG-58).

    Walks the transcript picking up consecutive cues, and keeps the run whose *spoken*
    seconds first reach ``min_seconds`` while the window itself stays within
    ``max_seconds``. A long silence between two cues therefore ends the run rather than
    being counted as speech: the vendor wants continuous reading, not a sparse window.

    Returns ``{"start", "seconds"}`` in seconds, or None when no such run exists.
    """
    for first in range(len(cues)):
        start = float(cues[first]["start"])
        spoken = 0.0
        for cue in cues[first:]:
            end = float(cue["end"])
            if end - start > max_seconds:
                break
            spoken += max(end - float(cue["start"]), 0.0)
            if spoken >= min_seconds:
                return {"start": round(start, 3), "seconds": round(end - start, 3)}
    return None


def sample_args(src: Path, dst: Path, start: float, seconds: float, *, mono_pcm: bool, ffmpeg_bin: str | None = None) -> list[str]:
    """Cut ``seconds`` of audio starting at ``start`` for the cloning sample (HIG-58).

    ``mono_pcm`` writes a 16 kHz mono wav (straight from source.mp4); otherwise the input is
    an already vocals-only m4a and is re-encoded to aac, since a stream copy cannot cut
    cleanly on an arbitrary second.
    """
    codec = ["-ac", "1", "-ar", str(ASR_SAMPLE_RATE), "-c:a", "pcm_s16le"] if mono_pcm else ["-c:a", "aac", "-b:a", "128k"]
    return [
        ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
        "-ss", _fmt(start), "-t", _fmt(seconds),
        "-i", str(src),
        "-vn", "-map", "0:a:0",
        *codec,
        str(dst),
    ]  # fmt: skip


def wav_duration(path: Path) -> float:
    """Seconds of audio in a PCM wav (TTS clips, the ASR input).

    Measured from the bytes actually on disk, not the header: CosyVoice streams its wav and
    leaves a placeholder data size in the header (``wave`` then reports hours of audio).
    """
    with wave.open(str(path), "rb") as w:
        rate, channels, width = w.getframerate(), w.getnchannels(), w.getsampwidth()
    if not rate or not channels or not width:
        return 0.0
    data = path.read_bytes()
    pos = 12  # after "RIFF" <size> "WAVE"
    while pos + 8 <= len(data):
        chunk_id = data[pos : pos + 4]
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        if chunk_id == b"data":
            payload = len(data) - (pos + 8)
            return min(size, payload) / (rate * channels * width) if size else payload / (rate * channels * width)
        pos += 8 + size + (size & 1)
    return 0.0


def wav_has_signal(path: Path) -> bool:
    """Reject a valid-duration TTS WAV whose PCM contains only silence or tiny noise."""
    with wave.open(str(path), "rb") as source:
        width = source.getsampwidth()
    if width not in (1, 2, 4):
        raise LocalizeError(f"口播音频位深不受支持：{width * 8} bit")
    data = path.read_bytes()
    pos = 12
    while pos + 8 <= len(data):
        size = int.from_bytes(data[pos + 4 : pos + 8], "little")
        if data[pos : pos + 4] == b"data":
            payload = data[pos + 8 : pos + 8 + min(size or len(data), len(data) - pos - 8)]
            if width == 1:
                samples = (byte - 128 for byte in payload)
            else:
                signed = array("h" if width == 2 else "i")
                signed.frombytes(payload[:len(payload) - len(payload) % width])
                if sys.byteorder != "little":
                    signed.byteswap()
                samples = iter(signed)
            threshold = max(1, int((1 << (width * 8 - 1)) / 512))
            count = len(payload) // width
            return count > 0 and sum(abs(sample) >= threshold for sample in samples) >= max(8, int(count * 0.001))
        pos += 8 + size + (size & 1)
    return False


def mixed_voice_has_signal(path: Path) -> bool:
    """Decode the final AAC and check it is audible before publishing it as a ready asset."""
    result = subprocess.run(
        [settings.ffmpeg_bin, "-hide_banner", "-nostdin", "-i", str(path), "-af", "volumedetect", "-f", "null", "-"],
        capture_output=True, text=True, timeout=180, check=False,
    )
    if result.returncode != 0:
        raise LocalizeError(f"配音文件无法解码：{result.stderr[-300:]}")
    match = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?|-inf) dB", result.stderr)
    if not match:
        raise LocalizeError("无法验证生成口播是否有声")
    return float(match.group(1)) > -70


def silent_wav(seconds: float, rate: int = 22050) -> bytes:
    """A mono 16-bit PCM wav of silence (Fake TTS, tests)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\x00\x00" * max(0, int(round(seconds * rate))))
    return buf.getvalue()


MAX_CUE_CHARS = 60  # a subtitle line the viewer can actually read; longer ASR "sentences" get split
MAX_CUE_SECONDS = 6.0
_SENTENCE_END = ".!?。！？"
_CLAUSE_END = ",;:，；："
_ASCII_LETTER = re.compile(r"[A-Za-z]")
_SENTENCE_SPLIT = re.compile(r"(?<=[.!?。！？])\s+")


def _word_text(word: dict[str, Any]) -> str:
    return (str(word.get("text") or "") + str(word.get("punctuation") or "")).strip()


def _join_words(parts: list[str]) -> str:
    if any(_ASCII_LETTER.search(p) for p in parts):
        return re.sub(r"\s+([,.;:!?])", r"\1", " ".join(parts)).strip()
    return "".join(parts).strip()


def split_sentence(sent: dict[str, Any], max_chars: int = MAX_CUE_CHARS, max_seconds: float = MAX_CUE_SECONDS) -> list[dict[str, Any]]:
    """Break one ASR sentence into subtitle-sized pieces (``begin_time`` / ``end_time`` ms, ``text``).

    Paraformer often hands back a whole ad as one "sentence" when the speaker never pauses.
    With word timestamps the cut goes at sentence-final punctuation, or at a clause break /
    any word once the piece is over ``max_chars`` / ``max_seconds``; without them the text is
    cut at sentence punctuation and the time shared out by character count.
    """
    text = str(sent.get("text") or "").strip()
    begin = float(sent.get("begin_time") or 0)
    end = float(sent.get("end_time") or begin)
    if not text:
        return []
    words = [w for w in (sent.get("words") or []) if isinstance(w, dict) and _word_text(w)]
    if words:
        pieces: list[dict[str, Any]] = []
        parts: list[str] = []
        piece_begin: float | None = None
        prev_end = begin
        hard_limit = max_chars * 1.5

        def flush(end_ms: float) -> None:
            nonlocal parts, piece_begin
            joined = _join_words(parts)
            if joined and piece_begin is not None:
                pieces.append({"begin_time": piece_begin, "end_time": end_ms, "text": joined})
            parts, piece_begin = [], None

        for k, word in enumerate(words):
            wtext = _word_text(word)
            wbegin = float(word.get("begin_time") or prev_end)
            wend = float(word.get("end_time") or wbegin)
            # A word that would push the piece past the hard limit starts a new piece instead.
            if parts and len(_join_words([*parts, wtext])) > hard_limit:
                flush(prev_end)
            if piece_begin is None:
                piece_begin = wbegin
            parts.append(wtext)
            prev_end = wend
            joined = _join_words(parts)
            last = k == len(words) - 1
            long_enough = len(joined) >= max_chars or (wend - piece_begin) / 1000.0 >= max_seconds
            if last or wtext[-1:] in _SENTENCE_END or (long_enough and wtext[-1:] in _CLAUSE_END):
                flush(wend)
        return [p for p in pieces if p["text"]]
    chunks = [c.strip() for c in _SENTENCE_SPLIT.split(text) if c.strip()]
    if len(chunks) <= 1:
        return [{"begin_time": begin, "end_time": end, "text": text}]
    total_chars = sum(len(c) for c in chunks) or 1
    pieces = []
    cursor = begin
    for c in chunks:
        span = (end - begin) * len(c) / total_chars
        pieces.append({"begin_time": cursor, "end_time": cursor + span, "text": c})
        cursor += span
    return pieces


def cues_from_sentences(sentences: list[dict[str, Any]], duration: float | None, max_cues: int = MAX_CUES) -> list[dict[str, Any]]:
    """ASR sentences (``begin_time`` / ``end_time`` ms, ``text``) → transcript cues in seconds.

    Long sentences are first cut into subtitle-sized pieces (``split_sentence``). Empty
    sentences are dropped, ends are clamped to the source duration, sentences starting
    past the end vanish, and ``i`` is renumbered so it stays a dense index.
    """
    cues: list[dict[str, Any]] = []
    pieces = [p for sent in sentences for p in split_sentence(sent)]
    for sent in sorted(pieces, key=lambda s: float(s.get("begin_time") or 0)):
        text = str(sent.get("text") or "").strip()
        if not text:
            continue
        start = max(0.0, float(sent.get("begin_time") or 0) / 1000.0)
        end = float(sent.get("end_time") or 0) / 1000.0
        if duration is not None and duration > 0:
            if start >= duration:
                continue
            end = min(end, duration)
        if end <= start:
            end = start + 0.1
        cues.append({"i": len(cues), "start": round(start, 3), "end": round(end, 3), "text": text})
        if len(cues) >= max_cues:
            break
    return cues


_NUMBERED = re.compile(r"^\s*(\d+)\s*[.．)）:：、]\s*(.*)$")


def numbered_block(texts: list[str]) -> str:
    """Sentences → one ``1. …\\n2. …`` block so the translator sees the whole context."""
    return "\n".join(f"{n}. {t.strip()}" for n, t in enumerate(texts, start=1))


def parse_numbered_block(text: str, n: int) -> list[str] | None:
    """Inverse of ``numbered_block``; None unless every number 1..n appears exactly once, in order."""
    out: list[str] = []
    for raw in (text or "").splitlines():
        line = raw.strip()
        if not line:
            continue
        m = _NUMBERED.match(line)
        if m and int(m.group(1)) == len(out) + 1:
            out.append(m.group(2).strip())
        elif out:
            out[-1] = (out[-1] + " " + line).strip()  # wrapped continuation of the last one
        else:
            return None
    if len(out) != n or any(not t for t in out):
        return None
    return out


def translate_with_fallback(provider: TranslateProvider, texts: list[str], source: str, target: str, terms: list[dict[str, str]]) -> list[str]:
    """One numbered request for the whole transcript; if it comes back malformed, sentence by sentence."""
    if not texts:
        return []
    block = provider.translate(numbered_block(texts), source, target, terms)
    parsed = parse_numbered_block(block, len(texts))
    if parsed is not None:
        return parsed
    log.warning("numbered translation did not parse (%d sentences); falling back to per-sentence", len(texts))
    return [provider.translate(t, source, target, terms).strip() for t in texts]


def localize_for_speech(
    provider: TranslateProvider,
    sources: list[str],
    translations: list[str],
    target: str,
    terms: list[dict[str, str]],
    target_seconds: list[float],
) -> tuple[list[str], str | None]:
    """Optional HIG-73 spoken-copy pass; old/custom providers keep literal MT unchanged."""
    rewrite = getattr(provider, "localize_for_speech", None)
    if not callable(rewrite) or not sources:
        return translations, None
    try:
        out = list(rewrite(sources, translations, target, terms, target_seconds))
        if len(out) != len(translations) or any(not str(text).strip() for text in out):
            raise LocalizeError("口播本地化返回的句数不一致")
        return [str(text).strip() for text in out], None
    except Exception as exc:  # noqa: BLE001 - literal MT is the deliberate production fallback
        log.warning("spoken localization failed; keeping literal translation: %s", exc)
        return translations, f"口播化改写失败，已使用直译：{exc}"


def plan_placements(cues: list[dict[str, Any]], clip_durations: list[float], total: float, max_tempo: float) -> tuple[list[dict[str, Any]], list[str]]:
    """Where each clip goes on the source timeline.

    A clip starts at its cue's ``start``; if it would run into the next cue (or past the end),
    it is sped up with ``atempo`` up to ``max_tempo``; if that still is not enough, the overlap
    is kept and reported in ``warnings`` so the user can shorten the translation.
    """
    placements: list[dict[str, Any]] = []
    warnings: list[str] = []
    slots = cue_slots(cues, total)
    for k, cue in enumerate(cues):
        start = float(cue["start"])
        available = slots[k]
        clip = float(clip_durations[k])
        tempo = 1.0
        if clip > available > 0:
            tempo = min(max_tempo, clip / available)
        elif clip > available:  # nothing left at all (cue at the very end)
            tempo = max_tempo
        tempo = round(max(tempo, 1.0), 3)
        effective = clip / tempo if tempo else clip
        if effective > available + 0.05:
            warnings.append(
                f"第 {int(cue['i']) + 1} 句配音 {effective:.1f} 秒，超出可用的 {available:.1f} 秒"
                + (f"（已加速 {tempo:.2f}×）" if tempo > 1 else "")
                + "，建议缩短译文"
            )
        placements.append({"i": cue["i"], "start": round(start, 3), "tempo": tempo, "duration": round(effective, 3)})
    return placements, warnings


def plan_adaptive_placements(
    cues: list[dict[str, Any]],
    clip_durations: list[float],
    total: float,
    min_speed: float = ADAPTIVE_VIDEO_SPEED_MIN,
    max_speed: float = ADAPTIVE_VIDEO_SPEED_MAX,
) -> tuple[list[dict[str, Any]] | None, float, list[str]]:
    """Map each spoken source span to its natural voice length, preserving silent gaps at 1×.

    The whole plan is rejected when any cue needs picture speed outside the conservative range;
    callers then use :func:`plan_placements`, the backwards-compatible audio-only fallback.
    """
    placements: list[dict[str, Any]] = []
    warnings: list[str] = []
    cursor = 0.0
    previous_end = 0.0
    for cue, voice_seconds in zip(cues, clip_durations, strict=True):
        source_start = float(cue["start"])
        source_end = float(cue["end"])
        source_seconds = max(source_end - source_start, 0.1)
        voice_seconds = max(float(voice_seconds), 0.01)
        speed = source_seconds / voice_seconds
        if speed < min_speed - 1e-6 or speed > max_speed + 1e-6:
            warnings.append(
                f"第 {int(cue['i']) + 1} 句需画面 {speed:.2f}×，超出保守范围 {min_speed:.2f}–{max_speed:.2f}×，已沿用原时间轴"
            )
            return None, total, warnings
        cursor += max(0.0, source_start - previous_end)
        placements.append({
            "i": cue["i"],
            "start": round(cursor, 3),
            "tempo": 1.0,
            "duration": round(voice_seconds, 3),
            "video_speed": round(speed, 3),
        })
        cursor += voice_seconds
        previous_end = source_end
    return placements, round(cursor + max(0.0, total - previous_end), 3), warnings


def plan_complete_placements(
    cues: list[dict[str, Any]], clip_durations: list[float], total: float,
    min_speed: float = ADAPTIVE_VIDEO_SPEED_MIN,
    max_speed: float = ADAPTIVE_VIDEO_SPEED_MAX,
) -> tuple[list[dict[str, Any]], float, list[str]]:
    """Keep every spoken line intact; hold its last picture frame if safe speed is insufficient."""
    placements: list[dict[str, Any]] = []
    warnings: list[str] = []
    cursor = 0.0
    previous_end = 0.0
    for cue, duration in zip(cues, clip_durations, strict=True):
        source_start = max(previous_end, float(cue["start"]))
        source_end = max(source_start, float(cue["end"]))
        source_seconds = source_end - source_start
        if source_seconds < 0.1:
            raise LocalizeError(f"第 {int(cue['i']) + 1} 句原画面不足 0.1 秒，无法按句适配")
        voice_seconds = max(float(duration), 0.01)
        speed = min(max(source_seconds / voice_seconds, min_speed), max_speed)
        picture_seconds = source_seconds / speed
        hold = max(0.0, voice_seconds - picture_seconds)
        cursor += max(0.0, source_start - previous_end)
        placements.append({
            "i": cue["i"], "start": round(cursor, 3), "tempo": 1.0,
            "duration": round(voice_seconds, 3), "video_speed": round(speed, 3),
            "hold_after": round(hold, 3),
        })
        if hold > 0.01:
            warnings.append(f"第 {int(cue['i']) + 1} 句为完整播完口播，在句末停帧 {hold:.1f} 秒")
        cursor += picture_seconds + hold
        previous_end = source_end
    return placements, round(cursor + max(0.0, total - previous_end), 3), warnings


DUB_KEYS = ("dub_start", "dub_duration", "video_speed", "hold_after", "voice_asset_id", "dub_tempo")


def with_placements(cues: list[dict[str, Any]], placements: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Version cues + where each line's dubbed audio sits on its version timeline (HIG-36/HIG-73).

    ``placements`` is what ``plan_placements`` returned. An empty list strips the fields, which is
    how "the voice-over no longer matches this text" is recorded (translate-only, edited cues); a
    cue with no placement (empty translation, so nothing was synthesised) loses them the same way.
    """
    placed = {int(p["i"]): p for p in placements if float(p.get("duration") or 0) > 0}
    out: list[dict[str, Any]] = []
    for cue in cues:
        clean = {k: v for k, v in cue.items() if k not in DUB_KEYS}
        hit = placed.get(int(cue["i"]))
        if hit is not None:
            clean["dub_start"] = round(float(hit["start"]), 3)
            clean["dub_duration"] = round(float(hit["duration"]), 3)
            if hit.get("video_speed") is not None:
                clean["video_speed"] = round(float(hit["video_speed"]), 3)
            if hit.get("hold_after"):
                clean["hold_after"] = round(float(hit["hold_after"]), 3)
            if hit.get("voice_asset_id"):
                clean["voice_asset_id"] = str(hit["voice_asset_id"])
            if float(hit.get("tempo") or 1.0) != 1.0:
                clean["dub_tempo"] = round(float(hit["tempo"]), 3)
        out.append(clean)
    return out


def mix_args(
    clips: list[tuple[Path, float, float]],
    total: float,
    dst: Path,
    ffmpeg_bin: str | None = None,
    *,
    normalize_loudness: bool = False,
) -> list[str]:
    """One ffmpeg command: silent stereo bed of ``total`` seconds + every clip delayed to its start.

    ``clips`` = (path, start_seconds, tempo). Output: aac 192k, 44.1 kHz stereo, browser-playable.
    """
    argv = [ffmpeg_bin or settings.ffmpeg_bin, "-hide_banner", "-loglevel", "error", "-nostdin", "-y"]
    for path, _start, _tempo in clips:
        argv += ["-i", str(path)]
    chains = [f"anullsrc=r={MIX_SAMPLE_RATE}:cl=stereo,atrim=end={_fmt(total)}[bed]"]
    labels = ["[bed]"]
    for k, (_path, start, tempo) in enumerate(clips):
        steps: list[str] = []
        if abs(tempo - 1.0) > 1e-6:
            steps.append(f"atempo={_fmt(tempo)}")
        delay_ms = round(start * 1000)
        if delay_ms > 0:
            steps.append(f"adelay={delay_ms}:all=1")
        steps.append(f"aformat=sample_rates={MIX_SAMPLE_RATE}:channel_layouts=stereo")
        chains.append(f"[{k}:a]" + ",".join(steps) + f"[c{k}]")
        labels.append(f"[c{k}]")
    if clips:
        output_label = "mixed" if normalize_loudness else "aout"
        chains.append(f"{''.join(labels)}amix=inputs={len(labels)}:duration=first:normalize=0:dropout_transition=0[{output_label}]")
        if normalize_loudness:
            chains.append(f"[mixed]{VOICE_LOUDNESS_FILTER}[aout]")
    else:
        chains[0] = chains[0].replace("[bed]", "[aout]")
    argv += [
        "-filter_complex", ";".join(chains),
        "-map", "[aout]", "-c:a", "aac", "-b:a", VOICE_BITRATE, "-movflags", "+faststart",
        str(dst),
    ]  # fmt: skip
    return argv


def cue_slots(cues: list[dict[str, Any]], total: float) -> list[float]:
    """Seconds each cue may occupy: from its start to the next cue's start (the last one: to the end)."""
    slots: list[float] = []
    for k, cue in enumerate(cues):
        start = float(cue["start"])
        limit = float(cues[k + 1]["start"]) if k + 1 < len(cues) else float(total)
        slots.append(max(limit - start, 0.0))
    return slots


def speech_rate_for(clip_seconds: float, slot_seconds: float, max_rate: float = MAX_SPEECH_RATE) -> float:
    """Faster synthesis rate that would fit ``clip_seconds`` into ``slot_seconds``; 1.0 = already fits."""
    if slot_seconds <= 0 or clip_seconds <= slot_seconds:
        return 1.0
    return round(min(max_rate, clip_seconds / slot_seconds), 2)


def voice_name(video_name: str, lang: str) -> str:
    """Asset name shown in the library: ``V01 新手引导A · 韩语配音.m4a``."""
    base = Path(video_name).stem or video_name
    label = LANGS.get(lang, {}).get("label", lang)
    return f"{base} · {label}配音.{VOICE_EXT}"


def previous_voice_asset_ids(localization: dict[str, Any] | None, langs: list[str] | None = None) -> list[str]:
    """Dubbed asset ids of the given (default: all) versions — what a re-run replaces / a delete removes."""
    if not localization:
        return []
    versions = localization.get("versions") or {}
    out: list[str] = []
    for lang, version in versions.items():
        if langs is not None and lang not in langs:
            continue
        if version and version.get("voice_asset_id"):
            out.append(str(version["voice_asset_id"]))
        for cue in (version or {}).get("cues") or []:
            if cue.get("voice_asset_id"):
                out.append(str(cue["voice_asset_id"]))
        out.extend(str(asset_id) for asset_id in (version or {}).get("old_cue_asset_ids") or [])
    return list(dict.fromkeys(out))


def apply_cue_edits(cues: list[dict[str, Any]], edits: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    """Return ``cues`` with ``key`` replaced per ``edits`` (matched on ``i``); unknown ``i`` → ValueError."""
    by_i = {int(c["i"]): dict(c) for c in cues}
    for edit in edits:
        i = int(edit["i"])
        if i not in by_i:
            raise ValueError(f"没有第 {i + 1} 句")
        by_i[i][key] = str(edit[key]).strip()
    return [by_i[i] for i in sorted(by_i)]


# ---------------------------------------------------------------------------
# providers
# ---------------------------------------------------------------------------


@dataclass
class AsrResult:
    sentences: list[dict[str, Any]]
    lang: str | None = None  # detected language when the model reports one


class AsrProvider(Protocol):
    def transcribe(self, wav: Path, lang: str | None) -> AsrResult: ...


class TranslateProvider(Protocol):
    def translate(self, text: str, source: str, target: str, terms: list[dict[str, str]]) -> str: ...


class TtsProvider(Protocol):
    def synthesize(self, text: str, voice: str, speech_rate: float = 1.0, *, model: str | None = None, lang: str | None = None, emotion: str | None = None) -> bytes: ...


class VoiceCloneProvider(Protocol):
    def create(self, sample_url: str, model: str) -> str: ...


@dataclass
class FakeVoiceClone:
    """Clones without calling anyone: tests get a stable id and a record of every call."""

    fail: str = ""
    calls: list[tuple[str, str]] = field(default_factory=list)

    def create(self, sample_url: str, model: str) -> str:
        self.calls.append((sample_url, model))
        if self.fail:
            raise LocalizeError(self.fail)
        return f"{CLONE_VOICE_PREFIX}-fake-{len(self.calls)}"


@dataclass
class Providers:
    asr: AsrProvider
    mt: TranslateProvider
    tts: TtsProvider
    # Poster highlight picking (HIG-50) rides on the same key / provider switch.
    highlight: HighlightProvider = field(default_factory=RuleHighlight)
    # Voice cloning for 「用原声配音」 (HIG-58).
    clone: VoiceCloneProvider = field(default_factory=FakeVoiceClone)


@dataclass
class FakeAsr:
    sentences: list[dict[str, Any]] = field(
        default_factory=lambda: [
            {"begin_time": 420, "end_time": 2910, "text": "Welcome to HitGO."},
            {"begin_time": 3000, "end_time": 5500, "text": "Let's get started."},
        ]
    )
    lang: str | None = "en"
    calls: list[tuple[Path, str | None]] = field(default_factory=list)

    def transcribe(self, wav: Path, lang: str | None) -> AsrResult:
        self.calls.append((wav, lang))
        return AsrResult(sentences=copy.deepcopy(self.sentences), lang=self.lang)


@dataclass
class FakeTranslate:
    """``[ko] text`` per line, numbering preserved; ``broken`` returns junk (fallback tests)."""

    broken: bool = False
    calls: list[str] = field(default_factory=list)

    def translate(self, text: str, source: str, target: str, terms: list[dict[str, str]]) -> str:
        self.calls.append(text)
        if self.broken and "\n" in text:
            return "번역 실패"
        lines = []
        for line in text.splitlines():
            m = _NUMBERED.match(line)
            if m:
                lines.append(f"{m.group(1)}. [{target}] {m.group(2)}")
            else:
                lines.append(f"[{target}] {line}")
        return "\n".join(lines)


@dataclass
class FakeTts:
    seconds: float = 1.0
    fail_voices: set[str] = field(default_factory=set)
    calls: list[tuple[str, str]] = field(default_factory=list)

    models: list[str | None] = field(default_factory=list)
    emotions: list[str | None] = field(default_factory=list)

    def synthesize(self, text: str, voice: str, speech_rate: float = 1.0, *, model: str | None = None, lang: str | None = None, emotion: str | None = None) -> bytes:
        self.calls.append((text, voice) if speech_rate == 1.0 else (text, voice, speech_rate))
        self.models.append(model)
        self.emotions.append(emotion)
        if voice in self.fail_voices:
            raise LocalizeError(f"音色 {voice} 合成失败")
        return silent_wav(self.seconds / speech_rate)


def fake_providers() -> Providers:
    return Providers(asr=FakeAsr(), mt=FakeTranslate(), tts=FakeTts(), highlight=RuleHighlight(), clone=FakeVoiceClone())


def make_providers(cfg: Settings | None = None) -> Providers:
    cfg = cfg or settings
    if cfg.localize_provider == "fake":
        return fake_providers()
    if cfg.localize_provider != "dashscope":
        raise LocalizeError(f"未知的 LOCALIZE_PROVIDER：{cfg.localize_provider}")
    if not cfg.dashscope_api_key:
        raise LocalizeError("没有配置 DASHSCOPE_API_KEY，无法调用百炼")
    from app.services import dashscope_providers  # noqa: PLC0415 - keeps the vendor SDK lazy

    return dashscope_providers.make_providers(cfg)


# ---------------------------------------------------------------------------
# job lifecycle
# ---------------------------------------------------------------------------


def _run(argv: list[str], what: str, timeout: int = 600) -> subprocess.CompletedProcess[bytes]:
    try:
        proc = subprocess.run(argv, capture_output=True, timeout=timeout, check=False)
    except FileNotFoundError as exc:
        raise LocalizeError(f"找不到 ffmpeg 可执行文件：{argv[0]}") from exc
    except subprocess.TimeoutExpired as exc:
        raise LocalizeError(f"{what}超时") from exc
    if proc.returncode != 0:
        tail = "\n".join((proc.stderr or b"").decode("utf-8", "replace").strip().splitlines()[-8:])
        raise LocalizeError(f"{what}失败（exit {proc.returncode}）：{tail}")
    return proc


def _save(
    db: Session,
    video: Video,
    loc: dict[str, Any],
    *,
    transcript: bool = False,
    langs: list[str] | tuple[str, ...] = (),
    stale_all: bool = False,
    clear_pending: bool = False,
    clone_voice: bool = False,
) -> None:
    """Write back only the parts this task owns (the transcript and / or the given versions).

    The API keeps accepting requests while a task runs — adding another language, deleting a
    finished version — so the row is re-read and merged rather than overwritten wholesale,
    otherwise a queued language could vanish under a running task.
    """
    db.refresh(video)
    fresh: dict[str, Any] = copy.deepcopy(video.localization or {})
    fresh.setdefault("versions", {})
    if transcript:
        fresh["transcript"] = copy.deepcopy(loc["transcript"])
        fresh["source_lang"] = loc.get("source_lang", fresh.get("source_lang"))
    if clone_voice:
        fresh["clone_voice"] = copy.deepcopy(loc.get("clone_voice"))
    if stale_all:
        for version in fresh["versions"].values():
            version["stale"] = True
    for lang in langs:
        if lang in loc["versions"]:
            fresh["versions"][lang] = copy.deepcopy(loc["versions"][lang])
    if clear_pending:
        fresh.pop("pending", None)
    video.localization = fresh  # a new object so the JSON column notices
    db.commit()


def _stamp(part: dict[str, Any], **fields: Any) -> dict[str, Any]:
    part.update(fields)
    part["updated_at"] = iso(utcnow())
    return part


def transcribe(video: Video, source_lang: str, asr: AsrProvider, tmp: Path) -> tuple[list[dict[str, Any]], str]:
    """Extract the audio and run ASR; returns (cues, source language actually used)."""
    if not video.has_audio:
        raise LocalizeError("源视频没有音轨")
    if video.duration and video.duration > settings.localize_max_seconds:
        raise LocalizeError(f"源视频 {video.duration:.0f} 秒，超过改语言上限 {settings.localize_max_seconds} 秒")
    source = storage.source_path(video.batch_id, video.id, video.source_ext)
    if not source.is_file():
        raise LocalizeError("源视频文件不存在")
    tmp.mkdir(parents=True, exist_ok=True)
    wav = tmp / "asr.wav"
    _run(extract_args(source, wav), "抽取源音轨")
    result = asr.transcribe(wav, None if source_lang == AUTO else source_lang)
    cues = cues_from_sentences(result.sentences, video.duration)
    if not cues:
        raise LocalizeError("没有识别出任何语句（源音轨可能没有人声）")
    lang = source_lang
    if lang == AUTO and result.lang in LANGS:
        lang = str(result.lang)
    return cues, lang


# ---------------------------------------------------------------------------
# voice cloning (HIG-58)
# ---------------------------------------------------------------------------


def clone_voice_id(loc: dict[str, Any] | None, cfg: Settings | None = None) -> str | None:
    """The reusable cloned voice of this video, or None when there is none to reuse.

    A clone is bound to the model it was created against, so one made for another model is
    not reusable and has to be redone.
    """
    cfg = cfg or settings
    clone = (loc or {}).get("clone_voice") or {}
    if clone.get("status") != LOC_DONE or not clone.get("voice_id"):
        return None
    if str(clone.get("model") or "") != cfg.localize_tts_model:
        return None
    return str(clone["voice_id"])


def _sample_source(db: Session, video: Video) -> tuple[Path, str, bool]:
    """Where to cut the cloning sample from: (path, ``clone_voice.sample.from``, mono pcm?).

    Prefers the separated vocals (HIG-58 asks for the cleanest speech available); falls back
    to the source video, which is all there is when separation was never run.
    """
    asset_id = ((video.separation or {}).get("vocals_asset_id")) if video.separation else None
    if asset_id:
        asset = db.get(Asset, str(asset_id))
        if asset is not None and asset.status == ASSET_READY:
            path = storage.asset_path(asset.id, asset.ext)
            if path.is_file():
                return path, SAMPLE_FROM_VOCALS, False
    source = storage.source_path(video.batch_id, video.id, video.source_ext)
    if not source.is_file():
        raise LocalizeError("源视频文件不存在")
    return source, SAMPLE_FROM_SOURCE, True


def sample_url(path: Path, cfg: Settings | None = None) -> str:
    """Absolute /media URL of the sample plus a read ticket, for the vendor to fetch."""
    cfg = cfg or settings
    rel = storage.media_url(path)[len(storage.MEDIA_PREFIX) + 1 :]
    url = cfg.public_base_url + storage.media_url(path)
    if not cfg.access_code:
        return url  # nothing gating /media; a ticket would be noise
    ticket = media_ticket.issue(rel, cfg.access_code, cfg.media_ticket_ttl_seconds)
    return f"{url}?{media_ticket.PARAM}={ticket}"


def ensure_clone_voice(db: Session, video: Video, loc: dict[str, Any], providers: Providers) -> str:
    """The cloned voice id for this video, creating it once and reusing it afterwards.

    Raises ``LocalizeError`` (with ``clone_voice`` left at ``failed``) when the sample cannot
    be produced or the vendor refuses it. The caller fails the versions that wanted it.
    """
    existing = clone_voice_id(loc)
    if existing:
        return existing

    clone: dict[str, Any] = {"voice_id": None, "model": settings.localize_tts_model, "sample": None}
    loc["clone_voice"] = clone
    _stamp(clone, status=LOC_RUNNING, error=None)
    _save(db, video, loc, clone_voice=True)

    try:
        cues = (loc.get("transcript") or {}).get("cues") or []
        window = plan_voice_sample(cues)
        if window is None:
            raise LocalizeError(
                f"可用于复刻的连续人声不足 {CLONE_SAMPLE_MIN_SECONDS:.0f} 秒，"
                "请换一条口播更连贯的视频，或关掉「用原声配音」"
            )
        src, origin, mono_pcm = _sample_source(db, video)
        dst = storage.voice_sample_path(video.id, "wav" if mono_pcm else VOICE_EXT)
        dst.parent.mkdir(parents=True, exist_ok=True)
        storage.remove_file(dst)
        _run(sample_args(src, dst, window["start"], window["seconds"], mono_pcm=mono_pcm), "截取复刻样本")
        if not dst.is_file() or dst.stat().st_size == 0:
            raise LocalizeError("截取复刻样本失败：没有生成音频")
        clone["sample"] = {"from": origin, **window}
        voice_id = providers.clone.create(sample_url(dst), settings.localize_tts_model)
        if not voice_id:
            raise LocalizeError("复刻接口没有返回音色 id")
    except SoftTimeLimitExceeded:
        raise
    except Exception as exc:  # noqa: BLE001 - lands in clone_voice.error and fails the versions
        log.exception("voice cloning for %s failed", video.id)
        _stamp(clone, status=LOC_FAILED, error=str(exc)[:4000])
        _save(db, video, loc, clone_voice=True)
        raise LocalizeError(f"音色复刻失败：{exc}") from exc

    _stamp(clone, status=LOC_DONE, error=None, voice_id=str(voice_id))
    _save(db, video, loc, clone_voice=True)
    return str(voice_id)


def transcript_status(loc: dict[str, Any]) -> str | None:
    return (loc.get("transcript") or {}).get("status")


def _fail_versions(loc: dict[str, Any], langs: list[str], error: str) -> None:
    for lang in langs:
        version = loc["versions"].get(lang)
        if version is not None and version.get("status") in (LOC_QUEUED, LOC_RUNNING):
            _stamp(version, status=LOC_FAILED, stage=None, error=error)


def _build_version(db: Session, video: Video, loc: dict[str, Any], lang: str, providers: Providers, tmp: Path) -> None:
    """translate → tts → mix for one language; raises on failure (caller records it)."""
    version = loc["versions"][lang]
    transcript = loc["transcript"]
    cues = transcript.get("cues") or []
    source_lang = str(loc.get("source_lang") or AUTO)
    terms = list(version.get("terms") or [])
    fresh_translation = not (version.get("stage") == STAGE_TTS and version.get("cues"))
    adaptive_candidate = callable(getattr(providers.mt, "localize_for_speech", None))
    warnings: list[str] = []

    if fresh_translation:
        version["old_cue_asset_ids"] = list(dict.fromkeys([
            *(version.get("old_cue_asset_ids") or []),
            *(str(c["voice_asset_id"]) for c in version.get("cues") or [] if c.get("voice_asset_id")),
        ]))
        _stamp(version, status=LOC_RUNNING, stage=STAGE_TRANSLATE, error=None)
        _save(db, video, loc, langs=[lang])
        translated = translate_with_fallback(providers.mt, [c["text"] for c in cues], mt_name(source_lang), mt_name(lang), terms)
        translated, rewrite_warning = localize_for_speech(
            providers.mt,
            [str(c["text"]) for c in cues],
            translated,
            mt_name(lang),
            terms,
            [max(0.1, float(c["end"]) - float(c["start"])) for c in cues],
        )
        if rewrite_warning:
            warnings.append(rewrite_warning)
        # Rebuilt from scratch, so any dub_start / dub_duration from the previous mix is gone with it (HIG-36).
        version["cues"] = [{"i": c["i"], "translated": t} for c, t in zip(cues, translated, strict=True)]
        if version.get("dub") is False:
            # Translate only (HIG-56): an older voice-over no longer matches the text, but stays until re-dubbed.
            _stamp(
                version, status=LOC_DONE, stage=None, error=None, warnings=warnings, stale=False,
                voice_stale=bool(version.get("voice_asset_id")), adaptive_timing=False, timeline_duration=None,
            )
            _save(db, video, loc, langs=[lang])
            return

    _stamp(version, status=LOC_RUNNING, stage=STAGE_TTS, error=None)
    _save(db, video, loc, langs=[lang])
    translated_by_i = {int(c["i"]): str(c.get("translated") or "").strip() for c in version["cues"]}
    if version.get("source_voice"):
        # The clone is not in the voice table; it belongs to the configured TTS model (HIG-58).
        voice = str(clone_voice_id(loc) or "")
        model = settings.localize_tts_model
        emotion: str | None = None
        if not voice:
            raise LocalizeError("音色复刻还没有完成，无法用原声合成")
    else:
        spec = voice_spec(lang, str(version.get("voice") or resolve_voice(lang, None)))
        voice, model, emotion = str(spec["voice"]), str(spec["model"]), spec["emotion"]
    spoken: list[dict[str, Any]] = []
    clip_paths: list[Path] = []
    clip_durations: list[float] = []
    tmp.mkdir(parents=True, exist_ok=True)
    def synthesize_checked(path: Path, text: str, speech_rate: float = 1.0) -> float:
        # The fake provider intentionally emits silence in tests and local demos.
        # Production providers may return a valid WAV header and duration but no speech.
        for attempt in range(2):
            path.write_bytes(providers.tts.synthesize(text, voice, speech_rate, model=model, lang=lang, emotion=emotion))
            seconds = wav_duration(path)
            if seconds > 0.05 and (isinstance(providers.tts, FakeTts) or wav_has_signal(path)):
                return seconds
            if attempt == 0:
                log.warning("TTS returned silent audio for %s cue; retrying once", lang)
        raise LocalizeError(f"{lang}口播合成返回无声音频；未替换已有配音，请重试或更换音色")

    total = float(video.duration or max(float(c["end"]) for c in cues))
    for cue in cues:
        text = translated_by_i.get(int(cue["i"]), "")
        if not text:
            continue
        clip = tmp / f"{lang}_{int(cue['i']):04d}.wav"
        seconds = synthesize_checked(clip, text)
        # Keep the natural TTS take; all providers now adapt the picture after
        # measuring it, instead of forcing voice speed or mixing adjacent lines.
        spoken.append(cue)
        clip_paths.append(clip)
        clip_durations.append(seconds)
    if not spoken:
        raise LocalizeError("没有可合成的译文")

    # The first script pass only estimated duration from the source cue. Give outliers one bounded
    # rewrite using the measured voice result, then synthesize those cues once more.
    if fresh_translation and adaptive_candidate:
        retry_indexes = [
            k for k, (cue, seconds) in enumerate(zip(spoken, clip_durations, strict=True))
            if (float(cue["end"]) - float(cue["start"])) / max(seconds, 0.01)
            < ADAPTIVE_VIDEO_SPEED_MIN - 1e-6
            or (float(cue["end"]) - float(cue["start"])) / max(seconds, 0.01)
            > ADAPTIVE_VIDEO_SPEED_MAX + 1e-6
        ]
        if retry_indexes:
            current = [str(version["cues"][int(spoken[k]["i"])]["translated"]) for k in retry_indexes]
            rewritten, retry_warning = localize_for_speech(
                providers.mt,
                [str(spoken[k]["text"]) for k in retry_indexes],
                current,
                mt_name(lang),
                terms,
                [max(0.1, float(spoken[k]["end"]) - float(spoken[k]["start"])) for k in retry_indexes],
            )
            if retry_warning:
                warnings.append(retry_warning)
            else:
                for k, text in zip(retry_indexes, rewritten, strict=True):
                    cue_i = int(spoken[k]["i"])
                    version["cues"][cue_i]["translated"] = text
                    clip_durations[k] = synthesize_checked(clip_paths[k], text)

    _stamp(version, stage=STAGE_MIX)
    _save(db, video, loc, langs=[lang])
    placements, mix_total, adaptive_warnings = plan_complete_placements(spoken, clip_durations, total)
    warnings.extend(adaptive_warnings)
    adaptive = True
    asset_id = ids.asset_id()
    dst = storage.asset_path(asset_id, VOICE_EXT)
    dst.parent.mkdir(parents=True, exist_ok=True)
    clips = [(path, p["start"], p["tempo"]) for path, p in zip(clip_paths, placements, strict=True)]
    try:
        _run(mix_args(clips, mix_total, dst, normalize_loudness=True), "混音")
        if not isinstance(providers.tts, FakeTts) and not mixed_voice_has_signal(dst):
            raise LocalizeError(f"{lang}口播混音结果无声；未替换已有配音，请重试")
    except Exception:
        storage.remove_file(dst)
        raise

    # Preserve each original TTS WAV as an independent editable asset. Legacy versions
    # keep using the combined m4a; a newly applied version uses these cue assets only.
    cue_assets: list[Asset] = []
    cue_paths: list[Path] = []
    try:
        for cue, clip_path, seconds, placement in zip(spoken, clip_paths, clip_durations, placements, strict=True):
            cue_asset_id = ids.asset_id()
            cue_dst = storage.asset_path(cue_asset_id, "wav")
            cue_dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(clip_path, cue_dst)
            cue_paths.append(cue_dst)
            placement["voice_asset_id"] = cue_asset_id
            cue_assets.append(Asset(
                id=cue_asset_id, type=ASSET_AUDIO, kind=ASSET_AUDIO, status=ASSET_READY,
                name=f"{Path(video.name).stem} · {LANGS.get(lang, {}).get('label', lang)}口播第{int(cue['i']) + 1}句.wav",
                ext="wav", source=ASSET_SOURCE_DERIVED, duration=seconds, has_audio=True,
                derived_from={"video_id": video.id, "video_name": video.name, "stem": "dubbed_cue", "lang": lang, "cue": cue["i"]},
            ))
    except Exception:
        for path in cue_paths:
            storage.remove_file(path)
        storage.remove_file(dst)
        raise

    # Replace last time's dubbed asset (contract §1); tracks still pointing at it get a warning.
    for old_id in previous_voice_asset_ids(loc, [lang]):
        old = db.get(Asset, old_id)
        if old is not None:
            storage.remove_file(storage.asset_path(old.id, old.ext))
            db.delete(old)
    db.add(
        Asset(
            id=asset_id,
            type=ASSET_AUDIO,
            kind=ASSET_AUDIO,
            status=ASSET_READY,
            name=voice_name(video.name, lang),
            ext=VOICE_EXT,
            source=ASSET_SOURCE_DERIVED,
            duration=mix_total,
            has_audio=True,
            derived_from={
                "video_id": video.id, "video_name": video.name, "stem": STEM_DUBBED, "lang": lang,
                **({"adaptive_timing": True} if adaptive else {}),
            },
        )
    )
    db.add_all(cue_assets)
    # Where each line's voice-over actually landed, so the editor can time split subtitles by it (HIG-36).
    version["cues"] = with_placements(version["cues"], placements)
    version.pop("old_cue_asset_ids", None)
    _stamp(
        version,
        status=LOC_DONE, stage=None, error=None, warnings=warnings, stale=False,
        voice=voice, voice_asset_id=asset_id, dub=True, voice_stale=False,
        source_voice=bool(version.get("source_voice")),
        adaptive_timing=adaptive, timeline_duration=mix_total if adaptive else None,
    )  # fmt: skip
    _save(db, video, loc, langs=[lang])


def run_localization(db: Session, video_id: str, providers: Providers | None = None) -> None:
    """Full lifecycle for what ``localization.pending`` asks: transcript if needed, then each language.

    Every version ends done or failed on its own; the transcript failing fails all of them.
    ``pending.transcribe_only`` (HIG-84 自动识别字幕) stops after the transcript.
    A Celery soft time limit fails whatever is still running / queued with a readable reason.
    """
    video = db.get(Video, video_id)
    if video is None or not video.localization:
        return  # deleted (or never requested) while queued
    loc = copy.deepcopy(video.localization)
    loc.setdefault("versions", {})
    loc.setdefault("transcript", {"status": LOC_QUEUED, "error": None, "cues": []})
    pending = dict(loc.get("pending") or {})
    # Every queued version is ours: a task queued behind this one finds nothing left to do.
    langs = [lang for lang, v in loc["versions"].items() if lang in LANGS and (v or {}).get("status") == LOC_QUEUED]
    if pending.get("transcribe_only"):
        langs = []  # HIG-84: ASR only; versions keep whatever state they are in (just marked stale)
    retranscribe = bool(pending.get("retranscribe"))
    needs_transcript = retranscribe or transcript_status(loc) != LOC_DONE
    tmp = storage.localize_tmp_dir(video_id)
    transcript = loc["transcript"]
    try:
        try:
            providers = providers or make_providers(settings)
        except Exception as exc:  # noqa: BLE001 - misconfiguration / missing SDK is a job failure
            log.exception("localization of %s could not start", video_id)
            message = str(exc)[:4000]
            if needs_transcript:
                _stamp(transcript, status=LOC_FAILED, error=message)
            _fail_versions(loc, langs, message)
            _save(db, video, loc, transcript=needs_transcript, langs=langs, clear_pending=True)
            return

        if needs_transcript:
            _stamp(transcript, status=LOC_RUNNING, error=None)
            _save(db, video, loc, transcript=True)
            try:
                cues, source_lang = transcribe(video, str(loc.get("source_lang") or AUTO), providers.asr, tmp)
            except SoftTimeLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001 - lands in transcript.error
                log.exception("transcription of %s failed", video_id)
                message = f"听写失败：{str(exc)[:4000]}"
                _stamp(transcript, status=LOC_FAILED, error=message)
                _fail_versions(loc, langs, message)
                _save(db, video, loc, transcript=True, langs=langs, clear_pending=True)
                return
            _stamp(transcript, status=LOC_DONE, error=None, cues=cues)
            loc["source_lang"] = source_lang
            for version in loc["versions"].values():  # every translation came from the old template
                version["stale"] = True
            _save(db, video, loc, transcript=True, stale_all=True, clear_pending=True)

        # One clone for the whole video, before any language needs it (HIG-58). Failing it
        # fails only the versions that asked for the original voice; the rest carry on.
        clone_langs = [lang for lang in langs if (loc["versions"].get(lang) or {}).get("source_voice")]
        if clone_langs and clone_voice_id(loc) is None:
            try:
                ensure_clone_voice(db, video, loc, providers)
            except SoftTimeLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001 - lands on the versions that wanted it
                db.rollback()
                _fail_versions(loc, clone_langs, str(exc)[:4000])
                _save(db, video, loc, langs=clone_langs)
                langs = [lang for lang in langs if lang not in clone_langs]

        for lang in langs:
            try:
                _build_version(db, video, loc, lang, providers, tmp)
            except SoftTimeLimitExceeded:
                raise
            except Exception as exc:  # noqa: BLE001 - one language failing must not stop the others
                log.exception("localization of %s to %s failed", video_id, lang)
                db.rollback()
                _stamp(loc["versions"][lang], status=LOC_FAILED, stage=None, error=str(exc)[:4000])
                _save(db, video, loc, langs=[lang])
    except SoftTimeLimitExceeded:
        log.warning("localization of %s hit the soft time limit", video_id)
        db.rollback()
        message = f"改语言超过 {settings.localize_timeout_seconds} 秒仍未完成，已中止"
        timed_out_transcript = transcript.get("status") in (LOC_QUEUED, LOC_RUNNING)
        if timed_out_transcript:
            _stamp(transcript, status=LOC_FAILED, error=message)
        _fail_versions(loc, langs, message)
        _save(db, video, loc, transcript=timed_out_transcript, langs=langs, clear_pending=True)
    finally:
        storage.remove_tree(tmp)
