/* symbollib.js — "Add symbol" modal (Insert > Text and Symbols).
   Catalog/search live in symbols.js (pure). This file = UI + insertion wiring.
   API: RPE.symbolLibrary.open({ onPick(sym, api) }) -> api { close, refresh, el }   (default onPick inserts at the caret via canvas.insertText)
   Insertion contract (task 22): opening the modal never touches the active textbox/selection; symbol buttons swallow mousedown so focus and
   selection are not stolen; each pick restores the preserved range, replaces a selected range, inherits the surrounding formatting and is ONE
   undo step; the modal stays open until Close/Esc (RPE.canvas.holdEdit keeps the text edit alive meanwhile). No caret -> grid disabled + message. */
(function (RPE) {
  'use strict';
  const MSG = 'Place the cursor inside a text box first';
  const HINT = 'Close this window, click inside a text box, then reopen it.';
  let current = null;

  function caret() { return RPE.canvas && RPE.canvas.caretState ? RPE.canvas.caretState() : { ok: false }; }

  /* Default pick: insert at the preserved caret. Returns true when something was inserted. */
  function insertAtCaret(sym) { return !!(RPE.canvas && RPE.canvas.insertText && RPE.canvas.insertText(sym.c, 'Insert symbol')); }

  function open(opts) {
    opts = opts || {};
    const U = RPE.ui, SY = RPE.symbols, h = U.h;
    if (current) { current.focusSearch(); return current; }
    let catId = SY.CATEGORIES[0].id, query = '';
    const onPick = opts.onPick || insertAtCaret;

    const search = h('input', { type: 'search', class: 'sym-lib__search', placeholder: 'Search by name, keyword or character…', 'aria-label': 'Search symbols', autocomplete: 'off', spellcheck: 'false' });
    const status = h('div', { class: 'sym-lib__status', role: 'status', 'aria-live': 'polite' });
    const nav = h('div', { class: 'sym-lib__nav', role: 'tablist', 'aria-label': 'Symbol categories', 'aria-orientation': 'vertical' });
    const grid = h('div', { class: 'sym-lib__grid scroll-burgundy', role: 'group', 'aria-label': 'Symbols' });
    const empty = h('div', { class: 'sym-lib__empty', hidden: true }, 'No symbols match your search.');
    const pvGlyph = h('div', { class: 'sym-lib__pv-glyph', 'aria-hidden': 'true' }, '');
    const pvName = h('div', { class: 'sym-lib__pv-name' }, 'Hover a symbol');
    const pvMeta = h('div', { class: 'sym-lib__pv-meta' }, '');
    const preview = h('div', { class: 'sym-lib__pv' }, pvGlyph, h('div', { class: 'sym-lib__pv-txt' }, pvName, pvMeta));

    const body = h('div', { class: 'sym-lib' },
      h('div', { class: 'sym-lib__top' }, search, status),
      h('div', { class: 'sym-lib__main' }, nav, h('div', { class: 'sym-lib__panel' }, grid, empty)),
      preview);

    const navBtns = {};
    SY.CATEGORIES.forEach((c) => {
      const b = h('button', { type: 'button', class: 'sym-lib__cat', role: 'tab', dataset: { cat: c.id }, 'aria-selected': 'false' },
        h('span', { class: 'sym-lib__cat-ic', 'aria-hidden': 'true' }, c.icon), h('span', { class: 'sym-lib__cat-lb' }, c.label), h('span', { class: 'sym-lib__cat-n' }, String(c.symbols.length)));
      navBtns[c.id] = b; nav.appendChild(b);
    });

    function showPreview(sym) {
      if (!sym) { pvGlyph.textContent = ''; pvName.textContent = 'Hover a symbol'; pvMeta.textContent = ''; return; }
      pvGlyph.textContent = SY.label(sym); pvGlyph.classList.toggle('is-ws', !!SY.WS_LABEL[sym.c]);
      pvName.textContent = sym.n[0].toUpperCase() + sym.n.slice(1);
      pvMeta.textContent = SY.hex(sym.c) + (sym.k ? ' · ' + sym.k.split(' ').filter((w, i, a) => a.indexOf(w) === i).join(', ') : '');
    }
    const symOf = (el) => { const b = el && el.closest && el.closest('.sym-cell'); return b ? SY.find(b.dataset.c) : null; };

    function renderGrid() {
      const list = SY.search(query, query.trim() ? null : catId);
      grid.replaceChildren();
      list.forEach((s, i) => {
        grid.appendChild(h('button', { type: 'button', class: 'sym-cell' + (SY.WS_LABEL[s.c] ? ' is-ws' : ''), dataset: { c: s.c }, tabindex: i === 0 ? '0' : '-1', title: s.n, 'aria-label': s.n + ' (' + SY.hex(s.c) + ')' }, SY.label(s)));
      });
      empty.hidden = list.length > 0; grid.hidden = !list.length; grid.scrollTop = 0;
      Object.keys(navBtns).forEach((id) => { const on = !query.trim() && id === catId; navBtns[id].classList.toggle('is-on', on); navBtns[id].setAttribute('aria-selected', String(on)); navBtns[id].tabIndex = on || (query.trim() && id === catId) ? 0 : -1; });
      grid.setAttribute('aria-label', query.trim() ? 'Search results (' + list.length + ')' : SY.get(catId).label);
      refresh();
    }

    /* Enabled/disabled state follows the live caret (the text edit can end while the modal is open, e.g. via undo). */
    function refresh() {
      const ok = caret().ok;
      body.classList.toggle('is-disabled', !ok);
      grid.setAttribute('aria-disabled', String(!ok));
      status.replaceChildren(ok ? h('span', { class: 'sym-lib__ok' }, caret().collapsed ? 'Click a symbol to insert it at the cursor.' : 'Click a symbol to replace the selected text.')
        : h('span', { class: 'sym-lib__warn' }, h('strong', null, MSG), h('span', null, HINT)));
    }

    function pick(sym, fromKeyboard, btn) {
      if (!sym || !caret().ok) { refresh(); return; }
      const done = onPick(sym, api);
      if (done === false) { refresh(); return; }
      if (fromKeyboard && btn && btn.isConnected) btn.focus({ preventScroll: true });   // keyboard users keep their place in the grid (range stays preserved)
      refresh();
    }

    /* Focus/selection protection: mouse presses on anything but the search box never move focus out of the text edit. */
    body.addEventListener('mousedown', (e) => { if (e.target !== search) e.preventDefault(); });
    grid.addEventListener('click', (e) => { const b = e.target.closest('.sym-cell'); if (b) pick(SY.find(b.dataset.c), e.detail === 0, b); });
    grid.addEventListener('mouseover', (e) => { const s = symOf(e.target); if (s) showPreview(s); });
    grid.addEventListener('focusin', (e) => { const s = symOf(e.target); if (s) showPreview(s); });
    grid.addEventListener('mouseleave', () => showPreview(null));
    grid.addEventListener('keydown', (e) => {
      const cells = [].slice.call(grid.querySelectorAll('.sym-cell')), i = cells.indexOf(document.activeElement); if (i < 0) return;
      const top = cells[0].offsetTop, cols = Math.max(1, cells.filter((c) => c.offsetTop === top).length);
      const to = { ArrowRight: i + 1, ArrowLeft: i - 1, ArrowDown: i + cols, ArrowUp: i - cols, Home: 0, End: cells.length - 1 }[e.key];
      if (to == null) return; e.preventDefault();
      const n = cells[Math.max(0, Math.min(cells.length - 1, to))]; cells.forEach((c) => { c.tabIndex = -1; }); n.tabIndex = 0; n.focus({ preventScroll: false });
    });
    nav.addEventListener('click', (e) => { const b = e.target.closest('.sym-lib__cat'); if (!b) return; catId = b.dataset.cat; query = ''; search.value = ''; renderGrid(); });
    nav.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return; e.preventDefault();
      const ids = SY.CATEGORIES.map((c) => c.id), n = ids[(ids.indexOf(catId) + (e.key === 'ArrowDown' ? 1 : ids.length - 1)) % ids.length];
      catId = n; query = ''; search.value = ''; renderGrid(); navBtns[n].focus();
    });
    search.addEventListener('input', () => { query = search.value; renderGrid(); });

    /* Esc closes the modal only (capture: the text edit underneath must not end, nor the object deselect). */
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); api.close(); } };
    document.addEventListener('keydown', onEsc, true);
    const offSel = RPE.bus.on('editsel', refresh), offUi = RPE.bus.on('ui', refresh);
    if (RPE.canvas && RPE.canvas.holdEdit) RPE.canvas.holdEdit(true);

    const dlg = U.dialog({
      title: 'Symbols', icon: 'omega', fit: true, width: 820, class: 'dlg--sym scroll-burgundy', focus: '.sym-lib__search', body,
      onClose() {
        document.removeEventListener('keydown', onEsc, true); offSel(); offUi(); current = null;
        if (RPE.canvas && RPE.canvas.holdEdit) RPE.canvas.holdEdit(false);
        // back into the text box, caret/range intact (deferred: U.dialog's close() re-focuses the opener right after onClose)
        setTimeout(() => { if (RPE.canvas && RPE.canvas.caretState && RPE.canvas.caretState().ok && RPE.canvas.focusEdit) RPE.canvas.focusEdit(); }, 0);
      }
    });
    const api = { el: dlg.el, close: () => dlg.close(), refresh, focusSearch: () => search.focus(), pick: (c) => pick(SY.find(c)) };
    current = api;
    renderGrid();
    return api;
  }

  RPE.symbolLibrary = { open, MSG, isOpen: () => !!current };
})(window.RPE = window.RPE || {});
