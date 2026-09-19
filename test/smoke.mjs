// End-to-end smoke test for Thor Viewer. Drives the real viewer page in a headless
// Chromium (playwright-core from the Playwright MCP install) against the real
// agent-browser "thor" session, and checks results through the agent-browser CLI.
//
// Requires the viewer, agent-browser and its stream to be running:
//   ~/.claude/skills/agent-browser/start.sh
// Run:  npm test
// Note: it navigates the shared "thor" session (and restores the URL at the end),
// so don't run it while someone is using the viewer.
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';

const VIEWER = 'http://127.0.0.1:4850/';
const AB = '/home/key/.local/bin/agent-browser';
const CHROMIUM = '/data/data/com.termux/files/usr/bin/chromium-browser';
const require = createRequire('/home/key/.local/share/playwright-mcp/node_modules/');
const { chromium } = require('playwright-core');

const PAGE = `<html><head><title>viewer test</title></head><body style="font:24px sans-serif;margin:16px">
<h1 id="t">Waiting</h1><input id="n" placeholder="name"><button id="g" onclick="t.textContent='Hello, '+n.value;console.log('greeted '+n.value)">Greet</button>
<button id="x" onclick="undefinedFn()">Break</button>
<div id="tap" style="width:260px;height:120px;background:#9cf;margin-top:16px" onclick="this.textContent='tapped'">tap zone</div>
<div style="height:3000px"></div></body></html>`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ab = (...args) => new Promise(resolve => execFile(AB, args, { env: { ...process.env, THOR_GATE: 'off' }, timeout: 20000 }, (err, stdout) => resolve(err ? '' : stdout.trim())));
const abEval = async js => { try { let v = JSON.parse(await ab('eval', js)); if (typeof v === 'string' && /^[\[{]/.test(v)) v = JSON.parse(v); return v; } catch { return null; } };
async function until(fn, ms = 6000, step = 200) { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await sleep(step); } return v; }

// ---- preconditions ----
const viewerUp = await fetch(VIEWER).then(r => r.ok).catch(() => false);
if (!viewerUp) { console.log('FAIL  viewer not running at ' + VIEWER + ' (run ~/.claude/skills/agent-browser/start.sh)'); process.exit(1); }
const originalUrl = await ab('get', 'url');
if (!originalUrl) { console.log('FAIL  agent-browser session not reachable (run ~/.claude/skills/agent-browser/start.sh)'); process.exit(1); }

const server = createServer((_, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PAGE); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const testUrl = `http://127.0.0.1:${server.address().port}/`;
await ab('open', testUrl);

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
const pageErrors = [];
page.on('console', m => { if (m.type() === 'error' && !/status of 403/.test(m.text())) pageErrors.push(m.text()); }); // the viewport-guard check causes an intentional 403
page.on('pageerror', e => pageErrors.push(String(e)));

try {
  await page.goto(VIEWER);
  const gotFrame = await until(() => page.evaluate(() => frame !== null && fw > 0), 10000);
  check('viewer loads and receives a frame', !!gotFrame);
  check('status overlay hidden after first frame', await page.evaluate(() => document.getElementById('status').classList.contains('hidden')));
  check('Carbon icon sprite loaded', await page.evaluate(() => fetch('icons.svg').then(r => r.ok)));

  // Shell stats bar: persistent, thin, translucent, centered in the gap between the corner buttons, click-through.
  const stats = await page.evaluate(() => { const el = document.getElementById('stats'); if (!el) return null; const cs = getComputedStyle(el); const r = el.getBoundingClientRect(); const tabs = document.getElementById('tabsBtn').getBoundingClientRect(); const url = document.getElementById('urlBtn').getBoundingClientRect(); return { visible: cs.display !== 'none', pe: cs.pointerEvents, translucent: parseFloat(cs.opacity) < 1, thin: r.height <= 28, gap: r.left > tabs.right && r.right < url.left, hasFps: /fps/.test(el.textContent) }; });
  check('stats bar visible, thin, translucent, click-through', !!stats && stats.visible && stats.thin && stats.translucent && stats.pe === 'none', JSON.stringify(stats));
  check('stats bar centered between the corner buttons and shows fps', !!stats && stats.gap && stats.hasFps, JSON.stringify(stats));
  const temp = await (await fetch(`${VIEWER}api/temp`).catch(()=>({json:async()=>({})}))).json();
  check('/api/temp returns a numeric battery temperature', typeof temp.battery === 'number' && temp.battery > 0 && temp.battery < 100, JSON.stringify(temp));
  check('/api/temp also returns body, CPU and GPU (C)', ['body', 'cpu', 'gpu'].every(k => typeof temp[k] === 'number' && temp[k] > 0 && temp[k] < 130), JSON.stringify(temp));
  const tp = await until(() => page.evaluate(() => { const t = document.getElementById('temps'), h = document.getElementById('heatBtn').getBoundingClientRect(), tabs = document.getElementById('tabsBtn').getBoundingClientRect(), url = document.getElementById('urlBtn').getBoundingClientRect(), m = document.getElementById('modeBtn').getBoundingClientRect();
    return t && t.children.length ? { n: t.children.length, f: /°/.test(t.textContent), labels: [...t.children].every(c => /degrees Fahrenheit/.test(c.getAttribute('aria-label'))), heat48: h.width >= 48 && h.height >= 48, clear: h.left > tabs.right && m.right < url.left, fits: t.scrollWidth <= t.clientWidth + 1 } : null; }), 8000);
  check('temperatures in °F beside the heat-guard thermometer, labelled, no clipping or overlap', !!tp && tp.n >= 3 && tp.f && tp.labels && tp.heat48 && tp.clear && tp.fits, JSON.stringify(tp));

  // Remote page geometry -> viewer canvas coordinates
  const rects = await abEval(`JSON.stringify(Object.fromEntries(['t','n','g','x','tap'].map(id => { const r = document.getElementById(id).getBoundingClientRect(); return [id, { x: r.x + r.width / 2, y: r.y + r.height / 2 }]; })))`);
  check('remote test page rendered', !!rects?.tap && rects.tap.y > 0, rects ? `tap zone at ${Math.round(rects.tap.x)},${Math.round(rects.tap.y)}` : 'no rects');
  const tap = async id => page.evaluate(({ x, y }) => { const c = document.getElementById('screen'); const cx = view.x + x * view.scale, cy = view.y + y * view.scale; for (const t of ['mousedown', 'mouseup']) c.dispatchEvent(new MouseEvent(t, { clientX: cx, clientY: cy, bubbles: true })); }, rects[id]);

  await tap('tap');
  check('tap on the picture reaches the page', (await until(async () => (await ab('get', 'text', '#tap')) === 'tapped' ? 'tapped' : '')) === 'tapped');

  await tap('n'); await sleep(150);
  await page.evaluate(() => { const k = document.getElementById('key'); k.focus(); k.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertText', data: 'Thor', cancelable: true, bubbles: true })); });
  await sleep(150); await tap('g');
  check('typing via the keyboard field and tapping Greet', (await until(async () => (await ab('get', 'text', '#t')) === 'Hello, Thor' ? 'ok' : '')) === 'ok', await ab('get', 'text', '#t'));
  check('console message appears in the drawer log', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('#log div')].some(l => l.textContent.includes('greeted Thor'))))));
  const logLines = await page.evaluate(() => [...document.querySelectorAll('#log div')].filter(l => l.textContent.includes('greeted Thor')).length);
  check('console messages are not duplicated', logLines === 1, `${logLines} line(s)`);

  // Interleaved duplicates: the stream sends log,warn,log,warn; each must appear once (regression: dedup only compared the previous line)
  await ab('eval', "console.log('il-a');console.warn('il-b');1");
  await sleep(1200);
  const il = await page.evaluate(() => ['il-a','il-b'].map(s => [...document.querySelectorAll('#log div')].filter(l => l.textContent.includes(s)).length));
  check('interleaved console duplicates are collapsed', il[0] === 1 && il[1] === 1, `a:${il[0]} b:${il[1]}`);

  await tap('x'); await sleep(300);
  await page.evaluate(() => { document.getElementById('tabsBtn').click(); document.getElementById('con').click(); });
  check('uncaught page error shows in the console panel', !!(await until(() => page.evaluate(() => [...document.querySelectorAll('#log div.error')].some(l => l.textContent.includes('undefinedFn'))), 8000)));
  check('console panel opened', await page.evaluate(() => !document.getElementById('console').classList.contains('hidden')));
  await page.evaluate(() => document.getElementById('con').click());

  // Address bar
  await page.evaluate(() => document.getElementById('urlBtn').click());
  check('address bar expands and shows current URL', await page.evaluate(u => urlwrap.classList.contains('open') && urlEl.value === u, testUrl), await page.evaluate(() => urlEl.value));
  const refresh = await page.evaluate(() => { const r = document.getElementById('refreshBtn').getBoundingClientRect(), u = document.getElementById('url').getBoundingClientRect(); return { visible: getComputedStyle(document.getElementById('refreshBtn')).display !== 'none' && r.width > 0, gap: Math.round(r.left - u.right) }; });
  check('refresh stays visible beside the open address field', refresh.visible && refresh.gap >= 0 && refresh.gap <= 12, JSON.stringify(refresh));
  await page.evaluate(u => { urlEl.value = u; document.getElementById('urlbar').requestSubmit(); }, testUrl + '?nav=1');
  check('address bar navigates', !!(await until(async () => (await ab('get', 'url')).includes('nav=1'))), await ab('get', 'url'));
  check('address bar collapses after Go', await page.evaluate(() => !urlwrap.classList.contains('open')));
  check('refresh stays visible with the address bar collapsed', await page.evaluate(() => { const r = document.getElementById('refreshBtn').getBoundingClientRect(), a = document.getElementById('urlBtn').getBoundingClientRect(); return getComputedStyle(document.getElementById('refreshBtn')).display !== 'none' && Math.abs(r.left - a.right) <= 1; }));
  await page.evaluate(() => { document.getElementById('urlBtn').click(); urlEl.value = 'thor viewer test search'; document.getElementById('urlbar').requestSubmit(); });
  check('search terms go to a search engine', !!(await until(async () => (await ab('get', 'url')).includes('duckduckgo.com/?q=thor'))), await ab('get', 'url'));
  await ab('open', testUrl);

  // Tabs drawer: list, new, confirm-close
  await page.evaluate(() => document.getElementById('tabsBtn').click());
  const before = await until(() => page.evaluate(() => document.querySelectorAll('#tabList li:not(.empty)').length));
  check('tabs drawer lists the open tab(s)', before >= 1, `${before} tab(s)`);
  await sleep(2000); // let titles settle after navigation
  let redraws = 0; await page.evaluate(() => { window.__redraws = 0; new MutationObserver(() => window.__redraws++).observe(document.getElementById('tabList'), { childList: true }); });
  await sleep(2500); redraws = await page.evaluate(() => window.__redraws);
  check('tab list does not flicker while idle', redraws === 0, `${redraws} redraws in 2.5s`);
  await page.evaluate(() => document.getElementById('tabNew').click());
  const after = await until(() => page.evaluate(n => { const c = document.querySelectorAll('#tabList li:not(.empty)').length; return c > n ? c : 0; }, before), 8000);
  check('new tab appears in the drawer', after === before + 1, `${after} tab(s)`);
  await page.evaluate(() => { const li = document.querySelector('#tabList li:not(.active)') || document.querySelector('#tabList li'); li.querySelector('button.ib:not(.yes):not(.no)').click(); });
  check('closing a tab asks for confirmation first', await page.evaluate(() => !!document.querySelector('#tabList li.arming')));
  await page.evaluate(() => document.querySelector('#tabList li.arming .yes').click());
  const closed = await until(() => page.evaluate(n => document.querySelectorAll('#tabList li:not(.empty)').length === n ? 1 : 0, before), 8000);
  check('confirmed close removes the tab', !!closed, `${await page.evaluate(() => document.querySelectorAll('#tabList li:not(.empty)').length)} tab(s)`);
  await page.evaluate(() => document.getElementById('scrim').click());
  check('tapping outside closes the drawer', await page.evaluate(() => !drawer.classList.contains('open')));

  // Size guards
  const remoteBefore = await abEval(`innerWidth+'x'+innerHeight`);
  const status = await page.evaluate(() => fetch('/api/viewport', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ w: 900, h: 600 }) }).then(r => r.status));
  check('server refuses viewport changes from a headless (test) browser', status === 403, `HTTP ${status}`);
  await page.setViewportSize({ width: 1000, height: 450 }); await sleep(1200);
  check('height-only resize does not change the remote page size', (await abEval(`innerWidth+'x'+innerHeight`)) === remoteBefore, `${remoteBefore}`);

  // Regression: errors already in the buffer must NOT reappear when the viewer loads; new ones must still show.
  await ab('eval', "setTimeout(function(){throw new Error('STALE-'+Date.now())},0);1"); // pre-existing error
  await sleep(600);
  await page.reload(); await page.waitForFunction(() => typeof frame !== 'undefined' && frame !== null, { timeout: 10000 });
  await page.waitForFunction(() => errBaseInit === true, { timeout: 5000 });
  await page.evaluate(() => { document.getElementById('con').click(); });
  await sleep(800);
  const staleShown = await page.evaluate(() => [...document.querySelectorAll('#log div.error')].some(l => l.textContent.includes('STALE-')));
  check('stale errors do not reappear on load', !staleShown);
  const marker = 'LIVE-' + Date.now();
  await ab('eval', "setTimeout(function(){throw new Error('" + marker + "')},0);1");
  await page.evaluate(() => pollErrors()); await sleep(400); await page.evaluate(() => pollErrors()); await sleep(400);
  const liveShown = await page.evaluate(m => [...document.querySelectorAll('#log div.error')].some(l => l.textContent.includes(m)), marker);
  check('new errors after load still show', liveShown);

  // Drawer + Settings -> Themes (Standard glass / Solid: same palette, opaque, no backdrop-filter)
  check('top-left button is the Drawer', (await page.getAttribute('#tabsBtn', 'title')) === 'Drawer');
  await page.evaluate(() => document.getElementById('tabsBtn').click());
  await page.evaluate(() => document.getElementById('settingsBtn').click());
  check('settings modal opens with Standard and Solid', (await page.locator('#settingsBody [data-theme]').allTextContents()).join() === 'Standard,Solid');
  await page.evaluate(() => document.querySelector('#settingsBody [data-theme="solid"]').click());
  const solid = await page.evaluate(() => ({ t: document.documentElement.dataset.theme, bf: getComputedStyle(document.getElementById('tabsBtn')).backdropFilter }));
  check('Solid theme: no backdrop-filter', solid.t === 'solid' && solid.bf === 'none', JSON.stringify(solid));
  await page.evaluate(() => document.querySelector('#settingsBody [data-theme="standard"]').click());
  await page.evaluate(() => document.getElementById('settingsClose').click());
  check('settings closed = out of rendering', await page.evaluate(() => getComputedStyle(document.getElementById('settings')).display === 'none'));
  check('no JavaScript errors in the viewer page', pageErrors.length === 0, pageErrors.slice(0, 2).join(' | '));
} catch (e) {
  check('test run completed', false, String(e).slice(0, 200));
} finally {
  await browser.close().catch(() => {});
  server.close();
  if (originalUrl && !originalUrl.startsWith('about:')) await ab('open', originalUrl);
}
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
