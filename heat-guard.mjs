// Heat guard for Live mode. Live renders heavy pages at the display's full resolution (measured: the
// Canvas Lab title took the hottest zone to 91°C in 60 s), so while Live is on the server reads the
// hottest thermal zone once a second. Above LIMIT_C for HOLD_MS -> trip (the caller falls back to Stream).
// Key can switch the guard off for OVERRIDE_MS (remote work, video); it turns itself back on.
// The "off until" time is persisted, so a reload or server restart keeps it. Nothing runs outside Live.
//
// Injected: read() -> °C (default: hottest readable zone; $LIVE_THERMAL_FILE = a file holding m°C, for
// tests), clock/timers, onTrip(tempC), log(line).
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';

export const LIMIT_C = 80, HOLD_MS = 20_000, OVERRIDE_MS = 30 * 60_000;

export function hottestZoneC() {
  if (process.env.LIVE_THERMAL_FILE) return Number(readFileSync(process.env.LIVE_THERMAL_FILE, 'utf8')) / 1000;
  let max = 0;
  for (const z of readdirSync('/sys/class/thermal')) {
    if (!z.startsWith('thermal_zone')) continue;
    try { const v = Number(readFileSync(`/sys/class/thermal/${z}/temp`, 'utf8')) / 1000; if (v > max && v < 150) max = v; } catch {}
  }
  return max;
}

export function createHeatGuard({ read = hottestZoneC, onTrip, log = () => {}, stateFile = null,
  now = Date.now, setTimer = setInterval, clearTimer = clearInterval, limit = LIMIT_C, hold = HOLD_MS } = {}) {
  let timer = null, hotSince = null, offUntil = 0;
  if (stateFile) { try { offUntil = Number(JSON.parse(readFileSync(stateFile, 'utf8')).offUntil) || 0; } catch {} }
  const save = () => { if (stateFile) try { writeFileSync(stateFile, JSON.stringify({ offUntil })); } catch {} };
  const overridden = () => offUntil > now();

  function tick() {
    let t; try { t = read(); } catch { return; }
    if (overridden()) { hotSince = null; return; }
    if (t > limit) {
      if (hotSince === null) { hotSince = now(); log(`heat ${t.toFixed(1)}C above ${limit}C, watching`); }
      else if (now() - hotSince >= hold) { hotSince = null; log(`heat trip at ${t.toFixed(1)}C after ${hold / 1000}s`); onTrip?.(t); }
    } else if (hotSince !== null) { hotSince = null; log(`heat back to ${t.toFixed(1)}C`); }
  }

  return {
    start() { if (!timer) { hotSince = null; timer = setTimer(tick, 1000); } },
    stop() { if (timer) { clearTimer(timer); timer = null; hotSince = null; } },
    running: () => !!timer,
    tick,
    // minutes > 0: guard off for that long (default 30); 0: guard back on now.
    override(ms = OVERRIDE_MS) {
      offUntil = ms > 0 ? now() + Math.min(ms, OVERRIDE_MS) : 0; hotSince = null; save();
      log(ms > 0 ? `heat guard off until ${new Date(offUntil).toISOString()}` : 'heat guard back on');
      return this.state();
    },
    state() {
      if (offUntil && !overridden()) { offUntil = 0; save(); log('heat guard back on (override expired)'); }
      return { on: !overridden(), offUntil: overridden() ? offUntil : null, limit, holdMs: hold };
    },
  };
}
