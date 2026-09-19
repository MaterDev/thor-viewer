#!/usr/bin/env bash
# Install / uninstall the agent-browser routing gate as the device's agent-browser wrapper.
#   bash tools/install-gate.sh install     # back up the current wrapper (once), put the gate in its place
#   bash tools/install-gate.sh uninstall   # put the backed-up wrapper back
#   bash tools/install-gate.sh status
# The gate is COPIED (not linked), so switching branches or removing a worktree cannot break it;
# re-run install after changing tools/agent-browser-gate.
set -eu
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
TARGET="${GATE_TARGET:-/home/key/.local/bin/agent-browser}"
BACKUP="${GATE_BACKUP:-/home/key/.local/share/agent-browser/wrapper.pre-gate.bak}"
SRC="$HERE/agent-browser-gate"
is_gate() { grep -q 'agent-browser gate' "$1" 2>/dev/null; }

case "${1:-status}" in
  install)
    if ! is_gate "$TARGET"; then
      [ -f "$BACKUP" ] || { mkdir -p "$(dirname "$BACKUP")"; cp -p "$TARGET" "$BACKUP"; }
    fi
    [ -f "$BACKUP" ] || { echo "refusing: no backup of the original wrapper at $BACKUP" >&2; exit 1; }
    cp "$SRC" "$TARGET.new" && chmod 755 "$TARGET.new" && mv "$TARGET.new" "$TARGET"   # atomic swap
    echo "installed the gate at $TARGET (original wrapper kept at $BACKUP)" ;;
  uninstall)
    [ -f "$BACKUP" ] || { echo "no backup at $BACKUP; nothing to restore" >&2; exit 1; }
    cp -p "$BACKUP" "$TARGET.new" && mv "$TARGET.new" "$TARGET"
    echo "restored the original wrapper at $TARGET" ;;
  status)
    if is_gate "$TARGET"; then
      if cmp -s "$SRC" "$TARGET"; then echo "gate installed (matches $SRC)"; else echo "gate installed (differs from $SRC: re-run install to update)"; fi
    else echo "gate not installed"; fi ;;
  *) echo "usage: install-gate.sh install|uninstall|status" >&2; exit 2 ;;
esac
