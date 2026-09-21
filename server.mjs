// Thor Viewer: serves the full-screen live view of the agent-browser session.
// Static files, plus /api/errors which asks agent-browser for uncaught page
// errors (the live stream carries console output but not exceptions).
// Run: node server.mjs   (prints the URL)
import { createServer } from 'node:http';
import { readFile, stat, appendFile, readdir, writeFile, rename, copyFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as live from './live-bridge.mjs';
import { applyPins } from './public/pins.js';   // pinned tabs (shared with the page)   // Live Page Mode (CDP to the viewer's own page)

const PORT = Number(process.env.PORT || 4850);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const AGENT_BROWSER = '/home/key/.local/bin/agent-browser';
// The server's own calls always mean the headless `thor` session, never the routing gate's Live target.
const AB_ENV = { env: { ...process.env, THOR_GATE: 'off' } };
// The headless page this server drives (tabs, open, viewport, errors, theme): the `thor` session, or another one
// in tests via HEADLESS_AB_ARGS (e.g. "--session x --profile y"), the same variable headless.mjs uses.
const AB_ARGS = (process.env.HEADLESS_AB_ARGS || '').split(' ').filter(Boolean);
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function setViewport(w, h) {
  return new Promise(resolve => {
    execFile(AGENT_BROWSER, [...AB_ARGS, "set", "viewport", String(w), String(h)], { timeout: 15000, ...AB_ENV }, err => resolve(!err));
  });
}

const INPUT_LOG = '/home/key/.cache/thor-viewer-input.log';
const NAV = { back: ['back'], forward: ['forward'], reload: ['reload'] };
const TAB_REF = /^(t\d+|[A-F0-9]{32})$/;
function agentBrowserJson(args) {
  return new Promise(resolve => execFile(AGENT_BROWSER, [...AB_ARGS, ...args, '--json'], { timeout: 15000, ...AB_ENV }, (err, stdout) => {
    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
  }));
}
function runAgentBrowser(args) {
  return new Promise(resolve => execFile(AGENT_BROWSER, [...AB_ARGS, ...args], { timeout: 15000, ...AB_ENV }, err => resolve(!err)));
}

// ---------- the app contract: ONE channel from the viewer to whatever app it is showing ----------
// (Key, 2026-09-20: "one pattern that can issue both, or any number of different commands, to our family of
// apps".) The viewer holds a small state object; every key becomes a data-attribute on the hosted page's
// <html>, and the page gets one `thor:state` event with the whole state and what changed. Theme is just a key.
// One-shot actions that are not state go out as `thor:command`. Apps that don't implement it are unaffected.
const STATE_FILE = process.env.THOR_APP_STATE_FILE || '/home/key/.local/state/thor-viewer/app-state.json';
const OLD_THEME_FILE = process.env.THOR_THEME_FILE || '/home/key/.cache/thor-viewer-theme';
const SETTINGS = {                              // key -> { values, default }: the whole contract, in one place
  theme:  { values: ['standard', 'solid'], default: 'standard' },
  chrome: { values: ['shown', 'hidden'], default: 'shown' },   // 'hidden' = app hides its own UI too
};
const DEFAULT_STATE = Object.fromEntries(Object.entries(SETTINGS).map(([k, v]) => [k, v.default]));
let stateCache = null;
async function getState() {
  if (stateCache) return stateCache;
  let s = {};
  try { s = JSON.parse(await readFile(STATE_FILE, 'utf8')); } catch {
    try { const t = (await readFile(OLD_THEME_FILE, 'utf8')).trim(); if (SETTINGS.theme.values.includes(t)) s = { theme: t }; } catch {}   // migrate the old theme file
  }
  stateCache = { ...DEFAULT_STATE, ...Object.fromEntries(Object.entries(s).filter(([k, v]) => SETTINGS[k]?.values.includes(v))) };
  return stateCache;
}
async function setState(patch) {
  const cur = await getState(), next = { ...cur };
  const changed = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!SETTINGS[k] || !SETTINGS[k].values.includes(v) || cur[k] === v) continue;
    next[k] = v; changed.push(k);
  }
  if (changed.length) {
    stateCache = next;
    await mkdir(STATE_FILE.replace(/\/[^/]*$/, ''), { recursive: true }).catch(() => {});
    await writeFile(STATE_FILE, JSON.stringify(next, null, 1));
  }
  return { state: next, changed };
}
// The script sent into the hosted page. Defaults are expressed as "no attribute", so a fresh page is correct.
const stateJs = (state, changed) => `(() => { const s = ${JSON.stringify(state)}, c = ${JSON.stringify(changed)}, d = ${JSON.stringify(DEFAULT_STATE)};
  const go = () => { const r = document.documentElement; if (!r) return;
    for (const [k, v] of Object.entries(s)) { if (v === d[k]) delete r.dataset[k]; else r.dataset[k] = v; }
    window.dispatchEvent(new CustomEvent('thor:state', { detail: { state: s, changed: c } }));
    if (c.includes('theme')) window.dispatchEvent(new CustomEvent('thor:theme', { detail: { theme: s.theme } })); };
  go(); if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); return s; })()`;
const commandJs = (name, args) => `(() => { window.dispatchEvent(new CustomEvent('thor:command', { detail: { name: ${JSON.stringify(name)}, args: ${JSON.stringify(args || {})} } })); return true; })()`;
async function sendToPage(js) {
  if (live.status().attached) return live.evalInFrame(js);                    // Live: over CDP into the live frame
  return { ok: await runAgentBrowser(['eval', js]) };                          // Stream: the headless page (gate off)
}
async function applyState(force = false, changed = null) {
  const state = await getState();
  const keys = changed || Object.keys(state).filter(k => state[k] !== DEFAULT_STATE[k]);
  if (!keys.length && !force) return { ok: true, skipped: true };              // a fresh page already matches the defaults
  return sendToPage(stateJs(state, keys));
}
// kept so older callers and tests keep working
async function getTheme() { return (await getState()).theme; }
async function applyTheme(force = false) { return applyState(force); }
live.onLiveContext(() => applyState().catch(() => {}));

// the shared tab list: { tabs: [{ id, url, title }], active, next }, persisted so every mode and reload gets it
const TABS_FILE = process.env.THOR_TABS_FILE || '/home/key/.cache/thor-viewer-tabs.json';
function cleanShared(s) {
  if (!s || !Array.isArray(s.tabs)) return null;
  const seen = new Set(), tabs = [];
  for (const t of s.tabs.slice(0, 50)) {                    // no duplicates by URL (the active one wins its URL)
    if (!t || typeof t.id !== 'string' || typeof t.url !== 'string') continue;
    const dup = t.url && seen.has(t.url) && t.id !== s.active; if (dup) continue;
    if (t.url) seen.add(t.url); tabs.push({ id: t.id, url: t.url, title: String(t.title || '').slice(0, 200) });
  }
  const active = tabs.some(t => t.id === s.active) ? s.active : tabs[tabs.length - 1]?.id || null;
  // `session` identifies the browser process these tabs belong to; it survives cleaning so a restart is
  // distinguishable from Key closing tabs.
  const out = { tabs, active, next: Math.max(Number(s.next) || 1, tabs.length + 1) };
  if (typeof s.session === 'string' && s.session) out.session = s.session;
  return out;
}
async function readShared() { try { return cleanShared(JSON.parse(await readFile(TABS_FILE, 'utf8'))) || { tabs: [], active: null, next: 1 }; } catch { return { tabs: [], active: null, next: 1 }; } }
async function writeShared(s) { await writeFile(TABS_FILE, JSON.stringify(s)); }
// pinned tabs: [{ id, url, title }] in pin order (public/pins.js explains the matching)
// Pins are Key's and must survive anything: kept in ~/.local/state (not the cache), written atomically
// (temp file + rename), with the previous version kept as .bak and used if the main file is unreadable.
const PINS_FILE = process.env.THOR_PINS_FILE || '/home/key/.local/state/thor-viewer/pins.json';
const OLD_PINS_FILE = '/home/key/.cache/thor-viewer-pins.json';     // first location (2026-09-19), migrated once
async function readPinsFrom(f) { const p = JSON.parse(await readFile(f, 'utf8')); if (!Array.isArray(p)) throw new Error('bad pins'); return p; }
async function readPins() {
  for (const f of [PINS_FILE, PINS_FILE + '.bak', ...(process.env.THOR_PINS_FILE ? [] : [OLD_PINS_FILE])]) {
    try { return await readPinsFrom(f); } catch {}
  }
  return [];
}
async function writePins(p) {
  await mkdir(PINS_FILE.replace(/\/[^/]*$/, ''), { recursive: true });
  await copyFile(PINS_FILE, PINS_FILE + '.bak').catch(() => {});
  await writeFile(PINS_FILE + '.tmp', JSON.stringify(p.slice(0, 20), null, 1)); await rename(PINS_FILE + '.tmp', PINS_FILE);
}
// Who may pin or unpin: Key in the viewer drawer (a same-origin fetch from the viewer page: the browser sets
// Sec-Fetch-Site and Origin, which a stray curl doesn't), or the pins tool (tools/pins), which a Claude Code
// hook lets agents run only when Key's latest message asks for it (~/.claude/hooks/guard-pins.py).
function mayChangePins(req) {
  if (req.headers['x-thor-pins'] === 'tools/pins') return true;
  return req.headers['sec-fetch-site'] === 'same-origin' && req.headers.origin === `http://${req.headers.host}`;
}
async function pinnedView(tabs) {                              // tabs -> pinned-first order, persisting pin moves
  const r = applyPins(await readPins(), tabs); if (r.changed) await writePins(r.pins); return r.order;
}
// agent-browser's tab list keeps the title a tab had when it opened (often just its URL); Chrome's own target
// list (/json/list on the CDP port) has the current one. Fresh titles by targetId; the CDP address is cached.
let cdpHttp = null;
const unescapeHtml = t => t.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
async function tabList() {
  const out = await agentBrowserJson(['tab', 'list']), list = out?.data?.tabs;
  if (!Array.isArray(list)) return list;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!cdpHttp) { const u = (await agentBrowserJson(['get', 'cdp-url']))?.data?.cdpUrl; cdpHttp = u ? u.replace(/^ws:\/\/([^/]+).*$/, 'http://$1') : null; }
    if (!cdpHttp) break;
    try {
      const targets = await (await fetch(cdpHttp + '/json/list', { signal: AbortSignal.timeout(1500) })).json();
      const byId = new Map(targets.map(t => [t.id, unescapeHtml(String(t.title || ''))]));
      for (const t of list) { const f = byId.get(t.targetId); if (f) t.title = f; }
      break;
    } catch { cdpHttp = null; }                                  // browser restarted: look the address up again
  }
  return list;
}
// A tab Key closes must really close: the headless page behind it is what Stream shows, so a tab left open
// there comes back the next time Stream rebuilds the list (Key, 2026-09-19: "no floating streams").
async function closeHeadlessTab(url) {
  if (!/^https?:\/\//.test(url || '')) return false;
  const pins = await readPins();
  if (pins.some(p => p.url === url)) return false;                 // a pinned tab is never closed by an agent or a sync
  const list = (await tabList()) || [];
  let ok = false;
  for (const t of list) if (t.url === url) ok = (await runAgentBrowser(['tab', 'close', t.tabId])) || ok;
  return ok;
}
// Make the headless tabs match the shared list exactly: close what Key closed, open what Live added, then
// switch to the active one. Runs when the viewer leaves Live.
async function syncHeadlessToShared() {
  const s = await readShared(), want = s.tabs.filter(t => /^https?:\/\//.test(t.url));
  if (!want.length) return true;
  const pins = await readPins(), keep = new Set([...want.map(t => t.url), ...pins.map(p => p.url)]);
  for (const t of (await tabList()) || []) if (/^https?:\/\//.test(t.url || '') && !keep.has(t.url)) await runAgentBrowser(['tab', 'close', t.tabId]);
  const have = new Set(((await tabList()) || []).map(t => t.url));
  for (const t of want) if (!have.has(t.url)) await runAgentBrowser(['tab', 'new', t.url]);
  const act = want.find(t => t.id === s.active) || want[want.length - 1];
  const m = ((await tabList()) || []).find(t => t.url === act.url);
  return m ? await runAgentBrowser(['tab', m.tabId]) : true;
}

// Which browser process the tabs belong to. The headless browser losing its tabs on restart is not the same
// event as Key closing them, and the difference decides whether they come back (Key, 2026-09-21: "restarting
// shouldn't remove tabs. It should always be consistent like a real browser"). agent-browser writes the pid of
// each session, so that file is the session's identity; a changed pid means a different browser.
const AB_SESSION = (() => {
  const i = AB_ARGS.indexOf('--session');
  return i >= 0 && AB_ARGS[i + 1] ? AB_ARGS[i + 1] : 'thor';
})();
const AB_PID_FILE = `/home/key/.agent-browser/${AB_SESSION}.pid`;
async function browserSession() {
  try { return (await readFile(AB_PID_FILE, 'utf8')).trim() || null; } catch { return null; }
}

async function sharedFromHeadless(prev) {
  const list = await tabList();
  if (!Array.isArray(list)) return prev;                        // headless not answering: keep what we have

  // A restarted browser comes back empty. Adopting that would throw away tabs nobody closed, so instead put the
  // stored ones back into it — the same direction used when leaving Live. Within one session we adopt as normal,
  // which is what keeps a tab Key closed from reappearing.
  const session = await browserSession();
  if (session && prev.session && session !== prev.session && prev.tabs.length) {
    await writeShared({ ...prev, session });                    // claim the new session first: restoring reads this
    await syncHeadlessToShared();
    const back = await tabList();
    if (Array.isArray(back) && back.length) return await sharedFromHeadless({ ...prev, session });
    return { ...prev, session };
  }
  if (session && session !== prev.session) prev = { ...prev, session };
  let next = prev.next || 1;
  const tabs = list.filter(t => /^https?:\/\//.test(t.url || '')).map(t => ({ id: 'S' + (t.tabId || next++), url: t.url, title: t.title || '' }));
  const act = list.find(t => t.active), s = cleanShared({ tabs, active: act ? 'S' + act.tabId : null, next, session: prev.session });
  await writeShared(s); return s;
}

function pageErrors() {
  return new Promise(resolve => {
    execFile(AGENT_BROWSER, [...AB_ARGS, 'errors', '--json'], { timeout: 10000, ...AB_ENV }, (err, stdout) => {
      try { resolve(JSON.parse(stdout).data?.errors ?? []); } catch { resolve([]); }
    });
  });
}


// Device temperature from /sys (the browser can't read it). Battery temp is deci-degC (÷10); thermal
// zones are milli-degC (÷1000). SoC = hottest cpu/gpu/aoss zone (reflects load), returned for later use.
let HOT_ZONE_PATHS = null;
async function hotZonePaths() {
  if (HOT_ZONE_PATHS) return HOT_ZONE_PATHS;
  HOT_ZONE_PATHS = [];
  for (let i = 0; i < 60; i++) {
    try {
      const type = (await readFile(`/sys/class/thermal/thermal_zone${i}/type`, 'utf8')).trim();
      if (/^(cpu|gpu|aoss)/.test(type)) HOT_ZONE_PATHS.push(`/sys/class/thermal/thermal_zone${i}/temp`);
    } catch { /* zone gap or unreadable — skip */ }
  }
  return HOT_ZONE_PATHS;
}
// Thermal zones by type, listed once; each /api/temp then reads only the few files it needs (the client polls
// only while the stats bar is shown). body = xo-therm (board; this device has no skin zone), cpu = max of
// cpu-* / cpuss-*, gpu = max of gpuss-*. All in C (the client shows F).
let zonesP = null;                                       // a promise, so concurrent first calls share one complete scan
function zones() { return zonesP ??= scanZones(); }
async function scanZones() {
  const zoneMap = { battery: [], body: [], cpu: [], gpu: [] };
  try {
    for (const z of await readdir('/sys/class/thermal')) {
      if (!z.startsWith('thermal_zone')) continue;
      let type = ''; try { type = (await readFile(`/sys/class/thermal/${z}/type`, 'utf8')).trim(); } catch { continue; }
      const k = type === 'battery' ? 'battery' : type === 'xo-therm' ? 'body' : /^cpu(ss)?-/.test(type) ? 'cpu' : /^gpuss-/.test(type) ? 'gpu' : null;
      if (k) zoneMap[k].push(`/sys/class/thermal/${z}/temp`);
    }
  } catch {}
  return zoneMap;
}
async function maxOf(paths) {
  let max = -Infinity;
  for (const p of paths) { try { const v = parseInt(await readFile(p, 'utf8'), 10); if (Number.isFinite(v) && v > max) max = v; } catch {} }
  return max > -Infinity ? Math.round(max / 100) / 10 : null;
}
async function readTemp() {
  let battery = null, soc = null;
  try { const v = parseInt(await readFile('/sys/class/power_supply/battery/temp', 'utf8'), 10); if (Number.isFinite(v)) battery = Math.round(v) / 10; } catch {}
  try {
    let max = 0;
    for (const path of await hotZonePaths()) { try { const v = parseInt(await readFile(path, 'utf8'), 10); if (Number.isFinite(v) && v > max) max = v; } catch {} }
    if (max > 0) soc = Math.round(max / 100) / 10;
  } catch {}
  const z = await zones();
  const [zb, body, cpu, gpu] = await Promise.all([maxOf(z.battery), maxOf(z.body), maxOf(z.cpu), maxOf(z.gpu)]);
  return { battery: battery ?? zb, soc, body, cpu, gpu };
}

createServer(async (req, res) => {
  let path = new URL(req.url, 'http://x').pathname;
  if (await live.handle(req, res, path, async () => { let b = ''; for await (const c of req) b += c; return b; })) return;
  // ---------- the app contract ----------
  // GET  /api/app                 -> { state, settings }
  // POST /api/app   {theme,chrome}-> merge, persist, push to the page
  // POST /api/app/apply           -> re-push after a navigation (skips keys already at their default)
  // POST /api/app/command {name}  -> a one-shot `thor:command` in the page (not state)
  // /api/theme is kept as a thin alias so older callers keep working.
  if ((path === '/api/app' || path === '/api/theme') && req.method === 'GET') {
    const state = await getState();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(path === '/api/theme' ? { theme: state.theme } : { state, settings: SETTINGS }));
  }
  if (/^\/api\/(app|theme)(\/(apply|command))?$/.test(path) && req.method === 'POST') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
    if (path === '/api/app/command') {
      if (!p.name) { res.writeHead(400); return res.end(JSON.stringify({ ok: false, reason: 'need a command name' })); }
      const r = await sendToPage(commandJs(String(p.name), p.args));
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: !!(r && r.ok) }));
    }
    const patch = path === '/api/theme' ? { theme: p.theme } : p;
    const isChange = path === '/api/app' || path === '/api/theme';
    if (isChange && !Object.entries(patch).some(([k, v]) => SETTINGS[k]?.values.includes(v))) { res.writeHead(400); return res.end(); }
    const { state, changed } = isChange ? await setState(patch) : { state: await getState(), changed: null };
    const r = await applyState(isChange, isChange ? changed : null);           // a change always applies; a navigation skips defaults
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(path === '/api/theme' ? { theme: state.theme, applied: !!(r && r.ok) } : { state, changed, applied: !!(r && r.ok) }));
  }
  if (path === '/api/temp') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(await readTemp()));
  }
  if (path === '/api/errors') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify(await pageErrors()));
  }
  if (path === '/api/viewport' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    const { w, h } = JSON.parse(body || '{}');
    const ua = req.headers['user-agent'] || '';
    appendFile(INPUT_LOG, `${new Date().toISOString()} viewport ${w}x${h} from ${ua.slice(0, 80)}\n`).catch(() => {});
    if (/HeadlessChrome/.test(ua)) { res.writeHead(403, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, reason: 'test browsers may not resize the shared session' })); }
    const ok = Number.isInteger(w) && Number.isInteger(h) && w >= 200 && h >= 200 && w <= 4096 && h <= 4096 && await setViewport(w, h);
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }
  if (path === '/api/input-log' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    appendFile(INPUT_LOG, new Date().toISOString() + ' ' + body.slice(0, 2000) + '\n').catch(() => {});
    res.writeHead(204); return res.end();
  }
  // ---------- ONE shared tab list for Stream and Live (the viewer server owns it) ----------
  // Stream: the headless browser's tabs ARE the list; reading refreshes it from there. Live: the live client
  // writes it (open, switch, close, title). Entering Live reads it (so Live starts on the stream's active tab);
  // leaving Live points the headless page at Live's active URL (/api/shared-tabs/to-stream).
  if (path === '/api/shared-tabs' && req.method === 'GET') {
    let s = await readShared();
    if (live.modes.get().mode === 'stream' && !new URL(req.url, 'http://x').searchParams.has('raw')) s = await sharedFromHeadless(s);
    s = { ...s, tabs: await pinnedView(s.tabs) };                // each tab says `pinned`, pinned ones first
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); return res.end(JSON.stringify(s));
  }
  if (path.startsWith('/api/shared-tabs') && req.method === 'POST') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    let ok = false;
    if (path === '/api/shared-tabs') { const s = cleanShared(JSON.parse(body || '{}')); if (s) { await writeShared(s); ok = true; } }
    else if (path === '/api/shared-tabs/to-stream') ok = await syncHeadlessToShared();
    else if (path === '/api/shared-tabs/closed') { let p = {}; try { p = JSON.parse(body || '{}'); } catch {} ok = await closeHeadlessTab(p.url); }
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok }));
  }
  // ---------- pinned tabs ----------
  // GET /api/pins -> [{ id, url, title }]. POST /api/pins { op: 'pin'|'unpin', id, url, title }.
  // GET /api/pins/active -> { pinned, url }: is the tab agents would act on pinned? (gate + start.sh ask this)
  if (path === '/api/pins' && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); return res.end(JSON.stringify(await readPins()));
  }
  if (path === '/api/pins' && req.method === 'POST') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    if (!mayChangePins(req)) {
      res.writeHead(403, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: 'pins are changed only by Key in the viewer drawer, or with tools/pins when Key asks' }));
    }
    let body = ''; for await (const c of req) body += c;
    let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
    let pins = await readPins(), ok = false;
    const id = typeof p.id === 'string' ? p.id : null, url = typeof p.url === 'string' ? p.url : '';
    const r = applyPins(pins, [{ id, url }]), mine = r.order[0]?.pinned ? r.pins.findIndex(q => q.id === id) : -1;
    if (p.op === 'pin' && id && /^https?:\/\//.test(url)) { if (mine < 0) pins.push({ id, url, title: String(p.title || '').slice(0, 200) }); ok = true; }
    else if (p.op === 'unpin' && id) { pins = mine < 0 ? pins : r.pins.filter((_, i) => i !== mine); ok = true; }
    if (ok) await writePins(pins);
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok, pins }));
  }
  // POST /api/pins/restore (Stream only): reopen pinned tabs that aren't open (after the headless browser
  // restarted), in pin order; a blank active tab is reused for the first one. start.sh calls this.
  if (path === '/api/pins/restore' && req.method === 'POST') {
    let opened = 0;
    if (live.modes.get().mode === 'stream') {
      const list = (await tabList()) || [];
      const tabs = list.map(t => ({ id: t.tabId, url: t.url, title: t.title }));
      const pins = await readPins(), have = applyPins(pins, tabs).order.filter(t => t.pinned).map(t => t.url);
      let blank = list.find(t => t.active && !/^https?:\/\//.test(t.url || ''));
      for (const p of pins) {
        if (have.includes(p.url) || !/^https?:\/\//.test(p.url)) continue;
        if (await runAgentBrowser(blank ? ['open', p.url] : ['tab', 'new', p.url])) opened++;
        blank = null;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, opened }));
  }
  if (path === '/api/pins/active' && req.method === 'GET') {
    let s = await readShared();
    if (live.modes.get().mode === 'stream') s = await sharedFromHeadless(s);
    const tabs = await pinnedView(s.tabs), a = tabs.find(t => t.id === s.active);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify({ pinned: !!a?.pinned, url: a?.url || '', title: a?.title || '' }));
  }
  if (path === '/api/tabs' && req.method === 'GET') {
    const list = await tabList();
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify((list ?? []).map(t => ({ id: t.tabId, targetId: t.targetId, title: t.title, url: t.url, active: !!t.active }))));
  }
  if (path.startsWith('/api/tabs/') && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
    const op = path.slice(10); let ok = false;
    if (op === 'new') ok = await runAgentBrowser(['tab', 'new', ...(/^https?:\/\/\S+$/.test(p.url || '') ? [p.url] : [])]);
    else if (op === 'switch' && TAB_REF.test(p.id || '')) ok = await runAgentBrowser(['tab', p.id]);
    else if (op === 'close' && TAB_REF.test(p.id || '')) ok = await runAgentBrowser(['tab', 'close', p.id]);
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }
  if (path === '/api/nav/open' && req.method === 'POST') {
    let body = ''; for await (const chunk of req) body += chunk;
    let url = ''; try { url = String(JSON.parse(body).url || ''); } catch {}
    const ok = /^https?:\/\/\S+$/.test(url) && await runAgentBrowser(['open', url]);
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }
  if (path.startsWith('/api/nav/') && req.method === 'POST') {
    const args = NAV[path.slice(9)];
    const ok = !!args && await runAgentBrowser(args);
    res.writeHead(ok ? 200 : 400, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok }));
  }
  if (path === '/') path = '/index.html';
  const file = join(ROOT, path);
  try {
    if (!file.startsWith(ROOT) || !(await stat(file)).isFile()) throw new Error('nope');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(await readFile(file));
  } catch {
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  live.recoverAtStartup();
  stat(PINS_FILE).catch(async () => { const p = await readPins(); if (p.length) await writePins(p); });   // migrate pins to the durable file
  console.log(`Thor Viewer running at http://127.0.0.1:${PORT}/`);
});
