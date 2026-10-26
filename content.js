// Runs on Salesforce pages: a slim OG handle on the right edge that slides out the OG panel (panel.html).
// Everything lives in a closed shadow root, so Salesforce's CSS can't touch it and it can't touch Salesforce.
// The panel frame is only created the first time the handle is clicked.
(() => {
  if (window.top !== window || document.getElementById('og-debugger-root')) return;

  const EXT_ORIGIN = new URL(chrome.runtime.getURL('/')).origin;
  const POS_KEY = 'og-debugger-handle-top';
  const host = document.createElement('div');
  host.id = 'og-debugger-root';
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483000; top: 0; right: 0; width: 0; height: 0;';
  const root = host.attachShadow({ mode: 'closed' });

  root.innerHTML = `
<style>
  :host { all: initial; }
  * { box-sizing: border-box; }
  .handle {
    position: fixed; right: 0; width: 22px; height: 58px; padding: 0; border: 0; cursor: pointer;
    display: grid; place-items: center; border-radius: 12px 0 0 12px;
    background: linear-gradient(160deg, #2563eb, #7c3aed); color: #fff;
    box-shadow: -2px 4px 14px rgba(37, 99, 235, .28); opacity: .78;
    transition: width .16s ease, opacity .16s ease, box-shadow .16s ease;
    font: 600 11px/1 ui-sans-serif, system-ui, "Segoe UI", sans-serif; touch-action: none;
  }
  .handle:hover, .handle:focus-visible, .handle.open { width: 30px; opacity: 1; box-shadow: -4px 6px 20px rgba(37, 99, 235, .4); outline: none; }
  .handle:focus-visible { box-shadow: 0 0 0 3px #fff, 0 0 0 5px #2563eb; }
  .handle svg { width: 15px; height: 15px; fill: #fff; stroke: #fff; transition: transform .2s; }
  .handle.open svg { transform: rotate(180deg); }
  .handle .grip { position: absolute; left: 4px; top: 50%; width: 2px; height: 16px; margin-top: -8px; border-radius: 2px; background: rgba(255,255,255,.45); opacity: 0; transition: opacity .16s; }
  .handle:hover .grip { opacity: 1; }
  .tip {
    position: fixed; right: 38px; padding: 6px 10px; border-radius: 8px; white-space: nowrap; pointer-events: none;
    background: #111827; color: #fff; font: 600 12px/1.2 ui-sans-serif, system-ui, "Segoe UI", sans-serif;
    box-shadow: 0 8px 22px rgba(0,0,0,.25); opacity: 0; transform: translateX(6px); transition: opacity .15s, transform .15s;
  }
  .tip small { display: block; margin-top: 2px; font-weight: 400; opacity: .7; }
  .handle:hover + .tip { opacity: 1; transform: none; transition-delay: .35s; }
  .handle.open + .tip, .dragging + .tip { display: none; }
  .tip.fresh { opacity: 1; transform: none; transition-delay: 0s; background: #15803d; }
  .panel {
    position: fixed; right: 12px; top: 56px; width: 380px; height: min(640px, calc(100vh - 80px));
    border-radius: 16px; overflow: hidden; background: #fff;
    box-shadow: 0 24px 64px rgba(15, 23, 42, .28), 0 0 0 1px rgba(15, 23, 42, .08);
    transform: translateX(calc(100% + 24px)); opacity: 0; visibility: hidden;
    transition: transform .22s cubic-bezier(.2, .9, .3, 1), opacity .18s ease, visibility 0s linear .22s;
  }
  .panel.open { transform: none; opacity: 1; visibility: visible; transition: transform .24s cubic-bezier(.2, .9, .3, 1), opacity .18s ease; }
  .panel iframe { position: relative; z-index: 1; width: 100%; height: 100%; border: 0; display: block; color-scheme: normal; opacity: 0; transition: opacity .15s; }
  .panel iframe.ready { opacity: 1; }
  .busy, .note { position: absolute; inset: 0; display: grid; place-items: center; align-content: center; gap: 12px; padding: 28px; text-align: center;
    font: 13px/1.5 ui-sans-serif, system-ui, "Segoe UI", sans-serif; color: #475569; }
  .busy i { width: 26px; height: 26px; border-radius: 50%; border: 3px solid #e2e8f0; border-top-color: #2563eb; animation: og-spin .7s linear infinite; }
  @keyframes og-spin { to { transform: rotate(360deg); } }
  .note { z-index: 2; background: inherit; }
  .note b { font-size: 14.5px; color: #0f172a; }
  .note p { margin: 0; max-width: 280px; }
  .note .row { display: flex; gap: 8px; justify-content: center; }
  .note button { padding: 7px 14px; border-radius: 8px; border: 1px solid #cbd5e1; background: #fff; color: #0f172a; font: 600 12.5px ui-sans-serif, system-ui, "Segoe UI", sans-serif; cursor: pointer; }
  .note button.primary { border-color: #2563eb; background: #2563eb; color: #fff; }
  @media (prefers-color-scheme: dark) { .busy, .note { color: #94a3b8; } .note b { color: #e2e8f0; } .note button { background: #1e293b; color: #e2e8f0; border-color: #334155; } }
  @media (prefers-color-scheme: dark) { .panel { background: #151a21; } }
  @media (prefers-reduced-motion: reduce) { .handle, .panel, .tip, .handle svg { transition: none !important; } }
</style>
<button class="handle" type="button" aria-label="Open OG Debugger" aria-expanded="false">
  <span class="grip"></span>
  <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5 8 12l7 7" fill="none" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
</button>
<div class="tip" role="tooltip">OG Debugger<small>Click to open · drag to move</small></div>
<div class="panel" role="dialog" aria-label="OG Debugger"></div>`;

  const handle = root.querySelector('.handle');
  const tip = root.querySelector('.tip');
  const panel = root.querySelector('.panel');
  let frame = null;
  let open = false;

  // where the handle sits on the edge (remembered per org, as a share of the window height)
  const placeHandle = (frac) => {
    const top = Math.round(Math.min(window.innerHeight - 70, Math.max(70, frac * window.innerHeight)));
    handle.style.top = `${top}px`;
    tip.style.top = `${top + 14}px`;
  };
  let frac = 0.42;
  try { frac = Number(localStorage.getItem(POS_KEY)) || 0.42; } catch { /* storage blocked */ }
  placeHandle(frac);
  window.addEventListener('resize', () => placeHandle(frac));

  const post = (msg) => frame?.contentWindow?.postMessage({ source: 'og-page', ...msg }, EXT_ORIGIN);
  // false once the extension was reloaded or updated after this page loaded (Chrome cuts old content scripts off)
  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };

  // ---------- the panel frame, and getting it back when Chrome took it away ----------
  // Reloading or updating the extension (or Chrome reclaiming memory on an idle tab) can leave the
  // frame empty: a blank white panel. So the frame says "ready" when it starts and answers a ping;
  // a frame that stays quiet is replaced with a fresh one.
  let frameReady = false;
  let pingT = 0;
  let loadT = 0;
  const busy = document.createElement('div');
  busy.className = 'busy';
  busy.innerHTML = '<i></i><span>Loading OG Debugger…</span>';
  panel.append(busy);

  function newFrame() {
    frame?.remove();
    clearNote();
    frameReady = false;
    frame = document.createElement('iframe');
    frame.title = 'OG Debugger';
    frame.allow = 'clipboard-write';
    // built from the extension's origin, not chrome.runtime: works even after the extension reloaded
    frame.src = `${EXT_ORIGIN}/panel.html?${new URLSearchParams({ host: location.hostname, url: location.href })}`;
    panel.append(frame);
    clearTimeout(loadT);
    loadT = setTimeout(() => { if (!frameReady) showNote(); }, 12000);
  }

  function checkFrame() {
    if (!frame) { newFrame(); return; }
    if (!frameReady) return; // still loading: the load timer watches it
    clearTimeout(pingT);
    const sent = Date.now();
    frame.dataset.ping = String(sent);
    post({ type: 'ping', at: sent });
    pingT = setTimeout(() => { if (frame?.dataset.ping === String(sent)) newFrame(); }, 1500);
  }

  function clearNote() { panel.querySelector('.note')?.remove(); }
  function showNote() {
    clearNote();
    const note = document.createElement('div');
    note.className = 'note';
    note.innerHTML = alive()
      ? '<b>The panel didn’t load</b><p>Chrome may have paused it while this tab sat idle. Try again, or reload the page.</p><div class="row"><button class="primary" data-a="retry">Try again</button><button data-a="reload">Reload page</button></div>'
      : '<b>OG Debugger was updated</b><p>It was reloaded or updated after this page opened. Reload the page to reconnect it.</p><div class="row"><button class="primary" data-a="reload">Reload page</button><button data-a="retry">Try again</button></div>';
    note.addEventListener('click', (e) => {
      const a = e.target.closest('button')?.dataset.a;
      if (a === 'reload') location.reload();
      if (a === 'retry') newFrame();
    });
    panel.append(note);
  }

  function toggle(force, { keepFocus = false } = {}) {
    open = force ?? !open;
    if (open) checkFrame();
    panel.classList.toggle('open', open);
    handle.classList.toggle('open', open);
    handle.setAttribute('aria-expanded', String(open));
    handle.setAttribute('aria-label', open ? 'Close OG Debugger' : 'Open OG Debugger');
    if (open) { post({ type: 'url', url: location.href, apiNames: API.on }); post({ type: 'opened' }); frame?.focus(); } else if (!keepFocus) handle.focus({ preventScroll: true });
  }

  // click toggles; a drag moves the handle up or down the edge
  let drag = null;
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    drag = { y: e.clientY, top: handle.offsetTop, moved: false };
    handle.setPointerCapture(e.pointerId);
  });
  handle.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.y;
    if (!drag.moved && Math.abs(dy) < 5) return;
    drag.moved = true;
    handle.classList.add('dragging');
    frac = (drag.top + dy + 29) / window.innerHeight;
    placeHandle(frac);
  });
  handle.addEventListener('pointerup', () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    handle.classList.remove('dragging');
    if (moved) { try { localStorage.setItem(POS_KEY, String(frac)); } catch { /* blocked */ } return; }
    toggle();
  });
  handle.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) toggle(false); });
  // a click on the Salesforce page (outside the panel and its handle) closes the panel. Clicks inside the
  // panel happen in its frame and never reach this page; the handle sits in our shadow root (the host).
  // Copying a field's API-name tag on the page keeps the panel open: that's work done together with it.
  document.addEventListener('pointerdown', (e) => {
    if (!open || e.button !== 0) return;
    const path = e.composedPath();
    if (path.includes(host)) return;
    if (path.some((n) => n.classList?.contains?.(TAG))) return;
    toggle(false, { keepFocus: true }); // focus goes where you clicked, not back to the handle
  }, true);

  // ---------- "Show field API names": a copyable API-name tag under every field label on the page ----------
  // Lightning marks record-layout fields with data-target-selection-name="sfdc:RecordField.<Object>.<Field>",
  // which gives the exact API name. Where that's missing (Dynamic Forms, Classic), the label text is matched
  // against the record's describe that the panel sends.
  const API = { on: false, byLabel: new Map(), object: null, observer: null, timer: 0, url: null };
  const TAG = 'og-api-name';
  const pageCss = document.createElement('style');
  pageCss.id = 'og-api-name-style';
  pageCss.textContent = `
    .${TAG} { display: inline-flex !important; align-items: center; gap: 4px; margin: 2px 0 0 !important; padding: 0 5px !important;
      max-width: 100%; border-radius: 4px; background: #fff1d6 !important; color: #7a4a00 !important; border: 1px solid #f5d38f;
      font: 600 11px/16px ui-monospace, "SF Mono", Menlo, Consolas, monospace !important; letter-spacing: 0 !important;
      text-transform: none !important; white-space: normal; overflow-wrap: anywhere; cursor: copy; user-select: all; vertical-align: middle; }
    .${TAG}:hover { background: #ffe4ad !important; border-color: #e8b456; }
    .${TAG}.og-copied { background: #d9f5e3 !important; border-color: #8fd6a9; color: #136c34 !important; }
    .${TAG}.og-guess { border-style: dashed; }
    .${TAG}-wrap { display: block !important; line-height: 1 !important; }
    @media (prefers-color-scheme: dark) { .${TAG} { background: #3a2a10 !important; color: #ffd28a !important; border-color: #6b4d1c; } }`;

  function tagFor(names, guess) {
    const t = document.createElement('span');
    t.className = `${TAG}${guess ? ' og-guess' : ''}`;
    t.textContent = names.join(' / ');
    t.title = guess ? 'Matched by label (click to copy)' : 'Click to copy the API name';
    t.setAttribute('role', 'button');
    t.tabIndex = 0;
    const copy = async (e) => {
      // keep Lightning from treating this as a click on the field (inline edit, help popovers)
      e.preventDefault();
      e.stopPropagation();
      const text = names[0];
      try { await navigator.clipboard.writeText(text); } catch {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0';
        document.body.append(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      const was = t.textContent;
      t.classList.add('og-copied');
      t.textContent = `Copied ✓ ${text}`;
      setTimeout(() => { t.classList.remove('og-copied'); t.textContent = was; }, 1200);
    };
    for (const ev of ['mousedown', 'pointerdown', 'dblclick']) t.addEventListener(ev, (e) => e.stopPropagation(), true);
    t.addEventListener('click', copy, true);
    t.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') copy(e); });
    return t;
  }

  // put the tag right under the label text (once per label)
  function attach(labelEl, names, guess) {
    if (!labelEl || labelEl.querySelector(`.${TAG}`) || labelEl.closest(`.${TAG}`)) return false;
    const wrap = document.createElement('span');
    wrap.className = `${TAG}-wrap`;
    wrap.append(tagFor(names, guess));
    labelEl.append(wrap);
    return true;
  }

  const cleanLabel = (s) => (s || '').replace(/\s+/g, ' ').replace(/^\*\s*/, '').replace(/\s*(Help|\(Edit\))?\s*$/i, '').trim().toLowerCase();

  function scan() {
    if (!API.on) return 0;
    let n = 0;
    // 1. exact: Lightning record layout items
    for (const item of document.querySelectorAll('[data-target-selection-name^="sfdc:RecordField."]')) {
      const name = item.getAttribute('data-target-selection-name').split('.').pop();
      const label = item.querySelector('.test-id__field-label, .slds-form-element__label');
      if (label && attach(label.closest('.slds-form-element__label') || label, [name], false)) n++;
    }
    // 2. by label: Dynamic Forms, other Lightning labels, Classic detail pages
    if (API.byLabel.size) {
      for (const label of document.querySelectorAll('.test-id__field-label, records-record-layout-item .slds-form-element__label, record_flexipage-record-field .slds-form-element__label, td.labelCol, .labelCol')) {
        // one tag per field: the inner and outer label elements of the same field both match
        const field = label.closest('[data-target-selection-name^="sfdc:RecordField."], records-record-layout-item, record_flexipage-record-field, .slds-form-element, tr') || label;
        if (field.querySelector(`.${TAG}`)) continue;
        const names = API.byLabel.get(cleanLabel(label.textContent));
        if (names && attach(label, names, true)) n++;
      }
    }
    return n;
  }

  function setApiNames(on, fields, object) {
    API.on = on;
    API.url = location.href;
    if (fields) {
      API.object = object;
      API.byLabel = new Map();
      for (const f of fields) {
        const k = cleanLabel(f.label);
        API.byLabel.set(k, [...(API.byLabel.get(k) || []), f.name]);
      }
    }
    if (on) {
      if (!pageCss.isConnected) document.head.append(pageCss);
      scan();
      API.observer ||= new MutationObserver(() => {
        clearTimeout(API.timer);
        API.timer = setTimeout(scan, 250); // Lightning renders sections lazily
      });
      API.observer.observe(document.body, { childList: true, subtree: true });
    } else {
      API.observer?.disconnect();
      API.observer = null;
      clearTimeout(API.timer);
      for (const w of document.querySelectorAll(`.${TAG}-wrap`)) w.remove();
      pageCss.remove();
    }
    post({ type: 'api-names', on, count: document.querySelectorAll(`.${TAG}`).length });
  }

  // messages from the panel: close, go somewhere in this tab (Login as), field API names
  window.addEventListener('message', (e) => {
    if (e.origin !== EXT_ORIGIN || e.data?.source !== 'og-panel') return;
    if (e.source !== frame?.contentWindow) return; // a replaced frame's last words don't count
    if (e.data.type === 'ready') {
      frameReady = true;
      clearTimeout(loadT);
      frame.classList.add('ready');
      clearNote();
      if (open) { post({ type: 'url', url: location.href, apiNames: API.on }); post({ type: 'opened' }); }
    }
    if (e.data.type === 'pong' && frame?.dataset.ping === String(e.data.at)) { delete frame.dataset.ping; clearTimeout(pingT); }
    if (e.data.type === 'close') toggle(false);
    if (e.data.type === 'navigate' && /^https:\/\/[\w.-]+\.(salesforce|force|salesforce-setup)\.com\//.test(e.data.url)) location.href = e.data.url;
    if (e.data.type === 'api-names') setApiNames(!!e.data.on, e.data.fields, e.data.object);
    if (e.data.type === 'api-names-count') post({ type: 'api-names', on: API.on, count: document.querySelectorAll(`.${TAG}`).length });
    if (e.data.type === 'hard-reload') hardReload(!!e.data.deep);
  });

  // ---------- Empty cache & hard reload: the background empties this org's cache, then reloads the tab ----------
  const FRESH_KEY = 'og-debugger-fresh';
  function hardReload(deep) {
    if (!alive()) {
      post({ type: 'hard-reload-failed', error: 'OG Debugger was updated since this page opened. Reload the page once (F5), then try again.' });
      return;
    }
    try { sessionStorage.setItem(FRESH_KEY, JSON.stringify({ at: Date.now(), deep })); } catch { /* blocked */ }
    chrome.runtime.sendMessage({ type: 'og-hard-reload', deep }, (res) => {
      // on success the page is already reloading; only a failure comes back here
      if (chrome.runtime.lastError || !res?.ok) {
        try { sessionStorage.removeItem(FRESH_KEY); } catch { /* blocked */ }
        post({ type: 'hard-reload-failed', error: chrome.runtime.lastError?.message || res?.error || 'Unknown error' });
      }
    });
  }
  // after the reload: a short "fresh" note by the handle, so it's clear it worked
  try {
    const fresh = JSON.parse(sessionStorage.getItem(FRESH_KEY) || 'null');
    sessionStorage.removeItem(FRESH_KEY);
    if (fresh && Date.now() - fresh.at < 60000) {
      tip.innerHTML = `✓ Fresh page<small>Cache emptied${fresh.deep ? ' + Lightning data cleared' : ''} · latest LWC loaded</small>`;
      tip.classList.add('fresh');
      setTimeout(() => {
        tip.classList.remove('fresh');
        setTimeout(() => { tip.innerHTML = 'OG Debugger<small>Click to open · drag to move</small>'; }, 300);
      }, 3600);
    }
  } catch { /* storage blocked */ }

  // Lightning changes pages without reloading: tell the panel which record is showing now
  let last = location.href;
  setInterval(() => {
    if (location.href === last) return;
    last = location.href;
    // the tags belong to the record they were made for: leaving it turns them off
    if (API.on && !location.href.startsWith(API.url.split(/[?#]/)[0].replace(/\/view$/, ''))) setApiNames(false);
    post({ type: 'url', url: last, apiNames: API.on });
  }, 700);

  (document.body || document.documentElement).append(host);
})();
