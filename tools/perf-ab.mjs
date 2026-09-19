// Stream vs Live A/B on the real device: for each scenario, run it in Stream and in Live for 60 s each and
// sample with tools/perf-sample.mjs. Drives Key's viewer app (switches its mode) and the headless `thor`
// session (THOR_GATE=off), so run it only when Key agrees, and nothing else is using the GPU.
//   node tools/perf-ab.mjs [--secs 60] [--only a,b,c]
// Thermal guard: a run starts only when the hottest zone is below START_C, and waits for COOL_C between runs.
import { execFile, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const SECS = Number(arg('secs') || 60), ONLY = (arg('only') || 'a,b,c').split(','), MODES = (arg('modes') || 'stream,live').split(',');
const START_C = 70, COOL_C = 65;
const VIEWER = 'http://127.0.0.1:4850';
const FIXTURE = 'http://127.0.0.1:4858/';
const SCENARIOS = [
  { id: 'a', label: 'static', url: FIXTURE },
  { id: 'b', label: 'canvas-lab-title', url: 'http://127.0.0.1:4860/?plugin=canvas-lab' },
  { id: 'c', label: 'demo-ripples', url: 'http://127.0.0.1:4860/?plugin=demo-ripples' },
].filter(s => ONLY.includes(s.id));

const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args, env = {}, timeout = 30000) => new Promise(r => execFile(cmd, args, { env: { ...process.env, ...env }, timeout }, (e, o, err) => r(String(o || '') + String(err || ''))));
const zones = readdirSync('/sys/class/thermal').filter(z => z.startsWith('thermal_zone')).map(z => `/sys/class/thermal/${z}/temp`);
const hottest = () => Math.max(...zones.map(z => { try { return Number(readFileSync(z, 'utf8')) || 0; } catch { return 0; } })) / 1000;
const log = (...a) => console.error(new Date().toISOString().slice(11, 19), ...a);

async function cdpEval(wsUrl, expression) {
  const ws = new WebSocket(wsUrl); await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  const res = await new Promise(r => { ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id === 1) r(d); }; ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } })); });
  ws.close(); return res.result?.result?.value;
}
// Key's viewer app: the fullscreen 4850 page. The forward is re-made each time (the viewer removes it on leaving Live).
async function app(expression) {
  await run('adb', ['forward', 'tcp:9222', 'localabstract:chrome_devtools_remote']);
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
  for (const t of list.filter(t => t.type === 'page' && t.url.startsWith(VIEWER))) {
    const fs = await Promise.race([cdpEval(t.webSocketDebuggerUrl, "matchMedia('(display-mode: fullscreen)').matches && document.visibilityState === 'visible'"), sleep(3000).then(() => false)]);
    if (fs) return cdpEval(t.webSocketDebuggerUrl, expression);
  }
  throw new Error('viewer app not found (open the Thor Viewer app on the top screen)');
}
const status = async () => { try { return await (await fetch(VIEWER + '/api/live/status')).json(); } catch { return {}; } };
// Open a URL in the live frame and confirm it landed (the viewer must be attached first).
async function liveOpen(url) {
  for (let i = 0; i < 30 && !(await status()).attached; i++) await sleep(500);
  const r = await (await fetch(VIEWER + '/api/live/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })).json().catch(() => ({}));
  if (!r.ok) return false;
  for (let i = 0; i < 30; i++) { if (((await status()).frameUrl || '').startsWith(url)) return true; await sleep(500); }   // the page may add params
  return false;
}
async function othersOnGpu() {
  const out = await run('pgrep', ['-af', 'gputest-profile|livetest|AGENT_BROWSER_SESSION=gputest|cleanroom']);
  return out.split('\n').filter(l => l && !l.includes('pgrep')).length > 0;
}
async function waitCool(limit) {
  let said = false;
  while (hottest() >= limit || await othersOnGpu()) {
    if (!said) { log(`waiting: hottest ${hottest().toFixed(1)}C (need < ${limit}) or another GPU test running`); said = true; }
    await sleep(15000);
  }
}

const fixture = spawn(process.execPath, ['test/fixtures/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: '4858' }, stdio: 'ignore' });
const startMode = process.env.RESTORE_MODE || await app('mode');                  // RESTORE_*: after an interrupted run
const liveTab = process.env.RESTORE_LIVE_TAB || await app("(() => { try { const s = JSON.parse(localStorage.getItem('thorLiveTabs')); return (s.tabs.find(t => t.id === s.active) || {}).url || ''; } catch { return ''; } })()");
const thorUrl = process.env.RESTORE_HEADLESS_URL || await (async () => {                    // the headless page's URL, read without touching its JS
  const ws = (await run('/home/key/.local/bin/agent-browser', ['get', 'cdp-url'], { THOR_GATE: 'off' })).match(/ws:\/\/\S+/)?.[0];
  const c = new WebSocket(ws); await new Promise(r => { c.onopen = r; });
  const res = await new Promise(r => { c.onmessage = m => r(JSON.parse(m.data)); c.send(JSON.stringify({ id: 1, method: 'Target.getTargets' })); });
  c.close(); return (res.result.targetInfos.find(t => t.type === 'page' && /^http/.test(t.url)) || {}).url || '';
})();
log('viewer app is in', startMode, 'mode; live tab', liveTab, '; headless page', thorUrl);
const results = [];
try {
  for (const sc of SCENARIOS) {
    for (const mode of MODES) {
      await waitCool(results.length ? COOL_C : START_C);
      log(`run ${sc.id} ${sc.label} ${mode} (hottest ${hottest().toFixed(1)}C)`);
      if (mode === 'stream') {
        await app("setMode('stream'); mode");
        await sleep(2500);
        await run('/home/key/.local/bin/agent-browser', ['open', sc.url], { THOR_GATE: 'off' }, 60000);
      } else {
        await app("setMode('live'); mode");
        if (!await liveOpen(sc.url)) { log(`skip ${sc.id} live: the live frame did not load ${sc.url}`); continue; }
      }
      await sleep(8000);                               // load + the first [lab:frame] window
      const out = await run(process.execPath, [ROOT + 'tools/perf-sample.mjs', '--mode', mode, '--label', `${sc.id}-${sc.label}`, '--secs', String(SECS)], {}, (SECS + 60) * 1000);
      const line = out.trim().split('\n').pop(); console.log(line); try { results.push(JSON.parse(line)); } catch {}
    }
  }
} finally {
  fixture.kill();
  try {
    await app("setMode('stream'); mode"); await sleep(2500);
    if (thorUrl) await run('/home/key/.local/bin/agent-browser', ['open', thorUrl], { THOR_GATE: 'off' }, 60000);
    if (startMode === 'live') {
      await app("setMode('live'); mode"); await sleep(5000);
      if (liveTab) await liveOpen(liveTab);
    }
    log('restored: viewer', startMode, liveTab, '; headless', thorUrl);
  } catch (e) { log('could not restore the viewer:', e.message); }
}
