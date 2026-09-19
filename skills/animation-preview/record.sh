#!/usr/bin/env bash
# Record the page open in the agent-browser `thor` session to a temp video (no reload).
# usage: record.sh <out.mp4> [seconds=8] [fps=12]
set -euo pipefail
out=${1:?usage: record.sh <out.mp4> [seconds=8] [fps=12]}
secs=${2:-8}
fps=${3:-12}
mkdir -p "$(dirname "$out")"
agent-browser record start "$out" --fps "$fps" >/dev/null
agent-browser wait "$((secs * 1000))" >/dev/null || true
agent-browser record stop >/dev/null
ffprobe -v error -show_entries format=duration:stream=width,height,nb_frames -of compact=p=0:nk=0 "$out"
echo "$out"
