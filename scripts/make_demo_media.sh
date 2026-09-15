#!/usr/bin/env bash
# Generate placeholder demo media with ffmpeg: 8 vertical 1080x1920 clips with a
# scene label + running timer + tone, and 4 sticker PNGs. Used to exercise the
# prototype before real creatives are available.
#
# Usage: make_demo_media.sh <out_dir>
set -euo pipefail

out="${1:?usage: make_demo_media.sh <out_dir>}"
mkdir -p "$out"
cd "$out"

# scene list: "<seconds> <label> <seed>"
scenes=(
  "12 Onboarding_A 0"
  "15 Onboarding_B 1"
  "18 Character_Show 2"
  "20 Battle_Cut 3"
  "22 Bonus_Teaser 4"
  "25 Player_Review 5"
  "14 Story_Clip 6"
  "16 Download_Guide 7"
)

i=0
for spec in "${scenes[@]}"; do
  read -r secs label seed <<<"$spec"
  i=$((i + 1))
  n=$(printf "V%02d" "$i")
  f="${n}_${label}.mp4"
  if [ -f "$f" ]; then echo "skip $f"; continue; fi
  ffmpeg -nostdin -v error -y \
    -f lavfi -i "gradients=size=1080x1920:rate=30:speed=0.03:seed=${seed}:duration=${secs}" \
    -f lavfi -i "sine=frequency=$((330 + seed * 40)):sample_rate=44100:duration=${secs}" \
    -vf "drawtext=text='${n} ${label//_/ }':fontsize=64:fontcolor=white:borderw=3:bordercolor=black:x=(w-tw)/2:y=h*0.42,\
drawtext=text='%{pts\:hms}':fontsize=72:fontcolor=white:borderw=3:bordercolor=black:x=(w-tw)/2:y=h*0.52,\
drawtext=text='DEMO SOURCE':fontsize=40:fontcolor=white@0.6:x=(w-tw)/2:y=h*0.9" \
    -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
    -c:a aac -b:a 96k -shortest -movflags +faststart "$f"
  echo "made $f"
done

# sticker <name> <bg color> <size> <text> <fontsize> <text color>
sticker() {
  ffmpeg -nostdin -v error -y -f lavfi -i "color=c=$2:s=$3,format=rgba" \
    -vf "drawtext=text='$4':expansion=none:fontsize=$5:fontcolor=$6:x=(w-tw)/2:y=(h-th)/2" \
    -frames:v 1 "$1.png"
  echo "made $1.png"
}
sticker sticker_limited_free 0xE5342B 440x150 "LIMITED FREE" 60 white
sticker sticker_half_off     0xFFC300 360x150 "-50%"         84 black
sticker sticker_download_now 0x1E6FE8 520x150 "DOWNLOAD NOW" 56 white
sticker sticker_new          0xFFFFFF 200x120 "NEW"          64 0x1a1d23

# Animated sticker with a real alpha channel (VP9/yuva420p): a pulsing ring on a
# transparent background. Exercises the video-sticker path end to end.
if [ ! -f sticker_pulse.webm ]; then
  # An opaque box overlaid on a transparent canvas. Note drawbox/drawtext are NOT
  # usable here: they write RGB but leave the alpha channel at 0, so the whole
  # frame would decode as fully transparent.
  ffmpeg -nostdin -v error -y \
    -f lavfi -i "color=c=0x00000000:s=320x320:r=25:d=2,format=rgba" \
    -f lavfi -i "color=c=0xFFC300:s=140x140:r=25:d=2,format=rgba" \
    -filter_complex "[0:v][1:v]overlay=x='90+60*sin(2*PI*t)':y=90:format=auto[v]" \
    -map "[v]" -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 -b:v 800k sticker_pulse.webm
  echo "made sticker_pulse.webm"
else
  echo "skip sticker_pulse.webm"
fi

ls -la
