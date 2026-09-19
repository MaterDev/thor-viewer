---
title: The agent-browser gate ships in the repo, not installed
date: 2026-09-19
status: active
---
tools/agent-browser-gate replaces ~/.local/bin/agent-browser only when Key/main session installs it.
Installing it changes every agent's browser calls on the device (other agents were mid-work), and it
only does anything once a viewer server with /api/mode runs on 4850 (fail-safe: no answer = Stream).
