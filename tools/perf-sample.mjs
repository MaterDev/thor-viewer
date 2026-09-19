// Samples device load at 1 Hz for N seconds while one page runs in the viewer, and writes a CSV.
//   node tools/perf-sample.mjs --mode stream|live --label NAME --secs 60 [--out DIR]
// Columns: t, gpu_busy_pct, gpuclk_mhz, hottest_zone_c, battery_c, top5 (pid:name:%cpu, from `adb shell top`,
// which sees every app's processes), lab_fps, lab_work_p50_ms (the page's latest [lab:frame] 5 s window).
// The page's console comes from the headless `thor` session over CDP (stream) or from the viewer's
// live log relay (live). Read-only: it changes nothing on the device.
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { join } from 'node:path';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const MODE = arg('mode'), LABEL = arg('label') || 'run', SECS = Number(arg('secs') || 60);
const OUT = arg('out') || '/home/key/.cache/thor-perf';
const ABORT_C = Number(process.env.PERF_ABORT_C || 80);
const VIEWER = process.env.THOR_VIEWER_URL || 'http://127.0.0.1:4850';
const read = p => { try { return readFileSync(p, 'utf8').trim(); } catch { return ''; } };
const zones = readdirSync('/sys/class/thermal').filter(z => z.startsWith('thermal_zone')).map(z => `/sys/class/thermal/${z}/temp`);
const hottest = () => Math.max(...zones.map(z => Number(read(z)) || 0)) / 1000;

// --- top 5 processes, streamed from one long-running `top` ---
let top5 = '';
const top = spawn('adb', ['shell', `top -b -d 1 -n ${SECS + 2} -m 6 -o PID,%CPU,NAME -s 2`]);
let buf = '';
top.stdout.on('data', d => {
  buf += d; const blocks = buf.split(/\n(?=Tasks:)/); buf = blocks.pop();
  for (const b of blocks) {
    const rows = b.split('\n').filter(l => /^\s*\d+\s+[\d.]+\s+\S/.test(l)).slice(0, 5);
    top5 = rows.map(l => { const [pid, cpu, ...name] = l.trim().split(/\s+/); return `${pid}:${name.join(' ').replace(/[,;]/g, ' ').slice(0, 48)}:${cpu}`; }).join(';');
  }
});

// --- the page's [lab:frame] readouts ---
let lab = { fps: '', raf: '', work: '' };
const takeLab = text => {
  if (!text.startsWith('[lab:frame]')) return;
  // fps = frames the plugin drew (0 for pieces that don't draw per rAF); raf = the page's vsync rate
  try { const j = JSON.parse(text.slice(12)); if (j.win === 5) lab = { fps: j.fps, raf: j.raf ? +(j.raf.n / j.win).toFixed(1) : '', work: j.work?.p50 ?? j.cpu?.p50 ?? '' }; } catch {}
};
let stopConsole = () => {};
if (MODE === 'live') {
  let since = Date.now();                               // only what is logged during this run (the relay is a ring)
  const t = setInterval(async () => {
    try { const logs = await (await fetch(VIEWER + '/api/live/logs')).json(); for (const l of logs.filter(l => l.t > since)) takeLab(l.text || ''); since = Math.max(since, ...logs.map(l => l.t)); } catch {}
  }, 1000);
  stopConsole = () => clearInterval(t);
} else {
  const url = await new Promise(r => execFile('/home/key/.local/bin/agent-browser', [...(process.env.HEADLESS_AB_ARGS || '').split(' ').filter(Boolean), 'get', 'cdp-url'], { env: { ...process.env, THOR_GATE: 'off' }, timeout: 15000 },
    (e, o) => r((String(o).match(/ws:\/\/\S+/) || [])[0])));
  const ws = new WebSocket(url); await new Promise(r => { ws.onopen = r; ws.onerror = r; });
  let id = 0; const send = (method, params = {}, sessionId) => ws.send(JSON.stringify({ id: ++id, method, params, ...(sessionId ? { sessionId } : {}) }));
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.result?.targetInfos) for (const t of m.result.targetInfos.filter(t => t.type === 'page' && /^http/.test(t.url))) send('Target.attachToTarget', { targetId: t.targetId, flatten: true });
    if (m.result?.sessionId) send('Runtime.enable', {}, m.result.sessionId);
    if (m.method === 'Runtime.consoleAPICalled') takeLab(String(m.params.args?.[0]?.value || ''));
  };
  send('Target.getTargets');
  stopConsole = () => ws.close();
}

// --- 1 Hz samples ---
const rows = ['t,gpu_busy_pct,gpuclk_mhz,hottest_zone_c,battery_c,top5,lab_fps,lab_work_p50_ms,lab_raf_fps'];
const t0 = Date.now();
for (let i = 0; i < SECS; i++) {
  await new Promise(r => setTimeout(r, t0 + (i + 1) * 1000 - Date.now()));
  rows.push([i + 1, parseInt(read('/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage')) || 0, Math.round((Number(read('/sys/class/kgsl/kgsl-3d0/gpuclk')) || 0) / 1e6),
    hottest().toFixed(1), (Number(read('/sys/class/power_supply/battery/temp')) / 10).toFixed(1), `"${top5}"`, lab.fps, lab.work, lab.raf].join(','));
  // Thermal abort: single zones spike briefly, so stop only when 5 samples in a row are above ABORT_C.
  const recent = rows.slice(-5).map(r => +r.split(',')[3]);
  if (i >= 4 && recent.every(v => v > ABORT_C)) { rows.push(`# aborted: hottest zone above ${ABORT_C}C for 5 s`); console.error('aborted: too hot'); break; }
}
stopConsole(); top.kill();
mkdirSync(OUT, { recursive: true });
const file = join(OUT, `${new Date(t0).toISOString().replace(/[:.]/g, '-')}-${LABEL}-${MODE}.csv`);
writeFileSync(file, rows.join('\n') + '\n');

// summary: means over the run, plus the max hottest zone
const data = rows.slice(1).filter(r => !r.startsWith('#')).map(r => r.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/));
const mean = k => { const v = data.map(r => Number(r[k])).filter(Number.isFinite); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NaN; };
const labs = data.map(r => Number(r[6])).filter(v => v > 0);
const rafs = data.map(r => Number(r[8])).filter(v => v > 0);
console.log(JSON.stringify({ label: LABEL, mode: MODE, secs: SECS, gpu_busy: +mean(1).toFixed(1), gpuclk: Math.round(mean(2)), hottest_max: Math.max(...data.map(r => +r[3])),
  hottest_end: +data.at(-1)[3], battery_end: +data.at(-1)[4], lab_fps: labs.length ? +(labs.reduce((a, b) => a + b, 0) / labs.length).toFixed(1) : null,
  lab_work: (() => { const w = data.map(r => Number(r[7])).filter(v => v > 0); return w.length ? +(w.reduce((a, b) => a + b, 0) / w.length).toFixed(2) : null; })(),
  lab_raf_fps: rafs.length ? +(rafs.reduce((a, b) => a + b, 0) / rafs.length).toFixed(1) : null,
  hottest_median: (() => { const h = data.map(r => +r[3]).sort((a, b) => a - b); return h[Math.floor(h.length / 2)]; })(),
  top_last: data.at(-1)[5], file }));
process.exit(0);
