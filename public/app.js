// Thor Viewer: full-screen live view of the agent-browser "thor" session.
// Connects straight to agent-browser's stream (JPEG frames + input injection);
// tabs, navigation and page errors go through the small server API.
// ---------- theme (applied first): Standard = frosted glass (default); Solid = same palette, opaque, no blur.
// A theme is a token swap: <html data-theme="solid"> overrides the glass tokens in app.css. ?theme= overrides
// for testing (not persisted); the Settings choice persists in localStorage.
const THEMES = ['standard', 'solid'];
function currentTheme() { return document.documentElement.dataset.theme || 'standard'; }
// ONE choice drives the viewer shell and the hosted page (Theme contract, CLAUDE.md): it's stored on the
// server, which applies it to the hosted page (Live: CDP into the frame; Stream: the headless page).
// localStorage is only a first-paint cache; ?theme= overrides this viewer locally (not saved).
function setTheme(t, persist) {
  if (!THEMES.includes(t)) return;
  if (t === 'standard') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  try { localStorage.setItem('thorTheme', t); } catch {}
  if (persist) fetch('/api/theme', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ theme: t }) }).catch(() => {});
}
const themeParam = (() => { try { return new URLSearchParams(location.search).get('theme'); } catch { return null; } })();
{ let t = themeParam; try { t = t || localStorage.getItem('thorTheme'); } catch {} if (t) setTheme(t, false); }
if (!themeParam) fetch('/api/theme').then(r => r.json()).then(r => { if (r.theme !== currentTheme()) setTheme(r.theme, false); }).catch(() => {});
let themeApplyTimer = 0;
function applyThemeToPage() {                        // after a Stream navigation (Live re-applies server-side);
  clearTimeout(themeApplyTimer);                      // the server holds the choice and skips Standard (nothing to undo on a fresh page)
  themeApplyTimer = setTimeout(() => fetch('/api/theme/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {}), 400);
}

const STREAM = 'ws://127.0.0.1:9223/?pacing=ack&maxFps=60';
const $ = id => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
const status = $('status'), urlEl = $('url'), urlwrap = $('urlwrap'), drawer = $('drawer'), scrim = $('scrim');
const consoleEl = $('console'), logEl = $('log'), badge = $('badge'), key = $('key');

let ws, frame = null, fw = 1280, fh = 720, errors = 0;
let view = { scale: 1, x: 0, y: 0 };                       // where the frame is drawn (CSS px)
const cursor = { x: 640, y: 360, visible: false, timer: null }; // controller pointer, frame coords
const api = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' }).catch(() => {});

// ---------- mode: Stream (JPEG copy of the agent's browser) or Live (the real page, in a frame) ----------
// Only one mode's machinery runs at a time. live.js is loaded on first use of Live mode.
let mode = 'stream', live = null;
try { if (localStorage.getItem('thorMode') === 'live') mode = 'live'; } catch {}
const isLive = () => mode === 'live' && live;
const nav = {                                           // every page action goes through here
  open: url => isLive() ? live.open(url) : api('/api/nav/open', { url }),
  go: op => isLive() ? live.nav(op) : api('/api/nav/' + op),
  tabNew: () => isLive() ? live.tabNew() : api('/api/tabs/new', {}),
  tabSwitch: id => isLive() ? live.tabSwitch(id) : api('/api/tabs/switch', { id }),
  tabClose: id => isLive() ? live.tabClose(id) : api('/api/tabs/close', { id }),
};

// ---------- visited-page history (built from stream url events; per device) ----------
let errSeen = 0;            // entries of the (append-only) error buffer we've already handled
let errBaseInit = false;   // becomes true once the pre-existing junk has been baselined out
let lastNavBase = null;
function clearConsoleOnNav(url) {
  if (!url) return;
  const base = url.split('#')[0];
  if (lastNavBase !== null && base !== lastNavBase) {  // real navigation, not a #hash change
    logEl.textContent = ''; errors = 0; badge.classList.add('hidden'); // fresh console per page; errSeen keeps advancing so new-page errors show
  }
  lastNavBase = base;
}
let history = [];
try { history = JSON.parse(localStorage.getItem('thorHistory') || '[]'); } catch {}
let urlEdited = false;
function addHistory(url) {
  if (!url || url.startsWith('about:')) return;
  if (history.length && history[history.length - 1].url === url) return;
  history.push({ url, t: Date.now() });
  if (history.length > 100) history = history.slice(-100);
  try { localStorage.setItem('thorHistory', JSON.stringify(history)); } catch {}
  if (urlwrap.classList.contains('open')) renderHistory();
}
function renderHistory() {
  const list = document.getElementById('histList');
  const filter = urlEdited ? urlEl.value.trim().toLowerCase() : '';
  const seen = new Set(), items = [];
  for (let i = history.length - 1; i >= 0 && items.length < 15; i--) {
    const u = history[i].url;
    if (seen.has(u)) continue;
    if (filter && !u.toLowerCase().includes(filter)) continue;
    seen.add(u); items.push(history[i]);
  }
  list.textContent = '';
  if (!items.length) { list.classList.add('hidden'); return; }
  list.classList.remove('hidden');
  for (const it of items) {
    const li = document.createElement('li');
    let host = it.url; try { host = new URL(it.url).hostname; } catch {}
    const t = document.createElement('span'); t.className = 'ht'; t.textContent = host;
    const u = document.createElement('span'); u.className = 'hu'; u.textContent = it.url;
    li.append(t, u);
    li.onclick = () => { closeUrlBar(); nav.open(it.url); };
    list.appendChild(li);
  }
}

// ---------- drawing ----------
function layout() {
  const W = innerWidth, H = innerHeight, scale = Math.min(W / fw, H / fh);
  const cssW = Math.round(fw * scale), cssH = Math.round(fh * scale);
  const x = Math.round((W - cssW) / 2), y = Math.round((H - cssH) / 2);
  view = { scale, x, y };
  if (canvas.width !== fw || canvas.height !== fh) { canvas.width = fw; canvas.height = fh; } // backing store = frame's native pixels
  canvas.style.left = x + 'px'; canvas.style.top = y + 'px';
  canvas.style.width = cssW + 'px'; canvas.style.height = cssH + 'px';
  draw();
}
function draw() {
  if (frame) ctx.drawImage(frame, 0, 0, fw, fh);
  else { ctx.fillStyle = '#05080c'; ctx.fillRect(0, 0, fw, fh); }
  if (cursor.visible) {
    const r = 10 / view.scale, lw = 2 / view.scale;
    ctx.beginPath(); ctx.arc(cursor.x, cursor.y, r, 0, Math.PI * 2); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = lw; ctx.stroke();
    ctx.beginPath(); ctx.arc(cursor.x, cursor.y, r / 5, 0, Math.PI * 2); ctx.fillStyle = '#ffffff'; ctx.fill();
  }
}
let lastW = innerWidth;
addEventListener('resize', () => { layout(); if (innerWidth !== lastW) { lastW = innerWidth; syncViewport(); } }); // height-only changes (toolbar, keyboard) do not resize the page

// ---------- viewport sync: the remote browser takes this screen's exact size ----------
let sentSize = '', sizeTimer, lastResync = 0;
const TEST_BROWSER = /HeadlessChrome/.test(navigator.userAgent);            // Claude's own test copies never set the size
const inFront = () => mode === 'stream' && !TEST_BROWSER && document.visibilityState === 'visible' && document.hasFocus(); // only the viewer in front sets the size
function syncViewport() {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(() => {
    if (!inFront()) return;
    const w = Math.round(innerWidth), h = Math.round(innerHeight), k = w + 'x' + h;
    if (k === sentSize) return;
    sentSize = k; api('/api/viewport', { w, h });
  }, 300);
}
function resyncIfMismatch() {
  if (!inFront() || (fw === Math.round(innerWidth) && fh === Math.round(innerHeight)) || Date.now() - lastResync < 3000) return;
  lastResync = Date.now(); sentSize = ''; syncViewport();
}
document.addEventListener('visibilitychange', () => { sentSize = ''; syncViewport(); });
addEventListener('focus', () => { sentSize = ''; syncViewport(); });

// ---------- stream ----------
let streamOn = false, errTimer = null;
function streamStart() {
  if (streamOn) return; streamOn = true;
  canvas.classList.remove('hidden'); connect();
  errTimer = setInterval(pollErrors, 20000);
}
function streamStop() {                                  // Live mode: no socket, no drawing, no polling
  streamOn = false; clearInterval(errTimer); errTimer = null;
  if (ws) { ws.onclose = null; ws.close(); ws = null; }
  if (frame && frame.close) frame.close(); frame = null;
  canvas.classList.add('hidden'); status.classList.add('hidden');
}
function connect() {
  if (!streamOn) return;
  status.textContent = 'connecting to browser'; status.classList.remove('hidden');
  ws = new WebSocket(STREAM);
  ws.onopen = () => { status.textContent = 'waiting for first frame'; };
  ws.onclose = () => { if (!streamOn) return; status.textContent = 'browser stream closed · ask Claude to run the start script · retrying'; status.classList.remove('hidden'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'frame') {
      const bin = atob(m.data), bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      createImageBitmap(new Blob([bytes], { type: 'image/jpeg' })).then(bmp => {
        if (frame && frame.close) frame.close();
        frame = bmp;
        if (m.metadata.deviceWidth !== fw || m.metadata.deviceHeight !== fh) { fw = m.metadata.deviceWidth; fh = m.metadata.deviceHeight; layout(); } else draw();
        status.classList.add('hidden');
        send({ type: 'ack', seq: m.seq });
        resyncIfMismatch(); statTick(bytes.length);
      }).catch(() => send({ type: 'ack', seq: m.seq }));
    } else if (m.type === 'url') {
      if (document.activeElement !== urlEl) urlEl.value = m.url;
      clearConsoleOnNav(m.url); addHistory(m.url); applyThemeToPage();
    } else if (m.type === 'tabs' && Array.isArray(m.tabs)) {
      setTabs(m.tabs.map(t => ({ id: t.tabId, title: t.title, url: t.url, active: !!t.active })));
      const active = m.tabs.find(t => t.active) || m.tabs[0];
      if (active?.url) { if (document.activeElement !== urlEl) urlEl.value = active.url; clearConsoleOnNav(active.url); addHistory(active.url); }
    } else if (m.type === 'console') {
      addLog(m.level, m.text);
    } else if (m.type === 'status' && m.viewportWidth) {
      if (m.viewportWidth !== fw || m.viewportHeight !== fh) { fw = m.viewportWidth; fh = m.viewportHeight; layout(); }
    }
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---------- address bar (top right, expands leftwards) ----------
const openUrlBar = () => { urlwrap.classList.add('open'); urlEdited = false; urlEl.focus(); urlEl.select(); renderHistory(); };
const closeUrlBar = () => { urlwrap.classList.remove('open'); urlEl.blur(); document.getElementById('histList').classList.add('hidden'); };
const toggleUrlBar = () => urlwrap.classList.contains('open') ? closeUrlBar() : openUrlBar();
$('urlBtn').onclick = openUrlBar;
$('urlClose').onclick = closeUrlBar;
urlEl.addEventListener('input', () => { urlEdited = true; renderHistory(); });
$('back').onclick = () => nav.go('back');
$('urlReload').onclick = () => nav.go('reload');
$('refreshBtn').onclick = () => nav.go('reload');
$('forward').onclick = () => nav.go('forward');
$('urlbar').onsubmit = e => {
  e.preventDefault();
  const v = urlEl.value.trim(); if (!v) return;
  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) url = v;                        // full URL
  else if (/^[^\s]+\.[^\s]+$/.test(v)) url = 'https://' + v;             // bare domain or path
  else url = 'https://duckduckgo.com/?q=' + encodeURIComponent(v);       // search terms
  closeUrlBar(); nav.open(url);
};

// ---------- the drawer (top left): tabs plus the footer tools; ids keep the old 'tabs' names ----------
// The stream sends the full tab list many times a second; keep a copy and redraw only when it changes.
let tabs = [], tabsKey = '';
function setTabs(list) {
  const k = JSON.stringify(list);
  if (k === tabsKey) return;
  tabs = list; tabsKey = k;
  if (drawer.classList.contains('open')) { renderTabs(); loadTitles(); }
}
// The stream's tab list keeps the title a tab had when it opened (often its URL); the server reads the current
// titles from Chrome. Fetched when the drawer opens and when the list changes while it's open (Stream only).
const titles = new Map(); let titlesBusy = false;
async function loadTitles() {
  if (isLive() || titlesBusy) return; titlesBusy = true;
  try { for (const t of await (await fetch('/api/tabs', { cache: 'no-store' })).json()) if (t.title) titles.set(String(t.id), t.title); } catch {}
  titlesBusy = false; if (drawer.classList.contains('open')) renderTabs();
}
const tabTitle = t => (!isLive() && titles.get(String(t.id))) || t.title || t.url || t.id;
const openDrawer = async () => {
  drawer.classList.add('open'); scrim.classList.remove('hidden'); renderTabs(); loadPins(); loadTitles();
  if (!tabs.length && !isLive()) { try { setTabs(await (await fetch('/api/tabs')).json()); } catch {} } // before the first stream update
};
const closeDrawer = () => { drawer.classList.remove('open'); scrim.classList.add('hidden'); };
const toggleDrawer = () => drawer.classList.contains('open') ? closeDrawer() : openDrawer();
$('tabsBtn').onclick = () => drawer.classList.contains('open') ? closeDrawer() : openDrawer();
scrim.onclick = closeDrawer;
$('tabNew').onclick = () => { nav.tabNew(); if (isLive()) { closeDrawer(); openUrlBar(); } };
// Pinned tabs (public/pins.js): kept on the server, shown first with a filled pin; agents leave them alone.
// The module and the pin list load on the first drawer open; a pin tap saves and redraws.
let pins = null, applyPins = null;
async function loadPins() {
  try {
    if (!applyPins) applyPins = (await import('./pins.js')).applyPins;
    pins = await (await fetch('/api/pins', { cache: 'no-store' })).json();
  } catch { pins = pins || []; }
  if (drawer.classList.contains('open')) renderTabs();
}
async function togglePin(t) {
  const r = await fetch('/api/pins', { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ op: t.pinned ? 'unpin' : 'pin', id: String(t.id), url: t.url || '', title: tabTitle(t) }) });
  const j = await r.json().catch(() => null);
  if (!j?.ok) { addLog('warn', 'pin: only a loaded web page can be pinned'); return; }
  pins = j.pins; renderTabs();
}
function renderTabs() {
  const list = $('tabList'); list.textContent = '';
  if (!tabs.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'no tabs'; list.appendChild(li); return; }
  const shown = applyPins && pins ? applyPins(pins, tabs).order : tabs;
  for (const t of shown) {
    const li = document.createElement('li'); if (t.active) li.classList.add('active'); if (t.pinned) li.classList.add('pinned');
    const body = document.createElement('div'); body.className = 't';
    const title = document.createElement('span'); title.className = 'title'; title.textContent = tabTitle(t);
    const u = document.createElement('span'); u.className = 'u'; u.textContent = t.url || '';
    body.append(title, u);
    body.onclick = async () => { await nav.tabSwitch(t.id); closeDrawer(); };
    // Closing takes two taps: the × turns into "close?" with a confirm (trash) and a cancel, and reverts after 4s.
    const x = document.createElement('button'); x.className = 'ib'; x.title = 'Close tab';
    x.innerHTML = '<svg><use href="icons.svg#close"/></svg>';
    const ask = document.createElement('span'); ask.className = 'ask hidden';
    ask.innerHTML = '<span class="q">close?</span><button class="ib yes" title="Close tab"><svg><use href="icons.svg#trash-can"/></svg></button><button class="ib no" title="Keep"><svg><use href="icons.svg#close"/></svg></button>';
    let revert;
    const arm = on => { x.classList.toggle('hidden', on); ask.classList.toggle('hidden', !on); li.classList.toggle('arming', on); clearTimeout(revert); if (on) revert = setTimeout(() => arm(false), 4000); };
    x.onclick = e => { e.stopPropagation(); arm(true); };
    ask.querySelector('.yes').onclick = e => { e.stopPropagation(); arm(false); nav.tabClose(t.id); };
    ask.querySelector('.no').onclick = e => { e.stopPropagation(); arm(false); };
    const pin = document.createElement('button'); pin.className = 'ib pin'; pin.title = t.pinned ? 'Unpin tab' : 'Pin tab';
    pin.setAttribute('aria-pressed', String(!!t.pinned));
    pin.innerHTML = `<svg><use href="icons.svg#${t.pinned ? 'pin--filled' : 'pin'}"/></svg>`;
    pin.onclick = e => { e.stopPropagation(); togglePin(t); };
    if (t.pinned) x.classList.add('hidden');                // unpin first to close a pinned tab
    li.append(pin, body, x, ask); list.appendChild(li);   // pin first: it stays put whether or not the × shows
  }
}

// ---------- tools (drawer footer) ----------
// ---------- settings (drawer footer gear): themes; the body is built on first open ----------
$('settingsBtn').onclick = () => { buildSettings(); $('settings').classList.remove('hidden'); closeDrawer(); };
$('settingsClose').onclick = () => $('settings').classList.add('hidden');
function buildSettings() {
  const body = $('settingsBody');
  if (body.childElementCount) { markTheme(); return; }
  body.innerHTML = '<h3>Theme</h3><div class="crow" role="radiogroup" aria-label="Theme"></div><p class="note">Standard is frosted glass. Solid uses the same muted colours with opaque surfaces and no blur (lighter on the GPU).</p>';
  for (const [id, label] of [['standard', 'Standard'], ['solid', 'Solid']]) {
    const b = document.createElement('button'); b.className = 'btn'; b.dataset.theme = id; b.textContent = label; b.setAttribute('role', 'radio');
    b.onclick = () => { setTheme(id, true); markTheme(); };
    body.querySelector('.crow').append(b);
  }
  markTheme();
}
function markTheme() { for (const b of $('settingsBody').querySelectorAll('[data-theme]')) { const on = b.dataset.theme === currentTheme(); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); } }
$('kbd').onclick = () => { closeDrawer(); key.focus(); };
const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
$('fs').onclick = () => { toggleFullscreen(); closeDrawer(); };
function updateFs() {
  const full = !!document.fullscreenElement;
  $('fsIcon').setAttribute('href', 'icons.svg#' + (full ? 'minimize' : 'maximize'));
  $('fs').title = full ? 'Exit full screen' : 'Full screen';
  const app = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  $('fs').classList.toggle('hidden', app || !document.fullscreenEnabled);
}
document.addEventListener('fullscreenchange', () => { updateFs(); sentSize = ''; syncViewport(); });
updateFs();

// ---------- console ----------
const recentLogs = new Map();                                 // the stream can deliver one event twice (seen ~6ms apart), and duplicates can interleave
function addLog(level, text) {
  const k = level + '|' + text, now = Date.now();
  for (const [key, t] of recentLogs) if (now - t > 1500) recentLogs.delete(key);
  if (recentLogs.has(k) && now - recentLogs.get(k) < 1500) { recentLogs.set(k, now); return; }
  recentLogs.set(k, now);
  const line = document.createElement('div'); line.className = level || 'log';
  line.textContent = `${new Date().toLocaleTimeString([], { hour12: false })}  ${level}  ${text}`;
  logEl.appendChild(line);
  while (logEl.children.length > 300) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
  if (level === 'error' && consoleEl.classList.contains('hidden')) { errors++; badge.textContent = errors; badge.classList.remove('hidden'); }
}
// Uncaught page errors are not on the stream; poll the server. The buffer is append-only
// (can't be cleared via the CLI in this version), so show only entries past what we've seen.
async function pollErrors() {
  if (!errBaseInit || mode !== 'stream') return;                             // don't surface anything until the baseline is set
  try {
    const list = await (await fetch('/api/errors')).json();
    if (list.length < errSeen) errSeen = 0;            // session restarted -> buffer shrank
    for (let i = errSeen; i < list.length; i++) addLog('error', list[i].text);
    errSeen = list.length;
  } catch {}
}
async function initErrorBaseline() {                    // skip errors already in the buffer when the viewer connects
  try { errSeen = (await (await fetch('/api/errors')).json()).length; } catch { errSeen = 0; }
  errBaseInit = true;
}
$('con').onclick = () => { consoleEl.classList.toggle('hidden'); errors = 0; badge.classList.add('hidden'); closeDrawer(); if (!consoleEl.classList.contains('hidden') && mode === 'stream') pollErrors(); };
$('clear').onclick = () => { logEl.textContent = ''; consoleEl.classList.add('hidden'); };

// ---------- controls reference ----------
$('help').onclick = () => { $('controls').classList.remove('hidden'); closeDrawer(); };
$('controlsClose').onclick = () => $('controls').classList.add('hidden');

// ---------- touch and mouse on the picture ----------
function toPage(t) { return { x: Math.round((t.clientX - view.x) / view.scale), y: Math.round((t.clientY - view.y) / view.scale) }; }
function tapAt(x, y) {
  send({ type: 'input_mouse', eventType: 'mouseMoved', x, y });
  send({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  send({ type: 'input_mouse', eventType: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
function scrollBy(dx, dy, at) { const p = at || cursor; send({ type: 'input_mouse', eventType: 'mouseWheel', x: Math.round(p.x), y: Math.round(p.y), deltaX: dx, deltaY: dy }); }
let touch = null;
canvas.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { touch = null; return; }
  const p = toPage(e.touches[0]); touch = { start: p, last: p, moved: false }; e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  if (!touch || e.touches.length !== 1) return;
  const p = toPage(e.touches[0]);
  if (Math.abs(p.x - touch.start.x) + Math.abs(p.y - touch.start.y) > 8) touch.moved = true;
  if (touch.moved) { scrollBy(touch.last.x - p.x, touch.last.y - p.y, touch.start); touch.last = p; }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchend', e => { if (touch && !touch.moved) tapAt(touch.start.x, touch.start.y); touch = null; e.preventDefault(); }, { passive: false });
canvas.addEventListener('mousedown', e => { const { x, y } = toPage(e); send({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: 'left', clickCount: 1 }); });
canvas.addEventListener('mouseup', e => { const { x, y } = toPage(e); send({ type: 'input_mouse', eventType: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); });
canvas.addEventListener('wheel', e => { scrollBy(e.deltaX, e.deltaY, toPage(e)); e.preventDefault(); }, { passive: false });

// ---------- typing (hidden field summons the Android keyboard) ----------
const pressKey = k => { send({ type: 'input_keyboard', eventType: 'keyDown', key: k, code: k }); send({ type: 'input_keyboard', eventType: 'keyUp', key: k, code: k }); };
key.addEventListener('keydown', e => { if (['Enter', 'Backspace', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) { pressKey(e.key); e.preventDefault(); } });
key.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertText' && e.data) for (const ch of e.data) send({ type: 'input_keyboard', eventType: 'char', text: ch });
  else if (e.inputType === 'deleteContentBackward') pressKey('Backspace');
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') pressKey('Enter');
  e.preventDefault();
});

// ---------- device controller (Gamepad API) and hardware keys ----------
// First-guess layout: left stick / D-pad scroll, right stick moves the pointer, A taps, B goes back,
// LB/RB page up/down, Start opens the address bar, Select opens the drawer.
// Everything received is logged to the server so the real mapping can be read off the log.
const logInput = (() => { let last = 0; return data => { const now = Date.now(); if (now - last < 150) return; last = now; api('/api/input-log', data); }; })();
function showCursor() { cursor.visible = true; clearTimeout(cursor.timer); cursor.timer = setTimeout(() => { cursor.visible = false; draw(); }, 2500); }
function moveCursor(dx, dy) { cursor.x = Math.max(0, Math.min(fw - 1, cursor.x + dx)); cursor.y = Math.max(0, Math.min(fh - 1, cursor.y + dy)); showCursor(); draw(); }
// AYN Thor pad is a non-standard "Odin Controller"; button indices vary and some are phantom/sticky,
// so the action->button map is learned by in-app calibration and saved. D-pad and sticks are stable.
const DEFAULT_BIND = { tap: 1, back: 2, tabs: 3, address: 4, pageup: 5, pagedown: 6 };
const DPAD = { up: 12, down: 13, left: 14, right: 15 };
let BIND = { ...DEFAULT_BIND };
try { const s = JSON.parse(localStorage.getItem('thorButtons') || 'null'); if (s) BIND = { ...DEFAULT_BIND, ...s }; } catch {}
let padTimer = null, prevButtons = [], rest = null, stillFor = 0, prevAx = null; // rest: axis values once the sticks have been still for 1s (a hat or trigger can rest at -1)
const dead = v => Math.abs(v) < 0.2 ? 0 : v;
const rel = (v, i) => { if (!rest) return 0; const r = rest[i] || 0; return Math.abs(r) > 0.9 ? 0 : dead(v - r); };
function pollPads() {
  const pad = [...(navigator.getGamepads?.() || [])].find(p => p && p.connected);
  if (!pad) return;
  if (calib.active) { calibCapture(pad); return; }
  const b = pad.buttons.map(x => x.pressed), ax = pad.axes.map(v => Math.round(v * 100) / 100);
  if (!rest) { stillFor = prevAx && ax.every((v, i) => v === prevAx[i]) && !b.some(Boolean) ? stillFor + 1 : 0; prevAx = ax; if (stillFor >= 30) rest = ax.slice(); }
  const edge = i => b[i] && !prevButtons[i];
  const lx = rel(ax[0] || 0, 0), ly = rel(ax[1] || 0, 1), rx = rel(ax[2] || 0, 2), ry = rel(ax[3] || 0, 3);
  if (mode === 'live') {
    if (edge(BIND.back)) nav.go('back');
    if (edge(BIND.address)) toggleUrlBar(); if (edge(BIND.tabs)) toggleDrawer();
    prevButtons = b; return;
  }
  if (lx || ly) scrollBy(lx * 24, ly * 24);
  if (rx || ry) moveCursor(rx * 14, ry * 14);
  if (b[DPAD.up]) scrollBy(0, -40); if (b[DPAD.down]) scrollBy(0, 40); if (b[DPAD.left]) scrollBy(-40, 0); if (b[DPAD.right]) scrollBy(40, 0);
  if (edge(BIND.tap)) { showCursor(); tapAt(Math.round(cursor.x), Math.round(cursor.y)); }
  if (edge(BIND.back)) api('/api/nav/back');
  if (edge(BIND.pageup)) scrollBy(0, -(fh - 80)); if (edge(BIND.pagedown)) scrollBy(0, fh - 80);
  if (edge(BIND.address)) toggleUrlBar(); if (edge(BIND.tabs)) toggleDrawer();
  const pressed = b.map((v, i) => v ? i : -1).filter(i => i >= 0);
  const moved = ax.some((v, i) => Math.abs(v - (rest?.[i] ?? 0)) > 0.2);
  if (pressed.length || moved) logInput({ type: 'gamepad', id: pad.id, mapping: pad.mapping, pressed, axes: ax.slice(0, 8), rest: rest?.slice(0, 8) });
  prevButtons = b;
}
function startPads() { if (!padTimer) padTimer = setInterval(() => { if (document.visibilityState === 'visible') pollPads(); }, 33); }
addEventListener('gamepadconnected', e => { logInput({ type: 'gamepadconnected', id: e.gamepad.id, mapping: e.gamepad.mapping, buttons: e.gamepad.buttons.length, axes: e.gamepad.axes.length }); startPads(); });
addEventListener('gamepaddisconnected', () => { clearInterval(padTimer); padTimer = null; });
if ([...(navigator.getGamepads?.() || [])].some(p => p)) startPads();
addEventListener('keydown', e => {                          // D-pad and buttons may arrive as key events on Android
  if (document.activeElement === key || document.activeElement === urlEl || mode === 'live') return;
  logInput({ type: 'key', key: e.key, code: e.code, keyCode: e.keyCode });
  const step = 60, map = {
    ArrowUp: () => scrollBy(0, -step), ArrowDown: () => scrollBy(0, step), ArrowLeft: () => scrollBy(-step, 0), ArrowRight: () => scrollBy(step, 0),
    PageUp: () => scrollBy(0, -(fh - 80)), PageDown: () => scrollBy(0, fh - 80),
    Enter: () => { showCursor(); tapAt(Math.round(cursor.x), Math.round(cursor.y)); }, Escape: () => api('/api/nav/back'), Backspace: () => api('/api/nav/back'),
  };
  if (map[e.key]) { map[e.key](); e.preventDefault(); }
});

// ---------- controller calibration ----------
// Steps through each action, waits for one fresh button-down (buttons already held at the start,
// which covers phantom/stuck ones, are excluded), and saves the action->index map to localStorage.
const CALIB_STEPS = [
  ['tap', 'TAP  (usually A)'], ['back', 'BACK  (usually B)'], ['tabs', 'OPEN TABS'],
  ['address', 'ADDRESS BAR'], ['pageup', 'PAGE UP  (a shoulder button)'], ['pagedown', 'PAGE DOWN  (a shoulder button)'],
];
const calib = { active: false, step: 0, baseline: new Set(), used: new Set(), prev: new Set(), result: {}, settleUntil: 0 };
function startCalibration() {
  calib.active = true; calib.step = 0; calib.used = new Set(); calib.result = {};
  calib.baseline = new Set(); calib.prev = new Set(); calib.settleUntil = Date.now() + 500;
  $('controls').classList.add('hidden'); $('calib').classList.remove('hidden');
  startPads(); renderCalib();
}
function endCalibration(save) {
  calib.active = false; $('calib').classList.add('hidden');
  if (save) { BIND = { ...DEFAULT_BIND, ...calib.result }; try { localStorage.setItem('thorButtons', JSON.stringify(BIND)); } catch {} }
}
function renderCalib() {
  const done = calib.step >= CALIB_STEPS.length;
  $('calibPrompt').textContent = done ? 'All set.' : 'Press the button for:';
  $('calibAction').textContent = done ? '' : CALIB_STEPS[calib.step][1];
  $('calibProgress').textContent = done ? '' : (calib.step + 1) + ' / ' + CALIB_STEPS.length;
  $('calibDone').classList.toggle('hidden', !done);
  $('calibSkip').classList.toggle('hidden', done);
}
function calibCapture(pad) {
  const pressed = new Set(pad.buttons.map((x, i) => x.pressed ? i : -1).filter(i => i >= 0));
  if (Date.now() < calib.settleUntil) { pressed.forEach(i => calib.baseline.add(i)); calib.prev = pressed; return; }
  if (calib.step >= CALIB_STEPS.length) return;
  for (const i of pressed) {
    if (!calib.prev.has(i) && !calib.baseline.has(i) && !calib.used.has(i)) {
      calib.result[CALIB_STEPS[calib.step][0]] = i; calib.used.add(i); calib.step++; renderCalib();
      break;
    }
  }
  calib.prev = pressed;
}
$('calibStart').onclick = startCalibration;
$('calibSkip').onclick = () => { if (calib.step < CALIB_STEPS.length) { calib.step++; renderCalib(); } };
$('calibDone').onclick = () => endCalibration(true);
$('calibCancel').onclick = () => endCalibration(false);

// ---------- optional FPS meter ----------
// Shell stats bar: the FPS/resolution/bandwidth of what we're actually seeing THROUGH the viewer
// (the CDP screencast stream), independent of whatever the page inside is doing. Subtle, persistent.
let statCount = 0, statLast = performance.now(), statBytes = 0, showStats = true;
let lastTemp = {};
const SENSORS = [                                        // [key, label, icon, warm C, hot C]
  ['battery', 'Battery', 'battery--full', 40, 44],
  ['body', 'Body', 'mobile', 40, 45],
  ['cpu', 'CPU', 'chip', 70, 80],                        // 70 C = the measurement gate, 80 C = the heat guard
  ['gpu', 'GPU', 'dashboard', 70, 80],
];
const toF = c => c * 9 / 5 + 32;   // declared before applyStats() first runs
try { showStats = localStorage.getItem('thorStats') !== '0'; } catch {}
function statTick(nbytes, flush = false) {
  if (!showStats) return;
  if (!flush) { statCount++; statBytes += (nbytes || 0); }
  const now = performance.now(), dt = now - statLast;
  if (dt >= 500 && (!flush || dt >= 1000)) {
    const fps = Math.round(statCount * 1000 / dt);
    const mbps = (statBytes * 8 / 1e6) / (dt / 1000);
    const el = $('stats');
    if (el) el.innerHTML = `<span class="v">${fps}</span> fps<span class="sep"> · </span><span class="res">${fw}×${fh}</span><span class="sep res"> · </span><span class="v">${mbps.toFixed(1)}</span> Mb/s`;
    statCount = 0; statBytes = 0; statLast = now;
  }
}
function applyStats() { const el = $('stats'); if (el) el.classList.toggle('hidden', !showStats); renderTemps(); const b = $('statsToggle'); if (b) { b.textContent = showStats ? 'Hide stats bar' : 'Show stats bar'; b.classList.toggle('on', showStats); } }
$('statsToggle').onclick = () => { showStats = !showStats; try { localStorage.setItem('thorStats', showStats ? '1' : '0'); } catch {} applyStats(); };
applyStats();
// Temperatures via the server's /api/temp (the page can't read /sys), shown in °F beside the heat-guard
// thermometer: battery (what the hand feels; battery health), body (xo-therm, the board: closest to skin),
// CPU and GPU (max over their zones). Coloured as they climb. Polled only while the stats bar is shown.
// Tapping the readouts opens a small list with each sensor's name and meaning (built only while open).
const SENSOR_INFO = { battery: 'what your hand feels; battery health', body: 'board sensor, closest to the surface',
  cpu: 'hottest CPU core; what throttles', gpu: 'hottest GPU zone; graphics load' };
function renderTempMenu() {
  const m = $('tempMenu'); if (!m || m.classList.contains('hidden')) return;
  m.innerHTML = SENSORS.filter(([k]) => lastTemp[k] != null).map(([k, label, icon, warm, hot]) => {
    const c = lastTemp[k], f = toF(c), cls = c >= hot ? 'hot' : c >= warm ? 'warm' : '';
    return `<div class="row ${cls}"><svg aria-hidden="true"><use href="icons.svg#${icon}"/></svg><span class="n">${label}</span><span class="d">${SENSOR_INFO[k] || ''}</span><span class="v">${Math.round(f)}°F</span></div>`;
  }).join('') || '<div class="row"><span class="n">No readings yet</span></div>';
}
function setTempMenu(open) {
  const m = $('tempMenu'), t = $('temps'); if (!m || !t) return;
  m.classList.toggle('hidden', !open); t.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (open) renderTempMenu(); else m.textContent = '';
}
$('temps').onclick = e => { e.stopPropagation(); setTempMenu($('tempMenu').classList.contains('hidden')); };
$('temps').onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('temps').click(); } };
document.addEventListener('pointerdown', e => { if (!e.target.closest('#tempWrap')) setTempMenu(false); });
function renderTemps() {
  const el = $('temps'); if (!el) return;
  renderTempMenu();
  el.classList.toggle('hidden', !showStats);
  el.innerHTML = SENSORS.filter(([k]) => lastTemp[k] != null).map(([k, label, icon, warm, hot]) => {
    const c = lastTemp[k], f = toF(c), cls = c >= hot ? 'hot' : c >= warm ? 'warm' : '';
    return `<span class="t ${cls}" data-k="${k}" title="${label} ${f.toFixed(1)} °F" aria-label="${label} ${Math.round(f)} degrees Fahrenheit"><svg aria-hidden="true"><use href="icons.svg#${icon}"/></svg>${Math.round(f)}°</span>`;
  }).join('');
}
// In Live the stats bar shows the live page's frame rate (not the stream's): the page's own [lab] frame readout
// when it has one, else a tiny rAF sampler that stops itself unless it's asked again within 5 s.
const LIVE_FPS_JS = `(() => { try { if (window.__lab) { const f = __lab.frames(2).frame; if (f) return Math.round(1000 / f.mean); } } catch {}
  const w = window, now = performance.now(); let s = w.__thorFps;
  if (!s || !s.on) { s = w.__thorFps = { n: 0, t: now, on: true, until: 0 }; const tick = () => { s.n++; if (performance.now() < s.until) requestAnimationFrame(tick); else s.on = false; }; requestAnimationFrame(tick); }
  s.until = now + 5000; const fps = s.n * 1000 / Math.max(1, now - s.t); s.n = 0; s.t = now; return Math.round(fps); })()`;
async function pollLiveFps() {
  if (!showStats || mode !== 'live') return;
  let fps = null;
  try { const r = await (await fetch('/api/live/eval', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expression: LIVE_FPS_JS }) })).json(); if (r.ok && Number.isFinite(r.value)) fps = r.value; } catch {}
  const el = $('stats'); if (el && mode === 'live') el.innerHTML = fps == null ? '<span class="v">–</span> fps' : `<span class="v">${fps}</span> fps`;
}
async function pollTemp() {
  if (!showStats) return renderTemps();
  try { const r = await fetch('/api/temp', { cache: 'no-store' }); if (r.ok) lastTemp = await r.json(); } catch {}
  renderTemps();
}
pollTemp(); setInterval(pollTemp, 5000); setInterval(pollLiveFps, 2000);
// an idle stream sends no frames: flush the stats once a second so the bar shows 0 fps instead of sticking at '–'
setInterval(() => { if (showStats && mode !== 'live') statTick(0, true); }, 1000);

// ---------- mode toggle (top, beside the tabs button) ----------
const shell = {                                          // what live.js may use
  setTabs, addLog, addHistory, openUrlBar, closeDrawer, pollTemp,
  setUrl: u => { if (document.activeElement !== urlEl) urlEl.value = u; },
  clearLog: () => { logEl.textContent = ''; errors = 0; badge.classList.add('hidden'); },
  status: msg => { status.textContent = msg; status.classList.toggle('hidden', !msg); },
  streamUrl: () => urlEl.value,
};
function showMode() {
  const b = $('modeBtn'); b.dataset.mode = mode;
  b.title = mode === 'live' ? 'Live page: tap for the stream' : 'Stream: tap for the live page';
}
async function setMode(m, persist = true) {
  if (m === mode && (m === 'stream' ? streamOn : live)) return;
  const was = mode; mode = m; showMode();
  if (persist) try { localStorage.setItem('thorMode', m); } catch {}
  tabs = []; tabsKey = ''; shell.clearLog(); closeDrawer();
  if (m === 'live') {
    streamStop();
    try { live = live || await import('./live.js').then(mod => mod.create(shell)); live.enter(); }
    catch (e) { live = null; mode = was; showMode(); shell.status('live mode failed to load'); if (was === 'stream') streamStart(); }
  } else {
    if (live) live.exit();
    streamStart(); sentSize = ''; syncViewport(); pollTemp();
  }
}
$('modeBtn').onclick = () => setMode(mode === 'live' ? 'stream' : 'live');
// Small glass notice, top centre; built on first use, removed when it times out (nothing left rendering).
let noticeEl = null, noticeTimer = null;
function notice(msg, ms = 7000, action = null) {
  clearTimeout(noticeTimer);
  if (!noticeEl) { noticeEl = document.createElement('div'); noticeEl.id = 'notice'; noticeEl.setAttribute('role', 'status'); document.body.appendChild(noticeEl); }
  noticeEl.textContent = msg;
  const close = () => { clearTimeout(noticeTimer); noticeEl?.remove(); noticeEl = null; };
  if (action) { const b = document.createElement('button'); b.textContent = action.label; b.onclick = () => { close(); action.run(); }; noticeEl.appendChild(b); }
  noticeTimer = setTimeout(close, ms);
}
// Live could not start or lost its connection: back to Stream for now. Key's choice (thorMode) is kept,
// so the next open tries Live again.
shell.fallback = (reason, hot) => {
  if (mode !== 'live') return;
  setMode('stream', false);
  if (hot) notice(reason || 'Too hot, switched to Stream.', 30000, { label: 'Back to Live', run: () => setMode('live') });  // no auto-return
  else notice('Live is unavailable, showing Stream. ' + (reason || ''));
};

// ---------- heat guard switch (the thermometer beside the temperature readouts) ----------
// Tap: guard off for 30 min / back on. The state lives on the server (/api/heat), so a reload keeps it.
// Long-press: shows the time left. The badge ticks once a minute, and only while the guard is off.
let heatOffUntil = null, heatTick = null;
function showHeat() {
  const b = $('heatBtn'), left = $('heatLeft');
  clearInterval(heatTick); heatTick = null;
  const off = heatOffUntil && heatOffUntil > Date.now();
  if (!off) { heatOffUntil = null; delete b.dataset.off; left.classList.add('hidden'); b.title = 'Heat guard on: Live switches to Stream if the device runs too hot. Tap to turn off for 30 min.'; return; }
  const mins = Math.ceil((heatOffUntil - Date.now()) / 60000);
  b.dataset.off = ''; left.textContent = mins + 'm'; left.classList.remove('hidden');
  b.title = `Heat guard off for ${mins} more min. Tap to turn it back on.`;
  heatTick = setInterval(showHeat, 60000);
}
async function heatSet(off) {
  try { const r = await (await fetch('/api/heat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ off }) })).json(); heatOffUntil = r.offUntil; } catch {}
  showHeat(); notice(heatOffUntil ? 'Heat guard off for 30 min.' : 'Heat guard on.', 3000);
}
{
  const b = $('heatBtn'); let press = null, long = false;
  b.addEventListener('pointerdown', () => { long = false; press = setTimeout(() => { long = true; notice(heatOffUntil ? `Heat guard off for ${Math.ceil((heatOffUntil - Date.now()) / 60000)} more min.` : 'Heat guard on.', 3000); }, 600); });
  b.addEventListener('pointerup', () => clearTimeout(press));
  b.addEventListener('pointercancel', () => clearTimeout(press));
  b.onclick = () => { if (!long) heatSet(!heatOffUntil); };
  fetch('/api/heat').then(r => r.json()).then(r => { heatOffUntil = r.offUntil; showHeat(); }).catch(() => {});
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
layout(); showMode();
if (mode === 'live') { mode = 'stream'; setMode('live'); } else { streamStart(); syncViewport(); }
initErrorBaseline();
