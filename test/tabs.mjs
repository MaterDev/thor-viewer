// One shared tab list for Stream and Live. Runs an ISOLATED second viewer (port 4851) with its own agent-browser
// session + profile, mode/tabs/theme files and an unreachable CDP address, so it never touches Key's viewer, his
// `thor` session or his Chrome, and works while he's in Live. Drives the real public/live.js in a headless page.
//   node --import /home/key/.local/share/playwright-mcp/platform-linux.mjs test/tabs.mjs      (npm run test:tabs)
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const ROOT = new URL('..', import.meta.url).pathname, V = 'http://127.0.0.1:4851';
const tmp = mkdtempSync(join(tmpdir(), 'thor-tabs-'));
const SESS = ['--session', 'tabtest', '--profile', join(tmp, 'profile')];
const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) + ')' : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ab = (args, timeout = 30000) => new Promise(r => execFile('/home/key/.local/bin/agent-browser', args, { timeout, env: { ...process.env, THOR_GATE: 'off' } }, (e, out) => r(String(out || '').trim())));
const get = p => fetch(V + p).then(r => r.json());
const post = (p, b) => fetch(V + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) }).then(r => r.json());
async function until(fn, ms = 10000) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(250); } return v; }
const page = createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<title>${req.url}</title><h1>${req.url}</h1>`); });
await new Promise(r => page.listen(0, '127.0.0.1', r));
const P = u => `http://127.0.0.1:${page.address().port}${u}`;

const srv = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: 'ignore', env: { ...process.env, PORT: '4851', HEADLESS_AB_ARGS: SESS.join(' '),
  LIVE_CDP: 'http://127.0.0.1:9', LIVE_NOTIFY: '0', LIVE_MODE_FILE: join(tmp, 'mode'), LIVE_MODE_LOG: join(tmp, 'modes.log'), LIVE_HEAT_FILE: join(tmp, 'heat.json'),
  THOR_TABS_FILE: join(tmp, 'tabs.json'), THOR_PINS_FILE: join(tmp, 'pins.json'), THOR_THEME_FILE: join(tmp, 'theme') } });
let browser;
try {
  await until(() => fetch(V + '/').then(r => r.ok, () => false));
  // 1. Stream: the headless page's tab is the shared list
  await ab([...SESS, 'open', P('/a')]);
  const s1 = await get('/api/shared-tabs');
  const act = s => s.tabs.find(t => t.id === s.active)?.url;
  check('stream: shared list = the headless tabs, active is /a', act(s1) === P('/a'), s1);

  // 2. Stream -> Live: live.js starts on the stream's active tab
  const { chromium } = createRequire('/home/key/.local/share/playwright-mcp/node_modules/')('playwright-core');
  browser = await chromium.launch({ executablePath: '/data/data/com.termux/files/usr/bin/chromium-browser', headless: true, args: ['--no-sandbox', '--disable-gpu'] });
  const pg = await browser.newPage();
  await pg.goto(V + '/manifest.webmanifest');
  await pg.evaluate(async () => {
    const noop = () => {}; const shell = { setTabs: t => (window.__tabs = t), setUrl: noop, addHistory: noop, addLog: noop, clearLog: noop, status: noop, pollTemp: noop, fallback: noop, streamUrl: () => '' };
    const m = await import('/live.js'); window.__live = m.create(shell); await window.__live.enter();
  });
  const frame = await until(() => pg.evaluate(() => document.getElementById('liveFrame')?.getAttribute('src')));
  check('stream -> live: the live page opens the stream\'s active tab', frame === P('/a'), frame);

  // 3. an open in Live (the agent's gate uses /api/live/open) updates the shared list
  await until(async () => (await get('/api/live/status')).clients > 0, 8000);
  const o = await post('/api/live/open', { url: P('/d?x=1') });
  const s3 = await until(async () => { const s = await get('/api/shared-tabs?raw'); return act(s) === P('/d?x=1') ? s : null; });
  check('live: agent open updates the shared list (params kept)', !!s3 && o.ok, s3 || o);

  // 4. Live -> Stream: the headless page follows Live's active tab
  await pg.evaluate(() => window.__live.exit());
  const u4 = await until(async () => { const u = await ab([...SESS, 'get', 'url']); return u === P('/d?x=1') ? u : null; }, 15000);
  check('live -> stream: the headless page opens the live tab', u4 === P('/d?x=1'), u4 || await ab([...SESS, 'get', 'url']));

  // 5. an agent open in Stream updates the shared list
  await until(async () => (await get('/api/mode')).mode === 'stream', 8000);
  await ab([...SESS, 'open', P('/c')]);
  const s5 = await get('/api/shared-tabs');
  check('stream: agent open updates the shared list', act(s5) === P('/c'), s5);
  check('no duplicate URLs in the shared list', new Set(s5.tabs.map(t => t.url)).size === s5.tabs.length, s5.tabs.map(t => t.url));
} finally {
  await browser?.close(); srv.kill(); page.close();
  await ab([...SESS, 'close'], 20000); rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter(r => !r).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
