/* canvas.js — the central editing workspace.
   Slide objects live in a CSS-scaled .slide; selection outlines/handles live in an unscaled overlay so they
   keep a constant pixel size at every zoom level. Coordinates are logical slide pixels (doc.size). */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, R = RPE.renderer, U = RPE.ui;
  const $ = (s) => document.querySelector(s);
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const PAD = 28, GRID = 24;
  let ws, scroll, frame, overlay, selLayer, guideLayer, rulerH, rulerV, slideEl = null;
  let scale = 1, editEl = null, savedRange = null, editHold = 0, inputMute = false, gesture = null, cellEl = null, dragMoved = false;
  let drawShapeKind = null; // when set, next mouse-drag creates a shape of this kind

  const objEl = (id) => (slideEl ? slideEl.querySelector(`[data-id="${id}"]`) : null);
  const snap = (v) => (ui.showGrid && !(gesture && gesture.alt) ? Math.round(v / GRID) * GRID : v);

  /* ---------- zoom / layout ---------- */
  function fitZoom() {
    const d = S.doc.size, w = scroll.clientWidth - PAD * 2, h = scroll.clientHeight - PAD * 2;
    if (w <= 0 || h <= 0) return ui.zoom;
    return clamp(Math.floor(Math.min(w / d.w, h / d.h) * 100), 10, 400);
  }
  function applyZoom() {
    if (!frame || ui.view !== 'normal') return;
    const d = S.doc.size;
    if (ui.zoomMode === 'fit') { const z = fitZoom(); if (z !== ui.zoom) S.setUI({ zoom: z }, 'fit'); }
    scale = ui.zoom / 100;
    frame.style.width = Math.round(d.w * scale) + 'px'; frame.style.height = Math.round(d.h * scale) + 'px';
    if (slideEl) slideEl.style.transform = `scale(${scale})`;
    renderSelection(); renderRulers();
  }
  function render() {
    const slide = S.activeSlide(); if (!slide || !frame) return;
    if (slideEl) slideEl.remove();
    slideEl = R.slideEl(slide, { doc: S.doc, index: S.activeIndex(), mode: 'edit' });
    slideEl.classList.toggle('show-grid', ui.showGrid);
    frame.insertBefore(slideEl, overlay);
    applyZoom(); updateGuides();
  }
  function refreshObject(id) {
    if (ui.editingId === id) return;
    const o = S.findObject(id), old = objEl(id);
    if (RPE.hf && RPE.hf.isId(id)) {   // header/footer region: not an object, rebuilt from the model (or dropped when nothing to show)
      if (!old) return;
      const n = R.hfElFor(S.doc, S.activeSlide(), id.slice(3), { mode: 'edit' });
      if (n) old.replaceWith(n); else old.remove();
      return;
    }
    if (!o || !old) return;
    old.replaceWith(R.objectEl(o, R.context(S.doc), { mode: 'edit' }));
  }
  function patchGeom(list) { list.forEach((id) => { const o = S.findObject(id), el = objEl(id); if (o && el) R.setGeom(el, o); }); }

  /* ---------- selection overlay ---------- */
  const place = (el, o) => { el.style.left = (o.x * scale) + 'px'; el.style.top = (o.y * scale) + 'px'; el.style.width = (o.w * scale) + 'px'; el.style.height = (o.h * scale) + 'px'; };
  const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  /* Inline-SVG yellow diamond — 100% immune to CSS cache/override issues.
     28×28 wrapper provides a generous click/drag target centred on the apex. */
  function makeDiamondHandle() {
    const wrap = document.createElement('div');
    wrap.className = 'handle handle--adj';
    wrap.dataset.dir = 'adj';
    wrap.style.cssText = 'position:absolute;width:28px;height:28px;margin:-14px 0 0 -14px;background:transparent;border:none;border-radius:0;transform:none;box-shadow:none;cursor:grab;z-index:30;pointer-events:auto;display:flex;align-items:center;justify-content:center;';
    wrap.innerHTML = '<svg width="18" height="18" viewBox="0 0 18 18" style="pointer-events:none;overflow:visible;filter:drop-shadow(0 0 2.5px #fff) drop-shadow(0 2px 5px rgba(0,0,0,0.6));" aria-hidden="true"><polygon points="9,1 17,9 9,17 1,9" fill="#FFD000" stroke="#7A4100" stroke-width="1.8"/></svg>';
    return wrap;
  }

  function renderSelection() {
    if (!selLayer) return;
    selLayer.replaceChildren();
    const objs = S.selectedObjects(); if (!objs.length || ui.view !== 'normal') return;
    const editing = !!ui.editingId;
    objs.forEach((o) => {
      const b = document.createElement('div'); b.className = 'sel' + (editing && o.id === ui.editingId ? ' sel--edit' : ''); b.dataset.for = o.id; place(b, o);
      if (objs.length === 1 && !editing) {
        if (RPE.shapes && RPE.shapes.isLine(o)) {
          b.classList.add('sel--line');
          const geom = RPE.shapes.lineGeometry(o);
          const hd1 = document.createElement('div');
          hd1.className = 'handle handle--line-start';
          hd1.dataset.dir = 'line-p1';
          hd1.style.left = ((geom.x1 - geom.x) * scale) + 'px';
          hd1.style.top = ((geom.y1 - geom.y) * scale) + 'px';
          hd1.style.cursor = 'crosshair';
          b.appendChild(hd1);

          const hd2 = document.createElement('div');
          hd2.className = 'handle handle--line-end';
          hd2.dataset.dir = 'line-p2';
          hd2.style.left = ((geom.x2 - geom.x) * scale) + 'px';
          hd2.style.top = ((geom.y2 - geom.y) * scale) + 'px';
          hd2.style.cursor = 'crosshair';
          b.appendChild(hd2);
        } else {
          DIRS.forEach((d) => { const hd = document.createElement('div'); hd.className = 'handle handle--' + d; hd.dataset.dir = d; b.appendChild(hd); });
          // Adjust handle (yellow diamond) for adjustable shapes
          if (o.type === 'shape' && RPE.shapes && RPE.shapes.isAdjustable(o.shape)) {
            const h = RPE.shapes.handle(o.shape, o.adj);
            const ah = makeDiamondHandle();
            ah.style.left = (o.w * (h[0] / 1000) * scale) + 'px';
            ah.style.top  = (o.h * (h[1] / 1000) * scale) + 'px';
            b.appendChild(ah);
          }
        }
      }
      selLayer.appendChild(b);
    });
    if (objs.length > 1) {
      const l = Math.min(...objs.map((o) => o.x)), t = Math.min(...objs.map((o) => o.y)), r = Math.max(...objs.map((o) => o.x + o.w)), bt = Math.max(...objs.map((o) => o.y + o.h));
      const g = document.createElement('div'); g.className = 'sel sel--multi'; place(g, { x: l, y: t, w: r - l, h: bt - t }); selLayer.appendChild(g);
    }
    // Draw cell selection overlay if active
    if (ui.cellSel && objs.length === 1 && objs[0].id === ui.cellSel.id && slideEl && frame) {
      const tblEl = slideEl.querySelector(`[data-id="${ui.cellSel.id}"] table`);
      if (tblEl) {
        const c1 = tblEl.querySelector(`[data-r="${ui.cellSel.r1}"][data-c="${ui.cellSel.c1}"]`);
        const c2 = tblEl.querySelector(`[data-r="${ui.cellSel.r2}"][data-c="${ui.cellSel.c2}"]`);
        if (c1 && c2) {
          const fr = frame.getBoundingClientRect();
          const r1 = c1.getBoundingClientRect();
          const r2 = c2.getBoundingClientRect();
          const left = Math.min(r1.left, r2.left) - fr.left;
          const top = Math.min(r1.top, r2.top) - fr.top;
          const right = Math.max(r1.right, r2.right) - fr.left;
          const bottom = Math.max(r1.bottom, r2.bottom) - fr.top;
          const cellBox = document.createElement('div');
          cellBox.className = 'sel--cell' + (ui.cellSel.r1 !== ui.cellSel.r2 || ui.cellSel.c1 !== ui.cellSel.c2 ? ' sel--range' : '');
          cellBox.style.cssText = `left:${left}px;top:${top}px;width:${right - left}px;height:${bottom - top}px;`;
          selLayer.appendChild(cellBox);
        }
      }
    }
    // Editor-only range handle at the table's top-left corner (lives in the selection layer: never in export/thumbnails)
    if (objs.length === 1 && objs[0].type === 'table' && !editing && slideEl && frame) {
      const tbl = slideEl.querySelector(`[data-id="${objs[0].id}"] table`);
      if (tbl) {
        const fr = frame.getBoundingClientRect(), tr = tbl.getBoundingClientRect();
        const hd = document.createElement('div');
        hd.className = 'tbl-handle'; hd.dataset.for = objs[0].id; hd.title = 'Drag to select a range of cells; click to select the whole table';
        hd.style.left = Math.max(2, tr.left - fr.left - 20) + 'px'; hd.style.top = Math.max(2, tr.top - fr.top - 20) + 'px';
        hd.innerHTML = '<svg viewBox="0 0 14 14" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2h4M2 2v4M2 2l10 10M12 12H8M12 12V8"/></svg>';
        selLayer.appendChild(hd);
      }
    }
    if (gesture && gesture.smartLines && gesture.smartLines.length) {
      renderSmartLines(gesture.smartLines);
    }
  }

  function updateGuides() {
    if (!slideEl) return;
    slideEl.classList.toggle('show-grid', ui.showGrid);
    guideLayer.hidden = !ui.showGuides || ui.view !== 'normal';
  }

  /* ---------- rulers (inches; 96 logical px = 1 in) ---------- */
  function rulerSvg(dir, len, origin) {
    const pxIn = 96 * scale, step = pxIn >= 110 ? pxIn / 8 : pxIn / 2, minor = pxIn >= 110 ? 8 : 2;
    const start = Math.floor(-origin / step), end = Math.ceil((len - origin) / step); let s = '';
    for (let i = start; i <= end; i++) {
      const pos = origin + i * step, major = i % minor === 0, half = !major && i % (minor / 2) === 0;
      const sz = major ? 11 : half ? 7 : 4;
      s += dir === 'h' ? `<line x1="${pos.toFixed(1)}" x2="${pos.toFixed(1)}" y1="${18 - sz}" y2="18"/>` : `<line y1="${pos.toFixed(1)}" y2="${pos.toFixed(1)}" x1="${18 - sz}" x2="18"/>`;
      if (major && i !== 0) s += dir === 'h' ? `<text x="${(pos + 3).toFixed(1)}" y="9">${Math.abs(i / minor)}</text>` : `<text transform="translate(9 ${(pos + 3).toFixed(1)}) rotate(-90)" >${Math.abs(i / minor)}</text>`;
    }
    return `<svg width="${dir === 'h' ? len : 18}" height="${dir === 'h' ? 18 : len}" aria-hidden="true">${s}</svg>`;
  }
  function renderRulers() {
    const on = ui.showRuler && ui.view === 'normal';
    ws.classList.toggle('has-ruler', on); rulerH.hidden = rulerV.hidden = !on; if (!on) return;
    const fr = frame.getBoundingClientRect(), sr = scroll.getBoundingClientRect();
    rulerH.innerHTML = rulerSvg('h', sr.width, fr.left - sr.left); rulerV.innerHTML = rulerSvg('v', sr.height, fr.top - sr.top);
  }

  /* ---------- inline text editing ---------- */
  function clean(html) {
    const d = document.createElement('div'); d.innerHTML = html;
    d.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((n) => n.remove());
    d.querySelectorAll('*').forEach((n) => [].slice.call(n.attributes).forEach((a) => { if (/^on/i.test(a.name) || (a.name === 'href' && /^\s*javascript:/i.test(a.value))) n.removeAttribute(a.name); }));
    return !d.textContent.trim() ? '' : d.innerHTML;
  }
  function caretRangeAtPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(x, y);
      if (pos && pos.offsetNode) {
        const r = document.createRange();
        r.setStart(pos.offsetNode, pos.offset);
        r.collapse(true);
        return r;
      }
    }
    return null;
  }
  function selectWordAt(sel, range, container) {
    if (!range) return false;
    let n = range.startContainer, offset = range.startOffset;
    if (n.nodeType === 1 && n.childNodes.length > 0) {
      if (offset >= n.childNodes.length) offset = n.childNodes.length - 1;
      n = n.childNodes[offset];
      while (n && n.nodeType === 1 && n.firstChild) n = n.firstChild;
      offset = 0;
    }
    if (n && n.nodeType === 3 && n.nodeValue) {
      const text = n.nodeValue;
      const isWord = (ch) => /[\p{L}\p{N}_]/u.test(ch);
      let start = offset, end = offset;
      if (start >= text.length && start > 0) start = text.length - 1;
      if (start > 0 && !isWord(text[start]) && isWord(text[start - 1])) start--;
      end = start;
      if (start < text.length && isWord(text[start])) {
        while (start > 0 && isWord(text[start - 1])) start--;
        while (end < text.length && isWord(text[end])) end++;
        if (end > start) {
          const wordRange = document.createRange();
          wordRange.setStart(n, start);
          wordRange.setEnd(n, end);
          sel.removeAllRanges();
          sel.addRange(wordRange);
          return true;
        }
      }
    }
    if (sel.modify) {
      try {
        sel.removeAllRanges();
        sel.addRange(range);
        sel.modify('move', 'backward', 'word');
        sel.modify('extend', 'forward', 'word');
        if (container && container.contains(sel.anchorNode) && container.contains(sel.focusNode) && !sel.isCollapsed) {
          return true;
        }
      } catch (_) {}
    }
    return false;
  }
  const isHF = (id) => !!(RPE.hf && RPE.hf.isId(id));
  /* Esc / click-away on a header or footer: store the text; empty text removes the stored item (no empty leftovers). Still inside the
     edit session's undo group. */
  function commitHF(id, html, o) {
    const key = id.slice(3), slide = S.activeSlide(), had = !!RPE.hf.holder(S.doc, slide, key, false);
    if (RPE.hf.plain(html)) {
      if (o.html !== html) S.mutate('Edit text', () => { o.html = html; }, { hint: { skipCanvas: true } });
    } else if (had) {
      S.mutate('Edit text', (d) => { const it = RPE.hf.holder(d, slide, key, false); if (it) it.html = ''; RPE.hf.prune(d); }, { hint: { skipCanvas: true } });
    }
  }
  function startEdit(id, opts) {
    opts = opts || {};
    const o = S.findObject(id); if (!o || !['text', 'shape'].includes(o.type)) return;
    if (ui.view !== 'normal') S.setUI({ view: 'normal' });
    stopEdit(); S.select([id]);
    const el = objEl(id), t = el && el.querySelector('.obj__text'); if (!t) return;
    if (isHF(id)) S.beginGroup('Edit ' + id.slice(3));   // text + formatting of this session = one undo step
    S.setUI({ editingId: id });
    if (!t.textContent.trim()) t.innerHTML = '<p><br></p>';
    t.contentEditable = 'true'; t.spellcheck = true; el.classList.add('is-editing'); editEl = t;
    try { document.execCommand('defaultParagraphSeparator', false, 'p'); } catch (e) { /* ignore */ }
    t.focus({ preventScroll: true });
    const sel = getSelection();
    let r = null;
    if (opts.selectAll && t.textContent.trim()) {
      r = document.createRange(); r.selectNodeContents(t);
      sel.removeAllRanges(); sel.addRange(r);
    } else if (opts.point && t.textContent.trim()) {
      let ptRange = caretRangeAtPoint(opts.point.x, opts.point.y);
      if (ptRange && !t.contains(ptRange.startContainer)) ptRange = null;
      if (ptRange) {
        sel.removeAllRanges(); sel.addRange(ptRange);
        if (opts.selectWord) {
          const ok = selectWordAt(sel, ptRange, t);
          if (ok && sel.rangeCount) r = sel.getRangeAt(0);
        }
        if (!r && sel.rangeCount) r = sel.getRangeAt(0);
      }
    }
    if (!r) {
      r = document.createRange(); r.selectNodeContents(t);
      r.collapse(opts.atEnd === false);
      sel.removeAllRanges(); sel.addRange(r);
    }
    savedRange = (sel.rangeCount ? sel.getRangeAt(0) : r).cloneRange();
    const onSel = () => {
      const s = getSelection();
      if (s && s.rangeCount && editEl && editEl.contains(s.anchorNode)) {
        savedRange = s.getRangeAt(0).cloneRange();
        RPE.bus.emit('editsel');
      }
    };
    t.addEventListener('input', onInput); t.addEventListener('blur', onBlur); t.addEventListener('keydown', onEditKey); t.addEventListener('paste', onPaste);
    t.addEventListener('mouseup', onSel); t.addEventListener('keyup', onSel);
    renderSelection(); RPE.bus.emit('editsel');
  }
  function onInput(label) {
    if (inputMute) return;   // insertText() records its own single, labelled undo step
    const o = S.findObject(ui.editingId); if (!o || !editEl) return;
    editEl.classList.toggle('is-empty', !editEl.textContent.trim());
    if (RPE.renderer && RPE.renderer.updateParaStruts) RPE.renderer.updateParaStruts(editEl, o.fontSize || 18);
    if (RPE.renderer && RPE.renderer.updateParaMarkers) RPE.renderer.updateParaMarkers(editEl);
    const html = clean(editEl.innerHTML);
    if (label) S.mutate(label, () => { o.html = html; }, { hint: { skipCanvas: true } });
    else S.mutate('Edit text', () => { o.html = html; }, { coalesce: 'edit:' + o.id, window: 2500, hint: { skipCanvas: true } });
  }
  function onBlur(e) {
    if (editHold) return;   // symbol library open: clicks in the modal must never end the text edit
    const rt = e.relatedTarget;
    if (rt && rt.closest && rt.closest('.ribbon,.popover,.titlebar,.tabrow,.statusbar,.dlg')) return;
    if (!document.hasFocus()) return;
    stopEdit();
  }
  function onEditKey(e) {
    if (e.key === 'Escape' && editHold) return;   // Esc belongs to the open modal (it closes itself, the edit stays)
    if (e.key === 'Escape') {
      if (ui.painter) { e.preventDefault(); e.stopPropagation(); S.setUI({ painter: null }); return; }
      e.preventDefault(); e.stopPropagation(); stopEdit(); scroll.focus({ preventScroll: true });
    }
    else if (e.key === 'Tab') { const o = S.findObject(ui.editingId); if (o && o.list) { e.preventDefault(); RPE.commands.run(e.shiftKey ? 'para.outdent' : 'para.indent', {}, 'key'); } }
  }
  function onPaste(e) { e.preventDefault(); const t = (e.clipboardData || window.clipboardData).getData('text/plain'); document.execCommand('insertText', false, t); }
  function stopEdit() {
    if (!editEl) return;
    const t = editEl, id = ui.editingId; editEl = null; savedRange = null;
    t.contentEditable = 'false'; const host = t.closest('.obj'); if (host) host.classList.remove('is-editing');
    S.endCoalesce(); S.setUI({ editingId: null });
    const o = S.findObject(id);
    if (o) {
      if (RPE.renderer && RPE.renderer.updateParaStruts) RPE.renderer.updateParaStruts(t, o.fontSize || 18);
      if (RPE.renderer && RPE.renderer.updateParaMarkers) RPE.renderer.updateParaMarkers(t);
      const html = clean(t.innerHTML);
      if (isHF(id)) commitHF(id, html, o);
      else if (html !== o.html) S.mutate('Edit text', () => { o.html = html; }, { hint: { skipCanvas: true } });
      refreshObject(id);
    }
    if (isHF(id)) { S.endGroup(); S.select([]); }
    renderSelection(); RPE.bus.emit('editsel');
  }
  document.addEventListener('selectionchange', () => {
    if (!editEl) return;
    const s = getSelection();
    if (s.rangeCount && editEl.contains(s.anchorNode)) { savedRange = s.getRangeAt(0).cloneRange(); RPE.bus.emit('editsel'); }
  });
  function focusEdit() {
    if (!editEl) return;
    const s = getSelection();
    if (s && s.rangeCount && editEl.contains(s.anchorNode)) {
      savedRange = s.getRangeAt(0).cloneRange();
    }
    editEl.focus({ preventScroll: true });
    if (savedRange) { const cur = getSelection(); cur.removeAllRanges(); cur.addRange(savedRange); }
  }
  /* ---------- text insertion from outside the editable (symbol library) ----------
     holdEdit(true) keeps the active text edit alive while a modal has focus; caretState() says whether a symbol can go in right now;
     insertText() restores the preserved caret/range, inserts through the browser's own text engine (so the surrounding character
     formatting is inherited and a selected range is replaced) and records ONE labelled undo step. */
  function holdEdit(on) { editHold = Math.max(0, editHold + (on ? 1 : -1)); }
  function caretState() {
    const live = !!(editEl && editEl.isConnected && ui.editingId && S.findObject(ui.editingId));
    return live ? { ok: true, id: ui.editingId, collapsed: !hasRange() } : { ok: false, id: null, collapsed: true };
  }
  function insertText(text, label, opts) {
    if (!text || !caretState().ok) return false;
    focusEdit();
    let s = getSelection();
    if (!s.rangeCount || !editEl.contains(s.anchorNode)) {   // preserved range went stale: caret at the end of the box
      const r = document.createRange(); r.selectNodeContents(editEl); r.collapse(false); s.removeAllRanges(); s.addRange(r);
    }
    S.endCoalesce();   // an insert is its own undo step, never merged into the typing before it
    let ok = false;
    inputMute = true;
    try { document.execCommand('styleWithCSS', false, true); ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    inputMute = false;
    if (!ok) {   // engine refused (e.g. empty-block edge case): same effect by hand
      s = getSelection(); const r = s.getRangeAt(0); r.deleteContents();
      const tn = document.createTextNode(text); r.insertNode(tn); r.setStartAfter(tn); r.collapse(true); s.removeAllRanges(); s.addRange(r);
    }
    onInput(label || 'Insert symbol');
    S.endCoalesce();
    s = getSelection(); if (s.rangeCount && editEl.contains(s.anchorNode)) savedRange = s.getRangeAt(0).cloneRange();
    if (!(opts && opts.keepFocus === false)) editEl.focus({ preventScroll: true });
    RPE.bus.emit('editsel');
    return true;
  }
  const hasRange = () => {
    if (!editEl) return false;
    const s = getSelection();
    if (s && s.rangeCount && editEl.contains(s.anchorNode)) {
      savedRange = s.getRangeAt(0).cloneRange();
      return !s.isCollapsed;
    }
    return !!(savedRange && !savedRange.collapsed);
  };
  function char(cmd, val, label) {
    if (!editEl) return; focusEdit();
    if (cmd === 'subscript' || cmd === 'superscript') {
      document.execCommand('styleWithCSS', false, false);
    } else {
      document.execCommand('styleWithCSS', false, true);
    }
    let ok = false;
    if (cmd === 'hiliteColor') {
      try { ok = document.execCommand('hiliteColor', false, val === undefined ? null : val); } catch (e) { /* ignore */ }
      if (!ok) {
        try { ok = document.execCommand('backColor', false, val === undefined ? null : val); } catch (e) { /* ignore */ }
      }
    } else {
      try { ok = document.execCommand(cmd, false, val === undefined ? null : val); } catch (e) { /* ignore */ }
    }
    S.endCoalesce();
    onInput(label);
    S.endCoalesce();
    RPE.bus.emit('editsel');
  }
  function getCharOffset(root, node, offset) {
    const r = document.createRange();
    r.setStart(root, 0);
    r.setEnd(node, offset);
    return r.toString().length;
  }

  function restoreCharRange(root, start, end) {
    const range = document.createRange();
    let count = 0;
    let startNode = null, startOff = 0;
    let endNode = null, endOff = 0;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) nodes.push(n);

    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const len = node.nodeValue.length;
      const isLast = (i === nodes.length - 1);
      if (!startNode && (start < count + len || (start === count + len && isLast))) {
        startNode = node;
        startOff = start - count;
      }
      if (!endNode && (end <= count + len || isLast)) {
        endNode = node;
        endOff = Math.min(end - count, len);
      }
      count += len;
    }
    if (startNode && endNode) {
      range.setStart(startNode, startOff);
      range.setEnd(endNode, endOff);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      savedRange = range.cloneRange();
      return range;
    }
    return null;
  }

  function splitRangeBoundaries(range) {
    if (range.startContainer === range.endContainer && range.startContainer.nodeType === 3) {
      const node = range.startContainer;
      if (range.endOffset < node.data.length) node.splitText(range.endOffset);
      let targetNode = node;
      if (range.startOffset > 0) targetNode = node.splitText(range.startOffset);
      range.setStartBefore(targetNode);
      range.setEndAfter(targetNode);
    } else {
      if (range.endContainer.nodeType === 3 && range.endOffset > 0 && range.endOffset < range.endContainer.data.length) {
        range.endContainer.splitText(range.endOffset);
        range.setEndAfter(range.endContainer);
      }
      if (range.startContainer.nodeType === 3 && range.startOffset > 0 && range.startContainer.data.length && range.startOffset < range.startContainer.data.length) {
        const nextNode = range.startContainer.splitText(range.startOffset);
        range.setStartBefore(nextNode);
      }
    }
  }

  function cleanupSpans(root) {
    let changed = true;
    while (changed) {
      changed = false;
      root.querySelectorAll('span').forEach((sp) => {
        if (!sp.childNodes.length || (sp.childNodes.length === 1 && sp.firstChild.nodeType === 3 && sp.firstChild.nodeValue === '')) {
          sp.remove();
          changed = true;
        }
      });
      root.querySelectorAll('span').forEach((sp) => {
        if (!sp.getAttribute('style') && sp.attributes.length === 0) {
          while (sp.firstChild) sp.parentNode.insertBefore(sp.firstChild, sp);
          sp.remove();
          changed = true;
        }
      });
      root.querySelectorAll('span').forEach((sp) => {
        if (sp.childNodes.length === 1 && sp.firstElementChild && sp.firstElementChild.tagName === 'SPAN') {
          const inner = sp.firstElementChild;
          for (let i = 0; i < sp.style.length; i++) {
            const prop = sp.style[i];
            if (!inner.style.getPropertyValue(prop)) {
              inner.style.setProperty(prop, sp.style.getPropertyValue(prop));
            }
          }
          sp.replaceWith(inner);
          changed = true;
        }
      });
      root.querySelectorAll('span').forEach((sp) => {
        const next = sp.nextSibling;
        if (next && next.nodeType === 1 && next.tagName === 'SPAN') {
          if (sp.getAttribute('style') === next.getAttribute('style')) {
            while (next.firstChild) sp.appendChild(next.firstChild);
            next.remove();
            changed = true;
          }
        }
      });
    }
    root.normalize();
  }

  function styleRange(styleOrFn, label) {
    if (!editEl) return;
    focusEdit();
    const sel = getSelection();
    if (!sel || !sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (range.collapsed) return;

    const startOffset = getCharOffset(editEl, range.startContainer, range.startOffset);
    const endOffset = getCharOffset(editEl, range.endContainer, range.endOffset);
    if (startOffset >= endOffset) return;

    splitRangeBoundaries(range);

    const textNodes = [];
    const walker = document.createTreeWalker(editEl, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      if (!n.nodeValue.length) continue;
      if (range.intersectsNode(n)) textNodes.push(n);
    }

    if (!textNodes.length) return;

    for (const node of textNodes) {
      const parent = node.parentElement;
      const comp = getComputedStyle(parent);
      const curPt = Math.round(parseFloat(comp.fontSize) * 0.75 * 2) / 2;
      const styles = typeof styleOrFn === 'function' ? styleOrFn(node, { fontSizePt: curPt, computedStyle: comp }) : styleOrFn;
      if (!styles) continue;

      if (parent.tagName === 'SPAN' && parent.childNodes.length === 1) {
        for (const [k, v] of Object.entries(styles)) parent.style[k] = v;
      } else {
        const sp = document.createElement('span');
        for (const [k, v] of Object.entries(styles)) sp.style[k] = v;
        node.replaceWith(sp);
        sp.appendChild(node);
      }
    }

    cleanupSpans(editEl);
    const o = S.findObject(ui.editingId);
    if (RPE.renderer && RPE.renderer.updateParaStruts) {
      RPE.renderer.updateParaStruts(editEl, o ? o.fontSize : 18);
    }
    restoreCharRange(editEl, startOffset, endOffset);
    S.endCoalesce();
    onInput(label);
    S.endCoalesce();
    RPE.bus.emit('editsel');
  }

  function applyPainterToRange(props) {
    if (!editEl || !props) return;
    const styles = {};
    if (props.font) styles.fontFamily = RPE.themes ? RPE.themes.cssFont(props.font) : props.font;
    if (props.fontSize) styles.fontSize = props.fontSize + 'pt';
    if (props.bold !== undefined) styles.fontWeight = props.bold ? 'bold' : 'normal';
    if (props.italic !== undefined) styles.fontStyle = props.italic ? 'italic' : 'normal';
    if (props.underline !== undefined || props.strike !== undefined) {
      const u = props.underline, st = props.strike;
      if (u && st) styles.textDecoration = 'underline line-through';
      else if (u) styles.textDecoration = 'underline';
      else if (st) styles.textDecoration = 'line-through';
      else styles.textDecoration = 'none';
    }
    if (props.color) {
      const th = (RPE.themes && RPE.themes.theme) ? RPE.themes.theme(S.doc) : {};
      const m = { accent: th.accent, accent2: th.accent2, text: th.text, muted: th.muted, bg: th.bg };
      styles.color = m[props.color] || props.color;
    }
    if (props.highlight !== undefined) {
      styles.backgroundColor = props.highlight || '';
    }
    if (props.subscript !== undefined || props.superscript !== undefined) {
      if (props.subscript) styles.verticalAlign = 'sub';
      else if (props.superscript) styles.verticalAlign = 'super';
      else styles.verticalAlign = 'baseline';
    }
    styleRange(styles, 'Format Painter');
  }

  function captureCharFormat() {
    if (!editEl) return null;
    const s = getSelection();
    let r = (s && s.rangeCount && editEl.contains(s.anchorNode)) ? s.getRangeAt(0) : savedRange;
    if (!r) return null;

    let node = r.startContainer;
    if (node.nodeType === 3) {
      node = node.parentElement;
    } else if (node.nodeType === 1) {
      if (node.childNodes.length > 0 && r.startOffset < node.childNodes.length) {
        const ch = node.childNodes[r.startOffset];
        node = ch.nodeType === 3 ? ch.parentElement : ch;
      } else if (node.childNodes.length > 0 && r.startOffset > 0) {
        const ch = node.childNodes[r.startOffset - 1];
        node = ch.nodeType === 3 ? ch.parentElement : ch;
      }
    }
    if (!node || node.nodeType !== 1) node = editEl;

    const comp = window.getComputedStyle(node);

    const font = resolveNodeFont(node, editEl);

    const fontSize = Math.round(parseFloat(comp.fontSize) * 0.75 * 2) / 2;
    const bold = comp.fontWeight === 'bold' || parseInt(comp.fontWeight, 10) >= 600;
    const italic = comp.fontStyle === 'italic' || comp.fontStyle === 'oblique';

    const decor = comp.textDecorationLine || comp.textDecoration || '';
    const underline = decor.includes('underline');
    const strike = decor.includes('line-through');
    const color = comp.color;
    const sub = !!(node.closest && node.closest('sub')) || comp.verticalAlign === 'sub';
    const sup = !!(node.closest && node.closest('sup')) || comp.verticalAlign === 'super';

    let highlight = null;
    let cur = node;
    while (cur && cur !== editEl) {
      const bg = cur.style && cur.style.backgroundColor;
      if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
        highlight = bg;
        break;
      }
      const cbg = window.getComputedStyle(cur).backgroundColor;
      if (cbg && cbg !== 'transparent' && cbg !== 'rgba(0, 0, 0, 0)') {
        highlight = cbg;
        break;
      }
      cur = cur.parentElement;
    }

    const p = (node && node.closest ? node.closest('p, div, li') : null) || editEl;
    let align = 'left';
    if (p) {
      const pAlign = window.getComputedStyle(p).textAlign;
      align = pAlign.startsWith('justify') ? 'justify' : (pAlign || 'left');
    }

    return {
      isChar: true,
      isText: true,
      font,
      fontSize,
      bold,
      italic,
      underline,
      strike,
      subscript: sub,
      superscript: sup,
      color,
      highlight,
      align
    };
  }

  function normalizeFontName(str) {
    if (!str) return '';
    const primary = str.split(',')[0].replace(/['"]/g, '').trim();
    const fonts = (RPE.themes && RPE.themes.FONTS) || [];
    const exact = fonts.find((f) => f.name.toLowerCase() === primary.toLowerCase());
    if (exact) return exact.name;
    const match = fonts.find((f) => str.toLowerCase().includes(f.name.toLowerCase()));
    if (match) return match.name;
    return primary;
  }

  function resolveNodeFont(node, rootEl, o) {
    rootEl = rootEl || editEl;
    if (!node) return '';
    let el = node.nodeType === 1 ? node : node.parentElement;
    if (!el && rootEl) el = rootEl;

    let cur = el;
    while (cur && rootEl && cur !== rootEl.parentElement) {
      if (cur.style && cur.style.fontFamily) {
        const val = cur.style.fontFamily.trim().toLowerCase();
        if (val && val !== 'inherit' && val !== 'initial' && val !== 'unset') {
          const f = normalizeFontName(cur.style.fontFamily);
          if (f) return f;
        }
      }
      if (cur.getAttribute && cur.getAttribute('face')) {
        const f = normalizeFontName(cur.getAttribute('face'));
        if (f) return f;
      }
      if (cur === rootEl) break;
      cur = cur.parentElement;
    }

    if (typeof window !== 'undefined' && window.getComputedStyle && el) {
      try {
        const comp = window.getComputedStyle(el);
        if (comp && comp.fontFamily) {
          const f = normalizeFontName(comp.fontFamily);
          if (f) return f;
        }
      } catch (_) {}
    }

    o = o || (ui.editingId ? S.findObject(ui.editingId) : null);
    if (o && o.font) return o.font;
    const cx = (RPE.renderer && RPE.renderer.context) ? RPE.renderer.context(S.doc) : null;
    if (cx && o) return RPE.typography ? RPE.typography.roleStyle(cx.ty, o).font : (o.role === 'title' ? cx.ty.head : cx.ty.body);
    return o ? (o.font || '') : '';
  }

  function textNodeIntersectsRange(textNode, r) {
    if (!textNode || !textNode.nodeValue) return false;
    const len = textNode.nodeValue.length;
    if (len === 0) return false;

    if (r.intersectsNode && !r.intersectsNode(textNode)) return false;

    if (textNode === r.startContainer && textNode === r.endContainer && r.startOffset >= r.endOffset) return false;
    if (textNode === r.startContainer && r.startOffset >= len) return false;
    if (textNode === r.endContainer && r.endOffset <= 0) return false;

    return true;
  }

  function currentFont() {
    if (!editEl) return '';
    const s = typeof getSelection === 'function' ? getSelection() : null;
    let r = (s && s.rangeCount && editEl.contains(s.anchorNode)) ? s.getRangeAt(0) : savedRange;
    if (!r) return resolveNodeFont(editEl, editEl);

    if (r.collapsed) {
      let node = r.startContainer;
      if (node.nodeType === 3) {
        node = node.parentElement;
      } else if (node.nodeType === 1) {
        if (node.childNodes.length > 0 && r.startOffset < node.childNodes.length) {
          const ch = node.childNodes[r.startOffset];
          node = ch.nodeType === 3 ? ch.parentElement : ch;
        } else if (node.childNodes.length > 0 && r.startOffset > 0) {
          const ch = node.childNodes[r.startOffset - 1];
          node = ch.nodeType === 3 ? ch.parentElement : ch;
        }
      }
      if (!node || node.nodeType !== 1) node = editEl;
      return resolveNodeFont(node, editEl);
    }

    const walker = document.createTreeWalker(editEl, NodeFilter.SHOW_TEXT);
    const allSelectedNodes = [];
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (textNodeIntersectsRange(textNode, r)) {
        allSelectedNodes.push(textNode);
      }
    }

    if (!allSelectedNodes.length) {
      return resolveNodeFont(r.startContainer, editEl);
    }

    const meaningfulNodes = allSelectedNodes.filter((n) => n.nodeValue && n.nodeValue.trim().length > 0);
    const nodesToCheck = meaningfulNodes.length > 0 ? meaningfulNodes : allSelectedNodes;

    const fonts = new Set();
    for (const n of nodesToCheck) {
      const f = resolveNodeFont(n, editEl);
      if (f) fonts.add(f);
      if (fonts.size > 1) return '';
    }

    if (fonts.size === 1) return Array.from(fonts)[0];
    if (fonts.size > 1) return '';
    return resolveNodeFont(r.startContainer, editEl);
  }

  function objectFont(o) {
    if (!o) return '';
    const cx = (RPE.renderer && RPE.renderer.context) ? RPE.renderer.context(S.doc) : null;
    const defaultFont = o.font || (cx && RPE.typography ? RPE.typography.roleStyle(cx.ty, o).font : (o.role === 'title' ? (cx ? cx.ty.head : 'Outfit') : (cx ? cx.ty.body : 'Outfit')));

    const el = objEl(o.id);
    const textEl = el ? el.querySelector('.obj__text') : null;
    if (!textEl) return defaultFont;

    const walker = document.createTreeWalker(textEl, NodeFilter.SHOW_TEXT);
    const fonts = new Set();
    let textNode;
    while ((textNode = walker.nextNode())) {
      if (!textNode.nodeValue || !textNode.nodeValue.trim()) continue;
      const f = resolveNodeFont(textNode, textEl, o);
      if (f) fonts.add(f);
      if (fonts.size > 1) return '';
    }
    if (fonts.size === 1) return Array.from(fonts)[0];
    if (fonts.size > 1) return '';
    return defaultFont;
  }

  function charSize(pt) {
    if (!editEl) return;
    styleRange({ fontSize: pt + 'pt' });
  }
  function currentSize() {
    if (!savedRange) return 18;
    let n = savedRange.startContainer; if (n.nodeType === 3) n = n.parentElement;
    return Math.round(parseFloat(getComputedStyle(n).fontSize) * 0.75 * 2) / 2;
  }

  function editCell(td) {
    const tbl = td.closest('.obj'), o = S.findObject(tbl.dataset.id); if (!o) return;
    stopEdit(); S.select([o.id]); cellEl = td;
    const rr = +td.dataset.r, cc = +td.dataset.c;
    S.setUI({ cellSel: RPE.tables.range.make(o.id, { r: rr, c: cc }, { r: rr, c: cc }, o.cells.length, o.cells[0].length) });
    td.contentEditable = 'true'; td.focus({ preventScroll: true });
    const r = document.createRange(); r.selectNodeContents(td); const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    const done = () => {
      td.contentEditable = 'false';
      cellEl = null;
      const v = td.textContent;
      if (o.cells[rr] && o.cells[rr][cc] !== v) {
        S.mutate('Edit cell', () => {
          o.cells[rr][cc] = v;
          if (RPE.commands && RPE.commands.syncTableRows) RPE.commands.syncTableRows(o);
        }, { hint: { objects: [o.id] } });
      }
    };
    td.addEventListener('blur', done, { once: true });
    td.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); td.blur(); }
      else if (e.key === 'Tab') {
        e.preventDefault();
        const all = [].slice.call(tbl.querySelectorAll('th,td'));
        const nx = all[(all.indexOf(td) + (e.shiftKey ? -1 : 1) + all.length) % all.length];
        td.blur();
        editCell(nx);
      }
    });
  }

  /* ---------- pointer interaction ---------- */
  const toSlide = (e) => { const r = frame.getBoundingClientRect(); return { x: (e.clientX - r.left) / scale, y: (e.clientY - r.top) / scale }; };

  function onPointerDown(e) {
    if (e.button !== 0 || ui.view !== 'normal') return;
    dragMoved = false;
    S.discardSelectionRestore();   // any new gesture drops the pending Undo-selection snapshot (the blank-area branch re-creates it)

    // ---- crop mode: intercept ALL clicks while cropping ----
    if (cropState) {
      const ch = e.target.closest('[data-crop="1"]');
      if (ch) { onCropHandleDown(e, ch.dataset.dir); return; }
      /* click inside the image object stays in crop mode */
      const el = e.target.closest('.obj');
      if (el && el.dataset.id === cropState.id) { e.preventDefault(); return; }
      /* click outside commits the crop */
      commitCrop(); e.preventDefault(); return;
    }

    // ---- draw-to-create mode ----
    if (drawShapeKind) {
      if (editEl) stopEdit();
      S.select([]);
      const p = toSlide(e);
      gesture = { type: 'draw', kind: drawShapeKind, x0: p.x, y0: p.y, box: null };
      attach(); e.preventDefault();
      return;
    }

    const tblHandle = e.target.closest('.tbl-handle');
    if (tblHandle) { startRangeDrag(e, tblHandle); e.preventDefault(); return; }

    const handle = e.target.closest('.handle');
    if (handle) {
      if (handle.dataset.dir === 'adj') { startAdjust(e); e.preventDefault(); return; }
      startResize(handle.dataset.dir, e); e.preventDefault(); return;
    }

    // ---- painter mode: drag-to-select like MS Word ----
    if (ui.painter) {
      const el = e.target.closest('.obj');
      if (el && slideEl && slideEl.contains(el)) {
        const id = el.dataset.id;
        const o = S.findObject(id);
        if (o && (o.type === 'text' || o.type === 'shape')) {
          // Enter edit mode at the click point so the user can drag-select;
          // the global onPointerUp will apply the format to the resulting range.
          if (ui.editingId !== id) {
            startEdit(id, { point: { x: e.clientX, y: e.clientY } });
          } else {
            // Already editing this box — just position caret at the click point.
            let r = caretRangeAtPoint(e.clientX, e.clientY);
            if (!r || !editEl.contains(r.startContainer)) {
              r = document.createRange();
              r.selectNodeContents(editEl);
              r.collapse(true);
            }
            const s = getSelection();
            s.removeAllRanges();
            s.addRange(r);
            savedRange = r.cloneRange();
          }
          // Don't preventDefault so the browser can handle native drag-select.
          return;
        }
      }
      // Clicked on a non-text object or blank area — cancel painter.
      S.setUI({ painter: null });
      return;
    }

    if (editEl && editEl.contains(e.target)) return;
    if (cellEl && cellEl.contains(e.target)) return;
    if (editEl && isHF(ui.editingId) && e.target.closest('.hf') && e.target.closest('.hf').dataset.id === ui.editingId) {
      editEl.focus({ preventScroll: true }); e.preventDefault(); return;   // padding of the region being edited: keep editing
    }
    const el = e.target.closest('.obj');
    if (el && slideEl && slideEl.contains(el)) {
      const id = el.dataset.id;
      if (editEl && id === ui.editingId) {
        let r = caretRangeAtPoint(e.clientX, e.clientY);
        if (!r || !editEl.contains(r.startContainer)) {
          r = document.createRange();
          r.selectNodeContents(editEl);
          const rect = editEl.getBoundingClientRect();
          r.collapse(e.clientY <= rect.top);
        }
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        savedRange = r.cloneRange();
        editEl.focus({ preventScroll: true });
        RPE.bus.emit('editsel');
        e.preventDefault();
        return;
      }
      if (editEl) stopEdit();
      if (e.shiftKey || e.ctrlKey || e.metaKey) S.select(ui.selectedIds.includes(id) ? ui.selectedIds.filter((x) => x !== id) : ui.selectedIds.concat(id));
      else if (!ui.selectedIds.includes(id)) S.select([id]);
      scroll.focus({ preventScroll: true });

      const td = e.target.closest('td,th');
      const o0 = S.findObject(id);
      if (td && o0 && el.dataset.type === 'table' && o0.cells && o0.cells.length) {
        const r = +td.dataset.r, c = +td.dataset.c;
        const RG = RPE.tables.range, nr = o0.cells.length, nc = o0.cells[0] ? o0.cells[0].length : 0;
        if (e.shiftKey && ui.cellSel && ui.cellSel.id === id) S.setUI({ cellSel: RG.make(id, RG.anchorOf(ui.cellSel), { r, c }, nr, nc) });
        else S.setUI({ cellSel: RG.make(id, { r, c }, { r, c }, nr, nc) });
      } else {
        if (ui.cellSel) S.setUI({ cellSel: null });
      }

      if (e.target.closest('td,th') && ui.selectedIds.length === 1 && e.detail > 1) return;
      startMove(e); e.preventDefault(); return;
    }
    /* blank area: clear selection, begin marquee */
    if (editEl) stopEdit();
    if (ui.cellSel) S.setUI({ cellSel: null });
    scroll.focus({ preventScroll: true });
    if (!(e.shiftKey)) S.clearSelectionByCanvasClick();
    const p = toSlide(e);
    gesture = { type: 'marquee', x0: p.x, y0: p.y, base: e.shiftKey ? ui.selectedIds.slice() : [], box: null };
    attach(); e.preventDefault();
  }
  /* ---------- table range handle: drag = rectangular range (pointer capture on the stable #slideFrame) ---------- */
  function cellAtPoint(tbl, x, y) {
    const colEl = [].slice.call(tbl.querySelectorAll('[data-r="0"]')).sort((a, b) => a.dataset.c - b.dataset.c);
    const rowEl = [].slice.call(tbl.querySelectorAll('[data-c="0"]')).sort((a, b) => a.dataset.r - b.dataset.r);
    if (!colEl.length || !rowEl.length) return null;
    const ce = colEl.map((n) => n.getBoundingClientRect().left); ce.push(colEl[colEl.length - 1].getBoundingClientRect().right);
    const re = rowEl.map((n) => n.getBoundingClientRect().top); re.push(rowEl[rowEl.length - 1].getBoundingClientRect().bottom);
    return RPE.tables.range.cellAt(x, y, ce, re);
  }
  function startRangeDrag(e, hd) {
    const o = S.findObject(hd.dataset.for); if (!o || !o.cells || !o.cells.length) return;
    if (cellEl) cellEl.blur();
    const RG = RPE.tables.range, nr = o.cells.length, nc = o.cells[0].length;
    const tbl = slideEl.querySelector(`[data-id="${o.id}"] table`); if (!tbl) return;
    const pid = e.pointerId, x0 = e.clientX, y0 = e.clientY; let moved = false, last = '';
    try { frame.setPointerCapture(pid); } catch (err) { /* synthetic events: window listeners below still cover it */ }
    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      if (!moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) < 3) return;
      moved = true;
      const cell = cellAtPoint(tbl, ev.clientX, ev.clientY); if (!cell) return;
      const sel = RG.make(o.id, { r: 0, c: 0 }, cell, nr, nc), key = [sel.r1, sel.c1, sel.r2, sel.c2].join();
      if (key !== last) { last = key; S.setUI({ cellSel: sel }); }
    };
    const end = (ev) => {
      if (ev && ev.pointerId !== undefined && ev.pointerId !== pid) return;
      frame.removeEventListener('pointermove', move); frame.removeEventListener('pointerup', end);
      frame.removeEventListener('pointercancel', end); frame.removeEventListener('lostpointercapture', end);
      window.removeEventListener('pointerup', end);
      try { frame.releasePointerCapture(pid); } catch (err) { /* already released */ }
      if (!moved && ui.cellSel) S.setUI({ cellSel: null });   // plain click: whole-table scope (same as no cell selected)
      scroll.focus({ preventScroll: true });
    };
    frame.addEventListener('pointermove', move); frame.addEventListener('pointerup', end);
    frame.addEventListener('pointercancel', end); frame.addEventListener('lostpointercapture', end);
    window.addEventListener('pointerup', end);
    if (!ui.selectedIds.includes(o.id)) S.select([o.id]);
  }

  function startMove(e) {
    const list = S.selectedObjects(), orig = {};
    list.forEach((o) => {
      const isLine = RPE.shapes && RPE.shapes.isLine(o);
      const lg = isLine ? RPE.shapes.lineGeometry(o) : null;
      orig[o.id] = {
        x: o.x, y: o.y, w: o.w, h: o.h,
        x1: lg ? lg.x1 : o.x1,
        y1: lg ? lg.y1 : o.y1,
        x2: lg ? lg.x2 : o.x2,
        y2: lg ? lg.y2 : o.y2
      };
    });
    gesture = { type: 'move', sx: e.clientX, sy: e.clientY, ids: list.map((o) => o.id), orig, moved: false, alt: e.altKey }; attach();
  }
  function startAdjust(e) {
    const o = S.selectedObjects()[0]; if (!o || o.type !== 'shape') return;
    const handle = e.target.closest('.handle--adj');
    if (handle) {
      handle.classList.add('is-dragging');
      handle.style.cursor = 'grabbing';
      if (e.pointerId != null && handle.setPointerCapture) {
        try { handle.setPointerCapture(e.pointerId); } catch (err) {}
      }
    }
    gesture = {
      type: 'adjust',
      id: o.id,
      handleEl: handle,
      pointerId: e.pointerId,
      sx: e.clientX,
      sy: e.clientY,
      startAdj: o.adj != null ? o.adj : 0.5,
      shape: o.shape,
      ox: o.x,
      oy: o.y,
      ow: o.w,
      oh: o.h,
      latestAdj: o.adj != null ? o.adj : 0.5,
    };
    attach();
  }
  function startResize(dir, e) {
    const o = S.selectedObjects()[0]; if (!o) return;
    const isLine = RPE.shapes && RPE.shapes.isLine(o);
    const lg = isLine ? RPE.shapes.lineGeometry(o) : null;
    const ratio = (o.h && !isNaN(o.w / o.h)) ? (o.w / o.h) : 1;
    gesture = {
      type: 'resize', dir, id: o.id, sx: e.clientX, sy: e.clientY,
      start: {
        x: o.x, y: o.y, w: o.w, h: o.h,
        x1: lg ? lg.x1 : o.x1,
        y1: lg ? lg.y1 : o.y1,
        x2: lg ? lg.x2 : o.x2,
        y2: lg ? lg.y2 : o.y2
      },
      ratio,
      keep: e.shiftKey || (['image', 'plot', 'figure'].includes(o.type) && dir.length === 2 && !e.altKey),
      alt: e.altKey
    };
    attach();
  }
  const attach = () => { window.addEventListener('pointermove', onMove); window.addEventListener('pointerup', onUp, { once: true }); window.addEventListener('pointercancel', onUp, { once: true }); };
  function renderSmartLines(lines) {
    if (!selLayer) return;
    lines.forEach((l) => { const d = document.createElement('div'); d.className = 'smart smart--' + l.axis; d.style[l.axis === 'v' ? 'left' : 'top'] = (l.pos * scale) + 'px'; selLayer.appendChild(d); });
  }
  function showSmart(lines) {
    if (gesture) gesture.smartLines = lines && lines.length ? lines.slice() : null;
    if (!selLayer) return;
    selLayer.querySelectorAll('.smart').forEach((n) => n.remove());
    if (lines && lines.length) renderSmartLines(lines);
  }
  function onMove(e) {
    const g = gesture; if (!g) return;
    if (g.type === 'move') {
      let dx = (e.clientX - g.sx) / scale, dy = (e.clientY - g.sy) / scale;
      if (!g.moved && Math.hypot(dx, dy) * scale < 3) return; g.moved = true; dragMoved = true;
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      const d = S.doc.size, lines = [];
      const snapActive = (ui.snapEnabled !== false) && !e.altKey;

      if (g.ids.length === 1 && snapActive) {
        const p = g.orig[g.ids[0]];
        const tol = 8; // logical units tolerance
        let nx = p.x + dx, ny = p.y + dy;

        // Targets in X: slide edges/center + all other objects' edges/center
        const otherObjs = (S.activeSlide().objects || []).filter((o) => !g.ids.includes(o.id));
        const targetsX = [0, d.w / 2, d.w];
        const targetsY = [0, d.h / 2, d.h];

        otherObjs.forEach((o) => {
          targetsX.push(o.x, o.x + o.w / 2, o.x + o.w);
          targetsY.push(o.y, o.y + o.h / 2, o.y + o.h);
        });

        // Horizontal snap (X)
        let bestDistX = tol + 1, bestAdjX = 0, bestLineX = null;
        [0, p.w / 2, p.w].forEach((anchorOffset) => {
          const anchorPos = nx + anchorOffset;
          targetsX.forEach((targetPos) => {
            const dist = Math.abs(anchorPos - targetPos);
            if (dist < bestDistX) {
              bestDistX = dist;
              bestAdjX = targetPos - anchorPos;
              bestLineX = targetPos;
            }
          });
        });

        if (bestDistX <= tol) {
          dx += bestAdjX;
          lines.push({ axis: 'v', pos: bestLineX });
        } else if (ui.snapToGrid) {
          const gridSnapX = Math.round((p.x + dx) / GRID) * GRID;
          if (Math.abs((p.x + dx) - gridSnapX) <= tol) dx = gridSnapX - p.x;
        }

        // Vertical snap (Y)
        let bestDistY = tol + 1, bestAdjY = 0, bestLineY = null;
        [0, p.h / 2, p.h].forEach((anchorOffset) => {
          const anchorPos = ny + anchorOffset;
          targetsY.forEach((targetPos) => {
            const dist = Math.abs(anchorPos - targetPos);
            if (dist < bestDistY) {
              bestDistY = dist;
              bestAdjY = targetPos - anchorPos;
              bestLineY = targetPos;
            }
          });
        });

        if (bestDistY <= tol) {
          dy += bestAdjY;
          lines.push({ axis: 'h', pos: bestLineY });
        } else if (ui.snapToGrid) {
          const gridSnapY = Math.round((p.y + dy) / GRID) * GRID;
          if (Math.abs((p.y + dy) - gridSnapY) <= tol) dy = gridSnapY - p.y;
        }
      }
      showSmart(lines);
      S.mutate('Move', () => g.ids.forEach((id) => {
        const o = S.findObject(id), p = g.orig[id];
        o.x = Math.round(p.x + dx);
        o.y = Math.round(p.y + dy);
        if (p.x1 != null && p.y1 != null && p.x2 != null && p.y2 != null) {
          o.x1 = Math.round(p.x1 + dx);
          o.y1 = Math.round(p.y1 + dy);
          o.x2 = Math.round(p.x2 + dx);
          o.y2 = Math.round(p.y2 + dy);
        }
      }), { coalesce: 'drag', window: 1e6, hint: { objects: g.ids, geom: true } });
    } else if (g.type === 'resize') {
      const o = S.findObject(g.id);
      if (!o) return;
      const isLine = RPE.shapes && RPE.shapes.isLine(o);
      if (isLine && (g.dir === 'line-p1' || g.dir === 'line-p2')) {
        let dx = (e.clientX - g.sx) / scale, dy = (e.clientY - g.sy) / scale;
        let x1 = g.start.x1, y1 = g.start.y1, x2 = g.start.x2, y2 = g.start.y2;
        if (g.dir === 'line-p1') {
          x1 = g.start.x1 + dx;
          y1 = g.start.y1 + dy;
          if (e.shiftKey && RPE.shapes.snapAngle) {
            const sn = RPE.shapes.snapAngle(x2, y2, x1, y1);
            x1 = sn.x; y1 = sn.y;
          }
        } else {
          x2 = g.start.x2 + dx;
          y2 = g.start.y2 + dy;
          if (e.shiftKey && RPE.shapes.snapAngle) {
            const sn = RPE.shapes.snapAngle(x1, y1, x2, y2);
            x2 = sn.x; y2 = sn.y;
          }
        }
        const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
        const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        S.mutate('Resize line', () => {
          const target = S.findObject(g.id);
          target.x1 = Math.round(x1);
          target.y1 = Math.round(y1);
          target.x2 = Math.round(x2);
          target.y2 = Math.round(y2);
          target.x = Math.round(minX);
          target.y = Math.round(minY);
          target.w = Math.round(w);
          target.h = Math.round(h);
        }, { coalesce: 'resize', window: 1e6, hint: { objects: [g.id], geom: true } });
        return;
      }

      const dx = (e.clientX - g.sx) / scale, dy = (e.clientY - g.sy) / scale, s = g.start;
      let { x, y, w, h } = s;
      const d = S.doc.size, lines = [];
      const snapActive = (ui.snapEnabled !== false) && !e.altKey;
      const tol = 8;

      if (g.dir.includes('e')) w = s.w + dx;
      if (g.dir.includes('s')) h = s.h + dy;
      if (g.dir.includes('w')) { w = s.w - dx; x = s.x + dx; }
      if (g.dir.includes('n')) { h = s.h - dy; y = s.y + dy; }

      if (snapActive) {
        const otherObjs = (S.activeSlide().objects || []).filter((o) => o.id !== g.id);
        const targetsX = [0, d.w / 2, d.w];
        const targetsY = [0, d.h / 2, d.h];
        otherObjs.forEach((o) => {
          targetsX.push(o.x, o.x + o.w / 2, o.x + o.w);
          targetsY.push(o.y, o.y + o.h / 2, o.y + o.h);
        });

        if (g.dir.includes('e')) {
          let bDist = tol + 1, bTarget = null;
          targetsX.forEach((t) => { const dist = Math.abs((x + w) - t); if (dist < bDist) { bDist = dist; bTarget = t; } });
          if (bDist <= tol) { w = bTarget - x; lines.push({ axis: 'v', pos: bTarget }); }
        } else if (g.dir.includes('w')) {
          let bDist = tol + 1, bTarget = null;
          targetsX.forEach((t) => { const dist = Math.abs(x - t); if (dist < bDist) { bDist = dist; bTarget = t; } });
          if (bDist <= tol) { const diff = bTarget - x; x = bTarget; w -= diff; lines.push({ axis: 'v', pos: bTarget }); }
        }

        if (g.dir.includes('s')) {
          let bDist = tol + 1, bTarget = null;
          targetsY.forEach((t) => { const dist = Math.abs((y + h) - t); if (dist < bDist) { bDist = dist; bTarget = t; } });
          if (bDist <= tol) { h = bTarget - y; lines.push({ axis: 'h', pos: bTarget }); }
        } else if (g.dir.includes('n')) {
          let bDist = tol + 1, bTarget = null;
          targetsY.forEach((t) => { const dist = Math.abs(y - t); if (dist < bDist) { bDist = dist; bTarget = t; } });
          if (bDist <= tol) { const diff = bTarget - y; y = bTarget; h -= diff; lines.push({ axis: 'h', pos: bTarget }); }
        }
      }

      if (g.keep && g.dir.length === 2) {
        w = Math.max(24, w); h = w / g.ratio;
        if (g.dir.includes('n')) y = s.y + s.h - h;
        if (g.dir.includes('w')) x = s.x + s.w - w;
      }
      if (isLine) {
        w = Math.max(0, w);
        h = Math.max(0, h);
      } else {
        if (w < 12) { if (g.dir.includes('w')) x -= 12 - w; w = 12; }
        if (h < 12) { if (g.dir.includes('n')) y -= 12 - h; h = 12; }
      }

      showSmart(lines);
      S.mutate('Resize', () => {
        const obj = S.findObject(g.id);
        obj.x = Math.round(x);
        obj.y = Math.round(y);
        obj.w = Math.round(w);
        obj.h = Math.round(h);
        if (isLine) {
          const sx = s.w > 0 ? (w / s.w) : 1;
          const sy = s.h > 0 ? (h / s.h) : 1;
          if (s.x1 != null) {
            obj.x1 = Math.round(x + (s.x1 - s.x) * sx);
            obj.y1 = Math.round(y + (s.y1 - s.y) * sy);
            obj.x2 = Math.round(x + (s.x2 - s.x) * sx);
            obj.y2 = Math.round(y + (s.y2 - s.y) * sy);
          } else {
            obj.x1 = Math.round(x);
            obj.y1 = Math.round(y + h / 2);
            obj.x2 = Math.round(x + w);
            obj.y2 = Math.round(y + h / 2);
          }
        }
      }, { coalesce: 'resize', window: 1e6, hint: { objects: [g.id] } });
    } else if (g.type === 'marquee') {
      const p = toSlide(e), l = Math.min(g.x0, p.x), t = Math.min(g.y0, p.y), w = Math.abs(p.x - g.x0), h = Math.abs(p.y - g.y0);
      if (!g.box) { if (w + h < 4) return; S.discardSelectionRestore(); g.box = document.createElement('div'); g.box.className = 'marquee'; selLayer.appendChild(g.box); }
      place(g.box, { x: l, y: t, w, h });
      const hit = S.activeSlide().objects.filter((o) => o.x < l + w && o.x + o.w > l && o.y < t + h && o.y + o.h > t).map((o) => o.id);
      S.select(Array.from(new Set(g.base.concat(hit))));
    } else if (g.type === 'draw') {
      const p = toSlide(e);
      if (g.kind === 'line') {
        let x1 = g.x0, y1 = g.y0;
        let x2 = p.x, y2 = p.y;
        if (e.shiftKey && RPE.shapes && RPE.shapes.snapAngle) {
          const sn = RPE.shapes.snapAngle(x1, y1, x2, y2);
          x2 = sn.x; y2 = sn.y;
        }
        const minX = Math.min(x1, x2), minY = Math.min(y1, y2);
        const w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
        g.linePts = { x1, y1, x2, y2 };
        g.cur = { x: Math.round(minX), y: Math.round(minY), w: Math.round(w), h: Math.round(h) };

        if (!g.ghostEl && slideEl) {
          const dummy = RPE.shapes.createLine(x1, y1, x2, y2, { id: '__draw_ghost__', stroke: 'accent', strokeWidth: 3 });
          const cx = R.context(S.doc);
          g.ghostEl = R.objectEl(dummy, cx, { mode: 'edit' });
          g.ghostEl.classList.add('obj--ghost');
          slideEl.appendChild(g.ghostEl);
        } else if (g.ghostEl) {
          const dummy = { x: Math.round(minX), y: Math.round(minY), w: Math.round(w), h: Math.round(h), x1, y1, x2, y2, shape: 'line' };
          R.setGeom(g.ghostEl, dummy);
        }
        return;
      }
      let l = Math.min(g.x0, p.x), t = Math.min(g.y0, p.y);
      let w = Math.max(4, Math.abs(p.x - g.x0)), h = Math.max(4, Math.abs(p.y - g.y0));
      if (e.shiftKey) {
        const side = Math.max(w, h);
        if (p.x < g.x0) l = g.x0 - side;
        if (p.y < g.y0) t = g.y0 - side;
        w = side;
        h = side;
      }
      g.cur = { x: Math.round(l), y: Math.round(t), w: Math.round(w), h: Math.round(h) };

      if (!g.box && (w + h >= 6)) {
        g.box = document.createElement('div');
        g.box.className = 'marquee marquee--draw';
        selLayer.appendChild(g.box);
      }
      if (g.box) {
        place(g.box, { x: l, y: t, w, h });
      }

      // Real-time ghost of the final shape (shapes only, no ghost for text)
      if (w + h >= 6 && g.kind !== 'text') {
        if (!g.ghostEl && slideEl) {
          const strokeOnly = ['line', 'brace', 'scalebar'].includes(g.kind);
          const dummy = {
            id: '__draw_ghost__',
            type: 'shape',
            shape: g.kind,
            x: Math.round(l), y: Math.round(t), w: Math.round(w), h: Math.round(h),
            fill: strokeOnly ? null : 'accent',
            stroke: 'accent',
            strokeWidth: strokeOnly ? 3 : 2,
            color: strokeOnly ? null : '#FFFFFF',
            lineHeight: 1.2,
            align: 'center',
            vAlign: 'middle',
            adj: 0.5
          };
          const cx = R.context(S.doc);
          g.ghostEl = R.objectEl(dummy, cx, { mode: 'edit' });
          g.ghostEl.classList.add('obj--ghost');
          slideEl.appendChild(g.ghostEl);
        } else if (g.ghostEl) {
          R.setGeom(g.ghostEl, { x: Math.round(l), y: Math.round(t), w: Math.round(w), h: Math.round(h) });
        }
      }
    } else if (g.type === 'adjust') {
      const o = S.findObject(g.id); if (!o) return;
      const p = toSlide(e);
      const frame = { x: g.ox, y: g.oy, w: g.ow, h: g.oh };
      const rawAdj = RPE.shapes.fromPointer(g.shape, g.startAdj, p, frame);
      const newAdj = Math.round(rawAdj * 200) / 200; // snap to 0.005 increments
      o.adj = newAdj;
      g.latestAdj = newAdj;

      // Update shape path in DOM
      const shapeEl = objEl(g.id);
      if (shapeEl) {
        let pathEl = shapeEl.querySelector('.shape-gfx svg path');
        if (!pathEl || !pathEl.isConnected) {
          const oldGfx = shapeEl.querySelector('.shape-gfx');
          if (oldGfx) {
            const cx = R.context(S.doc);
            oldGfx.replaceWith(R.shapeGfx(o, cx));
            pathEl = shapeEl.querySelector('.shape-gfx svg path');
          }
        }
        if (pathEl) {
          pathEl.setAttribute('d', RPE.shapes.toD(RPE.shapes.commands(g.shape, newAdj), g.ow, g.oh));
        }
      }

      // Live-move the diamond handle to track the apex
      let ah = g.handleEl;
      if (!ah || !ah.isConnected) {
        ah = selLayer.querySelector('.handle--adj');
        g.handleEl = ah;
      }
      if (ah) {
        const h = RPE.shapes.handle(g.shape, newAdj);
        ah.style.left = (g.ow * (h[0] / 1000) * scale) + 'px';
        ah.style.top  = (g.oh * (h[1] / 1000) * scale) + 'px';
      }
    }
  }

  function onUp() {
    window.removeEventListener('pointermove', onMove);
    const g = gesture; gesture = null; S.endCoalesce();
    selLayer.querySelectorAll('.smart,.marquee').forEach((n) => n.remove());
    if (g && g.type === 'move' && g.moved) { dragMoved = true; setTimeout(() => { dragMoved = false; }, 200); renderSelection(); }
    if (g && g.type === 'draw') {
      if (g.ghostEl) {
        g.ghostEl.remove();
        g.ghostEl = null;
      }
      const kind = g.kind;
      drawShapeKind = null;
      frame.classList.remove('drawing');
      const w = g.cur ? g.cur.w : 0;
      const h = g.cur ? g.cur.h : 0;
      if (kind === 'line') {
        const pts = g.linePts;
        const dist = pts ? Math.hypot(pts.x2 - pts.x1, pts.y2 - pts.y1) : 0;
        let o = null;
        if (pts && dist >= 3) {
          o = RPE.shapes.createLine(pts.x1, pts.y1, pts.x2, pts.y2);
        } else if (g.x0 != null && g.y0 != null) {
          const defW = (RPE.commands && RPE.commands.SHAPE_DIMS && RPE.commands.SHAPE_DIMS.line && RPE.commands.SHAPE_DIMS.line[0]) || 260;
          o = RPE.shapes.createLine(g.x0 - defW / 2, g.y0, g.x0 + defW / 2, g.y0);
        }
        if (o) {
          const slide = S.activeSlide();
          S.mutate('Insert line', () => { slide.objects.push(o); });
          S.select([o.id]);
        }
      } else if (kind === 'text') {
        const d = S.doc.size;
        let o = null;
        if (w > 8 && h > 8) {
          let x1 = clamp(g.cur.x, 0, d.w);
          let y1 = clamp(g.cur.y, 0, d.h);
          let x2 = clamp(g.cur.x + g.cur.w, 0, d.w);
          let y2 = clamp(g.cur.y + g.cur.h, 0, d.h);
          let bx = Math.min(x1, x2);
          let by = Math.min(y1, y2);
          let bw = Math.max(x1, x2) - bx;
          let bh = Math.max(y1, y2) - by;
          const minH = 36;
          bh = Math.max(bh, minH);
          if (by + bh > d.h) {
            by = Math.max(0, d.h - bh);
            if (by + bh > d.h) bh = d.h - by;
          }
          o = {
            id: S.uid('o'),
            type: 'text',
            role: 'text',
            x: Math.round(bx),
            y: Math.round(by),
            w: Math.round(bw),
            h: Math.round(bh),
            html: '',
            fontSize: 24,
            align: 'left',
            lineHeight: 1.2,
            vAlign: 'top',
            stroke: null
          };
        } else if (g.x0 != null && g.y0 != null) {
          const defW = 420, defH = 64;
          let bx = clamp(Math.round(g.x0), 0, Math.max(0, d.w - defW));
          let by = clamp(Math.round(g.y0), 0, Math.max(0, d.h - defH));
          o = {
            id: S.uid('o'),
            type: 'text',
            role: 'text',
            x: bx,
            y: by,
            w: defW,
            h: defH,
            html: '',
            fontSize: 24,
            align: 'left',
            lineHeight: 1.2,
            vAlign: 'top',
            stroke: null
          };
        }
        if (o) {
          const slide = S.activeSlide();
          S.mutate('Insert text box', () => { slide.objects.push(o); });
          S.select([o.id]);
          const edit = () => {
            const cur = S.findObject(o.id);
            if (cur && ui.selectedIds.includes(o.id)) {
              if (ui.editingId !== o.id || !editEl) {
                startEdit(o.id, { selectAll: true });
              } else if (document.activeElement !== editEl) {
                editEl.focus({ preventScroll: true });
              }
            }
          };
          edit();
          const onceClick = () => {
            window.removeEventListener('click', onceClick, true);
            edit();
          };
          window.addEventListener('click', onceClick, true);
          requestAnimationFrame(edit);
          setTimeout(() => {
            window.removeEventListener('click', onceClick, true);
            edit();
          }, 40);
        }
      } else if (w > 8 && h > 8) {
        const strokeOnly = ['line', 'brace', 'scalebar'].includes(kind);
        const o = {
          id: S.uid('o'), type: 'shape', shape: kind,
          x: g.cur.x, y: g.cur.y, w: g.cur.w, h: g.cur.h,
          fill: strokeOnly ? null : 'accent', stroke: 'accent', strokeWidth: strokeOnly ? 3 : 2,
          html: '', fontSize: 18, align: 'center', vAlign: 'middle',
          color: strokeOnly ? null : '#FFFFFF', lineHeight: 1.2, adj: 0.5
        };
        const slide = S.activeSlide();
        S.mutate('Insert ' + kind, () => { slide.objects.push(o); });
        S.select([o.id]);
      } else if (g.x0 != null && g.y0 != null) {
        const d = (RPE.commands && RPE.commands.SHAPE_DIMS && RPE.commands.SHAPE_DIMS[kind]) || [200, 140];
        const strokeOnly = ['line', 'brace', 'scalebar'].includes(kind);
        const o = {
          id: S.uid('o'), type: 'shape', shape: kind,
          x: Math.round(g.x0 - d[0] / 2), y: Math.round(g.y0 - d[1] / 2), w: d[0], h: d[1],
          fill: strokeOnly ? null : 'accent', stroke: 'accent', strokeWidth: strokeOnly ? 3 : 2,
          html: '', fontSize: 18, align: 'center', vAlign: 'middle',
          color: strokeOnly ? null : '#FFFFFF', lineHeight: 1.2, adj: 0.5
        };
        const slide = S.activeSlide();
        S.mutate('Insert ' + kind, () => { slide.objects.push(o); });
        S.select([o.id]);
      }
    }
    if (g && g.type === 'adjust') {
      if (g.handleEl) {
        g.handleEl.classList.remove('is-dragging');
        g.handleEl.style.cursor = 'grab';
        if (g.pointerId != null && g.handleEl.releasePointerCapture) {
          try { g.handleEl.releasePointerCapture(g.pointerId); } catch (err) {}
        }
      }
      // F-2: Restore starting adj so mutate snapshot records clean initial state
      if (g.latestAdj !== g.startAdj) {
        const obj = S.findObject(g.id);
        if (obj) obj.adj = g.startAdj;
        S.mutate('Adjust shape', () => {
          const target = S.findObject(g.id);
          if (target) target.adj = g.latestAdj;
        }, { hint: { adjustLive: true } });
      }
      render();
      renderSelection();
      if (RPE.slidepane && RPE.slidepane.render) RPE.slidepane.render();
    }
  }

  function stripConflictingInlineOverrides(html, props) {
    if (!html || typeof html !== 'string') return html;
    const d = document.createElement('div');
    d.innerHTML = html;

    const hasFontSize = props.fontSize !== undefined;
    const hasFont = props.font !== undefined;
    const hasColor = props.color !== undefined;
    const hasBold = props.bold !== undefined;
    const hasItalic = props.italic !== undefined;
    const hasUnderline = props.underline !== undefined;
    const hasStrike = props.strike !== undefined;
    const hasHighlight = props.highlight !== undefined;
    const hasSubscript = props.subscript !== undefined;
    const hasSuperscript = props.superscript !== undefined;

    if (hasBold) {
      d.querySelectorAll('b, strong').forEach((el) => el.replaceWith(...el.childNodes));
    }
    if (hasItalic) {
      d.querySelectorAll('i, em').forEach((el) => el.replaceWith(...el.childNodes));
    }
    if (hasUnderline) {
      d.querySelectorAll('u').forEach((el) => el.replaceWith(...el.childNodes));
    }
    if (hasStrike) {
      d.querySelectorAll('s, strike, del').forEach((el) => el.replaceWith(...el.childNodes));
    }
    if (hasSubscript || hasSuperscript) {
      d.querySelectorAll('sub, sup').forEach((el) => el.replaceWith(...el.childNodes));
    }
    if (hasHighlight && !props.highlight) {
      d.querySelectorAll('mark').forEach((el) => el.replaceWith(...el.childNodes));
    }

    d.querySelectorAll('font').forEach((el) => {
      if (hasFontSize) el.removeAttribute('size');
      if (hasFont) el.removeAttribute('face');
      if (hasColor) el.removeAttribute('color');
      if (!el.attributes.length) {
        el.replaceWith(...el.childNodes);
      }
    });

    d.querySelectorAll('*').forEach((el) => {
      if (!el.style) return;
      if (hasFontSize && el.style.fontSize) el.style.fontSize = '';
      if (hasFont && el.style.fontFamily) el.style.fontFamily = '';
      if (hasColor && el.style.color) el.style.color = '';
      if (hasBold && el.style.fontWeight) el.style.fontWeight = '';
      if (hasItalic && el.style.fontStyle) el.style.fontStyle = '';
      if (hasUnderline || hasStrike) {
        if (hasUnderline && hasStrike) {
          el.style.textDecoration = '';
        } else if (hasUnderline && el.style.textDecoration) {
          el.style.textDecoration = el.style.textDecoration.replace(/\bunderline\b/g, '').trim();
        } else if (hasStrike && el.style.textDecoration) {
          el.style.textDecoration = el.style.textDecoration.replace(/\bline-through\b/g, '').trim();
        }
      }
      if ((hasSubscript || hasSuperscript) && el.style.verticalAlign) {
        el.style.verticalAlign = '';
      }
      if (hasHighlight) {
        if (el.style.backgroundColor) el.style.backgroundColor = '';
        if (el.style.background) el.style.background = '';
      }
    });

    cleanupSpans(d);
    return d.innerHTML;
  }

  function applyPainter(id) {
    const o = S.findObject(id), props = ui.painter;
    S.setUI({ painter: null });
    if (!o || !props || !['text', 'shape', 'table'].includes(o.type)) return;

    if (editEl) stopEdit();

    let newHtml = o.html;
    if (newHtml && typeof newHtml === 'string') {
      newHtml = stripConflictingInlineOverrides(newHtml, props);
    }

    S.mutate('Format Painter', () => {
      const textProps = ['fontSize', 'font', 'bold', 'italic', 'underline', 'strike', 'subscript', 'superscript', 'color', 'lineHeight', 'spaceAfter', 'vAlign'];
      textProps.forEach((k) => {
        if (props[k] !== undefined) o[k] = props[k];
      });
      if (newHtml !== undefined) o.html = newHtml;
    }, { hint: { objects: [id] } });
    S.select([id]);
  }
  function nudge(dx, dy) {
    const list = S.selectedObjects(); if (!list.length) return;
    S.mutate('Nudge', () => list.forEach((o) => { o.x += dx; o.y += dy; }), { coalesce: 'nudge', window: 700, hint: { objects: list.map((o) => o.id), geom: true } });
    renderSelection();
  }

  function onCanvasClick(e) {
    if (ui.view !== 'normal') return;
    const link = e.target.closest('a');
    if (!link || !slideEl || !slideEl.contains(link)) return;
    e.preventDefault();

    if (dragMoved) {
      dragMoved = false;
      return;
    }

    const inEdit = editEl && editEl.contains(link);
    if (inEdit) {
      if (e.ctrlKey || e.metaKey) {
        U.openLink(link.getAttribute('href'));
      }
    } else {
      if (e.detail <= 1) {
        U.openLink(link.getAttribute('href'));
      }
    }
  }

  function onDblClick(e) {
    if (ui.view !== 'normal') return;
    const el = e.target.closest('.obj');
    if (!el) {
      const hf = e.target.closest('.hf');
      if (hf && slideEl && slideEl.contains(hf) && ui.editingId !== hf.dataset.id) startEdit(hf.dataset.id, { point: { x: e.clientX, y: e.clientY }, selectWord: true });
      return;
    }
    const o = S.findObject(el.dataset.id); if (!o) return;
    if (o.type === 'text' || o.type === 'shape') {
      if (ui.editingId === o.id) return;
      startEdit(o.id, { point: { x: e.clientX, y: e.clientY }, selectWord: true });
    }
    else if (o.type === 'table') { const td = e.target.closest('td,th'); if (td) editCell(td); }
    else if (o.type === 'plot' || o.type === 'figure') RPE.commands.run('plot.edit', {}, 'dblclick');
    else if (o.type === 'image') RPE.commands.run('picture.replace', {}, 'dblclick');
  }
  function objectMenu(x, y, onObject) {
    const kind = RPE.commands.selectionKind(), M = (label, cmd, args, o) => Object.assign({ label, cmd, args }, o);
    const items = [];
    if (onObject) {
      items.push(M('Cut', 'clip.cut', null, { icon: 'scissors', shortcut: 'Ctrl+X' }), M('Copy', 'clip.copy', null, { icon: 'copy', shortcut: 'Ctrl+C' }), M('Paste', 'clip.paste', null, { icon: 'clipboard-paste', shortcut: 'Ctrl+V' }), M('Duplicate', 'object.duplicate', null, { icon: 'copy-plus', shortcut: 'Ctrl+D' }), M('Delete', 'object.delete', null, { icon: 'trash-2', shortcut: 'Del' }), { sep: true });
      if (kind === 'plot') items.push(M('Edit Plot…', 'plot.edit', null, { icon: 'chart-line' }), M('Python Source…', 'fig.pythonSource', null, { icon: 'terminal' }), M('Add Caption', 'caption.add', null, { icon: 'captions' }), { sep: true });
      else if (kind === 'text' || kind === 'shape') items.push(M('Edit Text', 'text.edit', null, { icon: 'pencil-line' }), { sep: true });
      else if (kind === 'image' || kind === 'table') items.push(M('Add Caption', 'caption.add', null, { icon: 'captions' }), { sep: true });
      items.push(M('Bring to Front', 'arrange.order', { op: 'front' }, { icon: 'bring-to-front' }), M('Send to Back', 'arrange.order', { op: 'back' }, { icon: 'send-to-back' }));
      if (sel().length > 1) items.push(M('Group', 'arrange.group', null, { icon: 'group' }));
    } else {
      items.push(M('Paste', 'clip.paste', null, { icon: 'clipboard-paste', shortcut: 'Ctrl+V' }), M('New Slide', 'slide.new', null, { icon: 'file-plus-2' }), { sep: true },
        M('Show Grid', 'view.grid', null, { icon: 'grid-3x3', checked: ui.showGrid }), M('Show Guides', 'view.guides', null, { icon: 'separator-vertical', checked: ui.showGuides }), M('Fit Slide to Window', 'view.fit', null, { icon: 'scan' }));
    }
    U.contextMenu(x, y, items); RPE.icons.render(document.querySelector('.popover--context'));
  }
  const sel = () => S.selectedObjects();

  /* ---------- crop mode ---------- */
  let cropState = null; // { id, origAdj, cropL, cropR, cropT, cropB, snapDoc }
  let cropOverlayEls = []; // DOM elements added to selLayer for crop UI

  function isCropping() { return !!cropState; }

  function removeCropOverlay() {
    cropOverlayEls.forEach((el) => { if (el.parentNode) el.parentNode.removeChild(el); });
    cropOverlayEls = [];
    if (frame) frame.classList.remove('is-cropping');
  }

  /* Render the crop UI: 4 dim shadows + white frame + 8 edge/corner handles (all in selLayer). */
  function renderCropOverlay() {
    removeCropOverlay();
    if (!cropState || !selLayer) return;
    const o = S.findObject(cropState.id); if (!o) return;
    const { cropL, cropR, cropT, cropB } = cropState;
    const ox = o.x * scale, oy = o.y * scale, ow = o.w * scale, oh = o.h * scale;
    const kx = cropL * ow, ky = cropT * oh, kr = cropR * ow, kb = cropB * oh;
    const visX = ox + kx, visY = oy + ky, visW = ow - kx - kr, visH = oh - ky - kb;

    /* 4 dim shadow rectangles around the visible keep-area */
    const shadows = [
      { left: ox, top: oy, width: kx, height: oh },          // left strip
      { left: ox + ow - kr, top: oy, width: kr, height: oh }, // right strip
      { left: ox + kx, top: oy, width: visW, height: ky },    // top bar
      { left: ox + kx, top: oy + oh - kb, width: visW, height: kb } // bottom bar
    ];
    shadows.forEach((r) => {
      if (r.width <= 0 || r.height <= 0) return;
      const d = document.createElement('div');
      d.className = 'crop-shadow';
      d.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;`;
      selLayer.appendChild(d); cropOverlayEls.push(d);
    });

    /* White keep-area frame */
    const fr = document.createElement('div');
    fr.className = 'crop-frame';
    fr.style.cssText = `left:${visX}px;top:${visY}px;width:${Math.max(0,visW)}px;height:${Math.max(0,visH)}px;`;
    selLayer.appendChild(fr); cropOverlayEls.push(fr);

    /* 8 handles: corners and mid-edges */
    const handles = [
      { dir: 'nw', l: visX, t: visY }, { dir: 'n',  l: visX + visW/2, t: visY },
      { dir: 'ne', l: visX + visW, t: visY }, { dir: 'e', l: visX + visW, t: visY + visH/2 },
      { dir: 'se', l: visX + visW, t: visY + visH }, { dir: 's', l: visX + visW/2, t: visY + visH },
      { dir: 'sw', l: visX, t: visY + visH }, { dir: 'w', l: visX, t: visY + visH/2 }
    ];
    handles.forEach(({ dir, l, t }) => {
      const h = document.createElement('div');
      h.className = 'crop-handle crop-handle--' + dir;
      h.dataset.dir = dir; h.dataset.crop = '1';
      /* center the handle on its anchor point */
      const isCorner = dir.length === 2;
      const offset = isCorner ? '-5px' : dir === 'n' || dir === 's' ? '-16px' : '-4px';
      const offsetT = isCorner ? '-5px' : dir === 'e' || dir === 'w' ? '-16px' : '-4px';
      h.style.cssText = `left:${l}px;top:${t}px;margin-left:${isCorner ? '-5px' : (dir==='n'||dir==='s'?'-16px':'-4px')};margin-top:${isCorner ? '-5px' : (dir==='e'||dir==='w'?'-16px':'-4px')};`;
      selLayer.appendChild(h); cropOverlayEls.push(h);
    });
    if (frame) frame.classList.add('is-cropping');
  }

  function beginCrop(id) {
    if (cropState && cropState.id === id) { commitCrop(); return; } // toggle off
    if (cropState) cancelCrop();
    const o = S.findObject(id); if (!o || o.type !== 'image') return;
    const adj = o.imgAdj || {};
    cropState = {
      id,
      origAdj: JSON.parse(JSON.stringify(adj)),
      snapDoc: JSON.stringify(S.doc),
      cropL: Math.max(0, Math.min(0.95, adj.cropL || 0)),
      cropR: Math.max(0, Math.min(0.95, adj.cropR || 0)),
      cropT: Math.max(0, Math.min(0.95, adj.cropT || 0)),
      cropB: Math.max(0, Math.min(0.95, adj.cropB || 0))
    };
    S.select([id]);
    renderCropOverlay();
    RPE.bus.emit('ui', { changed: ['crop'], reason: 'crop' });
  }

  function cancelCrop() {
    if (!cropState) return;
    /* Restore original adj */
    const cs = cropState; cropState = null;
    removeCropOverlay();
    S.doc.slides.forEach((s) => s.objects.forEach((obj) => {
      if (obj.id === cs.id) {
        if (Object.keys(cs.origAdj).length) obj.imgAdj = Object.assign({}, cs.origAdj);
        else delete obj.imgAdj;
      }
    }));
    const o = S.findObject(cs.id);
    if (o) { const el = document.querySelector('#slideFrame [data-id="' + cs.id + '"]'); if (el) RPE.renderer.updateImageAdj(el, o, RPE.renderer.context(S.doc)); }
    RPE.bus.emit('doc', { label: 'Cancel crop', hint: { objects: [cs.id] } });
    RPE.bus.emit('ui', { changed: ['crop'], reason: 'crop' });
  }

  function commitCrop() {
    if (!cropState) return;
    const cs = cropState; cropState = null;
    removeCropOverlay();
    /* Push one undo step and save crop values into imgAdj */
    S.mutate('Crop image', (d) => {
      d.slides.forEach((s) => s.objects.forEach((obj) => {
        if (obj.id === cs.id) {
          const a = Object.assign({}, obj.imgAdj || {});
          a.cropL = cs.cropL; a.cropR = cs.cropR; a.cropT = cs.cropT; a.cropB = cs.cropB;
          obj.imgAdj = a;
        }
      }));
    });
    RPE.bus.emit('ui', { changed: ['crop'], reason: 'crop' });
  }

  /* Handle a crop-handle drag: update cropState values and re-render the overlay */
  function onCropHandleDown(e, dir) {
    if (!cropState) return;
    const o = S.findObject(cropState.id); if (!o) return;
    const startP = toSlide(e);
    const startCrop = { cropL: cropState.cropL, cropR: cropState.cropR, cropT: cropState.cropT, cropB: cropState.cropB };

    function onCropMove(ev) {
      const p = toSlide(ev);
      const dx = (p.x - startP.x) / o.w;
      const dy = (p.y - startP.y) / o.h;
      let { cropL, cropR, cropT, cropB } = startCrop;
      if (dir.includes('w')) cropL = Math.max(0, Math.min(0.95 - cropR, cropL + dx));
      if (dir.includes('e')) cropR = Math.max(0, Math.min(0.95 - cropL, cropR - dx));
      if (dir.includes('n')) cropT = Math.max(0, Math.min(0.95 - cropB, cropT + dy));
      if (dir.includes('s')) cropB = Math.max(0, Math.min(0.95 - cropT, cropB - dy));
      cropState.cropL = cropL; cropState.cropR = cropR; cropState.cropT = cropT; cropState.cropB = cropB;
      /* Live update the image element */
      const obj = S.findObject(cropState.id);
      if (obj) {
        S.doc.slides.forEach((s) => s.objects.forEach((x) => {
          if (x.id === cropState.id) x.imgAdj = Object.assign({}, x.imgAdj || {}, { cropL, cropR, cropT, cropB });
        }));
        const el = document.querySelector('#slideFrame [data-id="' + cropState.id + '"]');
        if (el) RPE.renderer.updateImageAdj(el, obj, RPE.renderer.context(S.doc));
      }
      renderCropOverlay();
    }
    function onCropUp() {
      window.removeEventListener('pointermove', onCropMove);
      window.removeEventListener('pointerup', onCropUp);
    }
    window.addEventListener('pointermove', onCropMove);
    window.addEventListener('pointerup', onCropUp);
    e.preventDefault(); e.stopPropagation();
  }

  /* ---------- init ---------- */

  function init() {
    ws = $('#wsMain'); scroll = $('#wsScroll'); frame = $('#slideFrame'); overlay = $('#slideOverlay'); selLayer = $('#selLayer'); guideLayer = $('#guideLayer'); rulerH = $('#rulerH'); rulerV = $('#rulerV');
    new ResizeObserver(() => { if (ui.view === 'normal') applyZoom(); }).observe(scroll);
    scroll.addEventListener('pointerdown', onPointerDown);
    scroll.addEventListener('click', onCanvasClick);
    scroll.addEventListener('dblclick', onDblClick);
    scroll.addEventListener('scroll', renderRulers, { passive: true });
    scroll.addEventListener('contextmenu', (e) => {
      if (ui.view !== 'normal') return; e.preventDefault();
      const el = e.target.closest('.obj'); if (el && !ui.selectedIds.includes(el.dataset.id)) S.select([el.dataset.id]);
      objectMenu(e.clientX, e.clientY, !!el);
    });
    scroll.addEventListener('wheel', (e) => { if (!(e.ctrlKey || e.metaKey)) return; e.preventDefault(); RPE.commands.run(e.deltaY < 0 ? 'view.zoomIn' : 'view.zoomOut', {}, 'wheel'); }, { passive: false });
    // Cancel draw-to-create mode on Escape; or clear cellSel if not editing text
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (cropState) { cancelCrop(); e.preventDefault(); return; }
        if (drawShapeKind || (gesture && gesture.type === 'draw')) { cancelDraw(); e.preventDefault(); }
        else if (ui.cellSel && !cellEl) { S.setUI({ cellSel: null }); }
      }
    }, true);
    RPE.bus.on('doc', (e) => {
      const h = e.hint || {};
      if (h.meta || h.adjustLive) return;
      if (h.skipCanvas) { renderSelection(); return; }
      if (h.objects && !h.full) { if (h.geom) patchGeom(h.objects); else h.objects.forEach(refreshObject); renderSelection(); return; }
      render();
    });
    RPE.bus.on('ui', (e) => {
      const c = e.changed;
      if (c.includes('activeSlideId')) { stopEdit(); render(); }
      else if (c.includes('selectedIds') || c.includes('editingId') || c.includes('cellSel')) { if (editEl && !ui.selectedIds.includes(ui.editingId)) stopEdit(); renderSelection(); }
      if (e.reason !== 'fit' && c.some((k) => ['zoom', 'zoomMode', 'view', 'showRuler'].includes(k))) requestAnimationFrame(applyZoom);
      if (c.includes('showGrid') || c.includes('showGuides') || c.includes('view')) updateGuides();
      if (c.includes('painter')) frame.classList.toggle('painting', !!ui.painter);
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('pointerup', onPointerUp);
      window.addEventListener('mouseup', onPointerUp);
    }
    render();
  }

  function onPointerUp() {
    if (!ui.painter) return;
    // Use rAF so the browser has finalized the drag-select before we inspect it.
    requestAnimationFrame(() => {
      if (!ui.painter) return; // Esc may have cancelled it

      const s = getSelection();
      if (!s || !s.rangeCount) return;

      // Find which .obj__text the selection is inside (anchor side).
      const anchor = s.anchorNode;
      const textEl = anchor ? (anchor.nodeType === 1 ? anchor : anchor.parentElement) : null;
      const targetTextEl = textEl && slideEl ? textEl.closest('.obj__text') : null;

      if (targetTextEl && !s.isCollapsed) {
        // If the drag ended in a different box than we entered, switch edit context.
        if (editEl !== targetTextEl) {
          const objElem = targetTextEl.closest('.obj');
          const id = objElem && objElem.dataset.id;
          if (id && ui.editingId !== id) {
            // Re-enter edit for the target box, preserving the existing browser selection.
            const existingRange = s.getRangeAt(0).cloneRange();
            startEdit(id, { point: { x: 0, y: 0 } });
            // Restore the full drag range (startEdit may have collapsed it).
            if (editEl && editEl.contains(existingRange.startContainer)) {
              s.removeAllRanges();
              s.addRange(existingRange);
              savedRange = existingRange;
            }
          }
        }
        if (editEl && editEl.contains(s.anchorNode)) {
          applyPainterToRange(ui.painter);
          S.setUI({ painter: null });
        }
      } else if (!editEl) {
        // Pure click (no drag) on a text box — painter was already cancelled in onPointerDown
        // for non-text objects; for text objects we entered edit. Nothing to do.
        S.setUI({ painter: null });
      }
    });
  }

  function beginDrawShape(kind) {
    drawShapeKind = kind;
    frame.classList.add('drawing');
    scroll.focus({ preventScroll: true });
  }

  function cancelDraw() {
    drawShapeKind = null;
    frame.classList.remove('drawing');
    if (gesture && gesture.type === 'draw') {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      selLayer.querySelectorAll('.marquee').forEach((n) => n.remove());
      if (gesture.ghostEl) {
        gesture.ghostEl.remove();
        gesture.ghostEl = null;
      }
      gesture = null;
    }
  }

  RPE.canvas = { init, render, applyZoom, refreshObject, startEdit, stopEdit, holdEdit, caretState, insertText, editable: () => editEl, editingCell: () => cellEl, hasRange, focusEdit, char, charSize, styleRange, currentSize, currentFont, objectFont, nudge, objectMenu, getScale: () => scale, fitZoom, beginDrawShape, beginDrawText: () => beginDrawShape('text'), beginDraw: beginDrawShape, cancelDraw, captureCharFormat, applyPainter, applyPainterToRange, beginCrop, cancelCrop, commitCrop, isCropping };
})(window.RPE = window.RPE || {});

