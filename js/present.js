/* present.js — lightweight slide show: full-window slide, keyboard/click navigation, optional presenter
   view (next slide, notes, timer) and laser pointer. No export happens here. */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, R = RPE.renderer, U = RPE.ui, h = RPE.h, ic = RPE.icons.html;
  let el = null, idx = 0, presenter = false, laser = false, t0 = 0, tick = null, idleT = null, dot = null;

  const fmt = (ms) => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  const fitScale = (w, hh) => Math.min(w / S.doc.size.w, hh / S.doc.size.h);

  function draw() {
    if (!el) return;
    const slides = S.doc.slides, slide = slides[idx], stage = el.querySelector('.present__stage'); stage.replaceChildren();
    const mk = (s, i, sc) => R.mountScaled(s, sc, { doc: S.doc, index: i, mode: 'present' });
    if (!presenter) {
      stage.appendChild(mk(slide, idx, fitScale(innerWidth, innerHeight)));
    } else {
      const mainW = Math.round(innerWidth * 0.64) - 48, mainH = innerHeight - 160, sc = fitScale(mainW, mainH);
      const next = slides[idx + 1], side = h('div', { class: 'present__side' },
        h('div', { class: 'present__lbl' }, 'Next slide'), next ? mk(next, idx + 1, Math.min(0.26, fitScale(innerWidth * 0.3, 220))) : h('div', { class: 'present__end' }, 'End of presentation'),
        h('div', { class: 'present__lbl' }, 'Speaker notes'), h('div', { class: 'present__notes' }, slide.notes || 'No notes for this slide.'),
        h('div', { class: 'present__timer', 'aria-label': 'Elapsed time' }, h('span', { html: ic('timer') }), h('b', { id: 'presentTimer' }, fmt(Date.now() - t0))));
      stage.append(h('div', { class: 'present__main' }, mk(slide, idx, sc)), side);
    }
    el.querySelector('.present__count').textContent = `${idx + 1} / ${slides.length}`;
    el.querySelector('[data-p=prev]').disabled = idx === 0; el.querySelector('[data-p=next]').disabled = idx === slides.length - 1;
    el.querySelector('[data-p=presenter]').setAttribute('aria-pressed', String(presenter)); el.querySelector('[data-p=laser]').setAttribute('aria-pressed', String(laser));
    el.classList.toggle('is-presenter', presenter); el.classList.toggle('is-laser', laser); RPE.icons.render(el);
  }
  const go = (n) => { n = Math.max(0, Math.min(S.doc.slides.length - 1, n)); if (n !== idx) { idx = n; draw(); } };
  function wake() { el.classList.add('show-ui'); clearTimeout(idleT); idleT = setTimeout(() => el && el.classList.remove('show-ui'), 2400); }

  function onKey(e) {
    if (!el) return; const k = e.key;
    const used = ['Escape', 'ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', ' ', 'PageDown', 'PageUp', 'Home', 'End', 'p', 'P', 'l', 'L', 'Enter'];
    if (!used.includes(k)) return; e.preventDefault(); e.stopPropagation();
    if (k === 'Escape') exit(); else if (['ArrowRight', 'ArrowDown', ' ', 'PageDown', 'Enter'].includes(k)) go(idx + 1); else if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(k)) go(idx - 1);
    else if (k === 'Home') go(0); else if (k === 'End') go(S.doc.slides.length - 1); else if (k === 'p' || k === 'P') { presenter = !presenter; draw(); } else { laser = !laser; draw(); }
  }

  function start(from, o) {
    if (el) return; o = o || {}; idx = Math.max(0, Math.min(S.doc.slides.length - 1, from || 0)); presenter = !!o.presenter; laser = !!o.laser; t0 = Date.now();
    RPE.canvas.stopEdit(); RPE.ui.closeAll();
    const btn = (p, label, icon) => h('button', { type: 'button', class: 'present__btn', 'aria-label': label, 'data-tip': label, 'data-tip-pos': 'top', dataset: { p }, html: ic(icon) });
    el = h('div', { class: 'present', role: 'dialog', 'aria-label': 'Slide show', 'aria-modal': 'true' }, h('div', { class: 'present__stage' }),
      h('div', { class: 'present__bar', role: 'toolbar', 'aria-label': 'Slide show controls' }, btn('prev', 'Previous slide', 'chevron-left'), h('span', { class: 'present__count' }), btn('next', 'Next slide', 'chevron-right'), h('span', { class: 'present__sep' }), btn('presenter', 'Presenter view (P)', 'monitor-speaker'), btn('laser', 'Laser pointer (L)', 'crosshair'), btn('exit', 'End show (Esc)', 'x')));
    dot = h('div', { class: 'present__dot' }); el.appendChild(dot);
    el.addEventListener('click', (e) => {
      const link = e.target.closest('a');
      if (link) { e.preventDefault(); U.openLink(link.getAttribute('href')); return; }
      const b = e.target.closest('[data-p]'); if (!b) { go(idx + 1); return; } const p = b.dataset.p; if (p === 'prev') go(idx - 1); else if (p === 'next') go(idx + 1); else if (p === 'exit') exit(); else if (p === 'presenter') { presenter = !presenter; draw(); } else { laser = !laser; draw(); }
    });
    el.addEventListener('mousemove', (e) => { wake(); dot.style.transform = `translate(${e.clientX}px,${e.clientY}px)`; });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); go(idx - 1); });
    document.body.appendChild(el); S.setUI({ presenting: true });
    document.addEventListener('keydown', onKey, true); window.addEventListener('resize', draw);
    tick = setInterval(() => { const t = document.getElementById('presentTimer'); if (t) t.textContent = fmt(Date.now() - t0); }, 1000);
    draw(); wake();
    if (S.prefs.fullscreenPresent && el.requestFullscreen) el.requestFullscreen().catch(() => { });
    document.addEventListener('fullscreenchange', onFs);
    const b = el.querySelector('[data-p=next]'); if (b) b.focus({ preventScroll: true });
  }
  function onFs() { if (el && !document.fullscreenElement && el.dataset.fs === '1') exit(); if (el && document.fullscreenElement) el.dataset.fs = '1'; }
  function exit() {
    if (!el) return;
    document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', draw); document.removeEventListener('fullscreenchange', onFs);
    clearInterval(tick); clearTimeout(idleT);
    const wasFs = !!document.fullscreenElement; el.remove(); el = null;
    if (wasFs && document.exitFullscreen) document.exitFullscreen().catch(() => { });
    S.setUI({ presenting: false }); if (S.doc.slides[idx]) S.setActiveSlide(S.doc.slides[idx].id);
  }
  RPE.present = { start, exit, isOn: () => !!el };
})(window.RPE = window.RPE || {});
