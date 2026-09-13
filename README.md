# Thor Viewer

A full-screen live view of the browser that Claude Code drives on an **AYN Thor** (a dual-screen Android handheld). It runs on the top screen while Claude works in the terminal on the bottom one, so you can watch every page Claude opens, tap or type into it yourself, and see the page's console. It exists because the Thor has no desktop: there is no browser window to glance at while an agent works, so this page is that window.

![The viewer mirroring a live WebGPU raymarch piece, with the shell chrome and the top-center stats bar](docs/viewer.png)

## What it does

- **Shows the real browser, live.** Frames come straight from the headless Chromium that Claude controls, at the exact size and shape of your screen. Rotate the device or go full screen and the remote page reflows to match — no black bars, no scaling artifacts.
- **Lets you take over.** Tap, drag to scroll, and type (the keyboard button opens Android's keyboard). The built-in controller works too: left stick and D-pad scroll, right stick moves a pointer, and the face and shoulder buttons tap, go back, and page up and down.
- **Stats bar.** A thin, translucent strip centered along the top reports the live stream: frames per second, resolution, bandwidth, and the device temperature (e.g. `53 fps · 832×396 · 5.7 Mb/s · 38.0°C`). It measures what you are actually seeing *through* the viewer, independent of whatever the page inside is doing; the temperature (battery, read server-side from `/sys`) turns amber then red as the device warms. Hide it from the Controls panel.
- **Address bar** in the top-right corner that expands leftwards, with back and forward. Type an address or search terms; recent pages you visited are offered below and filter as you type.
- **Tabs drawer** in the top-left corner: switch, open, and close tabs. Closing asks for confirmation first.
- **Console panel** with the page's console output and uncaught errors, with an error badge while it is closed.
- **Installs as an app.** Chrome's *Add to Home screen* opens it with no browser UI at all; a full-screen toggle is there for the plain-browser case.

The interface uses [Carbon](https://carbondesignsystem.com/) icons and a restrained dark, high-contrast style.

| Tabs drawer | Address bar | Console |
| --- | --- | --- |
| ![Tabs drawer](docs/tabs.png) | ![Address bar](docs/address.png) | ![Console panel](docs/console.png) |

## The graphics stack it belongs to

The viewer is one of three projects designed to work together on this device:

- **Thor Viewer** (this repo) — the mirror and shell you watch and drive on the top screen.
- **[Canvas Lab](https://github.com/MaterDev/thor-canvas-lab)** — a gallery of self-contained web-graphics pieces (WebGPU, WebGL2, Canvas2D, SVG, CSS), watched and controlled through this viewer.
- **[turnip-kgsl-shim](https://github.com/MaterDev/turnip-kgsl-shim)** — the runtime shim that gets the handheld's real GPU to the headless Chromium the viewer mirrors.

Because of that shim, the Chromium behind the viewer renders on the **actual Adreno 740 GPU**, not a software rasterizer. WebGL2 runs hardware-accelerated (ANGLE-on-Vulkan), and **WebGPU** runs on the GPU too — the lead image above is a WebGPU raymarch piece from Canvas Lab at 60fps, mirrored live through this viewer. (The GPU is deliberately disguised as SwiftShader to satisfy Chromium's decoder, so a page must never trust `adapter.info` or `adapter.isFallbackAdapter`; Canvas Lab's `gpu.js` handles that. See turnip-kgsl-shim for the full mechanism.)

## How it works

```
top screen (Chrome)                     bottom screen (Claude Code)
┌─────────────────────┐                 ┌────────────────────────┐
│  Thor Viewer page   │ ws frames+input │  agent-browser CLI     │
│  canvas + overlays  │◄───────────────►│  (Claude's commands)   │
└──────────┬──────────┘                 └───────────┬────────────┘
           │ http /api/*                            │ CDP
┌──────────▼──────────┐                 ┌───────────▼────────────┐
│ server.mjs (:4850)  │── agent-browser ─►│ headless Chromium      │
│ static + small API  │   CLI calls     │ session "thor"         │
└─────────────────────┘                 └────────────────────────┘
```

- [`agent-browser`](https://github.com/vercel-labs/agent-browser) runs the headless Chromium and exposes a per-session **WebSocket stream** (`ws://127.0.0.1:9223/`) carrying a CDP screencast: it sends JPEG frames whenever the page changes and accepts mouse, keyboard and touch input. The viewer connects to it directly for the picture, taps and typing, and reads the tab list and console messages it broadcasts.
- **Frames are paced by acks.** The stream sends the next frame only after the viewer acknowledges the last one, so at most one frame is ever in flight and latency never builds — the picture runs as fast as the device renders (measured ~53 fps on-device) and never queues stale frames. Frames decode off the main thread via `createImageBitmap`, and the canvas backing store is the frame's native pixels, CSS-scaled to fill.
- `server.mjs` serves the page and a small API for things the stream cannot do, each backed by one agent-browser CLI call: `POST /api/viewport` (match the page to the screen), `/api/nav/{back,forward,reload,open}`, `/api/tabs` and `/api/tabs/{new,switch,close}`, `GET /api/errors` (uncaught exceptions are not on the stream), and `POST /api/input-log` (controller and key events, for mapping the Thor's buttons).
- **One viewer sets the size.** The viewer sends its own dimensions to `/api/viewport` on load, rotation, and full-screen changes, so the remote page takes the screen's shape. Height-only changes (Android's toolbar or keyboard) are ignored, and only the visible, focused viewer sets the size. The server refuses size changes from headless browsers, so automated tests never resize the session someone is watching.

## Requirements

This is built for one specific setup and assumes it:

- **AYN Thor** (or any Android device) with [Termux](https://termux.dev/) from F-Droid, and Termux's `chromium` package (`pkg install x11-repo chromium`).
- **agent-browser** with the Linux arm64 binary pointed at that Chromium, streaming on port 9223, session `thor`. The wrapper and config that do this live outside the repo (`~/.local/bin/agent-browser`, `~/.agent-browser/config.json`).
- **Node.js** (Termux's `nodejs`). The server has no runtime dependencies; `@carbon/icons` is a dev dependency used only to build `public/icons.svg`.
- Chrome on the same device, opening the URL below. Everything is loopback-only; nothing is reachable from other machines.

Claude Code starts all of it with one script (`~/.claude/skills/agent-browser/start.sh`), which also prints the URL. By hand:

```
node server.mjs
```

```
http://127.0.0.1:4850/
```

## Development

```
npm test             # end-to-end smoke test (23 checks) against the running viewer and agent-browser
npm run build:icons  # regenerate public/icons.svg after editing tools/build-icons.mjs
```

The test drives the real page in a headless Chromium and verifies taps, typing, the address bar, tabs (including confirm-to-close), the console and error capture, and the size guards through the agent-browser CLI. It navigates the shared `thor` session and restores the URL afterwards, so do not run it while someone is using the viewer. `tools/screenshots.mjs` regenerates the images in `docs/`.

Files:

- `server.mjs`: static server and API.
- `public/app.js`: stream client, drawing, input, address bar, tabs, console, stats bar, controller.
- `public/app.css`, `public/index.html`: the interface. `public/icons.svg` is the Carbon sprite.
- `public/manifest.webmanifest`, `public/sw.js`, `public/icon-*.png`: installability.
- `test/smoke.mjs`, `tools/`: tests, icon build, screenshots.

## Controller

The Thor's built-in pad reports as a non-standard "Odin Controller" with variable button indices and phantom/sticky buttons, so the action-to-button map is **learned by in-app calibration**, not hardcoded. The Controls panel (the **?** button) has *Calibrate controller*: it first samples held and phantom buttons to exclude them, then steps through each action (tap, back, tabs, address bar, page up, page down), capturing one fresh press for each, and saves the map. The D-pad and sticks are stable and not calibrated: D-pad and left stick scroll, right stick moves the on-screen pointer. Calibration is stored per device browser.

## Known limitations

- Frames are JPEG images, not video; very fast animation can look choppy even when the frame rate is high.
- The controller mapping still depends on calibration because the Thor's pad is non-standard; some buttons (Start, Select, stick clicks) are intercepted by Android and may never reach the page.
- Everything stops when the Claude Code process ends or Android kills Termux, because the browser and servers are child processes. Restarting takes a few seconds.
- Single shared session: the viewer, Claude, and the test suite all drive the same browser.
</content>
</invoke>
