// Feedback: a quiet footer button that opens a short card inviting suggestions, bug reports and reviews,
// with one button that opens the Google Form (src/config.js) in a new tab. Never opens on its own.

import { h } from './dom.js';
import { FEEDBACK_FORM_URL } from './config.js';

const ICON = '<svg viewBox="0 0 24 24"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6a.5.5 0 0 1-.8-.4V16h0A2.5 2.5 0 0 1 4 13.5z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M8.5 8.5h7M8.5 11.5h4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

const icon = (markup, cls) => {
  const s = document.createElement('span');
  s.className = cls;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = markup;
  return s;
};

const TOPICS = [
  ['💡', 'Suggest a feature', 'A view, a shortcut, a smarter default: what would save you time?'],
  ['🐞', 'Report a bug', 'What happened and what you expected. Steps help, org data isn’t needed.'],
  ['⭐', 'Leave a review', 'What you like, what could be better. A few words are perfect.'],
];

export function setupFeedback(anchorParent) {
  const btn = h('button', { type: 'button', class: 'credits-link fb-pill', title: 'Share a suggestion, report a bug or leave a review', 'aria-haspopup': 'dialog' },
    icon(ICON, 'fb-pill-icon'), h('span', {}, 'Feedback'));
  anchorParent.prepend(btn);
  btn.addEventListener('click', () => openFeedback(btn));
}

function openFeedback(opener) {
  if (document.querySelector('.fbk')) return;
  const live = /^https?:\/\//i.test(FEEDBACK_FORM_URL);

  const cta = live
    ? h('a', { class: 'fb-cta', href: FEEDBACK_FORM_URL, target: '_blank', rel: 'noopener noreferrer', onclick: () => setTimeout(close, 150) },
      h('span', {}, 'Open the feedback form'), h('span', { class: 'fb-cta-arrow', 'aria-hidden': 'true' }, '↗'))
    : h('button', { type: 'button', class: 'fb-cta', disabled: true, title: 'The form isn’t live yet' },
      h('span', {}, 'Feedback form'), h('span', { class: 'fb-soon' }, 'Coming soon'));

  const closeBtn = h('button', { type: 'button', class: 'bmc-x', 'aria-label': 'Close' }, '×');
  const card = h('div', { class: 'bmc-card fb-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'fb-title', tabindex: '-1' },
    closeBtn,
    h('header', { class: 'fb-head' },
      h('div', { class: 'fb-head-glow', 'aria-hidden': 'true' }),
      icon(ICON, 'fb-head-icon'),
      h('span', { class: 'fb-kicker' }, 'Your voice, your tool'),
      h('h2', { id: 'fb-title' }, 'Help shape what gets built next'),
      h('p', {}, 'OG Debugger grows from the people who use it every day. Got an idea, hit a bug, or just want to say what you think? It takes a minute, and every response is read.')),
    h('div', { class: 'fb-body' },
      h('ul', { class: 'fb-topics' }, TOPICS.map(([emoji, title, text]) => h('li', {},
        h('span', { class: 'fb-topic-icon', 'aria-hidden': 'true' }, emoji),
        h('div', {}, h('b', {}, title), h('p', {}, text))))),
      h('div', { class: 'fb-actions' },
        cta,
        h('p', { class: 'fb-note' }, live
          ? 'Opens a short Google Form in a new tab · about 1 minute'
          : 'The form opens very soon. Thanks for wanting to help!')),
      h('p', { class: 'fb-privacy' },
        icon('<svg viewBox="0 0 24 24"><path d="M12 3 5 6v5c0 4.4 3 8.4 7 9.5 4-1.1 7-5.1 7-9.5V6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>', 'fb-shield'),
        'Nothing is sent from the extension. You only share what you choose to type into the form.')));

  const wrap = h('div', { class: 'bmc fbk' }, card);
  function close() {
    if (!wrap.isConnected || wrap.classList.contains('out')) return;
    wrap.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => { wrap.remove(); opener?.focus(); }, 160);
  }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const f = [...card.querySelectorAll('button:not([disabled]), a[href]')];
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  closeBtn.addEventListener('click', close);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(wrap);
  card.focus();
}
