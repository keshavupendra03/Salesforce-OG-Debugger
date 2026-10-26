// Hover a custom label in any code view (Apex `System.Label.X` / `Label.X`, LWC `@salesforce/label/c.X`,
// Aura `$Label.c.X`, Visualforce `$Label.X`) to see its value. The highlighters mark the name as
// <span class="tk-label" data-label="X">; one document-level listener does the rest, so Code Flow, Debug Logs,
// OG Explorer, peeks and sticky lines all get it.
//
// Labels come from the FBI Search loader (ExternalString, the org's own labels), read once on the first hover.

import { h } from '../dom.js';

let load = null;
let labels = null; // Promise<Map(lower-case name → label)>
let card = null;
let showT = 0;
let hideT = 0;
let anchor = null; // the label name the card is for

/** load() → Promise<[{ name, sub, lines: [{ label, text }], link }]> (the FBI Search 'label' group). */
export function installLabelHover(loadLabels) {
  const first = !load;
  load = loadLabels;
  labels = null;
  if (!first) return;
  document.addEventListener('mouseover', (e) => {
    const el = e.target.closest?.('.tk-label');
    if (!el) return;
    clearTimeout(hideT);
    if (card?.dataset.for === el.dataset.label && card.isConnected) return;
    clearTimeout(showT);
    showT = setTimeout(() => show(el), 300);
  });
  document.addEventListener('mouseout', (e) => {
    if (!e.target.closest?.('.tk-label, .lb-card')) return;
    clearTimeout(showT);
    hideT = setTimeout(() => { if (!card?.matches(':hover')) hide(); }, 160);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  // only a scroll that moves the hovered name hides the card (not, say, a Live refresh elsewhere)
  document.addEventListener('scroll', (e) => { if (anchor && (e.target === document || e.target.contains?.(anchor))) hide(); }, true);
}

/** Forget the labels (after a rescan, or when the org changes). */
export function resetLabels() { labels = null; }

function all() {
  labels ||= Promise.resolve(load?.() || []).then((list) => new Map(list.map((l) => [l.name.toLowerCase(), l])));
  labels.catch(() => { labels = null; }); // a failed read is retried on the next hover
  return labels;
}

function hide() { clearTimeout(showT); card?.remove(); card = null; anchor = null; }

async function show(el) {
  hide();
  const name = el.dataset.label;
  card = h('div', { class: 'cl-card lb-card', role: 'tooltip', 'data-for': name },
    h('div', { class: 'lb-head' }, h('span', { class: 'lb-chip' }, 'Custom label'), h('b', {}, name)),
    h('div', { class: 'lb-loading' }, h('span', { class: 'lg-spinner', 'aria-hidden': 'true' }), 'Reading custom labels…'));
  const mine = card;
  anchor = el;
  document.body.append(card);
  place(el);
  let found;
  try {
    found = (await all()).get(name.toLowerCase());
  } catch (err) {
    if (card !== mine) return;
    card.replaceChildren(card.firstChild, h('small', { class: 'lb-err' }, `Couldn’t read the custom labels: ${err.message}`));
    place(el);
    return;
  }
  if (card !== mine) return; // moved on
  if (!found) {
    card.replaceChildren(card.firstChild, h('small', {}, 'Not one of this org’s own labels. It may come from a managed package, or it was deleted.'));
    place(el);
    return;
  }
  const field = (k) => found.lines?.find((x) => x.label === k)?.text || '';
  const value = field('Value');
  const desc = field('Short description');
  const copy = h('button', { class: 'ghost small', onclick: async () => {
    try { await navigator.clipboard.writeText(value); copy.textContent = '✓ Copied'; } catch { copy.textContent = 'Copy failed'; }
    setTimeout(() => { copy.textContent = '⧉ Copy value'; }, 1400);
  } }, '⧉ Copy value');
  card.replaceChildren(
    h('div', { class: 'lb-head' }, h('span', { class: 'lb-chip' }, 'Custom label'), h('b', {}, found.name)),
    h('div', { class: `lb-value${value ? '' : ' empty'}` }, value || '(empty)'),
    ...[desc && desc !== value ? h('small', {}, desc) : null,
      found.sub ? h('small', { class: 'lb-meta' }, found.sub) : null,
      h('div', { class: 'lb-actions' }, copy, found.link ? h('a', { class: 'lb-setup', href: found.link, target: '_blank', rel: 'noopener' }, 'Open in Setup ↗') : null),
    ].filter(Boolean));
  place(el);
}

function place(el) {
  if (!card) return;
  const r = el.getBoundingClientRect();
  card.style.left = `${Math.max(8, Math.min(r.left, innerWidth - card.offsetWidth - 8))}px`;
  const below = r.bottom + 6 + card.offsetHeight < innerHeight;
  card.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - card.offsetHeight - 6)}px`;
}
