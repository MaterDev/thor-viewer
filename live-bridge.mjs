// Live Page Mode: the server side.
//
// In Live mode the viewer page shows the real page in an <iframe name="thorLive">. This module
// attaches over CDP to the viewer's OWN page target (found by a token the page publishes, never by
// switching tabs), watches that child frame, and relays its URL, title, console and uncaught
// errors to the viewer as server-sent events. It also runs history/reload/eval inside the frame,
// which the viewer cannot do itself because the frame is a different origin.
//
// Nothing here runs unless a viewer is in Live mode: the CDP socket opens on /api/live/start and
// closes when the last event stream disconnects or on /api/live/stop.
//
// Endpoint: $LIVE_CDP (default http://127.0.0.1:9222 = Android Chrome through
// `adb forward tcp:9222 localabstract:chrome_devtools_remote`). Tests point it at a headless
// Chromium's own CDP port instead, which needs no adb.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

const ENDPOINT = (process.env.LIVE_CDP || 'http://127.0.0.1:9222').replace(/\/$/, '');
const USES_ADB = !process.env.LIVE_CDP;
const ADB = process.env.LIVE_ADB || 'adb';
const THOR_ADB = process.env.THOR_ADB_SCRIPT || '/code/projects/thor-infrastructure/bin/thor-adb';
const FRAME_NAME = 'thorLive';
import { createModes } from './modes.mjs';
import { freezeHeadless, thawHeadless } from './headless.mjs';
import { createHeatGuard } from './heat-guard.mjs';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
const MODE_FILE = process.env.LIVE_MODE_FILE || '/home/key/.cache/thor-viewer-mode';
const MODE_LOG = process.env.LIVE_MODE_LOG || '/home/key/.cache/thor-viewer-modes.log';
// Pause the headless page in Live only when agents cannot hit it by accident: that needs the routing
// gate installed as the agent-browser wrapper. Without it an agent's command would go to a paused
// page and hang, so the headless page keeps running (it costs some GPU, it breaks nothing).
// LIVE_PAUSE_HEADLESS = auto (default) | always | never.
const WRAPPER = process.env.AGENT_BROWSER || '/home/key/.local/bin/agent-browser';
export async function gateInstalled() { try { return (await readFile(WRAPPER, 'utf8')).includes('agent-browser gate'); } catch { return false; } }
async function shouldPauseHeadless() {
  const p = process.env.LIVE_PAUSE_HEADLESS || 'auto';
  return p === 'always' || (p === 'auto' && await gateInstalled());
}
const LEAVE_GRACE = 3000;           // a viewer reload in Live mode reconnects within this; don't bounce modes
const LOG_KEEP = 300;

const run = (cmd, args, timeout) => new Promise(resolve =>
  execFile(cmd, args, { timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => resolve({ ok: !err, out: String(stdout || '') + String(stderr || '') })));

async function fetchJson(url, ms = 2000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); return r.ok ? await r.json() : null; }
  catch { return null; } finally { clearTimeout(t); }
}

// Minimal CDP client over the global WebSocket (Node 22+). Flat sessions: each message may carry a sessionId.
function cdpConnect(wsUrl, ms = 3000) {
  return new Promise(resolve => {
    let ws; try { ws = new WebSocket(wsUrl); } catch { return resolve(null); }
    let id = 0; const pending = new Map(), handlers = new Set();
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(null); }, ms);
    const c = {
      send(method, params = {}, sessionId, timeout = 3000) {
        return new Promise(res => {
          if (ws.readyState !== 1) return res({ error: 'closed' });
          const mid = ++id; const t = setTimeout(() => { pending.delete(mid); res({ error: 'timeout' }); }, timeout);
          pending.set(mid, m => { clearTimeout(t); res(m); });
          ws.send(JSON.stringify({ id: mid, method, params, ...(sessionId ? { sessionId } : {}) }));
        });
      },
      on(fn) { handlers.add(fn); },
      close() { try { ws.close(); } catch {} },
      onclose: null,
    };
    ws.onopen = () => { clearTimeout(timer); resolve(c); };
    ws.onerror = () => { clearTimeout(timer); resolve(null); };
    ws.onclose = () => { for (const p of pending.values()) p({ error: 'closed' }); pending.clear(); c.onclose?.(); };
    ws.onmessage = ev => {
      let m; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); p(m); }
      else if (m.method) for (const h of handlers) h(m);
    };
  });
}

// ---------- state (one live attachment at a time) ----------
const S = {
  cdp: null, targetId: null, token: null, mainFrameId: null,
  liveFrameId: null,          // the iframe's frame id
  liveSession: null,          // set when the iframe is out-of-process (its own CDP session)
  contexts: new Map(),        // `${session||''}:${contextId}` -> frameId
  url: '', title: '', logs: [], clients: new Set(), createdForward: false, starting: null,
  leaveTimer: null, origin: '',
};
// The one state machine. Effects: the headless page freezes while Live runs; during a borrow the
// live page (the whole viewer app target) freezes instead, after the viewer shows its note.
// While the live page is frozen it cannot take a tap, so Key's "resume" is an Android notification
// button (runs in Termux, which has curl). The deadline resumes it anyway.
function borrowNotice(until) {
  if (!S.origin || process.env.LIVE_NOTIFY === '0') return;
  const at = new Date(until).toTimeString().slice(0, 8);
  const resume = `curl -s -m 5 -X POST -H 'content-type: application/json' -d '{"owner":"*"}' ${S.origin}api/mode/return`;
  run('termux-notification', ['--id', 'thor-live-borrow', '--title', 'Live page paused', '--content', `An agent is using its own browser. Resumes by ${at}.`,
    '--button1', 'Resume now', '--button1-action', resume], 5000);
}
// After a crash or restart the headless page may still be frozen from a Live session: thaw it once.
export async function recoverAtStartup() {
  let last = ''; try { last = (await readFile(MODE_FILE, 'utf8')).trim(); } catch {}
  if (last === 'live' || last === 'borrowed') { try { await thawHeadless(); } catch {} writeFile(MODE_FILE, 'stream\n').catch(() => {}); }
}
// Heat guard: runs only while Live is on (started/stopped from the mode machine below).
const logLine = line => { console.log(line); appendFile(MODE_LOG, line + '\n').catch(() => {}); };
export const heat = createHeatGuard({
  stateFile: process.env.LIVE_HEAT_FILE || '/home/key/.cache/thor-viewer-heat.json',
  hold: Number(process.env.LIVE_HEAT_HOLD_MS) || undefined,
  log: line => logLine(`${new Date().toISOString()} ${line}`),
  onTrip: t => viewerGone(`Too hot (${Math.round(t)}°C), switched to Stream.`, { heat: true }),
});
export const modes = createModes({
  freezeHeadless: async () => (await shouldPauseHeadless()) ? freezeHeadless() : 0, thawHeadless,
  pauseLive: async until => {
    emit({ type: 'mode', mode: 'borrowed', until });
    borrowNotice(until);
    await new Promise(r => setTimeout(r, 250));                 // let the note paint before the freeze
    // Debugger.pause, not Page.setWebLifecycleState: see headless.mjs (lifecycle freeze leaves the page hidden).
    for (const sess of [null, S.liveSession].filter((x, i) => i === 0 || x)) {
      if (!S.cdp) break;
      await S.cdp.send('Debugger.enable', {}, sess); await S.cdp.send('Debugger.pause', {}, sess);
    }
  },
  resumeLive: async () => { run('termux-notification-remove', ['thor-live-borrow'], 5000); 
    for (const sess of [null, S.liveSession].filter((x, i) => i === 0 || x)) {
      if (!S.cdp) break;
      await S.cdp.send('Debugger.resume', {}, sess); await S.cdp.send('Debugger.disable', {}, sess);
    }
  },
  onChange: snap => { pings(snap.mode !== 'stream'); snap.mode === 'stream' ? heat.stop() : heat.start(); emit({ type: 'mode', ...snap }); writeFile(MODE_FILE, snap.mode + '\n').catch(() => {}); },
  log: line => { console.log(line); appendFile(MODE_LOG, line + '\n').catch(() => {}); },
});
const attached = () => !!S.cdp;
function emit(ev) {
  if (ev.type === 'console' || ev.type === 'error') { S.logs.push({ t: Date.now(), ...ev }); if (S.logs.length > LOG_KEEP) S.logs.shift(); }
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of S.clients) res.write(line);
}
const fmtArg = a => a.type === 'string' ? a.value : a.value !== undefined ? JSON.stringify(a.value) : (a.description ?? a.type);
const LEVEL = { warning: 'warning', warn: 'warning', error: 'error', assert: 'error', info: 'info', debug: 'debug' };

async function ensureEndpoint() {
  if (await fetchJson(ENDPOINT + '/json/version', 1500)) return { ok: true };
  if (!USES_ADB) return { ok: false, reason: `no CDP endpoint at ${ENDPOINT}` };
  let st = await run(ADB, ['get-state'], 3000);
  if (!st.ok || !/device/.test(st.out)) {
    if (existsSync(THOR_ADB)) await run('bash', [THOR_ADB, 'connect'], 25000);
    st = await run(ADB, ['get-state'], 3000);
    if (!st.ok || !/device/.test(st.out)) return { ok: false, reason: 'adb is not connected: turn on Wireless debugging, then run thor-adb connect' };
  }
  const fw = await run(ADB, ['forward', 'tcp:9222', 'localabstract:chrome_devtools_remote'], 5000);
  if (!fw.ok) return { ok: false, reason: 'adb forward failed: ' + fw.out.trim().slice(0, 120) };
  S.createdForward = true;
  if (await fetchJson(ENDPOINT + '/json/version', 2500)) return { ok: true };
  return { ok: false, reason: "Chrome's DevTools socket did not answer (is the Thor Viewer app open?)" };
}

// Find the viewer's own target: the page whose window.__thorLiveToken matches. Read-only probes;
// nothing is activated, so no other tab or app is brought to the front.
async function findViewerTarget(token, origin) {
  const list = (await fetchJson(ENDPOINT + '/json/list', 2500)) || [];
  const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl && t.url.startsWith(origin));
  for (const t of pages) {
    const c = await cdpConnect(t.webSocketDebuggerUrl, 2500);
    if (!c) continue;
    const r = await c.send('Runtime.evaluate', { expression: 'window.__thorLiveToken', returnByValue: true }, null, 2000);
    if (r.result?.result?.value === token) return c;
    c.close();
  }
  return null;
}

function contextFor(frameId) {
  for (const [k, f] of S.contexts) if (f === frameId) { const [sess, id] = k.split(':'); return { sessionId: sess || null, contextId: Number(id) }; }
  return null;
}
const isLiveContext = (sessionId, contextId) => {
  const f = S.contexts.get(`${sessionId || ''}:${contextId}`);
  return f && f === S.liveFrameId;
};

async function refreshTitle() {
  const r = await evalInFrame('document.title');
  if (r.ok && typeof r.value === 'string' && r.value !== S.title) { S.title = r.value; emit({ type: 'title', title: S.title }); }
}

function onEvent(m) {
  const { method, params = {}, sessionId } = m;
  const p = params;
  if (method === 'Page.frameNavigated' && p.frame) {
    const f = p.frame;
    if (!f.parentId) {                     // the viewer page itself navigated or reloaded: it left Live mode
      if (S.mainFrameId && attached()) viewerGone('the viewer page navigated away');
      S.mainFrameId = f.id; return;
    }
    if (f.name === FRAME_NAME || f.id === S.liveFrameId) {
      S.liveFrameId = f.id;
      const url = f.url + (f.urlFragment || '');
      if (url !== S.url) { S.url = url; emit({ type: 'url', url }); }
    }
  } else if (method === 'Page.navigatedWithinDocument' && p.frameId === S.liveFrameId) {
    if (p.url !== S.url) { S.url = p.url; emit({ type: 'url', url: p.url }); }
  } else if (method === 'Page.frameStoppedLoading' && p.frameId === S.liveFrameId) {
    refreshTitle();
  } else if (method === 'Runtime.executionContextCreated') {
    const c = p.context; const f = c.auxData?.frameId;
    if (f && c.auxData?.isDefault) S.contexts.set(`${sessionId || ''}:${c.id}`, f);
    if (f && c.auxData?.isDefault && f === S.liveFrameId && liveContextHook) setTimeout(() => liveContextHook(), 0);
  } else if (method === 'Runtime.executionContextDestroyed') {
    S.contexts.delete(`${sessionId || ''}:${p.executionContextId}`);
  } else if (method === 'Runtime.executionContextsCleared') {
    for (const k of [...S.contexts.keys()]) if (k.startsWith(`${sessionId || ''}:`)) S.contexts.delete(k);
  } else if (method === 'Runtime.consoleAPICalled') {
    if (!isLiveContext(sessionId, p.executionContextId)) return;
    emit({ type: 'console', level: LEVEL[p.type] || 'log', text: (p.args || []).map(fmtArg).join(' ') });
  } else if (method === 'Runtime.exceptionThrown') {
    const d = p.exceptionDetails || {};
    if (!isLiveContext(sessionId, d.executionContextId)) return;
    emit({ type: 'error', level: 'error', text: d.exception?.description || d.text || 'uncaught error' });
  } else if (method === 'Target.attachedToTarget' && p.targetInfo?.type === 'iframe') {
    // Out-of-process iframe (e.g. a different site): it gets its own session. Its frame id is its target id.
    S.liveSession = p.sessionId; S.liveFrameId = p.targetInfo.targetId;
    const url = p.targetInfo.url; if (url && url !== S.url) { S.url = url; emit({ type: 'url', url }); }
    S.cdp.send('Runtime.enable', {}, p.sessionId); S.cdp.send('Page.enable', {}, p.sessionId);
    S.cdp.send('Runtime.runIfWaitingForDebugger', {}, p.sessionId);
  } else if (method === 'Target.detachedFromTarget' && p.sessionId === S.liveSession) {
    S.liveSession = null;
  }
}

export async function start(token, origin) {
  if (attached() && S.token === token) return { ok: true, targetId: S.targetId };
  if (S.starting) return S.starting;
  S.starting = (async () => {
    stop(false);
    const ep = await ensureEndpoint();
    if (!ep.ok) return ep;
    const c = await findViewerTarget(token, origin);
    if (!c) return { ok: false, reason: 'the viewer page was not found over CDP (open the viewer app, then try again)' };
    S.cdp = c; S.token = token;
    c.onclose = () => { if (S.cdp === c) { S.cdp = null; emit({ type: 'state', attached: false, reason: 'CDP connection closed' }); viewerGone('CDP connection to the viewer closed'); } };
    c.on(onEvent);
    S.targetId = (await c.send('Target.getTargetInfo')).result?.targetInfo?.targetId || null;
    await c.send('Page.enable'); await c.send('Runtime.enable');
    await c.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
    const tree = (await c.send('Page.getFrameTree')).result?.frameTree;
    if (tree) {
      S.mainFrameId = tree.frame.id;
      const child = (tree.childFrames || []).find(f => f.frame.name === FRAME_NAME);
      if (child) { S.liveFrameId = child.frame.id; S.url = child.frame.url; }
    }
    emit({ type: 'state', attached: true, targetId: S.targetId });
    if (S.url) { emit({ type: 'url', url: S.url }); refreshTitle(); }
    return { ok: true, targetId: S.targetId };
  })();
  try { return await S.starting; } finally { S.starting = null; }
}

export function stop(removeForward = true) {
  const c = S.cdp; S.cdp = null;
  if (c) c.close();
  Object.assign(S, { targetId: null, token: null, mainFrameId: null, liveFrameId: null, liveSession: null, url: '', title: '', logs: [] });
  S.contexts.clear();
  if (removeForward && S.createdForward) { S.createdForward = false; run(ADB, ['forward', '--remove', 'tcp:9222'], 5000); }
}
// The viewer page is gone (navigated, reloaded, closed): detach now and end its event streams, which
// can outlive the page on Android. A viewer that comes back in Live mode starts over.
function viewerGone(why, extra = {}) {
  emit({ type: 'fallback', reason: why, ...extra });              // the viewer goes back to Stream and says why
  stop();
  for (const res of S.clients) { try { res.end(); } catch {} }
  S.clients.clear();
  modes.leaveLive(why);
}
// SSE clients that died without a clean close are only noticed on write: ping while Live is on.
let pingTimer = null;
function pings(on) {
  clearInterval(pingTimer); pingTimer = null;
  if (on) pingTimer = setInterval(() => { for (const res of S.clients) res.write(': ping\n\n'); }, 15000);
}
// The viewer left Live mode (or disappeared): back to Stream after a short grace.
function scheduleLeave(why) {
  clearTimeout(S.leaveTimer);
  S.leaveTimer = setTimeout(() => { S.leaveTimer = null; if (!S.clients.size) { stop(); modes.leaveLive(why); } }, LEAVE_GRACE);
}

// Called when the live frame gets a fresh default JavaScript context (every navigation or reload), so the
// server can re-apply page-level settings such as the theme (see the Theme contract in CLAUDE.md).
let liveContextHook = null;
export function onLiveContext(fn) { liveContextHook = fn; }

export async function evalInFrame(expression) {
  if (!attached()) return { ok: false, reason: 'not attached' };
  if (modes.get().mode === 'borrowed') return { ok: false, reason: 'the live page is paused while an agent borrows the headless page' };
  let ctx = S.liveSession ? [...S.contexts.entries()].find(([k]) => k.startsWith(S.liveSession + ':')) : null;
  let where = ctx ? { sessionId: S.liveSession, contextId: Number(ctx[0].split(':')[1]) } : contextFor(S.liveFrameId);
  if (!where) return { ok: false, reason: 'the live frame has no JavaScript context yet' };
  const r = await S.cdp.send('Runtime.evaluate', { expression, contextId: where.contextId, returnByValue: true, awaitPromise: true, userGesture: true }, where.sessionId, 5000);
  if (r.error) return { ok: false, reason: String(r.error.message || r.error) };
  if (r.result?.exceptionDetails) return { ok: false, reason: r.result.exceptionDetails.exception?.description || 'exception' };
  return { ok: true, value: r.result?.result?.value };
}

export function status() {
  return { attached: attached(), mode: modes.get().mode, endpoint: ENDPOINT, targetId: S.targetId, frameUrl: S.url, title: S.title, outOfProcess: !!S.liveSession, clients: S.clients.size };
}

const NAV_JS = { back: 'history.back()', forward: 'history.forward()', reload: 'location.reload()' };

// Route handler: returns true if it handled the request.
export async function handle(req, res, path, readBody) {
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(JSON.stringify(obj)); };
  if (path === '/api/mode' && req.method === 'GET') {
    const m = { ...modes.get(), viewerTargetId: S.targetId, cdp: ENDPOINT, liveUrl: S.url, liveTitle: S.title };
    if (new URL(req.url, 'http://x').searchParams.get('format') === 'sh') {       // for the agent-browser gate
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-cache' });
      res.end(Object.entries(m).map(([k, v]) => `${k}=${v ?? ''}`).join('\n') + '\n'); return true;
    }
    json(200, m); return true;
  }
  if (path === '/api/heat' && req.method === 'GET') { json(200, heat.state()); return true; }
  if (path === '/api/heat' && req.method === 'POST') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) { json(415, { ok: false }); return true; }
    let b = {}; try { b = JSON.parse(await readBody() || '{}'); } catch {}
    json(200, heat.override(b.off ? (Number(b.ms) || undefined) : 0)); return true;
  }
  if (!path.startsWith('/api/live/') && !path.startsWith('/api/mode/')) return false;
  const op = path.startsWith('/api/mode/') ? 'mode-' + path.slice(10) : path.slice(10);
  if (req.method === 'GET' && op === 'status') { json(200, status()); return true; }
  if (req.method === 'GET' && op === 'logs') { json(200, S.logs); return true; }
  if (req.method === 'GET' && op === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'state', ...status() })}\n\n`);
    S.clients.add(res); clearTimeout(S.leaveTimer); S.leaveTimer = null;
    req.on('close', () => { S.clients.delete(res); if (!S.clients.size) scheduleLeave('viewer left Live mode'); });
    return true;
  }
  if (req.method !== 'POST') { json(405, { ok: false }); return true; }
  // JSON-only POSTs: a cross-origin page cannot send these without a CORS preflight, which we never answer.
  if (!/^application\/json/.test(req.headers['content-type'] || '')) { json(415, { ok: false, reason: 'application/json only' }); return true; }
  let body = {}; try { body = JSON.parse(await readBody() || '{}'); } catch {}
  if (op === 'start') {
    const m = await modes.enterLive({});                        // pauses the headless page first (see above)
    if (!m.ok) { json(409, m); return true; }
    const origin = `http://${req.headers.host}/`; S.origin = origin;
    const r = await start(String(body.token || ''), origin);
    if (!r.ok) {                                                // auto-fallback: never stay in a half Live
      stop(); await modes.leaveLive('Live could not start: ' + (r.reason || 'unknown'));
      json(200, { ...r, fallback: true }); return true;
    }
    json(200, r); return true;
  }
  if (op === 'stop') { stop(); json(200, await modes.leaveLive('viewer switched to Stream')); return true; }
  if (op === 'nav' && NAV_JS[body.op]) { json(200, await evalInFrame(NAV_JS[body.op])); return true; }
  if (op === 'open' && /^https?:\/\/\S+$/.test(body.url || '')) {  // the viewer opens it in its frame (it owns the tabs)
    if (!S.clients.size) { json(409, { ok: false, reason: 'no viewer in Live mode' }); return true; }
    emit({ type: 'open', url: body.url }); json(200, { ok: true }); return true;
  }
  // the viewer owns the tabs, so tab commands are messages to it (Key, 2026-09-19: agents may open tabs in Live)
  if (op === 'tab-new') {
    if (!S.clients.size) { json(409, { ok: false, reason: 'no viewer in Live mode' }); return true; }
    const url = /^https?:\/\/\S+$/.test(body.url || '') ? body.url : '';
    emit({ type: 'tab-new', url }); json(200, { ok: true }); return true;
  }
  if (op === 'tab-close' || op === 'tab-switch') {
    if (!S.clients.size) { json(409, { ok: false, reason: 'no viewer in Live mode' }); return true; }
    if (!body.id) { json(400, { ok: false, reason: 'need a tab id' }); return true; }
    emit({ type: op, id: String(body.id) }); json(200, { ok: true }); return true;
  }
  if (op === 'eval' && typeof body.expression === 'string') { json(200, await evalInFrame(body.expression)); return true; }
  if (op === 'mode-borrow') { const r = await modes.borrow(String(body.owner || ''), Number(body.ms) || undefined); json(r.ok ? 200 : 409, r); return true; }
  if (op === 'mode-return') { const r = await modes.giveBack(String(body.owner || '')); json(r.ok ? 200 : 409, r); return true; }
  json(400, { ok: false }); return true;
}
