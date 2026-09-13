// Thor Viewer: full-screen live view of the agent-browser "thor" session.
// Connects straight to agent-browser's stream (JPEG frames + input injection).
const STREAM = 'ws://127.0.0.1:9223/?pacing=ack&maxFps=15';

const canvas = document.getElementById('screen');
const ctx = canvas.getContext('2d');
const status = document.getElementById('status');
const bar = document.getElementById('bar');
const urlEl = document.getElementById('url');
const consoleEl = document.getElementById('console');
const logEl = document.getElementById('log');
const badge = document.getElementById('badge');
const key = document.getElementById('key');

let ws, frame = null, fw = 1280, fh = 720, errors = 0, hideTimer;
let view = { scale: 1, x: 0, y: 0 }; // where the frame is drawn on the canvas (CSS px)
const cursor = { x: 640, y: 360, visible: false, timer: null }; // controller-driven pointer, in frame coords

// ---------- drawing ----------
function layout() {
  const dpr = devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scale = Math.min(W / fw, H / fh);
  view = { scale, x: (W - fw * scale) / 2, y: (H - fh * scale) / 2 };
  draw();
}
function draw() {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  if (frame) ctx.drawImage(frame, view.x, view.y, fw * view.scale, fh * view.scale);
  if (cursor.visible) {
    ctx.beginPath(); ctx.arc(view.x + cursor.x * view.scale, view.y + cursor.y * view.scale, 9, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,80,80,.55)'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
  }
}
addEventListener('resize', () => { layout(); syncViewport(); });

// Make the remote browser the same size as this view, so pages reflow to the real screen shape.
let sentSize = '', sizeTimer, lastResync = 0;
function resyncIfMismatch() {
  if (document.visibilityState !== 'visible') return;
  if (fw === Math.round(canvas.clientWidth) && fh === Math.round(canvas.clientHeight)) return;
  if (Date.now() - lastResync < 3000) return;
  lastResync = Date.now(); sentSize = ''; syncViewport();
}
document.addEventListener('visibilitychange', () => { sentSize = ''; syncViewport(); });
function syncViewport() {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(async () => {
    const w = Math.round(canvas.clientWidth), h = Math.round(canvas.clientHeight), k = w + 'x' + h;
    if (k === sentSize) return;
    sentSize = k;
    try { await fetch('/api/viewport', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ w, h }) }); } catch {}
  }, 300);
}

// ---------- stream ----------
function connect() {
  status.textContent = 'connecting to browser…'; status.classList.remove('hidden');
  ws = new WebSocket(STREAM);
  ws.onopen = () => { status.textContent = 'waiting for first frame…'; };
  ws.onclose = () => { status.textContent = 'browser stream closed. Ask Claude to run the agent-browser start script. Retrying…'; status.classList.remove('hidden'); setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.type === 'frame') {
      const img = new Image();
      img.onload = () => {
        frame = img;
        if (m.metadata.deviceWidth !== fw || m.metadata.deviceHeight !== fh) { fw = m.metadata.deviceWidth; fh = m.metadata.deviceHeight; layout(); }
        else draw();
        resyncIfMismatch();
        status.classList.add('hidden');
        send({ type: 'ack', seq: m.seq });
      };
      img.src = 'data:image/jpeg;base64,' + m.data;
    } else if (m.type === 'url') {
      if (document.activeElement !== urlEl) urlEl.value = m.url;
    } else if (m.type === 'tabs' && Array.isArray(m.tabs)) {
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

// ---------- console drawer ----------
let lastLog = { key: '', t: 0 };
function addLog(level, text) {
  const k = level + '|' + text, now = Date.now(); // the stream can deliver the same event twice
  if (k === lastLog.key && now - lastLog.t < 500) return;
  lastLog = { key: k, t: now };
  const line = document.createElement('div');
  line.className = level || 'log';
  line.textContent = `[${new Date().toLocaleTimeString([], { hour12: false })}] ${level}: ${text}`;
  logEl.appendChild(line);
  while (logEl.children.length > 300) logEl.firstChild.remove();
  logEl.scrollTop = logEl.scrollHeight;
  if (level === 'error') { errors++; badge.textContent = errors; badge.classList.remove('hidden'); }
}
// Uncaught page errors are not on the stream; ask the server for them while the drawer is open, and every 20s otherwise for the badge.
const seenErrors = new Set();
async function pollErrors() {
  try {
    const list = await (await fetch('/api/errors')).json();
    for (const e of list) { const k = e.text; if (!seenErrors.has(k)) { seenErrors.add(k); addLog('error', e.text); } }
  } catch {}
}
setInterval(pollErrors, 20000);
document.getElementById('con').onclick = () => { consoleEl.classList.toggle('hidden'); errors = 0; badge.classList.add('hidden'); keepBar(); if (!consoleEl.classList.contains('hidden')) pollErrors(); };
document.getElementById('clear').onclick = () => { logEl.textContent = ''; errors = 0; badge.classList.add('hidden'); };

// ---------- bar: persistent address bar. ▴ collapses it; a tap at the top edge of the picture brings it back ----------
function showBar() { bar.classList.remove('hidden'); layout(); syncViewport(); }
function keepBar() {}
document.getElementById('hide').onclick = () => { bar.classList.add('hidden'); layout(); syncViewport(); };
document.getElementById('back').onclick = () => nav('back');
document.getElementById('urlform').onsubmit = e => {
  e.preventDefault();
  const v = urlEl.value.trim(); if (!v) return;
  let url;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) url = v;                       // full URL
  else if (/^[^\s]+\.[^\s]+$/.test(v)) url = 'https://' + v;            // bare domain or path
  else url = 'https://duckduckgo.com/?q=' + encodeURIComponent(v);      // search terms
  urlEl.blur();
  fetch('/api/nav/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) }).catch(() => {});
};
const toggleFullscreen = () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
const fsBar = document.getElementById('fs'), fsbtn = document.getElementById('fsbtn');
fsBar.onclick = () => { toggleFullscreen(); keepBar(); };
fsbtn.onclick = toggleFullscreen;
function updateFsButton() {
  const app = matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches;
  const full = !!document.fullscreenElement;
  fsBar.textContent = full ? 'exit full screen' : 'full screen';
  fsbtn.textContent = full ? '⤡' : '⛶';
  fsbtn.title = full ? 'Exit full screen' : 'Full screen';
  fsbtn.classList.toggle('dim', full);
  fsbtn.classList.toggle('hidden', app || !document.fullscreenEnabled);
}
document.addEventListener('fullscreenchange', () => { updateFsButton(); syncViewport(); });
updateFsButton();
document.getElementById('kbd').onclick = () => { key.focus(); keepBar(); };

// ---------- input: touch → mouse on the remote page ----------
function toPage(t) { const r = canvas.getBoundingClientRect(); return { x: Math.round((t.clientX - r.left - view.x) / view.scale), y: Math.round((t.clientY - r.top - view.y) / view.scale) }; }
let touch = null; // {start, last, moved, startTime}
canvas.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { touch = null; return; }
  const p = toPage(e.touches[0]);
  touch = { start: p, last: p, moved: false, t: Date.now(), tip: e.touches[0].clientY - canvas.getBoundingClientRect().top < 24 };
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchmove', e => {
  if (!touch || e.touches.length !== 1) return;
  const p = toPage(e.touches[0]);
  if (Math.abs(p.x - touch.start.x) + Math.abs(p.y - touch.start.y) > 8) touch.moved = true;
  if (touch.moved) { // one-finger drag scrolls the remote page
    send({ type: 'input_mouse', eventType: 'mouseWheel', x: touch.start.x, y: touch.start.y, deltaX: touch.last.x - p.x, deltaY: touch.last.y - p.y });
    touch.last = p;
  }
  e.preventDefault();
}, { passive: false });
canvas.addEventListener('touchend', e => {
  if (!touch) return;
  if (!touch.moved) {
    if (touch.tip) showBar();
    const { x, y } = touch.start;
    send({ type: 'input_mouse', eventType: 'mouseMoved', x, y });
    send({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    send({ type: 'input_mouse', eventType: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  }
  touch = null; e.preventDefault();
}, { passive: false });
// Mouse (when a pointer is attached, or for desktop testing)
canvas.addEventListener('mousedown', e => { if (e.clientY - canvas.getBoundingClientRect().top < 24) showBar(); const { x, y } = toPage(e); send({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: 'left', clickCount: 1 }); });
canvas.addEventListener('mouseup', e => { const { x, y } = toPage(e); send({ type: 'input_mouse', eventType: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); });
canvas.addEventListener('wheel', e => { const { x, y } = toPage(e); send({ type: 'input_mouse', eventType: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY }); e.preventDefault(); }, { passive: false });

// ---------- input: keyboard (hidden field summons the Android keyboard) ----------
const SPECIAL = { Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight' };
key.addEventListener('keydown', e => {
  if (SPECIAL[e.key]) { send({ type: 'input_keyboard', eventType: 'keyDown', key: e.key, code: e.code || e.key }); send({ type: 'input_keyboard', eventType: 'keyUp', key: e.key, code: e.code || e.key }); e.preventDefault(); }
});
key.addEventListener('beforeinput', e => {
  if (e.inputType === 'insertText' && e.data) for (const ch of e.data) send({ type: 'input_keyboard', eventType: 'char', text: ch });
  else if (e.inputType === 'deleteContentBackward') { send({ type: 'input_keyboard', eventType: 'keyDown', key: 'Backspace', code: 'Backspace' }); send({ type: 'input_keyboard', eventType: 'keyUp', key: 'Backspace', code: 'Backspace' }); }
  else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') { send({ type: 'input_keyboard', eventType: 'keyDown', key: 'Enter', code: 'Enter' }); send({ type: 'input_keyboard', eventType: 'keyUp', key: 'Enter', code: 'Enter' }); }
  e.preventDefault();
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
layout();
syncViewport();
connect();

// ---------- device controller (Gamepad API) and hardware keys ----------
// Left stick / D-pad scroll, right stick moves the pointer, A taps, B goes back,
// LB/RB page up/down, Start shows the bar, Select toggles the console.
// Everything received is also logged to the server so the mapping can be checked.
const logInput = (() => { let last = 0; return (data) => { const now = Date.now(); if (now - last < 150) return; last = now; fetch('/api/input-log', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }).catch(() => {}); }; })();
function scrollBy(dx, dy) { send({ type: 'input_mouse', eventType: 'mouseWheel', x: Math.round(cursor.x), y: Math.round(cursor.y), deltaX: dx, deltaY: dy }); }
function tapAtCursor() {
  const x = Math.round(cursor.x), y = Math.round(cursor.y);
  send({ type: 'input_mouse', eventType: 'mouseMoved', x, y });
  send({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  send({ type: 'input_mouse', eventType: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
}
function showCursor() { cursor.visible = true; clearTimeout(cursor.timer); cursor.timer = setTimeout(() => { cursor.visible = false; draw(); }, 2500); }
function moveCursor(dx, dy) { cursor.x = Math.max(0, Math.min(fw - 1, cursor.x + dx)); cursor.y = Math.max(0, Math.min(fh - 1, cursor.y + dy)); showCursor(); draw(); }
const nav = what => fetch('/api/nav/' + what, { method: 'POST' }).catch(() => {});

let padTimer = null, prevButtons = [];
const dead = v => Math.abs(v) < 0.2 ? 0 : v;
function pollPads() {
  const pad = [...(navigator.getGamepads?.() || [])].find(p => p && p.connected);
  if (!pad) return;
  const b = pad.buttons.map(x => x.pressed), ax = pad.axes.map(v => Math.round(v * 100) / 100);
  const edge = i => b[i] && !prevButtons[i];
  const lx = dead(ax[0] || 0), ly = dead(ax[1] || 0), rx = dead(ax[2] || 0), ry = dead(ax[3] || 0);
  if (lx || ly) scrollBy(lx * 24, ly * 24);
  if (rx || ry) moveCursor(rx * 14, ry * 14);
  if (b[12]) scrollBy(0, -40); if (b[13]) scrollBy(0, 40); if (b[14]) scrollBy(-40, 0); if (b[15]) scrollBy(40, 0);
  if (edge(0)) { showCursor(); tapAtCursor(); }
  if (edge(1)) nav('back');
  if (edge(4)) scrollBy(0, -(fh - 80)); if (edge(5)) scrollBy(0, fh - 80);
  if (edge(9)) showBar(); if (edge(8)) document.getElementById('con').click();
  const pressed = b.map((v, i) => v ? i : -1).filter(i => i >= 0);
  if (pressed.length || lx || ly || rx || ry) logInput({ type: 'gamepad', id: pad.id, mapping: pad.mapping, pressed, axes: ax.slice(0, 6) });
  prevButtons = b;
}
function startPads() { if (!padTimer) padTimer = setInterval(() => { if (document.visibilityState === 'visible') pollPads(); }, 33); }
addEventListener('gamepadconnected', e => { logInput({ type: 'gamepadconnected', id: e.gamepad.id, mapping: e.gamepad.mapping, buttons: e.gamepad.buttons.length, axes: e.gamepad.axes.length }); startPads(); });
addEventListener('gamepaddisconnected', () => { clearInterval(padTimer); padTimer = null; });
if ([...(navigator.getGamepads?.() || [])].some(p => p)) startPads();

// Hardware keys (D-pad and buttons often arrive as key events on Android). Ignored while typing in the keyboard field.
addEventListener('keydown', e => {
  if (document.activeElement === key || document.activeElement === urlEl) return;
  logInput({ type: 'key', key: e.key, code: e.code, keyCode: e.keyCode });
  const step = 60;
  const map = { ArrowUp: () => scrollBy(0, -step), ArrowDown: () => scrollBy(0, step), ArrowLeft: () => scrollBy(-step, 0), ArrowRight: () => scrollBy(step, 0),
    PageUp: () => scrollBy(0, -(fh - 80)), PageDown: () => scrollBy(0, fh - 80), Enter: () => { showCursor(); tapAtCursor(); }, Escape: () => nav('back'), Backspace: () => nav('back') };
  if (map[e.key]) { map[e.key](); e.preventDefault(); }
});
