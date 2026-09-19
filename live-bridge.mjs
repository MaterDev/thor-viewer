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
};
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
    if (!f.parentId) { S.mainFrameId = f.id; return; }
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
    c.onclose = () => { if (S.cdp === c) { S.cdp = null; emit({ type: 'state', attached: false, reason: 'CDP connection closed' }); } };
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

export async function evalInFrame(expression) {
  if (!attached()) return { ok: false, reason: 'not attached' };
  let ctx = S.liveSession ? [...S.contexts.entries()].find(([k]) => k.startsWith(S.liveSession + ':')) : null;
  let where = ctx ? { sessionId: S.liveSession, contextId: Number(ctx[0].split(':')[1]) } : contextFor(S.liveFrameId);
  if (!where) return { ok: false, reason: 'the live frame has no JavaScript context yet' };
  const r = await S.cdp.send('Runtime.evaluate', { expression, contextId: where.contextId, returnByValue: true, awaitPromise: true, userGesture: true }, where.sessionId, 5000);
  if (r.error) return { ok: false, reason: String(r.error.message || r.error) };
  if (r.result?.exceptionDetails) return { ok: false, reason: r.result.exceptionDetails.exception?.description || 'exception' };
  return { ok: true, value: r.result?.result?.value };
}

export function status() {
  return { attached: attached(), endpoint: ENDPOINT, targetId: S.targetId, frameUrl: S.url, title: S.title, outOfProcess: !!S.liveSession, clients: S.clients.size };
}

const NAV_JS = { back: 'history.back()', forward: 'history.forward()', reload: 'location.reload()' };

// Route handler: returns true if it handled the request.
export async function handle(req, res, path, readBody) {
  if (!path.startsWith('/api/live/')) return false;
  const json = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); res.end(JSON.stringify(obj)); };
  const op = path.slice(10);
  if (req.method === 'GET' && op === 'status') { json(200, status()); return true; }
  if (req.method === 'GET' && op === 'logs') { json(200, S.logs); return true; }
  if (req.method === 'GET' && op === 'events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify({ type: 'state', ...status() })}\n\n`);
    S.clients.add(res);
    req.on('close', () => { S.clients.delete(res); if (!S.clients.size) stop(); });   // last viewer left Live mode
    return true;
  }
  if (req.method !== 'POST') { json(405, { ok: false }); return true; }
  // JSON-only POSTs: a cross-origin page cannot send these without a CORS preflight, which we never answer.
  if (!/^application\/json/.test(req.headers['content-type'] || '')) { json(415, { ok: false, reason: 'application/json only' }); return true; }
  let body = {}; try { body = JSON.parse(await readBody() || '{}'); } catch {}
  if (op === 'start') {
    const origin = `http://${req.headers.host}/`;
    json(200, await start(String(body.token || ''), origin)); return true;
  }
  if (op === 'stop') { stop(); json(200, { ok: true }); return true; }
  if (op === 'nav' && NAV_JS[body.op]) { json(200, await evalInFrame(NAV_JS[body.op])); return true; }
  if (op === 'eval' && typeof body.expression === 'string') { json(200, await evalInFrame(body.expression)); return true; }
  json(400, { ok: false }); return true;
}
