#!/usr/bin/env python3
"""Generate the tiny placeholder audio clips in samples/audio/.

They exist so a fresh environment has something in the editor's 音频 tab and so
scripts/smoke_render.py can exercise the BGM mix. Synthesised with ffmpeg's lavfi
sources only — no downloaded music, no licensing questions, a few tens of KB each.
Re-run after editing CLIPS; the output is deterministic.

    python scripts/gen_sample_audio.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "samples" / "audio"

# A soft C-major arpeggio (C4 E4 G4 C5) at 120 BPM with a percussive envelope, plus a
# low kick on every beat. Loops cleanly at 8 s (exactly 16 beats).
_ARPEGGIO = (
    "sin(2*PI*t*(261.63*eq(mod(floor(t*4),4),0)"
    "+329.63*eq(mod(floor(t*4),4),1)"
    "+392.00*eq(mod(floor(t*4),4),2)"
    "+523.25*eq(mod(floor(t*4),4),3)))"
    "*exp(-6*mod(t,0.25))*0.35"
)
_KICK = "sin(2*PI*t*55)*exp(-18*mod(t,0.5))*0.5"

# name -> (duration seconds, aevalsrc expression, bitrate)
CLIPS = {
    "bgm-arpeggio-loop.mp3": (8, f"{_ARPEGGIO}+{_KICK}", "96k"),
}


def main() -> int:
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        print("ffmpeg not found on PATH", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (seconds, expr, bitrate) in CLIPS.items():
        dst = OUT / name
        subprocess.run(
            [ffmpeg, "-hide_banner", "-loglevel", "error", "-y",
             "-f", "lavfi", "-i", f"aevalsrc=exprs='{expr}':s=44100:d={seconds}",
             "-ac", "1", "-c:a", "libmp3lame", "-b:a", bitrate,
             "-metadata", "title=HitGO sample BGM", str(dst)],
            check=True,
        )  # fmt: skip
        print(f"{dst.relative_to(OUT.parent.parent)}  {dst.stat().st_size // 1024} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
