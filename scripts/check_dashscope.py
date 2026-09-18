#!/usr/bin/env python3
"""自检百炼（DashScope）三个接口是否打通：TTS → ASR → 翻译，不需要任何素材。

用法（本机或服务器都行，key 从环境变量或参数来）：

    cd backend && DASHSCOPE_API_KEY=sk-xxx uv run python ../scripts/check_dashscope.py
    cd backend && uv run python ../scripts/check_dashscope.py --key sk-xxx --target ko

流程：用 cosyvoice 把一句英文合成 wav → 用 paraformer 把这段 wav 听写回来 → 用 qwen-mt 翻成目标语言。
每步打印耗时和结果；哪一步失败就打印百炼返回的原因（通常是 key 无效、模型没开通、余额不足）。
模型名默认与 .env.example 一致，可用 --asr / --mt / --tts 覆盖。
西 / 葡 / 法 / 德 / 意 / 俄走 Qwen3-TTS（音色 Cherry / Serena / Ethan）；泰 / 越 / 阿走百炼托管的 MiniMax
（HIG-59，音色表里已有默认音色）。要逐个核对 MiniMax 的 voice_id 是否可用，用 check_minimax_voices.py。
试一个表外的音色 / 模型组合：
    ... check_dashscope.py --target ko --voice loongjihun_v3 --tts-model cosyvoice-v3-flash
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.services import localize  # noqa: E402
from app.services.dashscope_providers import DashScopeAsr, DashScopeTranslate, DashScopeTts  # noqa: E402

SENTENCE = "Welcome to HitGO, the fastest way to localize your ads."


def step(name: str):
    print(f"\n== {name}")
    return time.perf_counter()


def done(t0: float, detail: str) -> None:
    print(f"   ok ({time.perf_counter() - t0:.1f}s): {detail}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--key", default=os.environ.get("DASHSCOPE_API_KEY", ""), help="百炼 API-KEY（缺省读 DASHSCOPE_API_KEY）")
    ap.add_argument("--target", default="ko", choices=sorted(localize.LANGS), help="翻译 / 合成的目标语言")
    ap.add_argument("--voice", default=None, help="目标语言的音色 id（缺省取该语言默认音色；没有默认音色的语言必须给）")
    ap.add_argument("--tts-model", default=None, help="该音色所属的 TTS 模型（缺省按音色表 / LOCALIZE_TTS_MODEL）")
    ap.add_argument("--keep", default=None, metavar="DIR", help="把合成出来的 wav 留在这个目录里，方便用耳朵听")
    ap.add_argument("--asr", default=os.environ.get("LOCALIZE_ASR_MODEL", "paraformer-realtime-v2"))
    ap.add_argument("--mt", default=os.environ.get("LOCALIZE_MT_MODEL", "qwen-mt-plus"))
    ap.add_argument("--tts", default=os.environ.get("LOCALIZE_TTS_MODEL", "cosyvoice-v3-flash"))
    args = ap.parse_args()
    if not args.key:
        print("没有 key：设置 DASHSCOPE_API_KEY 或传 --key", file=sys.stderr)
        return 2

    tts = DashScopeTts(api_key=args.key, model=args.tts)
    asr = DashScopeAsr(api_key=args.key, model=args.asr)
    mt = DashScopeTranslate(api_key=args.key, model=args.mt)
    table = localize.voice_table()
    en_voice = table["en"][0]["id"]
    if args.voice:
        target_voice = args.voice
    elif table.get(args.target):
        target_voice = table[args.target][0]["id"]
    else:
        print(f"{localize.LANGS[args.target]['label']} 还没有默认音色：用 --voice <id> --tts-model <model> 指定一个试", file=sys.stderr)
        return 2
    target_model = args.tts_model or localize.voice_model(args.target, target_voice, table)
    failed = False

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp = args.keep or tmpdir
        Path(tmp).mkdir(parents=True, exist_ok=True)
        wav = Path(tmp) / "en.wav"
        try:
            t0 = step(f"TTS {args.tts} · 音色 {en_voice}（英文）")
            wav.write_bytes(tts.synthesize(SENTENCE, en_voice))
            done(t0, f"{wav.stat().st_size} 字节，{localize.wav_duration(wav):.1f} 秒")
        except Exception as exc:  # noqa: BLE001
            print(f"   失败：{exc}")
            return 1

        try:
            t0 = step(f"ASR {args.asr}（language_hints=en）")
            result = asr.transcribe(wav, "en")
            text = " ".join(str(s.get("text", "")) for s in result.sentences).strip()
            cues = localize.cues_from_sentences(result.sentences, None)
            done(t0, f"{len(cues)} 句，识别语言={result.lang or '未报'}：{text!r}")
        except Exception as exc:  # noqa: BLE001
            print(f"   失败：{exc}")
            failed = True
            text = SENTENCE

        try:
            t0 = step(f"翻译 {args.mt}（English → {localize.mt_name(args.target)}，术语 HitGO 不翻）")
            translated = mt.translate(text, "English", localize.mt_name(args.target), [{"source": "HitGO", "target": "HitGO"}])
            done(t0, translated.strip())
        except Exception as exc:  # noqa: BLE001
            print(f"   失败：{exc}")
            failed = True
            translated = ""

        if translated:
            try:
                t0 = step(f"TTS {target_model} · 音色 {target_voice}（{localize.LANGS[args.target]['label']}）")
                out = Path(tmp) / f"{args.target}.wav"
                out.write_bytes(tts.synthesize(translated.strip(), target_voice, model=target_model, lang=args.target))
                seconds = localize.wav_duration(out)
                done(t0, f"{out.stat().st_size} 字节，{seconds:.1f} 秒（英文原句 {localize.wav_duration(wav):.1f} 秒）")
                rate = localize.speech_rate_for(seconds, localize.wav_duration(wav)) if localize.supports_speech_rate(target_model) else 1.0
                if rate > 1.0:
                    t0 = step(f"TTS 加速重合成 speech_rate={rate}（塞进英文原句的时长）")
                    out.write_bytes(tts.synthesize(translated.strip(), target_voice, rate, model=target_model, lang=args.target))
                    done(t0, f"{localize.wav_duration(out):.1f} 秒")
            except Exception as exc:  # noqa: BLE001
                print(f"   失败：{exc}")
                failed = True

    if args.keep:
        print(f"\nwav 已留在 {Path(args.keep).resolve()}：en.wav / {args.target}.wav")
    print("\n" + ("有步骤失败，按上面的原因处理（key / 模型开通 / 余额）。" if failed else "三个接口全部打通，可以把 key 写进服务器 .env。"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
