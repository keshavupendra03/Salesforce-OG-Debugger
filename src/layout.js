// Draggable splitters and the collapsible details block above source code. Sizes and open/closed
// state persist per browser; double-clicking a splitter resets it.

import { h } from './dom.js';

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/**
 * handle: the splitter element. pane: the element whose size changes. host: where the CSS variable lives
 * (the layout reads it). edge: which edge of `pane` the handle sits on ('end' = right/bottom, 'start' = left/top).
 */
export function resizable({ handle, pane, host, cssVar, axis = 'x', edge = 'end', min = 160, max = () => Infinity, key, label }) {
  const saved = key && store.get(key);
  if (saved) host.style.setProperty(cssVar, saved);
  const horizontal = axis === 'x';
  handle.classList.add('split', horizontal ? 'split-x' : 'split-y');
  handle.setAttribute('role', 'separator');
  handle.setAttribute('tabindex', '0');
  handle.setAttribute('aria-orientation', horizontal ? 'vertical' : 'horizontal');
  handle.setAttribute('aria-label', label || 'Resize');
  handle.title = `${label || 'Drag to resize'} · double-click to reset`;

  const dir = edge === 'end' ? 1 : -1;
  const size = () => { const r = pane.getBoundingClientRect(); return horizontal ? r.width : r.height; };
  const apply = (px) => {
    const v = Math.round(Math.max(min, Math.min(px, Math.max(min, max()))));
    host.style.setProperty(cssVar, `${v}px`);
    handle.setAttribute('aria-valuenow', String(v));
  };
  const save = () => { if (key) store.set(key, host.style.getPropertyValue(cssVar) || null); };

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = horizontal ? e.clientX : e.clientY;
    const from = size();
    handle.setPointerCapture(e.pointerId);
    handle.classList.add('active');
    document.documentElement.classList.add(horizontal ? 'resizing-x' : 'resizing-y');
    let frame = 0;
    let last = null;
    const move = (ev) => {
      last = horizontal ? ev.clientX : ev.clientY;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => apply(from + dir * (last - start)));
    };
    const end = () => {
      cancelAnimationFrame(frame);
      if (last != null) apply(from + dir * (last - start));
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      handle.classList.remove('active');
      document.documentElement.classList.remove('resizing-x', 'resizing-y');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  });

  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 80 : 24;
    const keys = horizontal ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowUp: -1, ArrowDown: 1 };
    if (!(e.key in keys)) return;
    e.preventDefault();
    apply(size() + keys[e.key] * step * dir);
    save();
  });

  handle.addEventListener('dblclick', () => {
    host.style.removeProperty(cssVar);
    if (key) store.set(key, null);
  });
  return handle;
}

/**
 * Makes the left pane of a grid layout collapsible into a slim rail.
 * host: the grid container; pane: the left pane (gets a rail child); rail(): nodes describing the current
 * selection, shown on the rail. Toggle with the edge button, the rail itself, or Ctrl/Cmd+B.
 */
export function collapsibleSide({ host, pane, key, label, rail }) {
  const railEl = h('div', { class: 'side-rail', role: 'button', tabindex: '0', 'aria-label': `Show ${label}`, title: `Show ${label} (Ctrl+B)` });
  const toggle = h('button', { type: 'button', class: 'side-toggle' }, h('span', { class: 'side-toggle-icon', 'aria-hidden': 'true' }, '‹'));
  pane.classList.add('side-pane');
  pane.append(railEl);
  host.append(toggle);

  const collapsed = () => host.classList.contains('side-collapsed');
  const refresh = () => {
    if (!collapsed()) return;
    railEl.replaceChildren(h('span', { class: 'side-rail-btn', 'aria-hidden': 'true' }, '›'), ...rail().filter(Boolean));
  };
  const set = (on, persist = true) => {
    if (persist) {
      host.classList.add('side-anim');
      setTimeout(() => host.classList.remove('side-anim'), 260);
    }
    host.classList.toggle('side-collapsed', on);
    toggle.setAttribute('aria-expanded', String(!on));
    toggle.setAttribute('aria-label', `${on ? 'Show' : 'Hide'} ${label}`);
    toggle.title = `${on ? 'Show' : 'Hide'} ${label} (Ctrl+B)`;
    refresh();
    if (persist) store.set(key, on ? '1' : null);
  };

  toggle.addEventListener('click', () => set(!collapsed()));
  railEl.addEventListener('click', () => set(false));
  railEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); set(false); } });
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'b') return;
    if (!host.isConnected || host.closest('[hidden]')) return; // only the visible view reacts
    e.preventDefault();
    set(!collapsed());
  });
  set(store.get(key) === '1', false);
  return { refresh, collapsed, set };
}

let cdSeq = 0;

/**
 * Collapsible, resizable panel shown above source code (error message, marked lines). The header always
 * shows counts (and turns red when there's an error) so it stays noticeable while collapsed.
 * badges: [[text, kind]] where kind is one of call | dml | soql | debug | callout | err | ref.
 */
export function codeDetails(content, { title = 'Details', badges = [], alert = false } = {}) {
  const open = store.get('ff-code-details') !== '0';
  const id = `cd-body-${++cdSeq}`;
  const body = h('div', { class: 'cd-body', id, hidden: !open }, content);
  const state = h('span', { class: 'cd-state' }, open ? 'Hide' : 'Show');
  const head = h('button', { type: 'button', class: 'cd-head', 'aria-expanded': String(open), 'aria-controls': id, title: 'Show or hide these details' },
    h('span', { class: 'cd-chev', 'aria-hidden': 'true' }, '▸'),
    h('span', { class: 'cd-title' }, title),
    h('span', { class: 'cd-badges' }, badges.map(([text, kind]) => h('span', { class: `cd-badge ${kind || ''}` }, text))),
    state);
  const grip = h('div', { class: 'cd-grip', hidden: !open }, h('span', { 'aria-hidden': 'true' }));
  const wrap = h('div', { class: `cd${open ? ' open' : ''}${alert ? ' alert' : ''}` }, head, body, grip);
  head.addEventListener('click', () => {
    const now = body.hidden;
    body.hidden = !now;
    grip.hidden = !now;
    wrap.classList.toggle('open', now);
    head.setAttribute('aria-expanded', String(now));
    state.textContent = now ? 'Hide' : 'Show';
    store.set('ff-code-details', now ? '1' : '0');
  });
  resizable({
    handle: grip, pane: body, host: document.documentElement, cssVar: '--cd-h', axis: 'y', edge: 'end', min: 48,
    max: () => (wrap.closest('.code')?.clientHeight || 600) - 180, key: 'ff-split-code-details', label: 'Resize details',
  });
  return wrap;
}
