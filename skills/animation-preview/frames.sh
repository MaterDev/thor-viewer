#!/usr/bin/env bash
# Extract individual frames from a video as PNGs.
# usage: frames.sh <in.mp4> <outdir> [fps=2] [width=640]
set -euo pipefail
in=${1:?usage: frames.sh <in.mp4> <outdir> [fps=2] [width=640]}
dir=${2:?missing <outdir>}
fps=${3:-2}
width=${4:-640}
mkdir -p "$dir"
ffmpeg -v error -y -i "$in" -vf "fps=$fps,scale=$width:-2" "$dir/frame_%03d.png"
ls "$dir"/frame_*.png | wc -l | xargs echo "frames in $dir:"
