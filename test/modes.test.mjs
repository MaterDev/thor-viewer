// Unit tests for the mode state machine (no browser). Run: node --test test/modes.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModes, MAX_BORROW_MS } from '../modes.mjs';

function rig() {
  const calls = [], logs = [], changes = [];
  let t = 1000; const timers = new Map(); let tid = 0;
  const fx = {
    freezeHeadless: async () => calls.push('freezeHeadless'),
    thawHeadless: async () => calls.push('thawHeadless'),
    pauseLive: async until => calls.push('pauseLive'),
    resumeLive: async () => calls.push('resumeLive'),
    onChange: s => changes.push(s.mode),
    log: l => logs.push(l),
  };
  const clock = {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: t + ms }); return id; },
    clearTimer: id => timers.delete(id),
  };
  const advance = async ms => { t += ms; for (const [id, x] of [...timers]) if (x.at <= t) { timers.delete(id); await x.fn(); } };
  return { m: createModes(fx, clock), calls, logs, changes, advance, timers, fx };
}

test('starts in stream', () => { assert.equal(rig().m.get().mode, 'stream'); });

test('stream -> live freezes the headless page', async () => {
  const r = rig(); const res = await r.m.enterLive({ liveUrl: 'http://x/' });
  assert.equal(res.ok, true); assert.equal(r.m.get().mode, 'live'); assert.equal(r.m.get().liveUrl, 'http://x/');
  assert.deepEqual(r.calls, ['freezeHeadless']);
});

test('enterLive twice is idempotent (no second freeze)', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.enterLive();
  assert.deepEqual(r.calls, ['freezeHeadless']);
});

test('live -> stream thaws the headless page', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.leaveLive();
  assert.equal(r.m.get().mode, 'stream'); assert.deepEqual(r.calls, ['freezeHeadless', 'thawHeadless']);
});

test('borrow is rejected in stream mode', async () => {
  const r = rig(); const res = await r.m.borrow('a');
  assert.equal(res.ok, false); assert.match(res.reason, /not in Live mode/); assert.deepEqual(r.calls, []);
});

test('live -> borrowed pauses live then thaws headless; giveBack reverses it', async () => {
  const r = rig(); await r.m.enterLive(); r.calls.length = 0;
  assert.equal((await r.m.borrow('a', 10000)).ok, true);
  assert.equal(r.m.get().mode, 'borrowed'); assert.equal(r.m.get().owner, 'a');
  assert.deepEqual(r.calls, ['pauseLive', 'thawHeadless']); r.calls.length = 0;
  assert.equal((await r.m.giveBack('a')).ok, true);
  assert.equal(r.m.get().mode, 'live'); assert.equal(r.m.get().owner, null);
  assert.deepEqual(r.calls, ['freezeHeadless', 'resumeLive']);
});

test('a second agent cannot borrow while one holds it; same owner is idempotent', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.borrow('a');
  const b = await r.m.borrow('b'); assert.equal(b.ok, false); assert.match(b.reason, /already borrowed by a/);
  assert.equal((await r.m.borrow('a')).ok, true);
  assert.equal(r.m.get().owner, 'a');
});

test('only the owner (or Key) can give back', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.borrow('a');
  assert.equal((await r.m.giveBack('b')).ok, false); assert.equal(r.m.get().mode, 'borrowed');
  assert.equal((await r.m.giveBack('*')).ok, true); assert.equal(r.m.get().mode, 'live');
});

test('giveBack with nothing borrowed is rejected', async () => {
  const r = rig(); await r.m.enterLive();
  assert.equal((await r.m.giveBack('a')).ok, false);
});

test('a crashed agent: the deadline resumes the live page', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.borrow('a', 5000); r.calls.length = 0;
  await r.advance(4999); assert.equal(r.m.get().mode, 'borrowed');
  await r.advance(2); assert.equal(r.m.get().mode, 'live');
  assert.deepEqual(r.calls, ['freezeHeadless', 'resumeLive']);
  assert.ok(r.logs.some(l => /timed out/.test(l)));
});

test('the deadline of an old borrow does not end a newer one', async () => {
  const r = rig(); await r.m.enterLive();
  await r.m.borrow('a', 5000); await r.m.giveBack('a');
  await r.m.borrow('b', 20000);
  await r.advance(6000); assert.equal(r.m.get().mode, 'borrowed'); assert.equal(r.m.get().owner, 'b');
});

test('borrow time is clamped to the maximum', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.borrow('a', 10 * MAX_BORROW_MS);
  assert.equal(r.m.get().until, 1000 + MAX_BORROW_MS);
});

test('leaving Live mid-borrow goes to stream and cancels the deadline', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.borrow('a', 5000);
  await r.m.leaveLive('viewer closed'); assert.equal(r.m.get().mode, 'stream');
  assert.equal(r.timers.size, 0);
  await r.advance(10000); assert.equal(r.m.get().mode, 'stream');
});

test('enterLive during a borrow is rejected', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.borrow('a');
  assert.equal((await r.m.enterLive()).ok, false);
});

test('concurrent borrows are serialized: exactly one wins', async () => {
  const r = rig(); await r.m.enterLive();
  const res = await Promise.all(['a', 'b', 'c', 'd'].map(o => r.m.borrow(o)));
  assert.equal(res.filter(x => x.ok).length, 1);
  assert.equal(r.calls.filter(c => c === 'pauseLive').length, 1);
});

test('a failing effect is logged and does not wedge the machine', async () => {
  const r = rig(); r.fx.freezeHeadless = async () => { throw new Error('no cdp'); };
  assert.equal((await r.m.enterLive()).ok, true); assert.equal(r.m.get().mode, 'live');
  assert.ok(r.logs.some(l => /freezeHeadless failed: no cdp/.test(l)));
  assert.equal((await r.m.leaveLive()).ok, true);
});

test('every transition is logged', async () => {
  const r = rig(); await r.m.enterLive(); await r.m.borrow('a'); await r.m.giveBack('a'); await r.m.leaveLive();
  assert.deepEqual(r.changes, ['live', 'borrowed', 'live', 'stream']);
  assert.equal(r.logs.filter(l => / -> /.test(l)).length, 4);
});
