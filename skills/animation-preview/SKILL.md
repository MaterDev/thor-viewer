---
name: animation-preview
description: Record a short temp video of what the Thor Viewer is showing (the agent-browser `thor` session), extract frames, and build timestamped contact sheets (frame grids) so Claude can analyze motion and the user can review it purely in chat. Use when the user asks for a clip, video, frames, strips, grid or contact sheet of an animation running in the viewer, or after changing an animated page viewed through it to check how it moves.
---

# Animation preview: clips, frames, contact sheets of the Thor Viewer

The Thor Viewer mirrors the agent-browser `thor` session. These scripts record that same session, so a clip shows exactly what the viewer shows.

Claude can't play video, but it can Read images, so it reviews motion as **contact sheets**: a grid of timestamped frames read left to right. The user often works from their phone, so the clip goes to them in chat with `SendUserFile`.

Clips are a **temporary feedback/debug loop**, not deliverables. Low fps is fine. Write them to the session scratchpad and delete them after sending. High-quality renders are a separate, deliberate job.

## Steps

Start the viewer and open the page first (skill `agent-browser`: `start.sh <url>`). Scripts are in `~/.claude/skills/animation-preview/`, a symlink to the viewer repo's `skills/animation-preview/`. The viewer owns this skill, and every app shown in the viewer can use it.

1. **Record**: `record.sh <scratch>/clip.mp4 [seconds=8] [fps=12]`. It records the page already open in the viewer, without reloading, and prints the duration and frame count.
2. **Contact sheet**: `sheet.sh <clip.mp4> <sheet.png> [fps=2] [cols=2] [width=416] [crop=w:h:x:y]`, then Read the PNG.
   - Crop to the subject so detail survives the downscale.
   - To study a fast moment, cut it first with `ffmpeg -ss 2 -t 1.5 -i clip.mp4 part.mp4`, then sheet it at 10–15 fps. A ~2Hz wobble aliases at 2–3 fps.
3. **Individual frames**: `frames.sh <clip.mp4> <outdir> [fps=2] [width=640]`, then Read the chosen frames.
4. **Judge it honestly**: is the intended motion or effect actually visible in the sheet? Say so if it isn't, and fix it before sending when it's clearly off.
5. **Send**: `SendUserFile` with the clip (display `render`), plus the sheet when it helps.
   - **Always MP4, never WebM**: the Claude phone app won't play WebM. Use H.264, `-pix_fmt yuv420p -movflags +faststart`, ≤1080p.
   - **Say what it is**: a recording of the viewer is low fps and looks choppy (one measured 72 distinct frames in 10 s). If a baked or rendered video exists (e.g. an app's own loop file), send that for judging smoothness. Check with `ffmpeg -i clip.mp4 -vf mpdecimate -f null -` (the final frame count is the number of distinct frames).
6. **Clean up**: delete the clip, sheet and frames.

## Notes

- `agent-browser record` needs ffmpeg with libx264 and libvpx. Termux's `ffmpeg`/`ffprobe` have both and are on PATH.
- Recording captures the browser page itself (viewport size, e.g. 832x468), not the viewer's overlay chrome.
- An 8s clip at 12fps is well under 1.5MB.
- `drawtext` uses the default fontconfig font. If it errors, drop the drawtext part of the filter.
- Verified 2026-09-14 on Canvas Lab's hello-world piece.
