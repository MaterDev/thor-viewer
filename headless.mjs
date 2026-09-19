// Freeze and thaw the agent's headless browser (the agent-browser `thor` session) over CDP.
//
// "Freeze" = Debugger.pause on every page: JavaScript stops at its next statement, so timers and
// requestAnimationFrame stop and no WebGL/WebGPU work is submitted; DOM, JS state, URL and scroll stay.
// Why not Page.setWebLifecycleState('frozen')? It marks the page hidden, and 'active' does not make it
// visible again (measured 2026-09-19: rAF stays at 0 until some tab switch), which would leave the page
// throttled after resume. Debugger.pause leaves visibility alone.
//
// Crash safety: the pause belongs to this CDP connection. If this process dies, Chrome drops the
// connection and resumes the pages by itself.
//
// $HEADLESS_AB_ARGS selects another session in tests (e.g. "--session x --profile y").
// Calls go to the agent-browser wrapper with THOR_GATE=off, so the gate never routes them.
import { execFile } from 'node:child_process';

const AB = process.env.AGENT_BROWSER || '/home/key/.local/bin/agent-browser';
const ARGS = (process.env.HEADLESS_AB_ARGS || '').split(' ').filter(Boolean);

function cdpUrl() {
  return new Promise(res => execFile(AB, [...ARGS, 'get', 'cdp-url'], { timeout: 15000, killSignal: 'SIGKILL', env: { ...process.env, THOR_GATE: 'off' } },
    (e, out) => { const m = String(out || '').match(/ws:\/\/\S+/); res(m ? m[0] : null); }));
}

function connect(url, ms = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); let id = 0; const pending = new Map();
    const t = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('cdp connect timeout')); }, ms);
    ws.onerror = () => { clearTimeout(t); reject(new Error('cdp connect failed')); };
    ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
    const c = {
      send: (method, params = {}, sessionId) => new Promise(r => {
        if (ws.readyState !== 1) return r({ error: 'closed' });
        const i = ++id; const to = setTimeout(() => { pending.delete(i); r({ error: 'timeout' }); }, 4000);
        pending.set(i, m => { clearTimeout(to); r(m); });
        ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
      close: () => { try { ws.close(); } catch {} },
      closed: false,
    };
    ws.onclose = () => { c.closed = true; };
    ws.onopen = () => { clearTimeout(t); resolve(c); };
  });
}

let held = null;   // { c, sessions: [] } while paused

export async function freezeHeadless() {
  if (held && !held.c.closed) return held.sessions.length;
  const url = await cdpUrl();
  if (!url) throw new Error('headless session has no CDP url');
  const c = await connect(url);
  const sessions = [];
  const targets = (await c.send('Target.getTargets')).result?.targetInfos || [];
  for (const t of targets.filter(t => t.type === 'page')) {
    const s = (await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result?.sessionId;
    if (!s) continue;
    await c.send('Debugger.enable', {}, s);
    const r = await c.send('Debugger.pause', {}, s);
    if (!r.error) sessions.push(s);
  }
  held = { c, sessions };
  return sessions.length;
}

export async function thawHeadless() {
  const h = held; held = null;
  if (!h) return 0;
  for (const s of h.sessions) { await h.c.send('Debugger.resume', {}, s); await h.c.send('Debugger.disable', {}, s); }
  h.c.close();                       // closing also resumes anything we missed
  return h.sessions.length;
}

export const headlessFrozen = () => !!(held && !held.c.closed);
