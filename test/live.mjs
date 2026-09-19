// Live Page Mode end-to-end test, without the device and without touching the `thor` session.
//
// Two throwaway headless sessions with their own profiles:
//   livetest-host  hosts the viewer page (stands in for Key's installed app); its CDP port is the
//                  bridge's endpoint (LIVE_CDP), so no adb is involved.
//   livetest-park  stands in for the `thor` session that Live mode must park and restore.
// A fixture server plays the dev page shown live. Run: node test/live.mjs
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AB = process.env.AGENT_BROWSER || '/home/key/.local/bin/agent-browser';
const VIEWER = 4857, FIXTURE = 4858, PARK_STREAM = 9237;
const V = `http://127.0.0.1:${VIEWER}`, F = `http://127.0.0.1:${FIXTURE}`;
const tmp = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'live-test-'));
const HOST = ['--session', 'livetest-host', '--profile', join(tmp, 'host')];
const PARK = ['--session', 'livetest-park', '--profile', join(tmp, 'park')];

const ab = (args, ms = 60000) => new Promise(res => execFile(AB, args, { timeout: ms, killSignal: 'SIGKILL' }, (e, out) => res(String(out || '').trim())));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const get = async p => (await fetch(V + p)).json();
const post = async (p, b) => (await fetch(V + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b || {}) })).json();
const evalHost = async js => { const o = await ab([...HOST, 'eval', js]); try { return JSON.parse(o); } catch { return o; } };
async function until(fn, ms = 12000) { const end = Date.now() + ms; let v; while (Date.now() < end) { if ((v = await fn())) return v; await sleep(400); } return v; }

let pass = 0, fail = 0;
const check = (name, ok, detail) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}${ok || detail === undefined ? '' : '\n        ' + JSON.stringify(detail)}`); };
const procs = [];
function serve(cmd, args, env) { const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: 'ignore' }); procs.push(p); return p; }

try {
  serve(process.execPath, ['test/fixtures/serve.mjs'], { PORT: String(FIXTURE) });
  await ab([...PARK, 'open', `${F}/?p=1#h`]);
  await ab([...PARK, 'stream', 'enable', '--port', String(PARK_STREAM)]);
  await ab([...HOST, 'open', 'about:blank']);
  const cdp = await ab([...HOST, 'get', 'cdp-url']);
  const port = (cdp.match(/127\.0\.0\.1:(\d+)/) || [])[1];
  check('host browser exposes CDP', !!port, cdp);
  serve(process.execPath, ['server.mjs'], { PORT: String(VIEWER), LIVE_CDP: `http://127.0.0.1:${port}`,
    LIVE_PARK_ARGS: PARK.join(' '), LIVE_STREAM_PORT: String(PARK_STREAM) });
  await until(() => fetch(V + '/').then(r => r.ok, () => false), 8000);

  // Enter Live mode on load, with one live tab on the fixture.
  await ab([...HOST, 'open', `${V}/manifest.webmanifest`]);
  await evalHost(`localStorage.setItem('thorMode','live'); localStorage.setItem('thorLiveTabs', JSON.stringify({tabs:[{id:'L1',url:'${F}/',title:''}],active:'L1',next:2})); 1`);
  await ab([...HOST, 'open', `${V}/`]);
  const st = await until(async () => { const s = await get('/api/live/status'); return s.attached && s.frameUrl ? s : null; });
  check('bridge attaches to the viewer page and finds the live frame', st?.frameUrl === `${F}/`, st);

  console.log('one GPU: headless session parked while Live is on');
  check('parked URL remembered (with params and hash)', st?.parked?.url === `${F}/?p=1#h`, st?.parked);
  check('headless session is on about:blank', (await ab([...PARK, 'get', 'url'])) === 'about:blank');
  check('headless screencast is off', /disabled/i.test(await ab([...PARK, 'stream', 'status'])));
  const idle = await evalHost(`JSON.stringify({ws: typeof ws === 'undefined' ? null : (ws && ws.readyState), hidden: document.getElementById('screen').classList.contains('hidden'), streamOn})`);
  check('viewer: no stream socket, canvas hidden', (() => { const o = JSON.parse(idle); return o.ws == null && o.hidden && o.streamOn === false; })(), idle);

  console.log('the agent drives the live frame');
  const snap = await ab([...HOST, 'snapshot', '-i']);
  const ref = (snap.match(/button "Add one" \[ref=(e\d+)\]/) || [])[1];
  check('snapshot reaches inside the frame', !!ref, snap.slice(0, 300));
  if (ref) { await ab([...HOST, 'click', '@' + ref]); await ab([...HOST, 'click', '@' + ref]); }
  const count = await post('/api/live/eval', { expression: "document.getElementById('count').textContent" });
  check('clicks landed in the live page', count.value === '2', count);
  const logs = await until(async () => { const l = await get('/api/live/logs'); return l.some(x => x.text === 'count 2') ? l : null; }, 5000);
  check('live page console reaches the viewer logs', !!logs, logs);
  await post('/api/live/eval', { expression: "setTimeout(() => { throw new Error('fixture boom'); }); 1" });
  check('uncaught errors reach the logs', !!(await until(async () => (await get('/api/live/logs')).some(x => x.type === 'error' && /fixture boom/.test(x.text)), 5000)));
  const viewerLogs = await evalHost(`document.getElementById('log').textContent`);
  check('...and show in the viewer console overlay', /count 2/.test(viewerLogs) && /fixture boom/.test(viewerLogs), viewerLogs);

  const deep = `${F}/page2.html?scene=7&seed=42`;
  await evalHost(`nav.open('${deep}'); 1`);
  const s2 = await until(async () => { const s = await get('/api/live/status'); return s.frameUrl === deep && s.title ? s : null; });
  check('address bar opens a URL in the frame; title tracked', s2?.title === 'Live fixture two', s2);
  await post('/api/live/nav', { op: 'back' });
  check('back goes back inside the frame', !!(await until(async () => (await get('/api/live/status')).frameUrl === `${F}/`, 6000)));
  await post('/api/live/nav', { op: 'forward' });
  await until(async () => (await get('/api/live/status')).frameUrl === deep, 6000);

  console.log('WebGL fallback');
  const fb = await post('/api/live/fallback', { on: true });
  check('fallback loads the live page headless', fb.ok && (await ab([...PARK, 'get', 'url'])) === deep, fb);
  await post('/api/live/fallback', { on: false });
  check('...and returns it to blank', (await ab([...PARK, 'get', 'url'])) === 'about:blank');

  console.log('leaving Live mode');
  await evalHost(`live.exit(); 1`);
  const restored = await until(async () => (await ab([...PARK, 'get', 'url'])) === deep, 12000);
  check('headless session gets the live page back (URL and params)', !!restored, await ab([...PARK, 'get', 'url']));
  check('its stream is back on its port', (await ab([...PARK, 'stream', 'status'])).includes(`:${PARK_STREAM}`));
  const s3 = await get('/api/live/status');
  check('bridge detached', !s3.attached && !s3.parked, s3);
} catch (e) {
  check('test ran without throwing', false, String(e?.stack || e));
} finally {
  await ab([...HOST, 'close'], 20000); await ab([...PARK, 'close'], 20000);
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
