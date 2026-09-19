// Pinned tabs (Key, 2026-09-19). A pinned tab keeps its place at the top of the drawer until unpinned, and
// agents must not navigate, reuse or close it (the gate and start.sh open a new tab instead).
// Pins are stored by the viewer server (/api/pins) as [{ id, url, title }] in pin order. Tab ids change
// between Stream (t1, S-t1) and Live (L3), and after the headless browser restarts, so a pin matches a tab by
// id first, then by URL; a match by id keeps the pin's URL current as the pinned tab navigates.
// Shared by the page and the server (pure function, no DOM).

const sameId = (a, b) => a != null && b != null && String(a).replace(/^S/, '') === String(b).replace(/^S/, '');

// -> { order: tabs with pinned first (in pin order), each tab gets `pinned: true|false`, pins: updated pins,
//      changed: whether any pin's id/url/title moved }
export function applyPins(pins, tabs) {
  const used = new Set(), out = [], next = [];
  let changed = false;
  for (const p of pins || []) {
    let t = tabs.find(t => !used.has(t) && sameId(t.id, p.id));
    if (!t) t = tabs.find(t => !used.has(t) && t.url && t.url === p.url);
    if (!t) { next.push(p); continue; }                       // not open right now: the pin waits for its URL
    used.add(t); out.push({ ...t, pinned: true });
    const q = { id: t.id, url: t.url || p.url, title: t.title || p.title || '' };
    if (q.id !== p.id || q.url !== p.url || q.title !== p.title) changed = true;
    next.push(q);
  }
  for (const t of tabs) if (!used.has(t)) out.push({ ...t, pinned: false });
  return { order: out, pins: next, changed };
}
