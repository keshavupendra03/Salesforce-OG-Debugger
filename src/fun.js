// Fun mode: a top-bar switch that sprinkles context-aware emojis (and the odd one-liner) over the UI.
// It never changes the views themselves: a MutationObserver decorates matching elements as they render,
// and turning it off removes every decoration and stops observing. Decorations are aria-hidden and
// not selectable, so copying text or values is unaffected.

const KEY = 'ff-fun';
const store = {
  get() { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } },
  set(on) { try { if (on) localStorage.setItem(KEY, '1'); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } },
};

// Exceptions and errors, most specific first: [pattern, emoji, one-liner]
const ERRORS = [
  [/NullPointerException|de-reference a null|null object/i, '😶‍🌫️', 'Something was null. It’s always something.'],
  [/Too many (SOQL|DML|query rows|callouts|future|queueable)|LimitException|Too many/i, '🥵', 'The governor said “that’s enough for today”. Time to bulkify.'],
  [/CPU time/i, '🐢', 'Apex ran out of breath. Maybe fewer nested loops?'],
  [/heap size/i, '🐘', 'That’s a big heap. Apex needs to go on a diet.'],
  [/List has no rows|QueryException/i, '🕳️', 'The query came back empty-handed. Like my fridge on a Friday.'],
  [/UNABLE_TO_LOCK_ROW|lock/i, '🔒', 'Someone else is holding this record hostage.'],
  [/FIELD_CUSTOM_VALIDATION_EXCEPTION|validation/i, '🙅', 'A validation rule stood its ground. Respect.'],
  [/REQUIRED_FIELD_MISSING/i, '🧩', 'A required field went missing. Check under the sofa.'],
  [/CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY/i, '🧨', 'A trigger downstream blew up. Chain reaction!'],
  [/DUPLICATE_VALUE|DUPLICATES_DETECTED/i, '👯', 'Twins detected. Salesforce only wants one.'],
  [/INSUFFICIENT_ACCESS|INSUFFICIENT_PRIVILEGES|access/i, '🚫', 'Access denied. Even Apex has a bouncer.'],
  [/MALFORMED_QUERY|No such column|unexpected token|Didn't understand/i, '🧐', 'SOQL is confused. Honestly, same.'],
  [/INVALID_SESSION|session may have expired|401/i, '🔑', 'Your session wandered off. Refresh the Salesforce tab.'],
  [/TypeException|Invalid conversion|Illegal assignment/i, '🦆', 'That type is not the type you think it is.'],
  [/ListException|out of bounds/i, '📏', 'Index out of bounds. The list was shorter than your hopes.'],
  [/MathException|Divide by 0|divide by zero/i, '➗', 'Dividing by zero: bold, but no.'],
  [/CalloutException|Read timed out|callout/i, '📡', 'The callout went to space and never came back.'],
  [/AuraHandledException/i, '🎭', 'An error in disguise, politely handed to the UI.'],
  [/DmlException/i, '💾', 'The save didn’t save.'],
];
const DEFAULT_ERR = ['🔥', 'This is fine. Everything is fine.'];
const errorOf = (text) => {
  for (const [re, emoji, quip] of ERRORS) if (re.test(text)) return [emoji, quip];
  return DEFAULT_ERR;
};
const textOf = (el) => (el.textContent || '').trim();
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/**
 * Decoration rules. where: 'start' | 'end' (an emoji inside the element) | 'quip' (a line after it).
 * emoji(el) may return null to skip the element.
 */
const RULES = [
  // ---- errors everywhere: the emoji says which kind ----
  { sel: '.lg-log-err', where: 'start', emoji: (el) => errorOf(el.title || textOf(el))[0] },
  { sel: '.lg-sess-err', where: 'start', emoji: () => '🔥', anim: 'flicker' },
  { sel: '.xp-errcard .name', where: 'start', emoji: (el) => errorOf(textOf(el.closest('.xp-errcard')))[0], anim: 'wobble' },
  { sel: '.badge.xp-fails:not(.ghosted)', where: 'start', emoji: () => '💥' },
  { sel: '.badge.xp-fails.ghosted', where: 'start', emoji: () => '🫣' },
  { sel: '.xp-errbox', where: 'quip', quip: (el) => errorOf(textOf(el)) },
  { sel: '.lv-errtext', where: 'start', emoji: (el) => errorOf(textOf(el))[0] },
  { sel: '.dx-error-title', where: 'start', emoji: (el) => errorOf(textOf(el.parentElement))[0], anim: 'wobble' },
  { sel: '.dx-error pre', where: 'quip', quip: (el) => errorOf(textOf(el)) },
  { sel: '.cd.alert .cd-title', where: 'start', emoji: () => '🚨' },
  { sel: '.toast.error', where: 'start', emoji: (el) => errorOf(textOf(el))[0] },
  { sel: '.lg-err:not([hidden])', where: 'start', emoji: (el) => errorOf(textOf(el))[0] },

  // ---- good news gets a dance ----
  { sel: '.toast.ok', where: 'start', emoji: (el) => (/deleted/i.test(textOf(el)) ? '🧹' : /copied/i.test(textOf(el)) ? '📋' : /saved|updated/i.test(textOf(el)) ? '💾' : '🎉') },
  { sel: '.xp-modes button[disabled]', where: 'end', emoji: (el) => (/no errors/i.test(textOf(el)) ? '🕺' : null), anim: 'dance' },
  { sel: '.lv-tile', where: 'end', emoji: tileEmoji, anim: (el) => (tileEmoji(el) === '🕺' ? 'dance' : null), target: (el) => el.querySelector('b') },

  // ---- governor limits: the closer to the edge, the sweatier ----
  { sel: '.lm.bad .lm-pct', where: 'start', emoji: () => '🥵', anim: 'flicker' },
  { sel: '.lm.warn .lm-pct', where: 'start', emoji: () => '😬' },
  { sel: '.lv-tile.bad .lv-tile-l', where: 'start', emoji: (el) => (/exception/i.test(textOf(el)) ? null : '🥵') },

  // ---- "Line details" next to the code: what each line did ----
  { sel: '.badge.xp-b.k-method', where: 'start', emoji: () => '📞' }, // calls: dialing another method
  { sel: '.badge.xp-b.k-error', where: 'start', emoji: () => '☄️', anim: 'flicker' }, // throws
  { sel: '.badge.xp-b.k-debug', where: 'start', emoji: () => '🐛' }, // System.debug: the bug confesses
  { sel: '.badge.xp-b.k-dml', where: 'start', emoji: () => '💾' },
  { sel: '.badge.xp-b.k-soql', where: 'start', emoji: () => '🔎' },
  { sel: '.badge.xp-b.k-callout', where: 'start', emoji: () => '📡' },
  { sel: '.badge.xp-b.k-write', where: 'start', emoji: () => '✍️' },
  { sel: '.badge.xp-b.k-read', where: 'start', emoji: () => '👀' },
  { sel: '.badge.xp-b.k-assign', where: 'start', emoji: () => '🏷️' },
  { sel: '.badge.xp-b.k-idle', where: 'start', emoji: () => '😴' },
  // the counts in the panel header ("3 calls · 2 debug · error")
  { sel: '.cd-badge.call', where: 'start', emoji: () => '📞' },
  { sel: '.cd-badge.debug', where: 'start', emoji: (el) => (/value/i.test(textOf(el)) ? '🏷️' : '🐛') },
  { sel: '.cd-badge.soql', where: 'start', emoji: () => '🔎' },
  { sel: '.cd-badge.dml', where: 'start', emoji: (el) => (/write/i.test(textOf(el)) ? '✍️' : '💾') },
  { sel: '.cd-badge.callout', where: 'start', emoji: () => '📡' },
  { sel: '.cd-badge.err', where: 'start', emoji: () => '☄️' },
  { sel: '.cd-badge.ref', where: 'start', emoji: () => '👀' },
  // Field Trace timeline
  { sel: '.ft-ev-kind.k-write', where: 'start', emoji: () => '✍️' },
  { sel: '.ft-ev-kind.k-read', where: 'start', emoji: () => '👀' },
  { sel: '.ft-ev-kind.k-dml', where: 'start', emoji: () => '⚙️' },
  { sel: '.ft-ev-kind.k-soql', where: 'start', emoji: () => '🔎' },
  { sel: '.ft-ev-kind.k-entries', where: 'start', emoji: () => '🐛' },
  { sel: '.ft-ev-kind.k-idle', where: 'start', emoji: () => '😴' },

  // ---- code flow & field trace: who writes, who reads ----
  { sel: '.badge.write', where: 'start', emoji: () => '✍️' },
  { sel: '.badge.read', where: 'start', emoji: () => '👀' },
  { sel: '.badge.idle', where: 'start', emoji: () => '😴' },
  { sel: '.ft-kind.k-write', where: 'start', emoji: () => '✍️' },
  { sel: '.ft-kind.k-read', where: 'start', emoji: () => '👀' },
  { sel: '.ft-kind.k-dml', where: 'start', emoji: () => '💾' },
  { sel: '.ft-kind.k-idle', where: 'start', emoji: () => '😴' },
  { sel: '.lg-log.fresh .lg-log-r1', where: 'start', emoji: () => '✨', anim: 'pop' },

  // ---- empty states: tumbleweeds and crickets ----
  { sel: '.dx-norows', where: 'start', emoji: (el) => (/no rows match/i.test(textOf(el)) ? '🔍' : /waiting/i.test(textOf(el)) ? '⏳' : '🌵'), anim: 'roll' },
  { sel: '.lv-empty > b, .ft-empty > b', where: 'start', emoji: () => pick(['🦗', '🌵', '🍃']) },
  { sel: '.lg-empty:not(.err)', where: 'start', emoji: (el) => (/loading/i.test(textOf(el)) ? '⏳' : '🦗') },
  { sel: '.lm-none', where: 'start', emoji: () => '🧘' },
  { sel: '.empty-title', where: 'start', emoji: (el) => (/couldn/i.test(textOf(el)) ? '🙈' : /log/i.test(textOf(el)) ? '🕵️' : /query/i.test(textOf(el)) ? '🧙' : '👋') },

  // ---- FBI Search (Full-Base Inspector): it's an investigation ----
  { sel: '.sx-title h1', where: 'start', emoji: () => '🕵️', anim: 'wobble' },
  { sel: '.sx-go', where: 'end', emoji: () => '🔦' },
  { sel: '.sx-loading > b', where: 'start', emoji: () => '🚔', anim: 'roll' },
  { sel: '.sx-summary > b', where: 'start', emoji: (el) => (/no matches/i.test(textOf(el)) ? '🕳️' : '🗂️') },
  { sel: '.sx-empty > b', where: 'start', emoji: (el) => (/nothing found/i.test(textOf(el)) ? '🕳️' : /ready/i.test(textOf(el)) ? '🗂️' : '🕵️') },
  { sel: '.sx-empty.small > p', where: 'start', emoji: () => 'No leads, detective. ' },
  // each source group gets its own suspect
  { sel: '.sx-group-head', where: 'end', emoji: (el) => ({ apex: '🧑‍💻', trigger: '🔫', flow: '🌊', process: '🦖', validation: '🚧', vf: '📜', lwc: '⚡', aura: '🌀', label: '🏷️' })[/k-(\w+)/.exec(el.querySelector('.sx-kind')?.className || '')?.[1]] || null },
  // the best match is the prime suspect; inactive ones have an alibi
  { sel: '.sx-groups > .sx-group:first-child > .sx-row:nth-child(2):not(.inactive) .sx-row-head', where: 'end', emoji: () => '🎯 Prime suspect', anim: 'pop' },
  { sel: '.sx-row.inactive .sx-row-head', where: 'end', emoji: () => '😴 off duty' },
  { sel: '.sx-note:not(.err) > span:nth-child(2)', where: 'end', emoji: () => ' 🔍 Enhance!' },
  { sel: '.sx-note.err', where: 'start', emoji: () => '🚨' },

  // ---- data export ----
  { sel: '.dx-status > b', where: 'end', emoji: (el) => (/^0 rows/.test(textOf(el)) ? '🦗' : /running|fetching/i.test(textOf(el)) ? '🏃' : null) },
  { sel: '.dx-count-n', where: 'end', emoji: (el) => (textOf(el) === '0' ? '🦗' : '🧮') },
  { sel: '.dx-warn', where: 'start', emoji: () => '✋' },
  { sel: '.dx-del:not([hidden])', where: 'start', emoji: () => '🗑️' },
  { sel: '.dx-modal-card h2', where: 'start', emoji: (el) => (/delete/i.test(textOf(el)) ? '😱' : null), anim: 'wobble' },
  { sel: '.dx-run', where: 'end', emoji: () => '🚀', anim: 'hover' },

  // ---- Data Import: moving in ----
  { sel: '.di-drop-title', where: 'start', emoji: () => '📦', anim: 'float' },
  { sel: '.di-run:not(:disabled)', where: 'end', emoji: (el) => (el.classList.contains('danger') ? '🧨' : /undelete/i.test(textOf(el)) ? '🧟' : '🚚'), anim: 'hover' },
  { sel: '.di-st.s-ok', where: 'start', emoji: () => '✅' },
  { sel: '.di-st.s-failed', where: 'start', emoji: () => '💥' },
  { sel: '.di-st.s-processing', where: 'start', emoji: () => '🏃' },
  { sel: '.di-map-st.s-unknown, .di-map-st.s-readonly', where: 'start', emoji: () => '🤷' },
  { sel: '.di-detected', where: 'end', emoji: () => ' 🔍' },
  { sel: '.di-prodwarn', where: 'start', emoji: () => '🫣' },

  // ---- The OG Executor: lights, camera, execute ----
  { sel: '.ox-title h1', where: 'start', emoji: () => '😎', anim: 'wobble' },
  { sel: '.ox-exec .ox-exec-l', where: 'end', emoji: () => ' 🚀', anim: 'hover' },
  { sel: '.ox-runner-title b', where: 'end', emoji: (el) => (/batch/i.test(textOf(el.closest('.ox-runner'))) ? ' 🍪' : /queueable/i.test(textOf(el.closest('.ox-runner'))) ? ' 🚶' : ' ⏰') },
  { sel: '.ox-tag.k-batch', where: 'start', emoji: () => '🍪' }, // a batch, of cookies
  { sel: '.ox-tag.k-queueable', where: 'start', emoji: () => '🚶' }, // waiting in the queue
  { sel: '.ox-tag.k-schedulable', where: 'start', emoji: () => '⏰' },
  { sel: '.ox-ok-title', where: 'start', emoji: (el) => (/job|schedule/i.test(textOf(el)) ? '🚀' : '🎯'), anim: 'pop' },
  { sel: '.ox-banner.compile .ox-banner-t', where: 'start', emoji: () => '🧐', anim: 'wobble' },
  { sel: '.ox-exc-title', where: 'start', emoji: (el) => errorOf(textOf(el.parentElement))[0], anim: 'flicker' },
  { sel: '.ox-banner.bad .ox-errmsg', where: 'quip', quip: (el) => errorOf(textOf(el)) },
  { sel: '.ox-st.ok', where: 'start', emoji: () => '🕺', anim: 'dance' },
  { sel: '.ox-st.bad', where: 'start', emoji: () => '💥' },
  { sel: '.ox-st.warn', where: 'start', emoji: () => '😬' },
  { sel: '.ox-st.wait', where: 'start', emoji: () => '⏳' },
  { sel: '.ox-st.off', where: 'start', emoji: () => '🛑' },
  { sel: '.ox-job-err', where: 'quip', quip: (el) => errorOf(textOf(el)) },
  { sel: '.ox-debug-lv', where: 'start', emoji: (el) => (/error/i.test(textOf(el)) ? '🚨' : /warn/i.test(textOf(el)) ? '⚠️' : '🐛') },
  { sel: '.ox-empty-title', where: 'start', emoji: () => '🎬' },
  { sel: '.ox-none > b', where: 'start', emoji: () => pick(['🦗', '🌵', '🍃']) },
  { sel: '.ox-trace-on', where: 'end', emoji: () => ' 🕵️' },
  { sel: '.ox-wait > b', where: 'start', emoji: () => '🏃', anim: 'roll' },
];

function tileEmoji(el) {
  const label = textOf(el.querySelector('.lv-tile-l') || el).toLowerCase();
  const value = textOf(el.querySelector('b') || el);
  if (label.startsWith('exceptions')) return value === '0' ? '🕺' : '🔥';
  if (label.startsWith('soql')) return el.classList.contains('warn') ? '🔁' : null;
  if (label.startsWith('cpu')) return el.classList.contains('bad') ? '🐢' : null;
  if (label.startsWith('heap')) return el.classList.contains('bad') ? '🐘' : null;
  return null;
}

const ALL = RULES.map((r) => r.sel).join(',');

function decorate(el) {
  for (const r of RULES) {
    if (!el.matches(r.sel)) continue;
    if (r.where === 'quip') {
      if (el.dataset.funQuip || el.nextElementSibling?.classList.contains('fun-quip')) continue;
      const q = r.quip(el);
      if (!q) continue;
      const line = document.createElement('div');
      line.className = 'fun-quip';
      line.setAttribute('aria-hidden', 'true');
      line.innerHTML = `<span class="fun-e" data-anim="float"></span><span></span>`;
      line.firstChild.textContent = q[0];
      line.lastChild.textContent = q[1];
      el.dataset.funQuip = '1';
      el.after(line);
      continue;
    }
    const host = r.target ? r.target(el) : el;
    if (!host || host.querySelector(':scope > .fun-e')) continue;
    const emoji = r.emoji(el);
    if (!emoji) continue;
    const s = document.createElement('span');
    s.className = `fun-e ${r.where}`;
    s.setAttribute('aria-hidden', 'true');
    const anim = typeof r.anim === 'function' ? r.anim(el) : r.anim;
    if (anim) s.dataset.anim = anim;
    s.textContent = emoji;
    if (r.where === 'start') host.prepend(s);
    else host.append(s);
  }
}

function scan(root) {
  if (root.nodeType !== 1) return;
  if (root.matches?.(ALL)) decorate(root);
  for (const el of root.querySelectorAll(ALL)) decorate(el);
}

function undecorate() {
  for (const n of document.querySelectorAll('.fun-e, .fun-quip')) n.remove();
  for (const n of document.querySelectorAll('[data-fun-quip]')) delete n.dataset.funQuip;
}

let observer = null;
let pending = new Set();
function start() {
  scan(document.body);
  observer = new MutationObserver((muts) => {
    for (const m of muts) {
      // our own decorations don't need decorating
      if (m.type === 'childList') {
        for (const n of m.addedNodes) if (n.nodeType === 1 && !n.classList.contains('fun-e') && !n.classList.contains('fun-quip')) pending.add(n);
        // text replaced inside a decorated element (e.g. a status line): look at it again
        if (m.target.nodeType === 1 && ![...m.addedNodes].every((n) => n.nodeType === 1 && (n.classList.contains('fun-e') || n.classList.contains('fun-quip')))) pending.add(m.target);
      } else if (m.type === 'attributes') pending.add(m.target);
    }
    // mutation callbacks already arrive batched (once per task), so decorate right away
    const roots = [...pending];
    pending = new Set();
    for (const r of roots) if (r.isConnected) scan(r);
  });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden', 'disabled'] });
}
function stop() {
  observer?.disconnect();
  observer = null;
  pending.clear();
  undecorate();
}

function burst(from, emojis) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const r = from.getBoundingClientRect();
  emojis.forEach((e, i) => {
    const s = document.createElement('span');
    s.className = 'fun-burst';
    s.setAttribute('aria-hidden', 'true');
    s.textContent = e;
    s.style.left = `${r.left + r.width / 2}px`;
    s.style.top = `${r.top + r.height / 2}px`;
    s.style.setProperty('--dx', `${(i - (emojis.length - 1) / 2) * 34 + (Math.random() * 16 - 8)}px`);
    s.style.setProperty('--dy', `${50 + Math.random() * 40}px`);
    s.style.setProperty('--rot', `${Math.random() * 60 - 30}deg`);
    s.style.animationDelay = `${i * 45}ms`;
    document.body.append(s);
    setTimeout(() => s.remove(), 1400);
  });
}

function say(text) {
  let box = document.getElementById('toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    box.className = 'toasts';
    box.setAttribute('aria-live', 'polite');
    document.body.append(box);
  }
  const t = document.createElement('div');
  t.className = 'toast fun-toast';
  t.setAttribute('role', 'status');
  t.textContent = text;
  box.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 2600);
}

export function setupFun(topbar) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'fun-switch';
  btn.setAttribute('role', 'switch');
  btn.innerHTML = '<span class="fun-face" aria-hidden="true"></span><span class="fun-label">Fun</span><span class="fun-track" aria-hidden="true"><span class="fun-thumb"></span></span>';
  topbar.append(btn);

  const apply = (on, announce) => {
    btn.setAttribute('aria-checked', String(on));
    btn.title = on ? 'Fun mode is on: emojis roast your bugs. Click to get serious again.' : 'Fun mode: let emojis roast your bugs';
    btn.querySelector('.fun-face').textContent = on ? '🥳' : '😐';
    document.documentElement.classList.toggle('fun', on);
    if (on) start(); else stop();
    if (!announce) return;
    if (on) {
      burst(btn, ['🕺', '🔥', '😶‍🌫️', '🥵', '🎉', '💃']);
      say(pick(['Fun mode on. Bugs, prepare to be roasted 🔥', 'Fun mode on. Let’s make debugging dance 🕺', 'Fun mode on. Null pointers fear this one trick 😶‍🌫️']));
    } else say('Back to business 👔');
  };
  btn.addEventListener('click', () => {
    const on = btn.getAttribute('aria-checked') !== 'true';
    store.set(on);
    apply(on, true);
  });
  apply(store.get(), false);
}
