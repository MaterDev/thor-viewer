// The viewer's mode state machine. The ONLY place mode transitions happen.
//
//   stream    Stream mode (default). The agent's headless `thor` page runs; Key watches its JPEG stream.
//   live      Live mode. Key's real page runs in the viewer app; the headless page is FROZEN
//             (DOM and JS kept, timers/rAF stopped), so one page uses the GPU at a time.
//   borrowed  Live mode, but one agent is briefly using the headless page (e.g. a WebGL look):
//             the live page is frozen and the headless page runs. Ends on giveBack, on the
//             deadline (a crashed agent cannot leave Key's page frozen), or when Live mode ends.
//
//   stream --enterLive--> live --borrow(owner)--> borrowed --giveBack(owner) | deadline--> live
//   live | borrowed --leaveLive--> stream
// Anything else is rejected with a reason. Transitions run one at a time (a promise queue), and
// every change is logged.
//
// Effects are injected so the machine can be tested without a browser:
//   freezeHeadless(), thawHeadless(), pauseLive(untilMs), resumeLive(), onChange(snapshot), log(line)
export const MAX_BORROW_MS = 5 * 60 * 1000;
export const DEFAULT_BORROW_MS = 60 * 1000;

export function createModes(fx, { now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let state = 'stream', since = now(), owner = null, until = 0, timer = null, meta = {};
  let queue = Promise.resolve();
  const snapshot = () => ({ mode: state, since, owner, until: until || null, ...meta });
  const log = line => fx.log?.(`${new Date(now()).toISOString()} mode ${line}`);
  const set = (next, why) => { log(`${state} -> ${next} (${why})`); state = next; since = now(); fx.onChange?.(snapshot()); };
  const safely = async (name, fn) => { try { await fn(); return true; } catch (e) { log(`effect ${name} failed: ${e?.message || e}`); return false; } };
  const serial = fn => { const p = queue.then(fn, fn); queue = p.catch(() => {}); return p; };
  const reject = reason => ({ ok: false, reason, ...snapshot() });

  async function endBorrow(why) {
    clearTimer(timer); timer = null;
    await safely('freezeHeadless', fx.freezeHeadless);
    await safely('resumeLive', fx.resumeLive);
    owner = null; until = 0;
    set('live', why);
  }

  return {
    get: snapshot,
    enterLive: (m = {}) => serial(async () => {
      if (state === 'borrowed') return reject('an agent is borrowing the headless page; Live is already on');
      meta = { ...meta, ...m };
      if (state === 'live') { fx.onChange?.(snapshot()); return { ok: true, ...snapshot() }; }
      await safely('freezeHeadless', fx.freezeHeadless);
      set('live', 'viewer entered Live mode');
      return { ok: true, ...snapshot() };
    }),
    leaveLive: why => serial(async () => {
      if (state === 'stream') return { ok: true, ...snapshot() };
      if (state === 'borrowed') { clearTimer(timer); timer = null; owner = null; until = 0; }
      await safely('thawHeadless', fx.thawHeadless);
      meta = {};
      set('stream', why || 'viewer left Live mode');
      return { ok: true, ...snapshot() };
    }),
    borrow: (who, ms = DEFAULT_BORROW_MS) => serial(async () => {
      if (!who) return reject('borrow needs an owner id');
      if (state === 'stream') return reject('not in Live mode: the headless page is already running');
      if (state === 'borrowed') return owner === who ? { ok: true, ...snapshot() } : reject(`already borrowed by ${owner}`);
      const span = Math.max(1000, Math.min(Number(ms) || DEFAULT_BORROW_MS, MAX_BORROW_MS));
      owner = who; until = now() + span;
      await safely('pauseLive', () => fx.pauseLive(until));
      await safely('thawHeadless', fx.thawHeadless);
      set('borrowed', `borrowed by ${who} for ${Math.round(span / 1000)}s`);
      timer = setTimer(() => serial(() => state === 'borrowed' && owner === who ? endBorrow(`borrow by ${who} timed out`) : null), span);
      return { ok: true, ...snapshot() };
    }),
    giveBack: who => serial(async () => {
      if (state !== 'borrowed') return reject('nothing is borrowed');
      if (who !== owner && who !== '*') return reject(`borrowed by ${owner}, not ${who}`);
      await endBorrow(who === '*' ? 'resumed by Key' : `given back by ${who}`);
      return { ok: true, ...snapshot() };
    }),
  };
}
