# Thor Viewer

Full-screen live view of Claude's browser (the agent-browser `thor` session) for the top screen. Shows only the page picture, forwards taps, drags, scrolling and typing, and has a self-hiding bar with the page URL and a console drawer.

## Run

```
node server.mjs
```

Prints and serves:

```
http://127.0.0.1:4850/
```

Normally started by `~/.claude/skills/agent-browser/start.sh`, which also starts agent-browser and its dashboard. Port 4850 is fixed; don't change it.

## How it works

- `server.mjs` (Termux node, no dependencies): static files from `public/`, plus `GET /api/errors`, which runs `agent-browser errors --json` because uncaught page errors are not on the live stream.
- `public/app.js`: connects to agent-browser's stream at `ws://127.0.0.1:9223/` (port pinned by the `agent-browser` wrapper), draws JPEG frames on a canvas letterboxed to the viewport, acks each frame (ack pacing, 15 fps cap), and injects input.
  - Tap → mouse press/release at the frame coordinate. One-finger drag → mouse wheel (scrolls the remote page). Tap within 24px of the top edge shows the bar.
  - The ⌨ button focuses a hidden input so Android shows the keyboard; `beforeinput` events are forwarded as `char` keystrokes, Backspace and Enter as keys.
  - Console drawer: `console` messages from the stream (deduplicated; the stream can deliver one event twice) plus polled page errors. Red badge counts errors while the drawer is closed.
- `manifest.webmanifest` + `sw.js` + PNG icons make it installable: Chrome's "Add to Home screen" opens it full screen with no browser UI. The ⛶ button requests fullscreen as a fallback.

## Testing

Serve any page, `agent-browser open` it, load the viewer with the Playwright MCP tools, dispatch `mousedown`/`mouseup` on `#screen` (frame coords + letterbox offset), then verify with `agent-browser get text`. Icons regenerate with headless Chromium screenshots of `icon.svg` (see history in `~/.claude/skills/thor-environment/history.md`).
