// Live Page Mode end-to-end test, without the device and without touching the `thor` session.
//
// Two throwaway headless sessions with their own profiles:
//   livetest-host  hosts the viewer page (stands in for Key's installed app); its CDP port is the
//                  bridge's endpoint (LIVE_CDP), so no adb is involved.
//   livetest-park  stands in for the `thor` session that Live mode must freeze and resume.
// A fixture server plays the dev page shown live. Run: node test/live.mjs
import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const AB = process.env.AGENT_BROWSER || '/home/key/.local/bin/agent-browser';
const VIEWER = 4857, FIXTURE = 4858;
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
  await ab([...HOST, 'open', 'about:blank']);
  const cdp = await ab([...HOST, 'get', 'cdp-url']);
  const port = (cdp.match(/127\.0\.0\.1:(\d+)/) || [])[1];
  check('host browser exposes CDP', !!port, cdp);
  serve(process.execPath, ['server.mjs'], { PORT: String(VIEWER), LIVE_CDP: `http://127.0.0.1:${port}`,
    HEADLESS_AB_ARGS: PARK.join(' '), LIVE_NOTIFY: '0', LIVE_MODE_FILE: join(tmp, 'mode'), LIVE_MODE_LOG: join(tmp, 'modes.log') });
  // A ticking page in the headless session: rAF and timer counters, some scroll.
  await ab([...PARK, 'eval', "window.__n=0;(function f(){__n++;requestAnimationFrame(f)})();window.__t=0;setInterval(()=>__t++,100);document.body.style.height='3000px';scrollTo(0,321);1"]);
  await until(() => fetch(V + '/').then(r => r.ok, () => false), 8000);
  const tick = async () => { let o = await ab([...PARK, 'eval', 'JSON.stringify([__n,__t,location.href,scrollY])'], 8000); try { o = JSON.parse(o); o = JSON.parse(o); } catch {} return o; };
  const hA = await tick(), tA = Date.now();

  // Enter Live mode on load, with one live tab on the fixture.
  await ab([...HOST, 'open', `${V}/manifest.webmanifest`]);
  await evalHost(`localStorage.setItem('thorMode','live'); localStorage.setItem('thorLiveTabs', JSON.stringify({tabs:[{id:'L1',url:'${F}/',title:''}],active:'L1',next:2})); 1`);
  await ab([...HOST, 'open', `${V}/`]);
  const st = await until(async () => { const s = await get('/api/live/status'); return s.attached && s.frameUrl ? s : null; });
  check('bridge attaches to the viewer page and finds the live frame', st?.frameUrl === `${F}/`, st);

  console.log('one GPU: the headless page is frozen while Live is on');
  const mode1 = await get('/api/mode');
  check('mode is live', mode1.mode === 'live', mode1);
  await sleep(5000);                                    // let the frozen headless page sit
  const idle = await evalHost(`JSON.stringify({ws: typeof ws === 'undefined' ? null : (ws && ws.readyState), hidden: document.getElementById('screen').classList.contains('hidden'), streamOn})`);
  check('viewer: no stream socket, canvas hidden', (() => { const o = JSON.parse(idle); return o.ws == null && o.hidden && o.streamOn === false; })(), idle);

  console.log('the gate routes an agent to the live page (no flags)');
  const gate = (args) => new Promise(res => execFile(join(ROOT, 'tools/agent-browser-gate'), args, { timeout: 60000,
    env: { ...process.env, THOR_VIEWER_URL: V, THOR_GATE_REAL: '/home/key/.local/share/agent-browser/bin/agent-browser', AGENT_BROWSER_SESSION: 'thor', THOR_GATE: 'on' } },
    (e, out, err) => res({ code: e?.code ?? 0, out: String(out) + String(err) })));
  const gs = await gate(['snapshot', '-i']);
  check('gate: snapshot shows the live frame', /button "Add one"/.test(gs.out), gs.out.slice(0, 300));
  const gu = await gate(['get', 'url']);
  check('gate: get url is the live page', gu.out.trim() === `${F}/`, gu);
  const gc = await gate(['close']);
  check('gate: close is refused', gc.code === 64, gc);
  await ab(['--session', 'thor-live', 'close'], 20000);

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

  console.log('borrowing (agent needs its headless page)');
  await post('/api/live/eval', { expression: 'window.__n=0;(function f(){__n++;requestAnimationFrame(f)})();1' });
  await sleep(500);
  const l0 = (await post('/api/live/eval', { expression: '__n' })).value;
  const b1 = await post('/api/mode/borrow', { owner: 'test-a', ms: 20000 });
  check('borrow accepted', b1.ok && b1.mode === 'borrowed', b1);
  const hB = await tick(), tB = Date.now();
  const effFps = (hB[0] - hA[0]) / ((tB - tA) / 1000);   // includes the ~1s before the freeze landed
  check(`headless page was frozen during Live: ${effFps.toFixed(1)} rAF/s over ${Math.round((tB - tA) / 1000)}s (60 when running)`, effFps < 20, { hA, hB });
  const b2 = await post('/api/mode/borrow', { owner: 'test-b' });
  check('a second borrower is refused', !b2.ok && /already borrowed by test-a/.test(b2.reason), b2);
  check('the live page refuses evals while paused (no hang)', /paused/.test((await post('/api/live/eval', { expression: '1' })).reason || ''));
  await sleep(2000); const hC = await tick();
  check('headless page runs during the borrow', hC[0] - hB[0] > 30, { hB, hC });
  check('only the owner can give back', !(await post('/api/mode/return', { owner: 'test-b' })).ok);
  const r1 = await post('/api/mode/return', { owner: 'test-a' });
  check('give back -> live', r1.ok && r1.mode === 'live', r1);
  const l1 = (await post('/api/live/eval', { expression: '__n' })).value;
  check('live page was paused during the borrow (~2.5s)', l1 - l0 < 30, { l0, l1 });
  await sleep(1500); const l2 = (await post('/api/live/eval', { expression: '__n' })).value;
  check('live page running again', l2 - l1 > 30, { l1, l2 });
  check('the paused note is gone', (await evalHost(`String(!!document.getElementById('liveNote'))`)) === 'false');
  await post('/api/mode/borrow', { owner: 'crashy', ms: 1500 });
  check('a borrow nobody returns times out back to live', !!(await until(async () => (await get('/api/mode')).mode === 'live', 6000)));

  console.log('leaving Live mode');
  await sleep(1000);
  await evalHost(`live.exit(); 1`);
  check('mode back to stream', !!(await until(async () => (await get('/api/mode')).mode === 'stream', 8000)));
  const a0 = await tick(); await sleep(1500); const a1 = await tick();
  check('headless page resumed where it was (URL with params, scroll, JS state)', a0[2] === `${F}/?p=1#h` && a0[3] === 321 && a0[0] >= hC[0], { hC, a0 });
  check('...and is ticking again at speed', a1[0] - a0[0] > 30, { a0, a1 });
  const log = await import('node:fs').then(fs => fs.readFileSync(join(tmp, 'modes.log'), 'utf8'));
  check('mode changes are logged', /stream -> live/.test(log) && /live -> borrowed/.test(log) && /timed out/.test(log) && /live -> stream/.test(log), log);

  console.log('the viewer page navigating away ends Live (regression: on-device run stayed "live")');
  await evalHost(`localStorage.setItem('thorMode','live'); 1`);
  await ab([...HOST, 'open', `${V}/`]);
  check('back in live', !!(await until(async () => (await get('/api/live/status')).attached, 12000)));
  await ab([...HOST, 'open', `${F}/page2.html`]);
  check('navigating the viewer away -> stream, detached', !!(await until(async () => { const m = await get('/api/mode'), st = await get('/api/live/status'); return m.mode === 'stream' && !st.attached && st.clients === 0; }, 8000)));

  console.log('crash safety');
  const crash = `import('${ROOT}headless.mjs').then(async m => { await m.freezeHeadless(); process.exit(0); })`;
  await new Promise(r => execFile(process.execPath, ['-e', crash], { env: { ...process.env, HEADLESS_AB_ARGS: PARK.join(' ') }, timeout: 30000 }, r));
  const c0 = await tick(); await sleep(1500); const c1 = await tick();
  check('a process that froze the headless page and died leaves it running', c1[0] - c0[0] > 30, { c0, c1 });
  const s3 = await get('/api/live/status');
  check('bridge detached', !s3.attached, s3);
} catch (e) {
  check('test ran without throwing', false, String(e?.stack || e));
} finally {
  await ab([...HOST, 'close'], 20000); await ab([...PARK, 'close'], 20000);
  for (const p of procs) p.kill();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
