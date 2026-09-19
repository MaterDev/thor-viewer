// Freeze and thaw the agent's headless browser (the agent-browser `thor` session) over CDP.
// Page.setWebLifecycleState('frozen') stops timers and requestAnimationFrame but keeps the DOM,
// JS state, URL and scroll; 'active' resumes exactly where it was. Every page target is set.
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
    ws.onopen = () => { clearTimeout(t); resolve({
      send: (method, params = {}, sessionId) => new Promise(r => { const i = ++id; const to = setTimeout(() => { pending.delete(i); r({ error: 'timeout' }); }, 4000); pending.set(i, m => { clearTimeout(to); r(m); }); ws.send(JSON.stringify({ id: i, method, params, ...(sessionId ? { sessionId } : {}) })); }),
      close: () => { try { ws.close(); } catch {} },
    }); };
  });
}

export async function setHeadlessState(state) {
  const url = await cdpUrl();
  if (!url) throw new Error('headless session has no CDP url');
  const c = await connect(url);
  try {
    const targets = (await c.send('Target.getTargets')).result?.targetInfos || [];
    let n = 0;
    for (const t of targets.filter(t => t.type === 'page')) {
      const s = (await c.send('Target.attachToTarget', { targetId: t.targetId, flatten: true })).result?.sessionId;
      if (!s) continue;
      const r = await c.send('Page.setWebLifecycleState', { state }, s);
      if (!r.error) n++;
      await c.send('Target.detachFromTarget', { sessionId: s });
    }
    return n;
  } finally { c.close(); }
}
export const freezeHeadless = () => setHeadlessState('frozen');
export const thawHeadless = () => setHeadlessState('active');
