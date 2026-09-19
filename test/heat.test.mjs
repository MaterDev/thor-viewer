// Unit tests for the heat guard (fake thermometer and clock). Run: node --test test/heat.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHeatGuard, OVERRIDE_MS } from '../heat-guard.mjs';

function rig(opts = {}) {
  let t = 1_000_000, temp = 50; const trips = [], logs = [], timers = new Map(); let id = 0;
  const g = createHeatGuard({ read: () => temp, onTrip: c => trips.push(c), log: l => logs.push(l), now: () => t,
    setTimer: (fn, ms) => { timers.set(++id, fn); return id; }, clearTimer: i => timers.delete(i), ...opts });
  const secs = n => { for (let i = 0; i < n; i++) { t += 1000; for (const fn of timers.values()) fn(); } };
  return { g, trips, logs, timers, secs, set: c => { temp = c; }, advance: ms => { t += ms; } };
}

test('does nothing until started (no timer outside Live)', () => { const r = rig(); assert.equal(r.timers.size, 0); r.set(95); r.secs(60); assert.equal(r.trips.length, 0); });
test('stop removes the timer', () => { const r = rig(); r.g.start(); assert.equal(r.timers.size, 1); r.g.stop(); assert.equal(r.timers.size, 0); });
test('trips after 20 s above 80C, not before', () => {
  const r = rig(); r.g.start(); r.set(85); r.secs(20); assert.equal(r.trips.length, 0); r.secs(1); assert.equal(r.trips.length, 1);
  assert.ok(r.logs.some(l => /heat trip/.test(l)));
});
test('a short spike does not trip; the clock restarts', () => {
  const r = rig(); r.g.start(); r.set(90); r.secs(15); r.set(70); r.secs(1); r.set(90); r.secs(15); assert.equal(r.trips.length, 0);
});
test('exactly at the limit is not above it', () => { const r = rig(); r.g.start(); r.set(80); r.secs(60); assert.equal(r.trips.length, 0); });
test('override: no trip while off; state shows the end time', () => {
  const r = rig(); r.g.start(); const s = r.g.override(); assert.equal(s.on, false); assert.ok(s.offUntil > 0);
  r.set(95); r.secs(120); assert.equal(r.trips.length, 0);
});
test('override expires by itself after 30 min, then the guard trips again', () => {
  const r = rig(); r.g.start(); r.g.override(); r.set(95);
  r.advance(OVERRIDE_MS + 1000); assert.equal(r.g.state().on, true); assert.ok(r.logs.some(l => /expired/.test(l)));
  r.secs(21); assert.equal(r.trips.length, 1);
});
test('override is capped at 30 min; override(0) turns it back on', () => {
  const r = rig(); const s = r.g.override(10 * OVERRIDE_MS); assert.equal(s.offUntil - 1_000_000, OVERRIDE_MS);
  assert.equal(r.g.override(0).on, true);
});
test('the off-until time survives a restart (persisted)', () => {
  const f = join(mkdtempSync(join(tmpdir(), 'heat-')), 'heat.json');
  const a = rig({ stateFile: f }); a.g.override();
  assert.ok(JSON.parse(readFileSync(f, 'utf8')).offUntil > 0);
  const b = rig({ stateFile: f }); assert.equal(b.g.state().on, false);
});
test('a failing thermometer is ignored, not fatal', () => {
  const r = rig({ read: () => { throw new Error('no sysfs'); } }); r.g.start(); r.secs(30); assert.equal(r.trips.length, 0);
});
