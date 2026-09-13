# Thor Viewer

Full-screen live view of Claude's browser (the agent-browser `thor` session) for the Thor's top screen. See README.md for what it is; this file is for working on it.

## Run and test

```
node server.mjs      # http://127.0.0.1:4850/  (fixed port; don't change)
npm test             # 23-check end-to-end smoke test; needs the viewer and agent-browser running
npm run build:icons  # regenerate public/icons.svg from @carbon/icons after editing tools/build-icons.mjs
node --import /home/key/.local/share/playwright-mcp/platform-linux.mjs tools/screenshots.mjs   # README images
```

Normally started by `~/.claude/skills/agent-browser/start.sh`, which also starts agent-browser and its dashboard and prints the URL. Everything dies when the Claude Code process ends; rerun the script.

## How it works

- `server.mjs` (Termux node, no runtime dependencies): static files from `public/`, plus a small API where each route is one agent-browser CLI call: `POST /api/viewport`, `POST /api/nav/{back,forward,reload}`, `POST /api/nav/open {url}`, `GET /api/tabs`, `POST /api/tabs/{new,switch,close}`, `GET /api/errors`, `POST /api/input-log`.
- `public/app.js`: connects to agent-browser's stream (`ws://127.0.0.1:9223/`, ack pacing, 15 fps cap), draws frames on a full-window canvas, injects mouse/keyboard input, and renders the overlays: tabs drawer (left, from the stream's `tabs` messages), address bar (right), console panel, full-screen toggle, controls-reference panel (the ? button), controller pointer.
- `public/app.css`: dark glass panels, cyan hairlines, Carbon icons via `<use href="icons.svg#name">`. Icon names are the Carbon 32px file names (`arrow--left`, `trash-can`, ...).
- `manifest.webmanifest` + `sw.js` + PNG icons (rendered from `icon.svg` with headless Chromium) make it installable from Chrome's "Add to Home screen".

## History and toggles

- The tabs button (touch top-left, controller tabs) and address button (touch top-right, controller address) each TOGGLE their panel: press again to close (`toggleDrawer`, `toggleUrlBar`).
- Recent history is built client-side from the stream's `url`/`tabs` events (the browser exposes no readable history list), stored in localStorage `thorHistory` (cap 100, per device browser). Opening the address bar shows the most recent 15 unique URLs in `#histList`; typing filters them (`urlEdited` gates filtering so the pre-filled current URL doesn't hide everything). Clicking one navigates via `/api/nav/open`.

## Rules learned the hard way

- **One viewer sets the page size.** The viewer POSTs its size to `/api/viewport` on load, width change, rotation and full-screen change, only when visible and focused. Height-only resizes (Android toolbar, keyboard) are ignored. The server refuses size changes from `HeadlessChrome` user agents so Playwright MCP test copies can't resize the session the user is watching. Two live viewers with different sizes make the page "zoom out and back"; every size change is logged with its user agent in `~/.cache/thor-viewer-input.log`.
- **Tabs come from the stream, not from polling.** The stream sends the full tab list ~9 times a second; re-fetching on each message flickered. `setTabs()` redraws only when the list changes. Closing a tab is two taps (× then trash) and reverts after 4s.
- **Console:** stream `console` events can arrive twice; `addLog` dedupes identical lines within a short window. Uncaught exceptions are not on the stream; `/api/errors` is polled while the panel is open and every 20s for the badge.
- **agent-browser quirks:** refs (`@e2`) exist only after `snapshot`; `eval` output is a JSON-quoted string (parse twice); plain `errors` prints nothing useful, use `--json`.
- **Controller:** shows up as "Odin Controller (Vendor: 2020 Product: 0111)", `mapping: ""`; axes 0/1 are the left stick. Axis rest values are sampled after 1s of stillness. Button indices are still a guess; presses are logged to the input log for mapping.
- **Testing by hand:** load the viewer with the Playwright MCP tools, dispatch `mousedown`/`mouseup` on `#screen` at `view.x + x*view.scale`, verify with `agent-browser get text`, and close the test page promptly. `pkill -f` kills the Bash tool's own shell; kill by PID.

## Controller

Buttons are learned by in-app calibration, not hardcoded, because the Thor pad ("Odin Controller", non-standard) has variable indices and phantom/sticky buttons (9 always, 4 intermittently). Controls panel (? button) has "Calibrate controller": it samples held/phantom buttons first (500ms) to exclude them, then steps through each action (tap, back, tabs, address bar, page up, page down) capturing one fresh button-down each, and saves the action->index map to localStorage ("thorButtons"). `BIND` loads it at startup over `DEFAULT_BIND`.

Stable, not calibrated: D-pad = 12/13/14/15 (`DPAD`), left stick = axes 0/1 (scroll), right stick = axes 2/3 (pointer). Start, Select, L3, R3 are intercepted by Android/AYN Game Assistant and often do not reach the page; if calibration can't capture a button, use Skip and pick a working one.

localStorage is per browser/origin, so calibration is per device browser (and separate in the Playwright test browser).