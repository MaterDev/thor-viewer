#!/usr/bin/env bash
# Build a timestamped contact sheet (frame grid, read left to right) from a video.
# usage: sheet.sh <in.mp4> <out.png> [fps=3] [cols=3] [width=340] [crop=w:h:x:y]
set -euo pipefail
in=${1:?usage: sheet.sh <in.mp4> <out.png> [fps] [cols] [width] [crop=w:h:x:y]}
out=${2:?missing <out.png>}
fps=${3:-2}
cols=${4:-2}
width=${5:-416}
crop=${6:-}
dur=$(ffprobe -v error -show_entries format=duration -of default=nk=1:nw=1 "$in")
n=$(awk -v d="$dur" -v f="$fps" 'BEGIN { print int(d * f + 0.5) }')
[ "$n" -lt 1 ] && n=1
rows=$(( (n + cols - 1) / cols ))
vf="fps=$fps"
[ -n "$crop" ] && vf="$vf,crop=$crop"
vf="$vf,scale=$width:-2,drawtext=text='%{pts\:hms}':x=4:y=4:fontsize=12:fontcolor=yellow:box=1:boxcolor=black@0.5,tile=${cols}x${rows}"
ffmpeg -v error -y -i "$in" -vf "$vf" -frames:v 1 "$out"
echo "$out ($n frames, ${cols}x${rows})"
