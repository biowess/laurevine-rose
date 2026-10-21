/* slidepane.js — left slide navigator and the Slide Sorter grid.
   Both render miniature slides with the same renderer as the canvas, support selection,
   drag-and-drop reordering, keyboard navigation and a context menu. */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, R = RPE.renderer, U = RPE.ui, ic = RPE.icons.html;
  let list, sorter, pane, renderTimer = null;

  function signature(slide, i) {
    const d = S.doc;
    return [i, d.themeId, d.typeId, JSON.stringify(d.typography || null), d.paletteId, JSON.stringify(d.palette || null), d.size.w, d.size.h, slide.layout, JSON.stringify(slide.objects), JSON.stringify(slide.hf || null), JSON.stringify(d.hf || null)].join('|');
  }

  function buildItem(slide, i, mode, thumbScale) {
    const item = document.createElement('div');
    item.className = mode === 'pane' ? 'thumb-item' : 'sorter-item';
    item.dataset.slideId = slide.id; item.draggable = true; item.tabIndex = -1; item.setAttribute('role', 'option');
    const num = document.createElement('span'); num.className = mode === 'pane' ? 'thumb-item__num' : 'sorter-item__num'; num.textContent = i + 1;
    const box = document.createElement('div'); box.className = 'thumb';
    item.append(num, box); item._sig = ''; item._scale = 0;
    return item;
  }
  function fillThumb(item, slide, i, scale) {
    const sig = signature(slide, i) + '|' + scale.toFixed(4);
    if (item._sig === sig) return;
    item._sig = sig;
    const box = item.querySelector('.thumb'); box.replaceChildren(R.mountScaled(slide, scale, { doc: S.doc, index: i, mode: 'thumb' }));
    item.querySelector('[class$="__num"]').textContent = i + 1;
    item.setAttribute('aria-label', `Slide ${i + 1}`);
  }

  function sync(container, mode, scale) {
    const existing = {}; [].slice.call(container.querySelectorAll('[data-slide-id]')).forEach((n) => { existing[n.dataset.slideId] = n; });
    const addBtn = container.querySelector('.thumb-add');
    S.doc.slides.forEach((s, i) => {
      let it = existing[s.id]; if (!it) it = buildItem(s, i, mode);
      delete existing[s.id];
      fillThumb(it, s, i, scale);
      const active = s.id === ui.activeSlideId;
      it.classList.toggle('is-active', active); it.setAttribute('aria-selected', String(active));
      const cur = container.children[i]; if (cur !== it) container.insertBefore(it, cur || addBtn || null);
    });
    Object.keys(existing).forEach((k) => existing[k].remove());
    if (addBtn && addBtn !== container.lastElementChild) container.appendChild(addBtn);
  }

  function renderPane() {
    if (!list) return;
    const avail = list.clientWidth - 44; // number column + paddings
    const scale = Math.max(0.05, Math.min(0.3, (avail > 40 ? avail : 140) / S.doc.size.w));
    sync(list, 'pane', scale);
    const act = list.querySelector('.is-active'); if (act && ui.view === 'normal') act.scrollIntoView({ block: 'nearest' });
    const n = S.doc.slides.length; document.getElementById('paneCount').textContent = n + (n === 1 ? ' slide' : ' slides');
  }
  function renderSorter() {
    if (!sorter || ui.view !== 'sorter') return;
    const scale = ui.sorterZoom / 100; sorter.style.setProperty('--sorter-w', Math.round(S.doc.size.w * scale) + 'px');
    sync(sorter, 'sorter', scale);
    const act = sorter.querySelector('.is-active'); if (act) act.scrollIntoView({ block: 'nearest' });
  }
  function renderAll() { renderPane(); renderSorter(); }
  function schedule(live) { clearTimeout(renderTimer); renderTimer = setTimeout(renderAll, live ? 90 : 0); if (!live) { clearTimeout(renderTimer); renderAll(); } }

  /* ---------- drag & drop ---------- */
  function attachDnD(container, horizontal) {
    let dragId = null;
    const clear = () => container.querySelectorAll('.drop-before,.drop-after,.is-dragging').forEach((n) => n.classList.remove('drop-before', 'drop-after', 'is-dragging'));
    container.addEventListener('dragstart', (e) => { const it = e.target.closest('[data-slide-id]'); if (!it) return; dragId = it.dataset.slideId; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); setTimeout(() => it.classList.add('is-dragging'), 0); });
    container.addEventListener('dragover', (e) => {
      if (!dragId) return; const it = e.target.closest('[data-slide-id]'); if (!it) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move';
      const r = it.getBoundingClientRect(), after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      container.querySelectorAll('.drop-before,.drop-after').forEach((n) => n.classList.remove('drop-before', 'drop-after')); it.classList.add(after ? 'drop-after' : 'drop-before');
    });
    container.addEventListener('drop', (e) => {
      if (!dragId) return; e.preventDefault(); const it = e.target.closest('[data-slide-id]'); if (!it) { clear(); dragId = null; return; }
      const r = it.getBoundingClientRect(), after = horizontal ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
      const slides = S.doc.slides, from = slides.findIndex((s) => s.id === dragId); let to = slides.findIndex((s) => s.id === it.dataset.slideId) + (after ? 1 : 0); if (from < to) to--;
      clear(); const id = dragId; dragId = null; if (to !== from) RPE.commands.run('slide.move', { id, to }, 'drag');
    });
    container.addEventListener('dragend', () => { clear(); dragId = null; });
  }

  /* ---------- menus & activation ---------- */
  function slideMenu(x, y, id) {
    const i = S.doc.slides.findIndex((s) => s.id === id), n = S.doc.slides.length, M = (label, cmd, args, o) => Object.assign({ label, cmd, args: Object.assign({ id }, args || {}) }, o);
    U.contextMenu(x, y, [
      M('New Slide', 'slide.new', { after: id }, { icon: 'file-plus-2', shortcut: 'Ctrl+M' }), M('Duplicate Slide', 'slide.duplicate', null, { icon: 'copy-plus', shortcut: 'Ctrl+D' }),
      M('Delete Slide', 'slide.delete', null, { icon: 'trash-2', shortcut: 'Del', disabled: n <= 1 }), { sep: true },
      M('Move Up', 'slide.moveUp', null, { icon: 'arrow-up', disabled: i === 0 }), M('Move Down', 'slide.moveDown', null, { icon: 'arrow-down', disabled: i === n - 1 }), { sep: true },
      M('Slide Show from Here', 'present.start', { from: 'current' }, { icon: 'circle-play' })
    ]);
    RPE.icons.render(document.querySelector('.popover--context'));
  }
  function wire(container) {
    container.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link) e.preventDefault();
      const it = e.target.closest('[data-slide-id]'); if (!it) return;
      if (it.dataset.slideId !== ui.activeSlideId) S.setActiveSlide(it.dataset.slideId);
    });
    container.addEventListener('contextmenu', (e) => {
      const it = e.target.closest('[data-slide-id]'); if (!it) return; e.preventDefault();
      if (it.dataset.slideId !== ui.activeSlideId) S.setActiveSlide(it.dataset.slideId);
      slideMenu(e.clientX, e.clientY, it.dataset.slideId);
    });
    container.addEventListener('keydown', (e) => {
      const slides = S.doc.slides, i = S.activeIndex(), horizontal = container === sorter;
      const prev = horizontal ? 'ArrowLeft' : 'ArrowUp', next = horizontal ? 'ArrowRight' : 'ArrowDown';
      if (e.key === prev && i > 0) { e.preventDefault(); S.setActiveSlide(slides[i - 1].id); focusActive(container); }
      else if (e.key === next && i < slides.length - 1) { e.preventDefault(); S.setActiveSlide(slides[i + 1].id); focusActive(container); }
      else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); RPE.commands.run('slide.delete', {}, 'key'); }
      else if (e.key === 'Enter') { e.preventDefault(); if (ui.view !== 'normal') S.setUI({ view: 'normal' }); const s = document.getElementById('wsScroll'); s.focus({ preventScroll: true }); }
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') { e.preventDefault(); RPE.commands.run('slide.duplicate', {}, 'key'); }
    });
  }
  function focusActive(container) { requestAnimationFrame(() => { const a = container.querySelector('.is-active'); if (a) a.focus({ preventScroll: true }); }); }

  function init() {
    list = document.getElementById('slideList'); sorter = document.getElementById('sorter'); pane = document.getElementById('slidepane');
    attachDnD(list, false); attachDnD(sorter, true); wire(list); wire(sorter);
    sorter.addEventListener('dblclick', (e) => { const it = e.target.closest('[data-slide-id]'); if (it) { S.setActiveSlide(it.dataset.slideId); S.setUI({ view: 'normal' }); } });
    document.getElementById('paneNew').addEventListener('click', () => RPE.commands.run('slide.new', {}, 'pane'));
    document.getElementById('paneMore').addEventListener('click', (e) => {
      const id = ui.activeSlideId, M = (label, cmd, o) => Object.assign({ label, cmd, args: { id } }, o), n = S.doc.slides.length, i = S.activeIndex();
      U.menu(e.currentTarget, [M('Duplicate Slide', 'slide.duplicate', { icon: 'copy-plus' }), M('Delete Slide', 'slide.delete', { icon: 'trash-2', disabled: n <= 1 }), { sep: true }, M('Move Up', 'slide.moveUp', { icon: 'arrow-up', disabled: i === 0 }), M('Move Down', 'slide.moveDown', { icon: 'arrow-down', disabled: i === n - 1 })], { placement: 'bottom-end' });
      RPE.icons.render(document.querySelector('.popover'));
    });
    new ResizeObserver(() => { renderPane(); }).observe(list);
    RPE.bus.on('doc', (e) => { const h = e.hint || {}; if (h.meta) return; schedule(!!(h.geom || h.skipCanvas || (h.objects && !h.full))); });
    RPE.bus.on('ui', (e) => { const c = e.changed; if (c.includes('activeSlideId') || c.includes('view') || c.includes('sorterZoom')) renderAll(); });
    renderAll();
  }

  RPE.slidepane = { init, render: renderAll };
})(window.RPE = window.RPE || {});
