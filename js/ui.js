/* ui.js — shared UI toolkit used by every other module.
   h()            tiny element builder
   popover/menu   anchored, dismissible surfaces (Esc, outside click, resize)
   dialog/confirm modal dialogs with focus handling (popovers opened from a dialog mount inside its backdrop; layers: css --z-* scale); dialog({ fit: true, width }) = viewport-bounded frame (css .dlg--fit: width/height clamped to
                  the window with a 20px margin, fixed title bar + footer, body fills the rest; the window's own CSS decides which inner region scrolls)
   toast          unobtrusive notifications (optionally with an action such as Undo)
   progressChip   non-modal chip for a running job (text + Cancel); lives above dialogs, never blocks editing
   tooltip        delegated tooltips for any element with data-tip */
(function (RPE) {
  'use strict';
  const S = RPE.store, T = RPE.themes, ic = RPE.icons.html;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function h(tag, props) {
    const el = document.createElement(tag);
    if (props) Object.keys(props).forEach((k) => {
      const v = props[k]; if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v);
      else el.setAttribute(k, v === true ? '' : v);
    });
    for (let i = 2; i < arguments.length; i++) {
      [].concat(arguments[i]).forEach((c) => { if (c == null || c === false) return; el.append(c.nodeType ? c : document.createTextNode(c)); });
    }
    return el;
  }

  /* ---------- shape catalogue (used by menus and insertion) ---------- */
  const SHAPES = [
    { id: 'rect', label: 'Rectangle', svg: '<rect x="8" y="22" width="84" height="56"/>' },
    { id: 'rounded', label: 'Rounded rectangle', svg: '<rect x="8" y="22" width="84" height="56" rx="14"/>' },
    { id: 'ellipse', label: 'Ellipse', svg: '<ellipse cx="50" cy="50" rx="42" ry="30"/>' },
    { id: 'triangle', label: 'Triangle', svg: '<polygon points="50,14 92,84 8,84"/>' },
    { id: 'diamond', label: 'Diamond', svg: '<polygon points="50,12 92,50 50,88 8,50"/>' },
    { id: 'pentagon', label: 'Pentagon', svg: '<polygon points="50,12 90,37 76,82 24,82 10,37"/>' },
    { id: 'hexagon', label: 'Hexagon', svg: '<polygon points="24,14 76,14 96,50 76,86 24,86 4,50"/>' },
    { id: 'octagon', label: 'Octagon', svg: '<polygon points="28,12 72,12 94,32 94,68 72,88 28,88 6,68 6,32"/>' },
    { id: 'parallelogram', label: 'Parallelogram', svg: '<polygon points="22,20 92,20 78,80 8,80"/>' },
    { id: 'trapezoid', label: 'Trapezoid', svg: '<polygon points="18,20 82,20 94,80 6,80"/>' },
    { id: 'arrow', label: 'Block arrow', svg: '<polygon points="6,36 56,36 56,18 94,50 56,82 56,64 6,64"/>' },
    { id: 'arrow2', label: 'Double arrow', svg: '<polygon points="4,50 20,30 20,40 80,40 80,30 96,50 80,70 80,60 20,60 20,70"/>' },
    { id: 'chevron', label: 'Chevron', svg: '<polygon points="8,18 72,18 92,50 72,82 8,82 28,50"/>' },
    { id: 'line', label: 'Line', svg: '<line x1="8" y1="50" x2="92" y2="50"/>', stroke: true },
    { id: 'callout', label: 'Rectangular callout', svg: '<polygon points="8,14 92,14 92,66 48,66 28,88 34,66 8,66"/>' },
    { id: 'callout2', label: 'Oval callout', svg: '<path d="M50,16 C80,16 88,30 88,44 C88,58 78,66 50,66 C38,66 28,62 22,56 L32,88 L26,62 C14,58 12,52 12,44 C12,30 20,16 50,16 Z"/>' },
    { id: 'cross', label: 'Cross', svg: '<polygon points="36,8 64,8 64,36 92,36 92,64 64,64 64,92 36,92 36,64 8,64 8,36 36,36"/>' },
    { id: 'star4', label: '4-point star', svg: '<polygon points="50,10 60,40 90,50 60,60 50,90 40,60 10,50 40,40"/>' },
    { id: 'star5', label: '5-point star', svg: '<polygon points="50,8 61,38 92,38 68,57 78,88 50,69 22,88 32,57 8,38 39,38"/>' },
    { id: 'star6', label: '6-point star', svg: '<polygon points="50,10 60,32 84,22 74,44 94,50 74,56 84,78 60,68 50,90 40,68 16,78 26,56 6,50 26,44 16,22 40,32"/>' },
    { id: 'ribbon', label: 'Ribbon', svg: '<path d="M8,34 L20,34 L20,20 L80,20 L80,34 L92,34 L80,50 L92,66 L80,66 L80,80 L20,80 L20,66 L8,66 L20,50 Z"/>' },
    { id: 'brace', label: 'Brace', svg: '<path d="M64 12 Q40 12 40 28 V42 Q40 50 24 50 Q40 50 40 58 V72 Q40 88 64 88" fill="none"/>', stroke: true },
    { id: 'scalebar', label: 'Scale bar', svg: '<path d="M8 50 H92 M8 34 V66 M92 34 V66" fill="none"/>', stroke: true }
  ];
  const shapePreview = (s) => `<svg viewBox="0 0 100 100" aria-hidden="true" class="shp"><g fill="${s.stroke ? 'none' : 'currentColor'}" fill-opacity=".14" stroke="currentColor" stroke-width="5" stroke-linejoin="round" stroke-linecap="round">${s.svg}</g></svg>`;


  function layoutPreview(id) {
    const L = T.layout(id), W = 100, Hh = 56.25;
    const parts = L.slots.map((s) => {
      const x = s.x * W, y = s.y * Hh, w = s.w * W, hh = s.h * Hh;
      if (s.role === 'title') return `<rect x="${x}" y="${y + hh * .25}" width="${w * (id === 'title' || id === 'section' ? .7 : .6)}" height="${Math.min(5, hh * .5)}" rx="1" fill="#702D3B" opacity=".8"/>`;
      if (s.role === 'subtitle') return `<rect x="${x}" y="${y}" width="${w * .5}" height="2.4" rx="1" fill="#6F7075" opacity=".6"/>`;
      if (s.role === 'figure') return `<rect x="${x}" y="${y}" width="${w}" height="${hh}" fill="#ECEBE8" stroke="#C9C4BE" stroke-width=".6"/><path d="M${x} ${y}L${x + w} ${y + hh}M${x + w} ${y}L${x} ${y + hh}" stroke="#C9C4BE" stroke-width=".5"/>`;
      return [0, 1, 2, 3].map((i) => `<rect x="${x}" y="${y + 2 + i * 6}" width="${w * (i === 3 ? .6 : .95)}" height="2" rx="1" fill="#8d8a86" opacity=".6"/>`).join('');
    }).join('');
    return `<svg viewBox="0 0 ${W} ${Hh}" class="lp" aria-hidden="true"><rect width="${W}" height="${Hh}" fill="#fff" stroke="#D9D5D0" stroke-width=".8"/>${parts}</svg>`;
  }
  const themePreview = (th) => `<span class="tp" style="background:${th.bg};border-color:${th.dark ? '#444' : '#D9D5D0'}"><i style="background:${th.accent}"></i><b style="background:${th.title}"></b><s style="background:${th.muted}"></s><s style="background:${th.muted};width:55%"></s><em style="background:${th.accent2}"></em></span>`;

  /* ---------- popovers ---------- */
  const pops = [];
  function place(el, anchor, placement) {
    const r = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : anchor;
    const anchorEl = anchor && anchor.nodeType ? anchor : (anchor && anchor.anchor && anchor.anchor.nodeType ? anchor.anchor : null);
    const parentGroup = anchorEl ? anchorEl.closest('.popover--group') : null;
    el.style.left = '0px'; el.style.top = '0px'; el.style.visibility = 'hidden';
    const vw = innerWidth, vh = innerHeight, m = 6;
    el.style.maxHeight = (vh - m * 2) + 'px';
    const w = el.offsetWidth, hh = el.offsetHeight;
    let x = r.left, y = r.bottom + 2;
    if (parentGroup && (!placement || placement.startsWith('bottom'))) {
      const gr = parentGroup.getBoundingClientRect();
      y = gr.bottom + 2;
      const spaceBelow = vh - y - m;
      if (spaceBelow >= 120 || spaceBelow >= gr.top - m) {
        el.style.maxHeight = Math.max(80, spaceBelow) + 'px';
      } else {
        y = Math.max(m, gr.top - hh - 2);
        el.style.maxHeight = Math.max(80, gr.top - m - 2) + 'px';
      }
    } else {
      if (placement === 'bottom-end') x = r.right - w;
      if (placement === 'top-start') y = r.top - hh - 4;
      if (placement === 'top-end') { y = r.top - hh - 4; x = r.right - w; }
      if (placement === 'right-start') { x = r.right + 2; y = r.top; }
      if (y + hh > vh - m) {
        y = Math.max(m, (placement === 'top-start' ? r.bottom + 2 : r.top - hh - 2));
      }
      if (y + hh > vh - m) y = Math.max(m, vh - hh - m);
      if (y < m) y = m;
    }
    if (parentGroup && placement === 'bottom-end') x = r.right - w;
    x = Math.min(Math.max(m, x), Math.max(m, vw - w - m));
    el.style.left = Math.round(x) + 'px'; el.style.top = Math.round(y) + 'px'; el.style.visibility = '';
  }
  function closeAll() { while (pops.length) pops.pop().dispose(); }
  const isOpenFor = (anchor) => pops.some((p) => p.anchor === anchor);

  function popover(anchor, content, opts) {
    opts = opts || {};
    const anchorEl = anchor && anchor.nodeType ? anchor : (anchor && anchor.anchor && anchor.anchor.nodeType ? anchor.anchor : null);
    const parentPop = anchorEl ? pops.find((p) => p.el.contains(anchorEl)) : null;
    if (parentPop) {
      const parentIdx = pops.indexOf(parentPop);
      while (pops.length > parentIdx + 1) pops.pop().dispose();
    } else if (!opts.nested) {
      closeAll();
    }
    const el = h('div', { class: 'popover ' + (opts.class || ''), role: opts.role || 'menu' }, content);
    el.style.zIndex = 'calc(var(--z-popover) + ' + pops.length * 10 + ')';
    el.addEventListener('mousedown', (e) => { if (!e.target.closest('input,textarea,select,[contenteditable],label')) e.preventDefault(); });
    el.addEventListener('click', (e) => { if (e.target.closest('[data-command]') && !e.target.closest('[data-keep]')) setTimeout(closeAll, 0); });
    el.addEventListener('keydown', (e) => {
      if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) || e.target.closest('input,textarea')) return;
      const items = [].slice.call(el.querySelectorAll('button:not([disabled])')); if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (e.key === 'ArrowDown' || e.key === 'ArrowRight') ? (i + 1) % items.length : (i <= 0 ? items.length - 1 : i - 1);
      e.preventDefault(); items[next].focus();
    });
    // Mount inside the topmost open dialog (its backdrop is a fixed stacking context), otherwise on <body>: a popover opened from a dialog is then
    // always above it, shares its focus scope and is removed with it. Position stays viewport-fixed, so place() is unaffected.
    const top = dlgs[dlgs.length - 1];
    (top ? top.backdrop : document.body).appendChild(el); RPE.icons.render(el);
    place(el, anchor, opts.placement || 'bottom-start');
    requestAnimationFrame(() => el.classList.add('is-open'));
    const entry = {
      el, anchor,
      dispose() { el.classList.remove('is-open'); setTimeout(() => el.remove(), 130); if (anchor && anchor.setAttribute && anchor.nodeType) anchor.setAttribute('aria-expanded', 'false'); if (opts.onClose) opts.onClose(); },
      close() {
        const i = pops.indexOf(entry);
        if (i >= 0) {
          while (pops.length > i) pops.pop().dispose();
        }
      },
      reposition() { place(el, anchor, opts.placement || 'bottom-start'); }
    };
    pops.push(entry);
    if (anchor && anchor.setAttribute && anchor.nodeType) anchor.setAttribute('aria-expanded', 'true');
    if (opts.focusFirst) { const f = el.querySelector('button:not([disabled]),input'); if (f) f.focus(); }
    return entry;
  }

  /* ---------- menus ---------- */
  function menuItem(it) {
    const checked = typeof it.checked === 'function' ? it.checked() : it.checked;
    const enabled = it.disabled ? false : (it.cmd ? RPE.commands.isEnabled(it.cmd, it.args) : true);
    const b = h('button', { type: 'button', class: 'menu__item' + (checked ? ' is-checked' : ''), role: checked !== undefined ? 'menuitemcheckbox' : 'menuitem', 'aria-checked': checked !== undefined ? String(!!checked) : null, disabled: !enabled, dataset: it.cmd ? { command: it.cmd } : null, title: it.desc || null });
    if (it.cmd && it.args) b.dataset.args = JSON.stringify(it.args);
    if (it.keep) b.dataset.keep = '1';
    b.innerHTML = `<span class="menu__icon">${checked ? ic('check') : (it.icon ? ic(it.icon) : '')}</span>` +
      (it.swatches ? `<span class="menu__sw">${it.swatches.map((c) => `<i style="background:${c}"></i>`).join('')}</span>` : '') +
      `<span class="menu__label"${it.font ? ` style="font-family:${T.cssFont(it.font)}"` : ''}>${esc(it.label)}${it.desc ? `<small${it.descFont ? ` style="font-family:${T.cssFont(it.descFont)}"` : ''}>${esc(it.desc)}</small>` : ''}</span>` +
      (it.shortcut ? `<kbd>${esc(it.shortcut)}</kbd>` : '');
    return b;
  }
  function listMenu(items) {
    const m = h('div', { class: 'menu' + (items.length > 12 ? ' menu--scroll' : '') });
    items.forEach((it) => {
      if (it.sep) m.appendChild(h('div', { class: 'menu__sep', role: 'separator' }));
      else if (it.head) m.appendChild(h('div', { class: 'menu__head' }, it.head));
      else m.appendChild(menuItem(it));
    });
    return m;
  }
  /* Shared layout picker (js/layoutpicker.js): used by Home > New Slide and Design > Layouts; the caller's command decides the action. */
  function layoutsMenu(def) {
    const P = RPE.layoutPicker;
    if (!P) return h('div', { class: 'menu' }, h('div', { class: 'menu__head' }, 'Layouts unavailable'));
    const cur = def.current && S.slide && S.ui ? S.slide(S.ui.activeSlideId) : null;
    const picker = P.create({ doc: S.doc, current: cur ? cur.layout : null, onSelect: (id) => { RPE.commands.run(def.cmd, { layout: id }, 'ui'); setTimeout(closeAll, 0); } });
    return h('div', { class: 'menu menu--layouts' }, picker.el);
  }
  function galleryMenu(def) {
    const g = h('div', { class: 'gallery', style: { gridTemplateColumns: `repeat(${def.cols || 3}, 1fr)` } });
    const wrap = h('div', { class: 'menu menu--gallery' }, def.head ? h('div', { class: 'menu__head' }, def.head) : null, g);
    def.items.forEach((it) => {
      let prev = '';
      if (it.preview) {
        const [k, id] = it.preview.split(':');
        prev = k === 'layout' ? layoutPreview(id) : k === 'shape' ? shapePreview(SHAPES.find((s) => s.id === id)) : k === 'theme' ? themePreview(T.THEMES.find((x) => x.id === id)) : '';
      }
      const b = h('button', { type: 'button', class: 'tile' + (it.checked ? ' is-checked' : ''), dataset: { command: it.cmd }, title: it.label, 'aria-label': it.label, html: `${prev}<span class="tile__label">${esc(it.label)}</span>` });
      if (it.args) b.dataset.args = JSON.stringify(it.args);
      g.appendChild(b);
    });
    return wrap;
  }
  const RECENT_COLORS_KEY = 'rpe.recentColors.v1';
  function loadRecentColors() {
    try {
      const raw = localStorage.getItem(RECENT_COLORS_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr) && arr.length) return arr.slice(0, 10);
      }
    } catch (e) {}
    return ['#7030A0']; // Default purple swatch matching user screenshot
  }

  let recentColorsList = loadRecentColors();

  function addRecentColor(val) {
    if (!val || val === 'null' || val === 'transparent') return;
    const th = T.theme ? T.theme(S.doc) : null;
    const m = th ? { accent: th.accent, accent2: th.accent2, text: th.text, muted: th.muted, bg: th.bg, title: th.title } : {};
    let hex = m[val] || val;
    if (typeof hex !== 'string' || !hex.startsWith('#')) return;
    hex = hex.toUpperCase();
    recentColorsList = [hex, ...recentColorsList.filter((c) => c.toUpperCase() !== hex)].slice(0, 10);
    try { localStorage.setItem(RECENT_COLORS_KEY, JSON.stringify(recentColorsList)); } catch (e) {}
    if (S.ui) S.ui.recentColors = recentColorsList;
  }

  function colorMenu(def) {
    const doc = S.doc;
    const matrix = (T.themeMatrix ? T.themeMatrix(doc) : null) || {
      base: T.STANDARD_COLORS.map((c) => ({ name: c, color: c, val: c })),
      shades: []
    };
    const wrap = h('div', { class: 'menu menu--colors' });

    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('.swatch');
      if (b && b.dataset.color) {
        addRecentColor(b.dataset.color);
      }
    });

    if (def.none) {
      const b = h('button', { type: 'button', class: 'menu__item menu__item--none', dataset: { command: def.cmd } },
        h('span', { class: 'menu__icon', html: ic('ban') }),
        h('span', { class: 'menu__label' }, def.none)
      );
      b.dataset.args = JSON.stringify(Object.assign({}, def.args || {}, { value: null }));
      wrap.appendChild(b);
      wrap.appendChild(h('div', { class: 'menu__sep' }));
    }

    const sw = (value, label, shown, extraClass) => {
      const b = h('button', {
        type: 'button',
        class: 'swatch' + (extraClass ? ' ' + extraClass : ''),
        dataset: { command: def.cmd, color: shown || value },
        title: label,
        'aria-label': label,
        style: { background: shown || value }
      });
      b.dataset.args = JSON.stringify(Object.assign({}, def.args || {}, { value }));
      return b;
    };

    // 1. Theme Colors
    wrap.appendChild(h('div', { class: 'menu__head' }, 'Theme Colors'));
    const baseGrid = h('div', { class: 'swatches swatches--theme-base', role: 'group', 'aria-label': 'Theme base colors' });
    matrix.base.forEach((c) => {
      baseGrid.appendChild(sw(c.val, c.name, c.color, 'swatch--base'));
    });
    wrap.appendChild(baseGrid);

    if (matrix.shades && matrix.shades.length) {
      const shadeGrid = h('div', { class: 'swatches swatches--theme-shades', role: 'group', 'aria-label': 'Theme shades and tints' });
      matrix.shades.forEach((row) => {
        row.forEach((c) => {
          shadeGrid.appendChild(sw(c.val, c.name, c.color, 'swatch--shade'));
        });
      });
      wrap.appendChild(shadeGrid);
    }

    // 2. Standard Colors
    wrap.appendChild(h('div', { class: 'menu__sep' }));
    wrap.appendChild(h('div', { class: 'menu__head' }, 'Standard Colors'));
    const stdGrid = h('div', { class: 'swatches swatches--standard', role: 'group', 'aria-label': 'Standard colors' });
    T.STANDARD_COLORS.forEach((c, idx) => {
      const name = (T.STANDARD_COLOR_NAMES && T.STANDARD_COLOR_NAMES[idx]) || c;
      stdGrid.appendChild(sw(c, name, c, 'swatch--std'));
    });
    wrap.appendChild(stdGrid);

    // 3. Recent Colors
    wrap.appendChild(h('div', { class: 'menu__sep' }));
    wrap.appendChild(h('div', { class: 'menu__head' }, 'Recent Colors'));
    const recentGrid = h('div', { class: 'swatches swatches--recent', role: 'group', 'aria-label': 'Recent colors' });
    recentColorsList.slice(0, 10).forEach((c) => {
      recentGrid.appendChild(sw(c, c, c, 'swatch--recent'));
    });
    wrap.appendChild(recentGrid);

    // 4. Separator & Actions
    wrap.appendChild(h('div', { class: 'menu__sep' }));

    const input = h('input', { type: 'color', value: recentColorsList[0] || '#4472C4', 'aria-label': 'Custom color' });
    const applyVal = (hex) => {
      addRecentColor(hex);
      RPE.commands.run(def.cmd, Object.assign({}, def.args || {}, { value: hex }), 'menu');
      closeAll();
    };
    input.addEventListener('input', (e) => {
      RPE.commands.run(def.cmd, Object.assign({}, def.args || {}, { value: e.target.value }), 'menu');
    });
    input.addEventListener('change', (e) => {
      applyVal(e.target.value);
    });

    const moreBtn = h('label', { class: 'menu__item menu__item--label' },
      h('span', { class: 'menu__icon', html: ic('palette') }),
      h('span', { class: 'menu__label' }, 'More Colors…'),
      input
    );
    wrap.appendChild(moreBtn);

    const eyedropperBtn = h('button', { type: 'button', class: 'menu__item menu__item--eyedropper' },
      h('span', { class: 'menu__icon', html: ic('pipette') }),
      h('span', { class: 'menu__label' }, 'Eyedropper')
    );
    eyedropperBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      closeAll();
      if (window.EyeDropper) {
        try {
          const ed = new window.EyeDropper();
          const res = await ed.open();
          if (res && res.sRGBHex) {
            applyVal(res.sRGBHex);
          }
        } catch (err) {
          // Aborted by user
        }
      } else {
        input.click();
      }
    });
    wrap.appendChild(eyedropperBtn);

    return wrap;
  }
  function tableGridMenu(def) {
    const wrap = h('div', { class: 'menu menu--tablegrid' });
    const label = h('div', { class: 'menu__head', 'aria-live': 'polite' }, 'Insert table');
    const grid = h('div', { class: 'tgrid', role: 'grid' });
    const COLS = 8, ROWS = 6;
    for (let r = 1; r <= ROWS; r++) for (let c = 1; c <= COLS; c++) {
      const b = h('button', { type: 'button', class: 'tcell', 'aria-label': `${r} by ${c} table`, dataset: { command: def.cmd, r, c } });
      b.dataset.args = JSON.stringify({ rows: r, cols: c }); grid.appendChild(b);
    }
    const paint = (r, c) => { grid.querySelectorAll('.tcell').forEach((b) => b.classList.toggle('is-hot', +b.dataset.r <= r && +b.dataset.c <= c)); label.textContent = r ? `${c} × ${r} table` : 'Insert table'; };
    grid.addEventListener('mouseover', (e) => { const b = e.target.closest('.tcell'); if (b) paint(+b.dataset.r, +b.dataset.c); });
    grid.addEventListener('focusin', (e) => { const b = e.target.closest('.tcell'); if (b) paint(+b.dataset.r, +b.dataset.c); });
    grid.addEventListener('mouseleave', () => paint(0, 0));
    wrap.append(label, grid, h('div', { class: 'menu__sep' }), menuItem({ label: 'Insert table…', icon: 'table-properties', cmd: 'insert.tableDialog' }));
    return wrap;
  }
  const SYMBOLS = 'α β γ δ ε θ λ μ π σ τ φ ω Δ Σ Ω ± × ÷ ° ≤ ≥ ≠ ≈ ∞ ∑ ∫ √ ∂ ∇ → ← ↑ ↓ ⇌ · ‰ Å ′ ″ ² ³ ⁻ ₀ ₁ ₂ ½ ©'.split(' ');
  function symbolMenu(def) {
    const g = h('div', { class: 'symgrid' });
    SYMBOLS.forEach((ch) => { const b = h('button', { type: 'button', class: 'sym', dataset: { command: def.cmd }, title: ch, 'aria-label': 'Symbol ' + ch }, ch); b.dataset.args = JSON.stringify({ char: ch }); g.appendChild(b); });
    return h('div', { class: 'menu menu--symbols' }, h('div', { class: 'menu__head' }, 'Symbols'), g);
  }
  function buildMenu(def) {
    if (typeof def === 'function') def = def();
    if (Array.isArray(def)) return listMenu(def);
    switch (def.kind) {
      case 'gallery': return galleryMenu(def);
      case 'layouts': return layoutsMenu(def);
      case 'colors': return colorMenu(def);
      case 'tablegrid': return tableGridMenu(def);
      case 'symbols': return symbolMenu(def);
      case 'custom': return def.build();
      default: return listMenu(def.items || []);
    }
  }
  function menu(anchor, def, opts) {
    const existing = pops.find((p) => p.anchor === anchor);
    if (existing) { existing.close(); return null; }
    opts = opts || {};
    return popover(anchor, buildMenu(def), Object.assign({ role: 'menu', focusFirst: opts.focusFirst }, opts));
  }
  function contextMenu(x, y, items) {
    closeAll();
    return popover({ left: x, right: x, top: y, bottom: y - 2, width: 0, height: 0 }, listMenu(items), { role: 'menu', class: 'popover--context', focusFirst: false });
  }

  /* ---------- dialogs ---------- */
  const dlgs = [];
  let swallowBackdrop = false;   // set for one event turn when a pointerdown on a dialog backdrop only closed popovers
  function dialog(o) {
    closeAll();
    const prev = document.activeElement, id = 'dlg' + Math.random().toString(36).slice(2, 7);
    const body = h('div', { class: 'dlg__body' }, o.body);
    const foot = h('div', { class: 'dlg__foot' });
    let resolveFn; const done = new Promise((r) => { resolveFn = r; });
    const el = h('div', { class: 'dlg ' + (o.fit ? 'dlg--fit ' : '') + (o.class || ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': id, tabindex: '-1', style: o.fit ? {} : { width: (o.width || 520) + 'px' } },
      h('div', { class: 'dlg__head' }, o.icon ? h('span', { class: 'dlg__icon', html: ic(o.icon) }) : null, h('h2', { id, class: 'dlg__title' }, o.title),
        h('button', { type: 'button', class: 'dlg__close', 'aria-label': 'Close', 'data-tip': 'Close', html: ic('x'), onclick: () => api.close(undefined) })), body, foot);
    if (o.fit) el.style.setProperty('--dlg-w', (o.width || 1180) + 'px');   // preferred width; .dlg--fit clamps it to the window (preferred height is set per window class in CSS)
    const backdrop = h('div', { class: 'dlg-backdrop' }, el);
    backdrop.style.setProperty('--dlg-depth', String(dlgs.length));   // nested dialogs stack in open order (css --z-modal + depth)
    const api = {
      el, body, foot, done, buttons: {}, backdrop,
      close(v) {
        const i = dlgs.indexOf(api); if (i < 0) return; dlgs.splice(i, 1);
        for (let k = pops.length - 1; k >= 0; k--) if (backdrop.contains(pops[k].el)) pops.splice(k, 1)[0].dispose();   // popovers mounted in this dialog go with it
        backdrop.classList.remove('is-open'); setTimeout(() => backdrop.remove(), 170);
        if (o.onClose) o.onClose(v);
        resolveFn(v);
        if (prev && prev.focus && document.contains(prev) && !prev.closest('[contenteditable]')) prev.focus();
      }
    };
    if (o.footerLeft) foot.appendChild(h('div', { class: 'dlg__foot-left' }, o.footerLeft));
    (o.buttons || []).forEach((b) => {
      const btn = h('button', { type: 'button', class: 'btn btn--' + (b.kind || 'ghost'), onclick: () => { const r = b.onClick ? b.onClick(api) : undefined; if (r !== false) api.close(b.value === undefined ? b.label : b.value); } }, b.icon ? h('span', { html: ic(b.icon) }) : null, b.label);
      if (b.id) api.buttons[b.id] = btn; foot.appendChild(btn);
    });
    if (!(o.buttons || []).length) foot.hidden = true;
    // The click that dismisses an open popover must not also dismiss the dialog (initDismissal flags it).
    backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop && o.dismiss === 'backdrop' && !swallowBackdrop) api.close(undefined); });
    backdrop.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      const ae = document.activeElement, scope = (ae && ae.closest && ae.closest('.popover')) || el;   // Tab cycles inside an open popover, otherwise inside the dialog
      const f = [].filter.call(scope.querySelectorAll('button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),summary,a[href],[tabindex]'), (n) => n.tabIndex >= 0 && n.getClientRects().length > 0);   // getClientRects: offsetParent is null for fixed popovers
      if (!f.length) { e.preventDefault(); scope.focus(); return; }
      const first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (f.indexOf(a) < 0) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }   // focus on the dialog frame or a roving (tabindex -1) item
      else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
    });
    document.body.appendChild(backdrop); dlgs.push(api);
    RPE.icons.render(backdrop);
    requestAnimationFrame(() => { backdrop.classList.add('is-open'); const f = (o.focus && el.querySelector(o.focus)) || el.querySelector('.btn--primary') || el.querySelector('input,textarea,select,button:not(.dlg__close)') || el; f.focus({ preventScroll: true }); });
    if (o.onOpen) o.onOpen(api);
    return api;
  }
  function confirm(o) {
    return dialog({ title: o.title, icon: o.icon || 'triangle-alert', width: 420, dismiss: 'backdrop', body: h('p', { class: 'dlg__text' }, o.message), focus: '.btn--primary',
      buttons: [{ label: o.cancelLabel || 'Cancel', value: false }, { label: o.confirmLabel || 'OK', kind: o.danger ? 'danger' : 'primary', value: true }] }).done.then((v) => v === true);
  }
  const hasDialog = () => dlgs.length > 0;
  function closeTopDialog() { const d = dlgs[dlgs.length - 1]; if (d) d.close(undefined); }

  /* ---------- toasts ---------- */
  function toast(msg, o) {
    o = o || {}; const host = document.getElementById('toasts'); if (!host) return;
    const kind = o.kind || 'info';
    const icon = { info: 'info', success: 'circle-check', warn: 'triangle-alert' }[kind] || 'info';
    const t = h('div', { class: 'toast toast--' + kind, role: 'status' });
    const dismiss = () => { t.classList.remove('is-in'); setTimeout(() => t.remove(), 160); };
    t.append(h('span', { class: 'toast__icon', html: ic(icon) }), h('span', { class: 'toast__msg' }, msg));
    if (o.action) t.appendChild(h('button', { type: 'button', class: 'toast__action', onclick: () => { o.action.onClick(); dismiss(); } }, o.action.label));
    t.appendChild(h('button', { type: 'button', class: 'toast__x', 'aria-label': 'Dismiss notification', html: ic('x'), onclick: dismiss }));
    host.appendChild(t); RPE.icons.render(t);
    while (host.children.length > 3) host.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('is-in'));
    setTimeout(dismiss, o.duration || 3400);
  }
  /* Non-modal progress chip for a long job: progressChip({ text, onCancel }) -> { el, update(text), remove() }. Chips stack bottom-left
     (above dialogs, so a job started in a dialog stays visible and cancellable after the dialog closes). Cancel disables itself and
     shows "Cancelling…" until the owner calls remove(). Nothing here modifies the document or blocks the editor. */
  function progressChip(o) {
    o = o || {};
    let host = document.getElementById('jobchips');
    if (!host) { host = h('div', { id: 'jobchips', class: 'jobchips' }); document.body.appendChild(host); }
    const txt = h('span', { class: 'jobchip__txt' }, o.text || '');
    const btn = h('button', { type: 'button', class: 'jobchip__x', 'aria-label': 'Cancel: ' + (o.text || 'job') }, 'Cancel');
    const el = h('div', { class: 'jobchip', role: 'status' }, h('span', { class: 'fe__spin', 'aria-hidden': 'true' }), txt, btn);
    let cancelling = false;
    btn.addEventListener('click', () => { if (cancelling) return; cancelling = true; btn.disabled = true; txt.textContent = 'Cancelling…'; if (o.onCancel) o.onCancel(); });
    host.appendChild(el);
    return { el, update(t) { if (!cancelling) txt.textContent = t; }, remove() { el.remove(); } };
  }

  /* ---------- tooltips ---------- */
  function initTooltips() {
    const tip = h('div', { class: 'tooltip', role: 'tooltip' }); document.body.appendChild(tip);
    let timer = null, cur = null;
    const hide = () => { clearTimeout(timer); cur = null; tip.classList.remove('is-on'); };
    const show = (el) => {
      const text = el.getAttribute('data-tip'); if (!text) return;
      tip.innerHTML = esc(text) + (el.dataset.shortcut ? ` <kbd>${esc(el.dataset.shortcut)}</kbd>` : '');
      tip.style.left = '0px'; tip.style.top = '0px'; tip.classList.add('is-on');
      const r = el.getBoundingClientRect(), w = tip.offsetWidth, hh = tip.offsetHeight;
      let y = el.dataset.tipPos === 'top' ? r.top - hh - 6 : r.bottom + 6; if (y + hh > innerHeight - 4) y = r.top - hh - 6;
      tip.style.left = Math.round(Math.min(Math.max(4, r.left + r.width / 2 - w / 2), innerWidth - w - 4)) + 'px'; tip.style.top = Math.round(y) + 'px';
    };
    document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el === cur) return; hide(); if (el && !el.disabled) { cur = el; timer = setTimeout(() => show(el), 520); } });
    document.addEventListener('focusin', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el && el.matches(':focus-visible')) { hide(); cur = el; timer = setTimeout(() => show(el), 260); } });
    ['mousedown', 'keydown', 'scroll', 'focusout'].forEach((n) => document.addEventListener(n, hide, true));
  }

  /* ---------- global dismissal ---------- */
  function initDismissal() {
    document.addEventListener('pointerdown', (e) => {
      if (!pops.length) return;
      if (pops.some((p) => p.anchor && p.anchor.nodeType && p.anchor.contains(e.target))) return;
      const hitPop = e.target.closest('.popover');
      if (hitPop) {
        const idx = pops.findIndex((p) => p.el === hitPop);
        if (idx >= 0) {
          while (pops.length > idx + 1) pops.pop().dispose();
        }
        return;
      }
      if (e.target.classList && e.target.classList.contains('dlg-backdrop')) { swallowBackdrop = true; setTimeout(() => { swallowBackdrop = false; }, 0); }
      closeAll();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (pops.length) {
        e.preventDefault(); e.stopPropagation();
        const last = pops[pops.length - 1], a = last.anchor;
        last.close();
        if (a && a.focus && a.nodeType && document.activeElement && document.activeElement.closest && document.activeElement.closest('.popover')) a.focus();
        return;
      }
    }, true);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !e.defaultPrevented && dlgs.length) { e.preventDefault(); closeTopDialog(); } });
    window.addEventListener('resize', closeAll);
    window.addEventListener('blur', closeAll);
  }

  /* ---------- safe hyperlink opener ---------- */
  function openLink(url) {
    if (!url || typeof url !== 'string') return false;
    const u = url.trim();
    if (!/^(https?:|mailto:)/i.test(u)) return false;
    try {
      const parsed = new URL(u, window.location.href);
      if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return false;
      window.open(u, '_blank', 'noopener,noreferrer');
      return true;
    } catch (e) {
      return false;
    }
  }

  RPE.h = h;
  RPE.openLink = openLink;
  RPE.ui = { h, esc, SHAPES, shapePreview, layoutPreview, themePreview, popover, menu, buildMenu, contextMenu, closeAll, isOpenFor, dialog, confirm, hasDialog, closeTopDialog, toast, progressChip, initTooltips, initDismissal, openLink, hasPopover: () => pops.length > 0, addRecentColor, getRecentColors: () => recentColorsList };
})(window.RPE = window.RPE || {});
