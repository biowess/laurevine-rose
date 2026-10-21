/* a11y.js — keyboard and ARIA helpers shared by the four figure windows (RPE.figures.a11y).
   radios   roving tabindex + arrow keys for role=radiogroup tile sets (follows aria-checked)
   linkTabs aria-controls / aria-labelledby between tab buttons and tabpanels
   help     one-sentence "?" help popover button
   panes    F6 / Shift+F6 moves focus between the main regions of a dialog
   keys     Ctrl+S / Ctrl+Enter handlers scoped to a dialog (stops the app-level save) */
(function (RPE) {
  'use strict';
  const h = RPE.ui.h, U = RPE.ui, F = (RPE.figures = RPE.figures || {});
  const A = (F.a11y = {});
  let uid = 0;
  const FOCUSABLE = 'button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])';
  const visible = (n) => n && n.offsetParent !== null && !n.closest('[hidden]');

  /* tooltip with shortcut (custom tooltip shows <kbd>) + aria-keyshortcuts; replaces the native title */
  A.tip = function (el, text, sc) {
    if (!el) return el;
    el.setAttribute('data-tip', text); el.removeAttribute('title');
    if (sc) { el.setAttribute('data-shortcut', sc); el.setAttribute('aria-keyshortcuts', sc.replace(/Ctrl/g, 'Control')); }
    return el;
  };

  /* polite live region that speaks only when the state word changes ("Running 3.2s" -> "Running"), never on timer ticks */
  A.announcer = function (prefix) {
    const el = h('div', { class: 'sr-only', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    let last = '';
    return { el, say(label) { const k = String(label || '').replace(/\s*\d[\d.]*\s*s?$/, ''); if (k && k !== last) { last = k; el.textContent = prefix + ': ' + k; } } };
  };

  A.id = (p) => (p || 'a11y') + (++uid);

  /* Radio tiles: exactly one tab stop (the checked tile, else the first); arrows move AND select. */
  A.radios = function (group) {
    const items = () => [].filter.call(group.querySelectorAll('[role="radio"]'), (b) => !b.disabled);
    const sync = () => {
      const all = items(); if (!all.length) return;
      const cur = all.find((b) => b.getAttribute('aria-checked') === 'true') || all[0];
      all.forEach((b) => { b.tabIndex = b === cur ? 0 : -1; });
    };
    group.addEventListener('keydown', (e) => {
      const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key], all = items(), i = all.indexOf(document.activeElement);
      if (i < 0 || (!d && e.key !== 'Home' && e.key !== 'End')) return;
      e.preventDefault();
      const n = all[e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : (i + d + all.length) % all.length];
      n.focus(); n.click();
    });
    if (typeof MutationObserver === 'function') new MutationObserver(sync).observe(group, { attributes: true, attributeFilter: ['aria-checked', 'disabled'], subtree: true, childList: true });
    sync();
    return sync;
  };

  A.linkTabs = function (btns, panes) {
    Object.keys(btns).forEach((k) => {
      if (!btns[k] || !panes[k]) return;
      const t = A.id('ftab'), p = A.id('fpan');
      btns[k].id = t; btns[k].setAttribute('aria-controls', p);
      panes[k].id = p; panes[k].setAttribute('aria-labelledby', t);
    });
  };

  /* One sentence of help in a small popover. Esc closes it (global handler) and returns focus here. */
  A.help = function (text, label) {
    const b = h('button', { type: 'button', class: 'helpbtn', 'aria-label': 'Help: ' + label, 'aria-haspopup': 'dialog', 'aria-expanded': 'false', 'data-tip': label }, '?');
    b.addEventListener('click', () => {
      if (U.isOpenFor(b)) { U.closeAll(); return; }
      U.popover(b, h('p', { class: 'helppop__t' }, text), { role: 'dialog', class: 'popover--help', placement: 'bottom-start' });
    });
    return b;
  };

  /* add a help button to the label of a field (label.field > .field__label) */
  A.withHelp = function (fld, text, label) {
    const lab = fld && fld.querySelector ? fld.querySelector('.field__label') : null, b = A.help(text, label);
    if (lab) lab.append(' ', b); else if (fld) fld.appendChild(b);
    return fld;
  };

  /* F6 / Shift+F6 cycle through regions; each region is a selector inside the dialog. */
  A.panes = function (dlg, selectors) {
    dlg.el.addEventListener('keydown', (e) => {
      if (e.key !== 'F6' || U.hasPopover()) return;
      const regs = selectors.map((s) => dlg.el.querySelector(s)).filter(visible); if (!regs.length) return;
      e.preventDefault();
      let i = regs.findIndex((r) => r.contains(document.activeElement));
      i = i < 0 ? 0 : (i + (e.shiftKey ? -1 : 1) + regs.length) % regs.length;
      const r = regs[i], f = r.matches(FOCUSABLE) ? r : (r.querySelector('[aria-selected="true"],[aria-checked="true"]') || [].find.call(r.querySelectorAll(FOCUSABLE), visible));
      if (f) f.focus(); else { r.tabIndex = -1; r.focus(); }
    });
  };

  /* Ctrl/Cmd+S -> o.save, Ctrl/Cmd+Enter -> o.run. A handler may return false to leave the key alone
     (the code editor keeps Ctrl+Enter for itself). Ctrl+S is always consumed so the app never saves the deck behind a dialog. */
  A.keys = function (dlg, o) {
    dlg.el.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || U.hasPopover()) return;
      const k = e.key.toLowerCase();
      if (k === 's' && o.save) { e.preventDefault(); e.stopPropagation(); o.save(); }
      else if (e.key === 'Enter' && o.run) { if (o.run(e) !== false) { e.preventDefault(); e.stopPropagation(); } }
    });
  };
})(window.RPE);
