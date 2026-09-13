// Thor Viewer: serves the full-screen live view of the agent-browser session.
// Static files, plus /api/errors which asks agent-browser for uncaught page
// errors (the live stream carries console output but not exceptions).
// Run: node server.mjs   (prints the URL)
import { createServer } from 'node:http';
import { readFile, stat, appendFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT || 4850);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), 'public');
const AGENT_BROWSER = '/home/key/.local/bin/agent-browser';
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
    execFile(AGENT_BROWSER, ["set", "viewport", String(w), String(h)], { timeout: 15000 }, err => resolve(!err));
  });
}

const INPUT_LOG = '/home/key/.cache/thor-viewer-input.log';
const NAV = { back: ['back'], forward: ['forward'], reload: ['reload'] };
const TAB_REF = /^(t\d+|[A-F0-9]{32})$/;
function agentBrowserJson(args) {
  return new Promise(resolve => execFile(AGENT_BROWSER, [...args, '--json'], { timeout: 15000 }, (err, stdout) => {
    try { resolve(JSON.parse(stdout)); } catch { resolve(null); }
  }));
}
function runAgentBrowser(args) {
  return new Promise(resolve => execFile(AGENT_BROWSER, args, { timeout: 15000 }, err => resolve(!err)));
}

function pageErrors() {
  return new Promise(resolve => {
    execFile(AGENT_BROWSER, ['errors', '--json'], { timeout: 10000 }, (err, stdout) => {
      try { resolve(JSON.parse(stdout).data?.errors ?? []); } catch { resolve([]); }
    });
  });
}

createServer(async (req, res) => {
  let path = new URL(req.url, 'http://x').pathname;
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
  console.log(`Thor Viewer running at http://127.0.0.1:${PORT}/`);
});
