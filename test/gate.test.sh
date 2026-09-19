#!/usr/bin/env bash
# Routing tests for tools/agent-browser-gate with a fake viewer server and a fake agent-browser binary.
# Never touches a browser. Run: bash test/gate.test.sh
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d "${TMPDIR:-/tmp}/gate-test.XXXXXX")
GATE="$ROOT/tools/agent-browser-gate"
pass=0 fail=0
ok() { pass=$((pass+1)); printf '  ok    %s\n' "$1"; }
bad() { fail=$((fail+1)); printf '  FAIL  %s\n        %s\n' "$1" "${2:-}"; }
check() { local n=$1; shift; if "$@"; then ok "$n"; else bad "$n" "$(tail -3 "$T/real.log" 2>/dev/null | tr '\n' '|') out=${OUT:-}"; fi; }

# Fake agent-browser: logs its args; answers `tab list --json` with a viewer tab and a Chrome tab.
cat >"$T/real" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$T/real.log"
case "\$*" in *"tab list --json"*) echo '{"success":true,"data":{"tabs":[{"active":true,"tabId":"t1","targetId":"CHROMETAB"},{"active":false,"tabId":"t2","targetId":"VIEWERTARGET"}]}}';; esac
[ -f "$T/real-sleep" ] && sleep "\$(cat "$T/real-sleep")"
exit 0
EOF
chmod +x "$T/real"

# Fake viewer: GET /api/mode?format=sh from $T/mode; POSTs logged; borrow/return follow $T/borrow-reply.
cat >"$T/server.mjs" <<'EOF'
import { createServer } from 'node:http';
import { readFileSync, appendFileSync, existsSync } from 'node:fs';
const T = process.argv[2];
const s = createServer(async (req, res) => {
  let body = ''; for await (const c of req) body += c;
  if (req.method === 'POST') appendFileSync(T + '/posts.log', req.url + ' ' + body + '\n');
  if (req.url.startsWith('/api/mode?')) { res.end(existsSync(T + '/mode') ? readFileSync(T + '/mode') : ''); return; }
  if (req.url === '/api/mode/borrow') { const r = existsSync(T + '/borrow-reply') ? readFileSync(T + '/borrow-reply', 'utf8') : '{"ok":true}'; res.end(r); return; }
  if (req.url === '/api/live/logs') { res.end('[{"type":"console","text":"hello"}]'); return; }
  res.end('{"ok":true,"value":"42"}');
});
s.listen(0, '127.0.0.1', () => { console.log(s.address().port); });
EOF
node "$T/server.mjs" "$T" >"$T/port" & SPID=$!
trap 'kill $SPID 2>/dev/null; rm -rf "$T"' EXIT
for _ in $(seq 50); do [ -s "$T/port" ] && break; sleep 0.1; done
PORT=$(cat "$T/port")
export THOR_GATE_REAL="$T/real" THOR_VIEWER_URL="http://127.0.0.1:$PORT" XDG_CACHE_HOME="$T/cache" THOR_BORROW_WAIT=4
unset AGENT_BROWSER_SESSION THOR_GATE
g() { : >"$T/real.log"; : >"$T/posts.log"; OUT=$("$GATE" "$@" 2>&1); RC=$?; }
live() { printf 'mode=%s\nviewerTargetId=VIEWERTARGET\ncdp=http://127.0.0.1:9222\nliveUrl=http://127.0.0.1:4860/?plugin=x\nliveTitle=Lab\n' "${1:-live}" >"$T/mode"; }

echo "fail-safe and stream"
rm -f "$T/mode"
g snapshot; check "viewer says nothing -> stream, unchanged args" grep -qx "snapshot" "$T/real.log"
THOR_VIEWER_URL=http://127.0.0.1:1 g open https://x.test; check "viewer unreachable -> stream" grep -qx "open https://x.test" "$T/real.log"
printf 'mode=stream\n' >"$T/mode"
g click @e3; check "stream mode -> headless thor" grep -qx "click @e3" "$T/real.log"
g --headless snapshot; check "--headless in stream is just stripped" grep -qx "snapshot" "$T/real.log"
live; g --session other snapshot; check "another session is never routed" grep -qx -- "--session other snapshot" "$T/real.log"
THOR_GATE=off g snapshot; check "THOR_GATE=off bypasses routing" grep -qx "snapshot" "$T/real.log"

echo "live routing"
live
g snapshot -i
check "page commands go to the viewer target over CDP" grep -qx -- "--session thor-live --cdp 9222 snapshot -i" "$T/real.log"
check "...after binding to the viewer tab, not the active Chrome tab" grep -qx -- "--session thor-live --cdp 9222 tab t2" "$T/real.log"
g open https://example.test/a; check "open -> the live frame" grep -q '/api/live/open {"url":"https://example.test/a"}' "$T/posts.log"
check "open never reaches the real binary" test ! -s "$T/real.log"
g back; check "back -> live nav" grep -q '/api/live/nav {"op":"back"}' "$T/posts.log"
g eval 'document.title'; check "eval -> the live frame" grep -q '/api/live/eval {"expression":"document.title"}' "$T/posts.log"
check "eval prints the value" test "$OUT" = '"42"'
g get url; check "get url -> the live page URL" test "$OUT" = "http://127.0.0.1:4860/?plugin=x"
g console; check "console -> live logs" grep -q hello <<<"$OUT"
g close; check "close is refused in Live" test "$RC" = 64 -a ! -s "$T/real.log"
g tab new; check "tab is refused in Live" test "$RC" = 64
g --session thor snapshot; check "an explicit --session thor is replaced" grep -qx -- "--session thor-live --cdp 9222 snapshot" "$T/real.log"
printf 'mode=live\nviewerTargetId=\n' >"$T/mode"
g snapshot; check "live but not attached -> clear error, no fallback to the frozen page" test "$RC" = 69 -a ! -s "$T/real.log"

echo "borrowing"
live; rm -f "$T/borrow-reply"
g --headless screenshot /tmp/x.png
check "borrow is requested" grep -q '/api/mode/borrow {"owner":"gate-' "$T/posts.log"
check "the command runs on the headless thor session" grep -qx "screenshot /tmp/x.png" "$T/real.log"
check "and it is given back" grep -q '/api/mode/return {"owner":"gate-' "$T/posts.log"
echo '{"ok":false,"reason":"already borrowed by gate-1"}' >"$T/borrow-reply"
g --headless snapshot; check "busy borrow waits, then gives up without running" test "$RC" = 75 -a ! -s "$T/real.log"
echo '{"ok":false,"reason":"not in Live mode: the headless page is already running"}' >"$T/borrow-reply"
g --headless snapshot; check "Key went back to Stream meanwhile -> runs plainly" grep -qx "snapshot" "$T/real.log"
rm -f "$T/borrow-reply"; echo 30 >"$T/real-sleep"
: >"$T/posts.log"; "$GATE" --headless snapshot >/dev/null 2>&1 & GP=$!
for _ in $(seq 40); do grep -q borrow "$T/posts.log" 2>/dev/null && break; sleep 0.1; done
sleep 0.3; kill -TERM $GP; wait $GP 2>/dev/null
check "killed mid-borrow -> still gives back (trap)" grep -q '/api/mode/return' "$T/posts.log"
rm -f "$T/real-sleep"; pkill -P $$ -x sleep 2>/dev/null
live borrowed; ( sleep 1; live live ) &
g snapshot; check "a plain command waits out someone else's borrow, then goes live" grep -qx -- "--session thor-live --cdp 9222 snapshot" "$T/real.log"

echo
echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
