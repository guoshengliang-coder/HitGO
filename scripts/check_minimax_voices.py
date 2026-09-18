#!/usr/bin/env python3
"""逐个真调 MINIMAX_VOICES 里的每个 voice_id，产出「哪些在百炼路径上可用」的清单（HIG-59）。

百炼的 MiniMax 文档只举了 `male-qn-qingse` 一个 voice_id 示例，既不列清单也不指向 MiniMax 自己的
系统音色页，所以官方那批 id 能不能在百炼这条路径上用，只有真调一次才知道。这是 HIG-59 验收里
「服务器一次性容器对每个 MiniMax voice_id 真调一次全部成功」那一条的执行工具。

用法（本机没有 key，实际在原型服务器的一次性容器里跑）：

    cd backend && DASHSCOPE_API_KEY=sk-xxx uv run python ../scripts/check_minimax_voices.py
    cd backend && uv run python ../scripts/check_minimax_voices.py --key sk-xxx --lang th --lang ar
    cd backend && uv run python ../scripts/check_minimax_voices.py --model MiniMax/speech-2.8-turbo --keep /tmp/mm

每条音色用该语言线上试听的那句话合成一次，逐行打印 OK / FAIL；结尾给出三段汇总：可用清单、
一段可以直接粘回 MINIMAX_VOICES 的骨架、以及失败清单与百炼原样返回的原因。判断失败属于哪一类
要看那个原因：`invalid voice_id` 是这个 id 不可用，`Model not exist` / 无权限是整个模型没开通
（与 id 无关），限流 / 余额则是重试或充值的事。只读，除了 --keep 指定的目录不写任何文件。
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "backend"))

from app.config import settings  # noqa: E402
from app.services import localize, tts  # noqa: E402
from app.services.dashscope_providers import DashScopeTts  # noqa: E402


def _args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description="逐个真调百炼上的 MiniMax 系统音色")
    p.add_argument("--key", default=os.environ.get("DASHSCOPE_API_KEY", ""), help="缺省读 DASHSCOPE_API_KEY")
    p.add_argument("--lang", action="append", dest="langs", metavar="CODE", help="只测这些语言（可重复），缺省全部")
    p.add_argument("--model", action="append", dest="models", metavar="NAME", help="要测的模型（可重复），缺省 MINIMAX_TTS_MODEL")
    p.add_argument("--id", action="append", dest="ids", metavar="VOICE_ID", help="只测这些 voice_id（可重复），可以是表外的候选")
    p.add_argument("--text", default="", help="覆盖合成文本，缺省用该语言线上试听的那句")
    p.add_argument("--keep", metavar="DIR", help="把合成的 wav 留在这个目录，供人耳确认后填 style")
    p.add_argument("--sleep", type=float, default=0.5, help="每次调用之间的间隔秒数，缺省 0.5")
    p.add_argument("--dry-run", action="store_true", help="只打印将要测什么，不调用")
    return p.parse_args()


def _targets(args: argparse.Namespace) -> list[tuple[str, str, str | None, str]]:
    """``(lang, vendor_voice_id, emotion, label)``，每个厂商音色只测一次（情绪版不重复调）。"""
    out: list[tuple[str, str, str | None, str]] = []
    seen: set[tuple[str, str]] = set()
    for lang, voices in localize.MINIMAX_VOICES.items():
        if args.langs and lang not in args.langs:
            continue
        for v in voices:
            voice = v.get("voice") or v["id"]
            if args.ids and voice not in args.ids:
                continue
            if (lang, voice) in seen:
                continue
            seen.add((lang, voice))
            out.append((lang, voice, v.get("emotion"), v["label"]))
    for voice in args.ids or []:
        lang = (args.langs or ["zh"])[0]
        if (lang, voice) not in seen:
            out.append((lang, voice, None, voice))
    return out


def main() -> int:
    args = _args()
    models = args.models or [settings.minimax_tts_model or "MiniMax/speech-2.8-hd"]
    targets = _targets(args)
    keep = Path(args.keep).expanduser() if args.keep else None
    if keep:
        keep.mkdir(parents=True, exist_ok=True)

    print(f"模型：{', '.join(models)}")
    print(f"音色：{len(targets)} 个，覆盖 {len(dict.fromkeys(t[0] for t in targets))} 种语言")
    if args.dry_run:
        for lang, voice, emotion, label in targets:
            print(f"  {lang}\t{voice}\t{emotion or '-'}\t{label}")
        return 0
    if not args.key:
        print("没有 DASHSCOPE_API_KEY：用 --key 或环境变量传进来", file=sys.stderr)
        return 2

    ok: dict[str, list[tuple[str, str]]] = {}
    failed: list[tuple[str, str, str, str]] = []
    for model in models:
        client = DashScopeTts(api_key=args.key, model=model)
        for lang, voice, emotion, label in targets:
            text = args.text or tts.preview_text(lang)
            started = time.monotonic()
            try:
                data = client.synthesize(text, voice, 1.0, model=model, lang=lang, emotion=emotion)
            except Exception as exc:  # noqa: BLE001 - every failure is a row in the report
                took = time.monotonic() - started
                print(f"{lang}\t{model}\t{voice}\tFAIL\t{took:.1f}s\t{exc}")
                failed.append((lang, model, voice, str(exc)))
            else:
                took = time.monotonic() - started
                shape = "wav" if data.startswith(b"RIFF") else f"NOT-WAV {data[:4]!r}"
                print(f"{lang}\t{model}\t{voice}\tOK\t{took:.1f}s\t{len(data) // 1024} KB\t{shape}")
                ok.setdefault(lang, []).append((voice, label))
                if keep:
                    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in f"{lang}-{model.split('/')[-1]}-{voice}")
                    (keep / f"{safe}.wav").write_bytes(data)
            time.sleep(args.sleep)

    print("\n=== 可用 ===")
    for lang, voices in ok.items():
        print(f"{lang}（{len(voices)}）: " + ", ".join(v for v, _ in voices))

    print("\n=== 可粘回 MINIMAX_VOICES 的骨架（label / gender / style 待人填）===")
    for lang, voices in ok.items():
        print(f'    "{lang}": [')
        for voice, label in voices:
            print(f'        _mv("{voice}", "{label}", "TODO-gender", "TODO-style"),')
        print("    ],")

    print("\n=== 失败 ===")
    if not failed:
        print("（无）")
    for lang, model, voice, why in failed:
        print(f"{lang}\t{model}\t{voice}\t{why}")

    missing = [lang for lang in dict.fromkeys(t[0] for t in targets) if lang not in ok]
    if missing:
        print(f"\n这些语言一个音色都没成功：{', '.join(missing)}", file=sys.stderr)
    return 1 if missing or failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
