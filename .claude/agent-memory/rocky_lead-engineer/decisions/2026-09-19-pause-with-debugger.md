---
title: Pause pages with Debugger.pause, not Page.setWebLifecycleState
date: 2026-09-19
status: active
---
Ruled: "freeze" in Live Page Mode is Debugger.pause on a held CDP connection.
Why: measured in headless Chromium, setWebLifecycleState('frozen') marks the page hidden and
'active' does not make it visible again (rAF 0, timers 1/s until a tab switch). Debugger.pause stops
timers, rAF and GPU submissions, keeps visibility/DOM/JS/URL/scroll, and Chrome releases it when the
pausing connection dies (verified: killing the server resumed the page at 62 fps) - crash safety for free.
Cost: CDP Runtime.evaluate on a paused page hangs, so the server refuses frame evals while borrowed and
the gate never routes to a paused page. Revisit if Chrome changes lifecycle-resume visibility.
