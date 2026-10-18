// "Buy me a coffee": a quiet footer button that opens a thank-you card with UPI (QR + id) and
// a Buy Me a Coffee option that's coming soon. Never opens on its own.

import { h } from './dom.js';

const UPI_ID = '9479954470@ybl';
const PAYEE = 'Keshav Yadav';
const QR_SRC = 'src/QR/1003884949.png';

const svg = (markup, cls = '') => {
  const s = document.createElement('span');
  s.className = cls;
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = markup;
  return s;
};

const CUP = `
<svg viewBox="0 0 120 120" class="bmc-cup-svg">
  <g class="bmc-steam" fill="none" stroke-linecap="round" stroke-width="4">
    <path d="M44 38c-6-8 6-12 0-21" /><path d="M60 36c-6-8 6-12 0-21" /><path d="M76 38c-6-8 6-12 0-21" />
  </g>
  <ellipse cx="60" cy="104" rx="44" ry="7" class="bmc-saucer" />
  <path d="M24 50h64v22c0 17.7-14.3 32-32 32s-32-14.3-32-32z" class="bmc-mug" />
  <path d="M88 58h6a12 12 0 0 1 0 24h-8" fill="none" stroke-width="7" class="bmc-handle" />
  <path d="M24 50h64v6H24z" class="bmc-rim" />
  <path d="M46 74c0-4 4-7 7-4l3 3 3-3c3-3 7 0 7 4 0 5-10 11-10 11s-10-6-10-11z" class="bmc-heart" />
</svg>`;

const COFFEE_ICON = '<svg viewBox="0 0 24 24"><path d="M5 8h11v5a5.5 5.5 0 0 1-11 0z" /><path d="M16 9.5h1.6a2.4 2.4 0 0 1 0 4.8H16" fill="none" stroke="currentColor" stroke-width="1.8" /><path class="s" d="M8 2.8c-.9 1 .9 1.6 0 2.8M11 2.8c-.9 1 .9 1.6 0 2.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /><path d="M4 20h13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>';

export function setupCoffee(anchorParent) {
  const btn = h('button', { type: 'button', class: 'credits-link bmc-pill', title: 'Support the developer', 'aria-haspopup': 'dialog' },
    svg(COFFEE_ICON, 'bmc-pill-icon'), h('span', {}, 'Buy me a coffee'));
  anchorParent.prepend(btn);
  btn.addEventListener('click', () => { opened = true; openCoffee(btn); });
  scheduleNudge(btn);
}

// A quiet reminder now and then: a light sweep across the pill and a little cup tilt (~1.6 s).
// First after 3 minutes, then every 4, at most 5 times a session. Skipped while the tab is hidden,
// the pointer is on the pill, a dialog is open, or reduced motion is on. Stops once the card was opened.
const NUDGE_FIRST = 3 * 60 * 1000;
const NUDGE_EVERY = 4 * 60 * 1000;
const NUDGE_MAX = 5;
let opened = false;
function scheduleNudge(btn) {
  let count = 0;
  const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)');
  const tick = () => {
    if (opened || count >= NUDGE_MAX) return;
    const busy = document.hidden || calm?.matches || btn.matches(':hover') || !btn.offsetParent
      || document.querySelector('.bmc, .fx, .dx-modal, .fbk, [role="dialog"]');
    if (!busy) {
      count++;
      btn.classList.remove('nudge');
      void btn.offsetWidth; // restart the animation
      btn.classList.add('nudge');
      setTimeout(() => btn.classList.remove('nudge'), 1800);
    }
    setTimeout(tick, busy ? 30 * 1000 : NUDGE_EVERY); // busy: try again a little later
  };
  setTimeout(tick, NUDGE_FIRST);
}

function openCoffee(opener) {
  if (document.querySelector('.bmc')) return;
  let tab = 'upi';
  const copyBtn = h('button', { type: 'button', class: 'bmc-copy', 'aria-label': 'Copy UPI ID' }, h('span', { class: 'bmc-copy-label' }, 'Copy'));
  copyBtn.addEventListener('click', async () => {
    let ok = false;
    try { await navigator.clipboard.writeText(UPI_ID); ok = true; } catch {
      const t = h('textarea', { style: 'position:fixed;opacity:0' }, UPI_ID);
      document.body.append(t);
      t.select();
      ok = document.execCommand('copy');
      t.remove();
    }
    copyBtn.classList.toggle('done', ok);
    copyBtn.querySelector('.bmc-copy-label').textContent = ok ? 'Copied ✓' : 'Copy failed';
    setTimeout(() => { copyBtn.classList.remove('done'); copyBtn.querySelector('.bmc-copy-label').textContent = 'Copy'; }, 1800);
  });

  const touch = window.matchMedia?.('(pointer: coarse)').matches;
  const upiLink = `upi://pay?pa=${encodeURIComponent(UPI_ID)}&pn=${encodeURIComponent(PAYEE)}&tn=${encodeURIComponent('Coffee for OG Debugger')}&cu=INR`;

  const upiPane = h('div', { class: 'bmc-pane', role: 'tabpanel', id: 'bmc-upi', 'aria-labelledby': 'bmc-t-upi' },
    h('div', { class: 'bmc-qr' },
      h('span', { class: 'bmc-qr-corner tl' }), h('span', { class: 'bmc-qr-corner tr' }),
      h('span', { class: 'bmc-qr-corner bl' }), h('span', { class: 'bmc-qr-corner br' }),
      h('img', { src: QR_SRC, alt: `UPI QR code for ${UPI_ID}`, width: '176', height: '176', draggable: 'false' })),
    h('p', { class: 'bmc-scan' }, 'Scan with any UPI app'),
    h('div', { class: 'bmc-apps', 'aria-label': 'Works with' }, ['GPay', 'PhonePe', 'Paytm', 'BHIM'].map((a) => h('span', {}, a))),
    h('div', { class: 'bmc-id' },
      h('span', { class: 'bmc-id-label' }, 'UPI ID'),
      h('code', { class: 'bmc-id-val' }, UPI_ID),
      copyBtn),
    touch ? h('a', { class: 'bmc-open', href: upiLink }, 'Open in UPI app →') : null);

  const bmcPane = h('div', { class: 'bmc-pane', role: 'tabpanel', id: 'bmc-intl', 'aria-labelledby': 'bmc-t-intl', hidden: true },
    h('div', { class: 'bmc-soon' },
      h('span', { class: 'bmc-soon-badge' }, 'Coming soon'),
      svg(CUP, 'bmc-soon-cup'),
      h('b', {}, 'Buy Me a Coffee page'),
      h('p', {}, 'Cards, PayPal and other countries: it’s on its way. Until then, UPI works for anyone in India.'),
      h('button', { type: 'button', class: 'bmc-yellow', disabled: true, title: 'Not live yet' }, svg(COFFEE_ICON, 'bmc-yellow-icon'), 'buymeacoffee.com · soon')));

  const tabBtn = (k, id, label, sub) => h('button', {
    type: 'button', role: 'tab', id, class: 'bmc-tab', 'aria-selected': String(tab === k), 'aria-controls': k === 'upi' ? 'bmc-upi' : 'bmc-intl',
    onclick: () => {
      tab = k;
      for (const b of tabs.children) b.setAttribute('aria-selected', String(b.id === id));
      upiPane.hidden = k !== 'upi';
      bmcPane.hidden = k === 'upi';
    },
  }, h('span', {}, label), h('small', {}, sub));
  const tabs = h('div', { class: 'bmc-tabs', role: 'tablist', 'aria-label': 'How to support' },
    tabBtn('upi', 'bmc-t-upi', 'UPI', 'India · instant'),
    tabBtn('intl', 'bmc-t-intl', 'Buy Me a Coffee', 'Worldwide · soon'));

  const closeBtn = h('button', { type: 'button', class: 'bmc-x', 'aria-label': 'Close' }, '×');
  const card = h('div', { class: 'bmc-card', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bmc-title', tabindex: '-1' },
    closeBtn,
    h('div', { class: 'bmc-hero' },
      h('div', { class: 'bmc-hero-glow', 'aria-hidden': 'true' }),
      svg(CUP, 'bmc-cup'),
      h('span', { class: 'bmc-kicker' }, 'Support the project'),
      h('h2', { id: 'bmc-title' }, 'Enjoying OG Debugger?', h('br'), 'Fuel the next feature.'),
      h('p', { class: 'bmc-lede' },
        'It’s free, built in evenings and weekends, and everything runs right here in your browser. ',
        'If it saved you an hour of digging through debug logs, a coffee is a lovely way to say thanks.'),
      h('ul', { class: 'bmc-points' },
        h('li', {}, 'Free for everyone, no ads, no tracking'),
        h('li', {}, 'Your code and data never leave your browser'),
        h('li', {}, 'Every coffee goes into new features and fixes')),
      h('p', { class: 'bmc-sign' }, '— Keshav')),
    h('div', { class: 'bmc-side' },
      tabs, upiPane, bmcPane,
      h('p', { class: 'bmc-foot' }, 'No coffee? No problem. Sharing the tool with your team helps just as much. ♥')));

  const wrap = h('div', { class: 'bmc' }, card);
  const close = () => {
    wrap.classList.add('out');
    document.removeEventListener('keydown', onKey, true);
    setTimeout(() => { wrap.remove(); opener?.focus(); }, 160);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    // keep focus inside the card
    const f = [...card.querySelectorAll('button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])')].filter((x) => !x.closest('[hidden]'));
    if (!f.length) return;
    const first = f[0];
    const last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  closeBtn.addEventListener('click', close);
  wrap.addEventListener('pointerdown', (e) => { if (e.target === wrap) close(); });
  document.addEventListener('keydown', onKey, true);
  document.body.append(wrap);
  card.focus(); // focus inside the dialog for Esc / Tab, without a ring on any one control
}
