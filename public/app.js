// Thor Viewer: full-screen live view of the agent-browser "thor" session.
// Connects straight to agent-browser's stream (JPEG frames + input injection);
// tabs, navigation and page errors go through the small server API.
const STREAM = 'ws://127.0.0.1:9223/?pacing=ack&maxFps=15';
const $ = id => document.getElementById(id);
const canvas = $('screen'), ctx = canvas.getContext('2d');
const status = $('status'), urlEl = $('url'), urlwrap = $('urlwrap'), drawer = $('drawer'), scrim = $('scrim');
const consoleEl = $('console'), logEl = $('log'), badge = $('badge'), key = $('key');

let ws, frame = null, fw = 1280, fh = 720, errors = 0;
let view = { scale: 1, x: 0, y: 0 };                       // where the frame is drawn (CSS px)
const cursor = { x: 640, y: 360, visible: false, timer: null }; // controller pointer, frame coords
const api = (path, body) => fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { method: 'POST' }).catch(() => {});

// ---------- drawing ----------
function layout() {
  const dpr = devicePixelRatio || 1, W = innerWidth, H = innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scale = Math.min(W / fw, H / fh);
  view = { scale, x: (W - fw * scale) / 2, y: (H - fh * scale) / 2 };
  draw();
}
function draw() {
  ctx.fillStyle = '#05080c'; ctx.fillRect(0, 0, innerWidth, innerHeight);
  if (frame) ctx.drawImage(frame, view.x, view.y, fw * view.scale, fh * view.scale);
  if (cursor.visible) {
    const x = view.x + cursor.x * view.scale, y = view.y + cursor.y * view.scale;
    ctx.beginPath(); ctx.arc(x, y, 10, 0, Math.PI * 2); ctx.strokeStyle = '#5ee0ff'; ctx.lineWidth = 2; ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fillStyle = '#5ee0ff'; ctx.fill();
  }
}
let lastW = innerWidth;
addEventListener('resize', () => { layout(); if (innerWidth !== lastW) { lastW = innerWidth; syncViewport(); } }); // height-only changes (toolbar, keyboard) do not resize the page

// ---------- viewport sync: the remote browser takes this screen's exact size ----------
let sentSize = '', sizeTimer, lastResync = 0;
const TEST_BROWSER = /HeadlessChrome/.test(navigator.userAgent);            // Claude's own test copies never set the size
const inFront = () => !TEST_BROWSER && document.visibilityState === 'visible' && document.hasFocus(); // only the viewer in front sets the size
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
function connect() {
  status.textContent = 'connecting to browser'; status.classList.remove('hidden');
  ws = new WebSocket(STREAM);
  ws.onopen = () => { status.textContent = 'waiting for first frame'; };
  ws.onclose = () => { status.textContent = 'browser stream closed · ask Claude to run the start script · retrying'; status.classList.remove('hidden'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'frame') {
      const img = new Image();
      img.onload = () => {
        frame = img;
        if (m.metadata.deviceWidth !== fw || m.metadata.deviceHeight !== fh) { fw = m.metadata.deviceWidth; fh = m.metadata.deviceHeight; layout(); } else draw();
        status.classList.add('hidden');
        send({ type: 'ack', seq: m.seq });
        resyncIfMismatch();
      };
      img.src = 'data:image/jpeg;base64,' + m.data;
    } else if (m.type === 'url') {
      if (document.activeElement !== urlEl) urlEl.value = m.url;
    } else if (m.type === 'tabs' && Array.isArray(m.tabs)) {
      setTabs(m.tabs.map(t => ({ id: t.tabId, title: t.title, url: t.url, active: !!t.active })));
      const active = m.tabs.find(t => t.active) || m.tabs[0];
      if (active?.url && document.activeElement !== urlEl) urlEl.value = active.url;
    } else if (m.type === 'console') {
      addLog(m.level, m.text);
    } else if (m.type === 'status' && m.viewportWidth) {
      if (m.viewportWidth !== fw || m.viewportHeight !== fh) { fw = m.viewportWidth; fh = m.viewportHeight; layout(); }
    }
  };
}
function send(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ---------- address bar (top right, expands leftwards) ----------
const openUrlBar = () => { urlwrap.classList.add('open'); urlEl.focus(); urlEl.select(); };
const closeUrlBar = () => { urlwrap.classList.remove('open'); urlEl.blur(); };
$('urlBtn').onclick = openUrlBar;
$('urlClose').onclick = closeUrlBar;
$('back').onclick = () => api('/api/nav/back');
$('forward').onclick = () => api('/api/nav/forward');
$('urlbar').onsubmit = e => {
  e.preventDefault();
  const v = urlEl.value.trim(); if (!v) return;
  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) url = v;                        // full URL
  else if (/^[^\s]+\.[^\s]+$/.test(v)) url = 'https://' + v;             // bare domain or path
  else url = 'https://duckduckgo.com/?q=' + encodeURIComponent(v);       // search terms
  closeUrlBar(); api('/api/nav/open', { url });
};

// ---------- tabs drawer (top left) ----------
// The stream sends the full tab list many times a second; keep a copy and redraw only when it changes.
let tabs = [], tabsKey = '';
function setTabs(list) {
  const k = JSON.stringify(list);
  if (k === tabsKey) return;
  tabs = list; tabsKey = k;
  if (drawer.classList.contains('open')) renderTabs();
}
const openDrawer = async () => {
  drawer.classList.add('open'); scrim.classList.remove('hidden'); renderTabs();
  if (!tabs.length) { try { setTabs(await (await fetch('/api/tabs')).json()); } catch {} } // before the first stream update
};
const closeDrawer = () => { drawer.classList.remove('open'); scrim.classList.add('hidden'); };
$('tabsBtn').onclick = () => drawer.classList.contains('open') ? closeDrawer() : openDrawer();
scrim.onclick = closeDrawer;
$('tabNew').onclick = () => api('/api/tabs/new', {});
function renderTabs() {
  const list = $('tabList'); list.textContent = '';
  if (!tabs.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'no tabs'; list.appendChild(li); return; }
  for (const t of tabs) {
    const li = document.createElement('li'); if (t.active) li.classList.add('active');
    const body = document.createElement('div'); body.className = 't';
    const title = document.createElement('span'); title.className = 'title'; title.textContent = t.title || t.url || t.id;
    const u = document.createElement('span'); u.className = 'u'; u.textContent = t.url || '';
    body.append(title, u);
    body.onclick = async () => { await api('/api/tabs/switch', { id: t.id }); closeDrawer(); };
    // Closing takes two taps: the × turns into "close?" with a confirm (trash) and a cancel, and reverts after 4s.
    const x = document.createElement('button'); x.className = 'ib'; x.title = 'Close tab';
    x.innerHTML = '<svg><use href="icons.svg#close"/></svg>';
    const ask = document.createElement('span'); ask.className = 'ask hidden';
    ask.innerHTML = '<span class="q">close?</span><button class="ib yes" title="Close tab"><svg><use href="icons.svg#trash-can"/></svg></button><button class="ib no" title="Keep"><svg><use href="icons.svg#close"/></svg></button>';
    let revert;
    const arm = on => { x.classList.toggle('hidden', on); ask.classList.toggle('hidden', !on); li.classList.toggle('arming', on); clearTimeout(revert); if (on) revert = setTimeout(() => arm(false), 4000); };
    x.onclick = e => { e.stopPropagation(); arm(true); };
    ask.querySelector('.yes').onclick = e => { e.stopPropagation(); arm(false); api('/api/tabs/close', { id: t.id }); };
    ask.querySelector('.no').onclick = e => { e.stopPropagation(); arm(false); };
    li.append(body, x, ask); list.appendChild(li);
  }
}

// ---------- tools (drawer footer) ----------
$('reload').onclick = () => { api('/api/nav/reload'); closeDrawer(); };
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
const seenErrors = new Set();                                 // uncaught page errors are not on the stream; poll the server
async function pollErrors() {
  try { for (const e of await (await fetch('/api/errors')).json()) if (!seenErrors.has(e.text)) { seenErrors.add(e.text); addLog('error', e.text); } } catch {}
}
setInterval(pollErrors, 20000);
$('con').onclick = () => { consoleEl.classList.toggle('hidden'); errors = 0; badge.classList.add('hidden'); closeDrawer(); if (!consoleEl.classList.contains('hidden')) pollErrors(); };
$('clear').onclick = () => { logEl.textContent = ''; consoleEl.classList.add('hidden'); };

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
// LB/RB page up/down, Start opens the address bar, Select opens the tabs drawer.
// Everything received is logged to the server so the real mapping can be read off the log.
const logInput = (() => { let last = 0; return data => { const now = Date.now(); if (now - last < 150) return; last = now; api('/api/input-log', data); }; })();
function showCursor() { cursor.visible = true; clearTimeout(cursor.timer); cursor.timer = setTimeout(() => { cursor.visible = false; draw(); }, 2500); }
function moveCursor(dx, dy) { cursor.x = Math.max(0, Math.min(fw - 1, cursor.x + dx)); cursor.y = Math.max(0, Math.min(fh - 1, cursor.y + dy)); showCursor(); draw(); }
// AYN Thor pad reports as non-standard "Odin Controller"; indices from calibration (see history / input log).
// Button 9 reads as permanently pressed (phantom) and is ignored. R2/L3/R3/Start/Select pending a second pass.
const PAD = { A: 1, B: 2, X: 3, Y: 4, L1: 5, R1: 6, L2: 7, DU: 12, DD: 13, DL: 14, DR: 15 };
// Start, Select, L3, R3 and R2 are intercepted by Android/AYN Game Assistant and do not reliably reach the page, so no actions use them.
const PHANTOM = 9;
let padTimer = null, prevButtons = [], rest = null, stillFor = 0, prevAx = null; // rest: axis values once the sticks have been still for 1s (a hat or trigger can rest at -1)
const dead = v => Math.abs(v) < 0.2 ? 0 : v;
const rel = (v, i) => { if (!rest) return 0; const r = rest[i] || 0; return Math.abs(r) > 0.9 ? 0 : dead(v - r); };
function pollPads() {
  const pad = [...(navigator.getGamepads?.() || [])].find(p => p && p.connected);
  if (!pad) return;
  const b = pad.buttons.map((x, i) => x.pressed && i !== PHANTOM), ax = pad.axes.map(v => Math.round(v * 100) / 100);
  if (!rest) { stillFor = prevAx && ax.every((v, i) => v === prevAx[i]) && !b.some(Boolean) ? stillFor + 1 : 0; prevAx = ax; if (stillFor >= 30) rest = ax.slice(); }
  const edge = i => b[i] && !prevButtons[i];
  const lx = rel(ax[0] || 0, 0), ly = rel(ax[1] || 0, 1), rx = rel(ax[2] || 0, 2), ry = rel(ax[3] || 0, 3);
  if (lx || ly) scrollBy(lx * 24, ly * 24);
  if (rx || ry) moveCursor(rx * 14, ry * 14);
  if (b[PAD.DU]) scrollBy(0, -40); if (b[PAD.DD]) scrollBy(0, 40); if (b[PAD.DL]) scrollBy(-40, 0); if (b[PAD.DR]) scrollBy(40, 0);
  if (edge(PAD.A)) { showCursor(); tapAt(Math.round(cursor.x), Math.round(cursor.y)); }
  if (edge(PAD.B)) api('/api/nav/back');
  if (edge(PAD.L1)) scrollBy(0, -(fh - 80)); if (edge(PAD.R1)) scrollBy(0, fh - 80);
  if (edge(PAD.Y)) openUrlBar(); if (edge(PAD.X)) openDrawer();
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
  if (document.activeElement === key || document.activeElement === urlEl) return;
  logInput({ type: 'key', key: e.key, code: e.code, keyCode: e.keyCode });
  const step = 60, map = {
    ArrowUp: () => scrollBy(0, -step), ArrowDown: () => scrollBy(0, step), ArrowLeft: () => scrollBy(-step, 0), ArrowRight: () => scrollBy(step, 0),
    PageUp: () => scrollBy(0, -(fh - 80)), PageDown: () => scrollBy(0, fh - 80),
    Enter: () => { showCursor(); tapAt(Math.round(cursor.x), Math.round(cursor.y)); }, Escape: () => api('/api/nav/back'), Backspace: () => api('/api/nav/back'),
  };
  if (map[e.key]) { map[e.key](); e.preventDefault(); }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
layout(); syncViewport(); connect();
