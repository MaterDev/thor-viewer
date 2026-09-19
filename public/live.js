// Live Page Mode, client side. Loaded on first use (dynamic import from app.js).
//
// The real page runs in <iframe name="thorLive"> filling the viewer; Key touches it directly.
// The server (live-bridge.mjs) attaches over CDP to THIS viewer page (matched by a token) and
// reports the frame's URL, title, console and errors as server-sent events. The agent drives the
// same frame through that CDP target (see tools/live-agent.sh).
//
// Live tabs are the viewer's own list (localStorage thorLiveTabs). Only the active one is loaded;
// switching reloads it, so hidden tabs never run (the work inside is often GPU-heavy).
const FRAME_NAME = 'thorLive';
const STORE = 'thorLiveTabs';
const post = (path, body) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) })
  .then(r => r.json()).catch(() => ({ ok: false, reason: 'viewer server not reachable' }));

export function create(shell) {
  let state = { tabs: [], active: null, next: 1 };
  try { const s = JSON.parse(localStorage.getItem(STORE) || 'null'); if (s && Array.isArray(s.tabs)) state = s; } catch {}
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} };
  const token = (crypto.randomUUID?.() || String(Math.random()).slice(2)) + '';
  window.__thorLiveToken = token;                        // how the server finds this page over CDP

  let frameEl = null, emptyEl = null, noteEl = null, events = null, on = false;
  function note(until) {                                  // shown just before the server freezes this page
    if (!until) { noteEl?.remove(); noteEl = null; return; }
    if (!noteEl) { noteEl = document.createElement('div'); noteEl.id = 'liveNote'; document.body.appendChild(noteEl); }
    noteEl.textContent = `Paused: an agent is using its own browser · resumes by ${new Date(until).toTimeString().slice(0, 8)} · "Resume now" is in the notification`;
  }
  const activeTab = () => state.tabs.find(t => t.id === state.active) || null;
  const publishTabs = () => shell.setTabs(state.tabs.map(t => ({ id: t.id, title: t.title || t.url, url: t.url, active: t.id === state.active })));

  function show(url) {
    if (!url) {                                           // nothing to show: remove the frame entirely
      frameEl?.remove(); frameEl = null;
      if (!emptyEl) { emptyEl = document.createElement('div'); emptyEl.id = 'liveEmpty'; emptyEl.textContent = 'live · open an address (top right)'; document.body.prepend(emptyEl); }
      shell.setUrl(''); return;
    }
    emptyEl?.remove(); emptyEl = null;
    if (!frameEl) {
      frameEl = document.createElement('iframe');
      frameEl.id = 'liveFrame'; frameEl.name = FRAME_NAME;
      frameEl.allow = 'fullscreen; gamepad; autoplay; clipboard-read; clipboard-write; xr-spatial-tracking; accelerometer; gyroscope';
      document.body.prepend(frameEl);
    }
    if (frameEl.src !== url) frameEl.src = url;
    shell.setUrl(url);
  }

  function onEvent(ev) {
    const t = activeTab();
    if (ev.type === 'url' && ev.url && !ev.url.startsWith('about:')) {
      if (t && t.url !== ev.url) { t.url = ev.url; save(); publishTabs(); }
      shell.setUrl(ev.url); shell.addHistory(ev.url);
    } else if (ev.type === 'title' && t) { t.title = ev.title; save(); publishTabs(); }
    else if (ev.type === 'console' || ev.type === 'error') shell.addLog(ev.level || 'log', ev.text);
    else if (ev.type === 'mode') note(ev.mode === 'borrowed' ? ev.until : 0);
    else if (ev.type === 'open' && ev.url) this_.open(ev.url);   // the agent asked to open a page
    else if (ev.type === 'state' && ev.attached === false && on && ev.reason) shell.addLog('warning', 'live: ' + ev.reason);
  }

  async function attach() {
    events = new EventSource('/api/live/events');       // closing it ends the server's CDP attachment
    events.onmessage = m => { try { onEvent(JSON.parse(m.data)); } catch {} };
    const r = await post('/api/live/start', { token });
    if (!on) return;
    if (!r.ok) shell.addLog('warning', 'live: agent not attached · ' + (r.reason || 'unknown') + ' (the page still works; Key can use it)');
    else shell.addLog('info', 'live: agent attached to this page');
  }

  const this_ = {
    enter() {
      on = true; shell.status('');
      if (!state.tabs.length) {                         // first time: take the page the stream was showing
        const u = shell.streamUrl();
        if (/^https?:\/\//.test(u)) { state.tabs.push({ id: 'L' + state.next++, url: u, title: '' }); state.active = state.tabs[0].id; save(); }
      }
      publishTabs(); show(activeTab()?.url || '');
      attach(); shell.pollTemp();
    },
    exit() {
      on = false;
      events?.close(); events = null; post('/api/live/stop');
      frameEl?.remove(); frameEl = null; emptyEl?.remove(); emptyEl = null; note(0);
    },
    open(url) {
      let t = activeTab();
      if (!t) { t = { id: 'L' + state.next++, url, title: '' }; state.tabs.push(t); state.active = t.id; }
      t.url = url; t.title = ''; save(); publishTabs(); show(url); shell.addHistory(url);
    },
    nav(op) {
      if (op === 'reload' && frameEl) { const u = activeTab()?.url || frameEl.src; frameEl.src = 'about:blank'; frameEl.src = u; return; }  // works even when the agent is not attached
      return post('/api/live/nav', { op }).then(r => { if (!r.ok) shell.addLog('warning', `live: ${op} needs the agent attachment (${r.reason || 'failed'})`); });
    },
    tabNew() { const t = { id: 'L' + state.next++, url: '', title: 'new tab' }; state.tabs.push(t); state.active = t.id; save(); publishTabs(); show(''); },
    tabSwitch(id) { if (!state.tabs.some(t => t.id === id)) return; state.active = id; save(); publishTabs(); shell.clearLog(); show(activeTab().url); },
    tabClose(id) {
      state.tabs = state.tabs.filter(t => t.id !== id);
      if (state.active === id) state.active = state.tabs[state.tabs.length - 1]?.id || null;
      save(); publishTabs(); show(activeTab()?.url || '');
    },
  };
  return this_;
}
