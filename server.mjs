// Thor Viewer: serves the full-screen live view of the agent-browser session.
// Static files, plus /api/errors which asks agent-browser for uncaught page
// errors (the live stream carries console output but not exceptions).
// Run: node server.mjs   (prints the URL)
import { createServer } from 'node:http';
import { readFile, stat, appendFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as live from './live-bridge.mjs';   // Live Page Mode (CDP to the viewer's own page)

const PORT = Number(process.env.PORT || 4850);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const AGENT_BROWSER = '/home/key/.local/bin/agent-browser';
// The server's own calls always mean the headless `thor` session, never the routing gate's Live target.
const AB_ENV = { env: { ...process.env, THOR_GATE: 'off' } };
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
    execFile(AGENT_BROWSER, ["set", "viewport", String(w), String(h)], { timeout: 15000, ...AB_ENV }, err => resolve(!err));
  });
}

const INPUT_LOG = '/home/key/.cache/thor-viewer-input.log';
const NAV = { back: ['back'], forward: ['forward'], reload: ['reload'] };
const TAB_REF = /^(t\d+|[A-F0-9]{32})$/;
function agentBrowserJson(args) {
  return new Promise(resolve => execFile(AGENT_BROWSER, [...args, '--json'], { timeout: 15000, ...AB_ENV }, (err, stdout) => {
    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
  }));
}
function runAgentBrowser(args) {
  return new Promise(resolve => execFile(AGENT_BROWSER, args, { timeout: 15000, ...AB_ENV }, err => resolve(!err)));
}

// ---------- theme: one choice for the viewer shell AND the hosted page (Theme contract, CLAUDE.md) ----------
// Persisted server-side so every mode and page gets it. Applying = one small script in the hosted page that
// sets <html data-theme> and dispatches a 'thor:theme' event; pages without the contract are unaffected.
const THEME_FILE = '/home/key/.cache/thor-viewer-theme';
const THEMES = ['standard', 'solid'];
async function getTheme() { try { const t = (await readFile(THEME_FILE, 'utf8')).trim(); return THEMES.includes(t) ? t : 'standard'; } catch { return 'standard'; } }
const themeJs = t => `(() => { const t = ${JSON.stringify(t)}; const go = () => { const r = document.documentElement; if (!r) return;
  if (t === 'standard') delete r.dataset.theme; else r.dataset.theme = t;
  window.dispatchEvent(new CustomEvent('thor:theme', { detail: { theme: t } })); };
  go(); if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go, { once: true }); return t; })()`;
async function applyTheme(force = false) {
  const t = await getTheme();
  if (t === 'standard' && !force) return { ok: true, skipped: true };        // a fresh page is already standard
  if (live.status().attached) return live.evalInFrame(themeJs(t));             // Live: over CDP into the live frame
  return { ok: await runAgentBrowser(['eval', themeJs(t)]) };                    // Stream: the headless page (gate off)
}
live.onLiveContext(() => applyTheme().catch(() => {}));

function pageErrors() {
  return new Promise(resolve => {
    execFile(AGENT_BROWSER, ['errors', '--json'], { timeout: 10000, ...AB_ENV }, (err, stdout) => {
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
  if (path === '/api/theme' && req.method === 'GET') { res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' }); return res.end(JSON.stringify({ theme: await getTheme() })); }
  if ((path === '/api/theme' || path === '/api/theme/apply') && req.method === 'POST') {
    if (!/^application\/json/.test(req.headers['content-type'] || '')) { res.writeHead(415); return res.end(); }
    let body = ''; for await (const c of req) body += c;
    if (path === '/api/theme') { const { theme } = JSON.parse(body || '{}'); if (!THEMES.includes(theme)) { res.writeHead(400); return res.end(); } await writeFile(THEME_FILE, theme + '\n'); }
    const r = await applyTheme(path === '/api/theme');                          // a change always applies; a navigation skips standard
    res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ theme: await getTheme(), applied: !!(r && r.ok) }));
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
  if (path === '/api/tabs' && req.method === 'GET') {
    const out = await agentBrowserJson(['tab', 'list']);
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-cache' });
    return res.end(JSON.stringify((out?.data?.tabs ?? []).map(t => ({ id: t.tabId, targetId: t.targetId, title: t.title, url: t.url, active: !!t.active }))));
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
  console.log(`Thor Viewer running at http://127.0.0.1:${PORT}/`);
});
