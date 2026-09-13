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

// ---------- drawing ----------
function layout() {
  const dpr = devicePixelRatio || 1;
  canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const scale = Math.min(innerWidth / fw, innerHeight / fh);
  view = { scale, x: (innerWidth - fw * scale) / 2, y: (innerHeight - fh * scale) / 2 };
  draw();
}
function draw() {
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, innerWidth, innerHeight);
  if (frame) ctx.drawImage(frame, view.x, view.y, fw * view.scale, fh * view.scale);
}
addEventListener('resize', () => { layout(); syncViewport(); });

// Make the remote browser the same size as this view, so pages reflow to the real screen shape.
let sentSize = '', sizeTimer, lastResync = 0;
function resyncIfMismatch() {
  if (document.visibilityState !== 'visible') return;
  if (fw === Math.round(innerWidth) && fh === Math.round(innerHeight)) return;
  if (Date.now() - lastResync < 3000) return;
  lastResync = Date.now(); sentSize = ''; syncViewport();
}
document.addEventListener('visibilitychange', () => { sentSize = ''; syncViewport(); });
function syncViewport() {
  clearTimeout(sizeTimer);
  sizeTimer = setTimeout(async () => {
    const w = Math.round(innerWidth), h = Math.round(innerHeight), k = w + 'x' + h;
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
      urlEl.textContent = m.url;
    } else if (m.type === 'tabs' && Array.isArray(m.tabs)) {
      const active = m.tabs.find(t => t.active) || m.tabs[0];
      if (active?.url) urlEl.textContent = active.url;
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

// ---------- bar (shows on a tap near the top edge, auto-hides) ----------
function showBar() { bar.classList.remove('hidden'); keepBar(); }
function keepBar() { clearTimeout(hideTimer); hideTimer = setTimeout(() => { if (consoleEl.classList.contains('hidden') && document.activeElement !== key) bar.classList.add('hidden'); }, 4000); }
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
function toPage(t) { return { x: Math.round((t.clientX - view.x) / view.scale), y: Math.round((t.clientY - view.y) / view.scale) }; }
let touch = null; // {start, last, moved, startTime}
canvas.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) { touch = null; return; }
  const p = toPage(e.touches[0]);
  touch = { start: p, last: p, moved: false, t: Date.now(), tip: e.touches[0].clientY < 24 };
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
canvas.addEventListener('mousedown', e => { if (e.clientY < 24) showBar(); const { x, y } = toPage(e); send({ type: 'input_mouse', eventType: 'mousePressed', x, y, button: 'left', clickCount: 1 }); });
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
