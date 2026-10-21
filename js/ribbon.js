/* ribbon.js — builds the tab row and ribbon from ribbon-config.js, keeps control states in sync with the
   document, collapses groups into dropdowns when space runs out, and powers command search. */
(function (RPE) {
  'use strict';
  const S = RPE.store, ui = S.ui, U = RPE.ui, h = RPE.h, T = RPE.themes, C = RPE.ribbonConfig, ic = RPE.icons.html;
  let tablist, body, ribbonEl, groupEls = [], menuReg = {}, menuN = 0, ctxKey = '';
  const CHEV = ic('chevron-down', 'ic--chev');

  /* ---------- item builders ---------- */
  function baseBtn(it, cls) {
    const b = h('button', { type: 'button', class: 'rbtn ' + cls + (it.accent ? ' rbtn--accent' : ''), 'aria-label': it.label, 'data-tip': it.tip || it.label, 'data-shortcut': it.shortcut || null });
    if (it.gate) b.dataset.gate = it.gate;   // menu buttons: the command whose reason() disables them
    if (it.en) b.dataset.en = it.en; if (it.toggle || it.size === 'icon') b.dataset.toggle = '1';
    return b;
  }
  function wireCmd(b, it) { b.dataset.command = it.cmd; if (it.args) b.dataset.args = JSON.stringify(it.args); }
  function wireMenu(b, it) { const id = 'm' + (++menuN); menuReg[id] = it.menu; b.dataset.menu = id; b.setAttribute('aria-haspopup', 'menu'); b.setAttribute('aria-expanded', 'false'); }
  const sw = (it) => (it.swatch ? `<i class="rbtn__sw" data-swatch="${it.swatch}"></i>` : '');

  function btn(it) {
    const size = it.size;
    if (size === 'lg') {
      if (it.split) {
        const w = h('div', { class: 'rsplit rsplit--lg' });
        const top = baseBtn(it, 'rbtn--lg-top'); wireCmd(top, it); top.innerHTML = ic('' + it.icon);
        const bot = baseBtn(it, 'rbtn--lg-bot'); bot.removeAttribute('data-shortcut'); bot.dataset.tip = it.label + ' options'; wireMenu(bot, it); bot.innerHTML = `<span class="rbtn__label">${U.esc(it.label)}</span>${CHEV}`;
        w.append(top, bot); return w;
      }
      const b = baseBtn(it, 'rbtn--lg'); b.innerHTML = `${ic(it.icon)}<span class="rbtn__label">${U.esc(it.label)}</span>${it.menu ? CHEV : ''}`;
      if (it.menu) wireMenu(b, it); else wireCmd(b, it); return b;
    }
    if (size === 'sm') {
      if (it.split) {
        const w = h('div', { class: 'rsplit rsplit--sm' });
        const m = baseBtn(it, 'rbtn--sm'); wireCmd(m, it); m.innerHTML = `<span class="rbtn__ico">${ic(it.icon)}${sw(it)}</span><span class="rbtn__label">${U.esc(it.label)}</span>`;
        const c = baseBtn(it, 'rbtn--caret'); c.dataset.tip = it.label + ' options'; c.removeAttribute('data-shortcut'); c.setAttribute('aria-label', it.label + ' options'); wireMenu(c, it); c.innerHTML = CHEV;
        w.append(m, c); return w;
      }
      const b = baseBtn(it, 'rbtn--sm'); b.innerHTML = `<span class="rbtn__ico">${ic(it.icon)}</span><span class="rbtn__label">${U.esc(it.label)}</span>${it.menu ? CHEV : ''}`;
      if (it.menu) wireMenu(b, it); else wireCmd(b, it); return b;
    }
    /* icon-only */
    if (it.split) {
      const w = h('div', { class: 'rsplit rsplit--icon' });
      const m = baseBtn(it, 'rbtn--icon'); wireCmd(m, it); m.innerHTML = `<span class="rbtn__ico">${ic(it.icon)}${sw(it)}</span>`;
      const c = baseBtn(it, 'rbtn--caret'); c.dataset.tip = it.label + ' options'; c.removeAttribute('data-shortcut'); c.setAttribute('aria-label', it.label + ' options'); wireMenu(c, it); c.innerHTML = CHEV;
      w.append(m, c); return w;
    }
    const b = baseBtn(it, 'rbtn--icon'); b.innerHTML = ic(it.icon);
    if (it.menu) { wireMenu(b, it); b.innerHTML += CHEV; b.classList.add('rbtn--icon-menu'); } else wireCmd(b, it);
    return b;
  }

  function combo(it) {
    const input = h('input', { class: 'combo__in', 'aria-label': it.label, spellcheck: 'false', autocomplete: 'off', dataset: { combo: it.cmd } });
    const caret = h('button', { type: 'button', class: 'combo__btn', tabindex: '-1', 'aria-label': it.label + ' list', 'aria-haspopup': 'listbox', 'data-tip': it.label, html: ic('chevron-down') });
    const apply = () => { RPE.commands.run(it.cmd, { value: input.value }, 'ribbon'); if (RPE.canvas.editable()) RPE.canvas.focusEdit(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); apply(); } if (e.key === 'ArrowDown') { e.preventDefault(); caret.click(); } });
    input.addEventListener('focus', () => input.select());
    caret.addEventListener('click', () => {
      const opts = it.options === 'fonts' ? T.FONTS.map((f) => ({ label: f.name, font: f.name, cmd: it.cmd, args: { value: f.name }, checked: () => RPE.commands.value(it.cmd) === f.name })) : RPE.commands.SIZES.map((s) => ({ label: String(s), cmd: it.cmd, args: { value: s }, checked: () => RPE.commands.value(it.cmd) === String(s) }));
      U.menu(caret, opts, { class: 'popover--list' });
    });
    return h('div', { class: 'combo', style: { width: it.width + 'px' } }, input, caret);
  }
  function num(it) {
    const input = h('input', { class: 'rnum__in', type: 'number', step: '0.1', min: '0.1', 'aria-label': it.label + ' (inches)', dataset: { num: it.prop } });
    input.addEventListener('change', () => RPE.commands.run(it.cmd, { prop: it.prop, value: input.value }, 'ribbon'));
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
    return h('label', { class: 'rnum', dataset: { en: 'object' } }, h('span', { class: 'rnum__lbl' }, it.label), input, h('span', { class: 'rnum__unit' }, 'in'));
  }
  function templates() {
    const wrap = h('div', { class: 'rtemplates rthemes', role: 'group', 'aria-label': 'Templates' });
    const tpls = (RPE.templates && RPE.templates.list) ? RPE.templates.list() : [];
    tpls.slice(0, 4).forEach((tpl) => {
      const b = h('button', {
        type: 'button',
        class: 'rtemplate rtheme',
        'data-tip': tpl.name,
        'aria-label': tpl.name,
        html: RPE.templates.renderThumbnailSvg ? RPE.templates.renderThumbnailSvg(tpl, 72, 40) : (RPE.ui.themePreview ? RPE.ui.themePreview({ bg: tpl.colors.bg, accent: tpl.colors.accent, accent2: tpl.colors.accent2, title: tpl.colors.text, muted: tpl.colors.muted, border: tpl.colors.border, dark: tpl.dark }) : ''),
        dataset: { command: 'design.template', toggle: '1' }
      });
      b.dataset.args = JSON.stringify({ id: tpl.id });
      b.dataset.templateId = tpl.id;
      wrap.appendChild(b);
    });
    const more = h('button', {
      type: 'button',
      class: 'rtemplate-more rtheme-more',
      'aria-label': 'More templates',
      'data-tip': 'Academic Templates gallery',
      html: ic('chevrons-up-down'),
      onclick: () => {
        if (RPE.templates && RPE.templates.openGallery) {
          RPE.templates.openGallery(more);
        }
      }
    });
    wrap.appendChild(more);
    return wrap;
  }
  function themes() {
    const wrap = h('div', { class: 'rthemes', role: 'group', 'aria-label': 'Themes' });
    T.THEMES.slice(0, 4).forEach((th) => {
      const b = h('button', { type: 'button', class: 'rtheme', 'data-tip': th.name, 'aria-label': th.name, html: RPE.ui.themePreview(th), dataset: { command: 'design.theme', toggle: '1' } }); b.dataset.args = JSON.stringify({ id: th.id }); b.dataset.themeId = th.id; wrap.appendChild(b);
    });
    const more = h('button', { type: 'button', class: 'rtheme-more', 'aria-label': 'More themes', 'data-tip': 'All themes', html: ic('chevrons-up-down') });
    menuReg['themes'] = () => ({ kind: 'gallery', cols: 3, head: 'Academic themes', items: T.THEMES.map((th) => ({ label: th.name, cmd: 'design.theme', args: { id: th.id }, preview: 'theme:' + th.id, checked: S.doc.themeId === th.id })) });
    more.dataset.menu = 'themes'; wrap.appendChild(more); return wrap;
  }
  function build(it) {
    switch (it.t) {
      case 'btn': return btn(it);
      case 'combo': return combo(it);
      case 'num': return num(it);
      case 'templates': return templates();
      case 'themes': return themes();
      case 'vsep': return h('span', { class: 'rvsep', role: 'separator' });
      case 'stack': return h('div', { class: 'rstack' }, it.items.map(build));
      case 'row': return h('div', { class: 'rrow' }, it.items.map(build));
      default: return h('span');
    }
  }
  const content = (g) => h('div', { class: 'rgroup__content' }, g.items.map(build));

  function group(g) {
    const el = h('div', { class: 'rgroup' + (g.accent ? ' rgroup--accent' : ''), role: 'group', 'aria-label': g.label, dataset: { group: g.id } });
    const full = content(g), label = h('div', { class: 'rgroup__label' }, g.label);
    const collapsed = h('button', { type: 'button', class: 'rbtn rbtn--lg rbtn--collapsed', 'aria-label': g.label, 'aria-haspopup': 'true', 'aria-expanded': 'false', 'data-tip': g.label, html: `${ic(g.icon || 'layers')}<span class="rbtn__label">${U.esc(g.label)}</span>${CHEV}` });
    RPE.icons.render(collapsed);
    collapsed.addEventListener('click', () => {
      if (U.isOpenFor(collapsed)) { U.closeAll(); return; }
      const pop = h('div', { class: 'rgroup-pop' }, content(g), h('div', { class: 'rgroup__label' }, g.label));
      U.popover(collapsed, pop, { class: 'popover--group', role: 'group' }); RPE.icons.render(pop); refresh();
    });
    el.append(full, label);
    return {
      el, full, label, collapsed,
      expand() { if (el.classList.contains('is-collapsed')) { el.classList.remove('is-collapsed'); el.replaceChildren(full, label); } },
      collapse() { if (!el.classList.contains('is-collapsed')) { el.classList.add('is-collapsed'); el.replaceChildren(collapsed); RPE.icons.render(collapsed); } }
    };
  }

  function activeDef() { return C.TABS.concat(C.CONTEXT).find((t) => t.id === ui.activeTab) || C.TABS[1]; }
  function renderRibbon() {
    const def = activeDef(); if (def.backstage) return;
    menuReg = {}; menuN = 0; body.replaceChildren(); groupEls = [];
    ribbonEl.setAttribute('aria-labelledby', 'tab-' + def.id);
    def.groups.forEach((g) => { const ge = group(g); groupEls.push(ge); body.appendChild(ge.el); });
    RPE.icons.render(body); fit(); refresh();
  }
  function fit() {
    if (!body || !groupEls.length) return;
    groupEls.forEach((g) => g.expand());
    for (let i = groupEls.length - 1; i >= 0 && body.scrollWidth > body.clientWidth + 1; i--) groupEls[i].collapse();
  }

  /* ---------- tabs ---------- */
  function renderTabs() {
    const kind = RPE.commands.selectionKind(), ctx = kind ? C.CONTEXT.filter((t) => t.for.includes(kind)) : [];
    const key = ctx.map((t) => t.id).join(',');
    if (!ctx.some((t) => t.id === ui.activeTab) && C.CONTEXT.some((t) => t.id === ui.activeTab)) { S.setUI({ activeTab: 'home' }); return; }
    if (key !== ctxKey || !tablist.children.length) {
      ctxKey = key; tablist.replaceChildren();
      C.TABS.concat(ctx).forEach((t) => {
        const isCtx = C.CONTEXT.includes(t);
        tablist.appendChild(h('button', { type: 'button', role: 'tab', id: 'tab-' + t.id, class: 'tab' + (t.backstage ? ' tab--file' : '') + (isCtx ? ' tab--ctx' : ''), dataset: { tab: t.id }, 'aria-selected': 'false', tabindex: '-1' }, t.label));
      });
    }
    [].forEach.call(tablist.children, (b) => { const on = b.dataset.tab === ui.activeTab; b.classList.toggle('is-active', on); b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1; });
  }
  function onTab(e) {
    const b = e.target.closest('.tab'); if (!b) return; const id = b.dataset.tab;
    if (id === 'file') { RPE.commands.run('file.backstage', { panel: 'new' }, 'tab'); return; }
    if (ui.ribbonCollapsed) { if (ui.ribbonPeek && ui.activeTab === id) S.setUI({ ribbonPeek: false }); else S.setUI({ activeTab: id, ribbonPeek: true }); return; }
    if (ui.activeTab !== id) S.setUI({ activeTab: id });
  }

  /* ---------- state refresh ---------- */
  let queued = false;
  function refresh() { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; refreshNow(); }); }
  function refreshNow() {
    const C2 = RPE.commands;
    document.querySelectorAll('[data-command],[data-en],[data-gate]').forEach((el) => {
      const id = el.dataset.command || el.dataset.gate; let args = null; if (el.dataset.args) { try { args = JSON.parse(el.dataset.args); } catch (e) { args = null; } }
      let ok = id ? C2.isEnabled(id, args) : true;
      if (ok && el.dataset.en) ok = !!C2.when[el.dataset.en]();
      /* A command that explains itself (reason) stays focusable: aria-disabled + tooltip text instead of a dead disabled button. */
      const why = !ok && id ? C2.reason(id, args) : '';
      if (why) { if (el.dataset.tip0 === undefined) el.dataset.tip0 = el.dataset.tip || ''; el.dataset.tip = [el.dataset.tip0.split('\n')[0], why].filter(Boolean).join('\n'); }
      else if (el.dataset.tip0 !== undefined) { el.dataset.tip = el.dataset.tip0; delete el.dataset.tip0; }
      if (why) { if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') el.disabled = false; el.classList.add('is-disabled'); el.setAttribute('aria-disabled', 'true'); }
      else { el.removeAttribute('aria-disabled'); if (el.tagName === 'BUTTON' || el.tagName === 'INPUT') { el.disabled = !ok; el.classList.toggle('is-disabled', false); } else el.classList.toggle('is-disabled', !ok); }
      if (id && (el.dataset.toggle || el.classList.contains('menu__item'))) { const on = C2.isChecked(id, args); el.classList.toggle('is-on', on); if (el.dataset.toggle) el.setAttribute('aria-pressed', String(on)); }
      if (el.dataset.themeId) { const on = S.doc.themeId === el.dataset.themeId; el.classList.toggle('is-on', on); el.setAttribute('aria-pressed', String(on)); }
      if (el.dataset.templateId) { const on = (S.doc.templateId || S.doc.themeId) === el.dataset.templateId; el.classList.toggle('is-on', on); el.setAttribute('aria-pressed', String(on)); }
    });
    document.querySelectorAll('[data-combo]').forEach((i) => { if (document.activeElement !== i) i.value = C2.value(i.dataset.combo); i.disabled = !C2.when.text(); });
    document.querySelectorAll('[data-num]').forEach((i) => { if (document.activeElement !== i) i.value = C2.value('object.' + i.dataset.num); i.disabled = !C2.when.object(); });
    document.querySelectorAll('[data-swatch]').forEach((i) => i.style.setProperty('--sw', C2.swatch(i.dataset.swatch)));
  }

  /* ---------- global click dispatch ---------- */
  function onClick(e) {
    const m = e.target.closest('[data-menu]');
    if (m && !m.disabled && !m.classList.contains('is-disabled')) {
      const def = menuReg[m.dataset.menu]; if (!def) return;
      U.menu(m, def, { focusFirst: e.detail === 0 }); RPE.icons.render(document.querySelector('.popover:last-of-type')); refresh(); return;
    }
    const c = e.target.closest('[data-command]');
    if (c && !c.disabled && !c.classList.contains('is-disabled')) {
      let args = null; if (c.dataset.args) { try { args = JSON.parse(c.dataset.args); } catch (err) { args = null; } }
      RPE.commands.run(c.dataset.command, args, 'ui');
      if (ui.ribbonPeek && c.closest('.ribbon') && !c.dataset.menu) S.setUI({ ribbonPeek: false });
    }
  }

  /* ---------- command search ---------- */
  let index = null;
  const EXTRA = [
    { label: 'Undo', cmd: 'app.undo', icon: 'undo-2', path: 'Quick Access' }, { label: 'Redo', cmd: 'app.redo', icon: 'redo-2', path: 'Quick Access' }, { label: 'Save', cmd: 'file.save', icon: 'save', path: 'File' },
    { label: 'Duplicate Slide', cmd: 'slide.duplicate', icon: 'copy-plus', path: 'Slides' }, { label: 'Delete Slide', cmd: 'slide.delete', icon: 'trash-2', path: 'Slides' },
    { label: 'Toggle Notes Pane', cmd: 'view.notes', icon: 'sticky-note', path: 'View' }, { label: 'Show Comments', cmd: 'view.comments', icon: 'message-square', path: 'Review' },
    { label: 'Download Project File (.json)', cmd: 'file.exportJson', icon: 'download', path: 'File › Export' }, { label: 'Preferences', cmd: 'file.prefs', icon: 'settings', path: 'File' }, { label: 'About', cmd: 'file.about', icon: 'info', path: 'File' },
    { label: 'Keyboard Shortcuts', cmd: 'app.shortcuts', icon: 'keyboard', path: 'Help' }, { label: 'Slide Sorter View', cmd: 'view.mode', args: { mode: 'sorter' }, icon: 'layout-grid', path: 'View' }, { label: 'Normal View', cmd: 'view.mode', args: { mode: 'normal' }, icon: 'panel-left', path: 'View' }
  ];
  function buildIndex() {
    const out = [], seen = new Set();
    const push = (e) => { const k = e.label + e.cmd + JSON.stringify(e.args || {}); if (!seen.has(k)) { seen.add(k); out.push(e); } };
    const walk = (items, path, tab) => items.forEach((it) => {
      if (it.t === 'stack' || it.t === 'row') return walk(it.items, path, tab);
      if (it.t !== 'btn') return;
      if (it.menu) { let m = it.menu; if (typeof m === 'function') { try { m = m(); } catch (e) { m = null; } } (Array.isArray(m) ? m : (m && m.items) || []).forEach((mi) => { if (mi.cmd && mi.label) push({ label: mi.label, cmd: mi.cmd, args: mi.args, path: path + ' › ' + it.label, icon: mi.icon || it.icon, tab }); }); }
      if (it.cmd && !(it.menu && !it.split)) push({ label: it.label, cmd: it.cmd, args: it.args, path, icon: it.icon, en: it.en, tab });
    });
    C.TABS.concat(C.CONTEXT).forEach((t) => (t.groups || []).forEach((g) => walk(g.items, t.label + ' › ' + g.label, t.id)));
    EXTRA.forEach(push); return out;
  }
  function initSearch() {
    const input = document.getElementById('cmdSearch'), box = document.getElementById('cmdResults'); let results = [], cur = 0;
    const close = () => { box.hidden = true; input.setAttribute('aria-expanded', 'false'); };
    function draw() {
      const q = input.value.trim().toLowerCase(); if (!q) { close(); return; }
      index = index || buildIndex(); const toks = q.split(/\s+/);
      results = index.map((e) => { const l = e.label.toLowerCase(), p = e.path.toLowerCase(); if (!toks.every((t) => l.includes(t) || p.includes(t))) return null; return { e, s: (l.startsWith(q) ? 0 : l.includes(q) ? 1 : 2) }; }).filter(Boolean).sort((a, b) => a.s - b.s).slice(0, 8).map((r) => r.e);
      cur = 0; box.replaceChildren();
      if (!results.length) box.appendChild(h('div', { class: 'search-empty' }, 'No matching commands'));
      results.forEach((r, i) => {
        const ok = RPE.commands.isEnabled(r.cmd, r.args) && (!r.en || RPE.commands.when[r.en]());
        box.appendChild(h('button', { type: 'button', role: 'option', class: 'search-item' + (i === 0 ? ' is-cur' : ''), disabled: !ok, 'aria-selected': String(i === 0), dataset: { i }, html: `${ic(r.icon || 'command')}<span class="search-item__label">${U.esc(r.label)}</span><span class="search-item__path">${ok ? U.esc(r.path) : 'Select an object first'}</span>` }));
      });
      RPE.icons.render(box); box.hidden = false; input.setAttribute('aria-expanded', 'true');
    }
    const mark = () => [].forEach.call(box.querySelectorAll('.search-item'), (b, i) => { b.classList.toggle('is-cur', i === cur); b.setAttribute('aria-selected', String(i === cur)); });
    function invoke(r) { if (!r) return; close(); input.value = ''; input.blur(); if (r.tab && !r.cmd) return; RPE.commands.run(r.cmd, r.args || {}, 'search'); }
    input.addEventListener('input', () => { index = null; draw(); });
    input.addEventListener('focus', draw);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(results.length - 1, cur + 1); mark(); } else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(0, cur - 1); mark(); }
      else if (e.key === 'Enter') { e.preventDefault(); invoke(results[cur]); }
      else if (e.key === 'Escape') { input.value = ''; close(); input.blur(); }
    });
    box.addEventListener('mousedown', (e) => e.preventDefault());
    box.addEventListener('click', (e) => { const b = e.target.closest('.search-item'); if (b && !b.disabled) { if (e.target.closest('.search-item__path') && results[+b.dataset.i].tab) { const r = results[+b.dataset.i]; close(); input.value = ''; S.setUI({ activeTab: r.tab, ribbonPeek: ui.ribbonCollapsed }); } else invoke(results[+b.dataset.i]); } });
    input.addEventListener('blur', () => setTimeout(close, 120));
  }

  function init() {
    tablist = document.getElementById('tablist'); body = document.getElementById('ribbonBody'); ribbonEl = document.getElementById('ribbon');
    tablist.addEventListener('click', onTab);
    tablist.addEventListener('dblclick', (e) => { if (e.target.closest('.tab') && !e.target.closest('.tab--file')) RPE.commands.run('view.collapseRibbon', {}, 'tab'); });
    tablist.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; const tabs = [].slice.call(tablist.children), i = tabs.indexOf(document.activeElement); if (i < 0) return;
      const n = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length]; n.focus(); if (n.dataset.tab !== 'file') n.click();
    });
    document.addEventListener('click', onClick);
    document.addEventListener('mousedown', (e) => { if (e.target.closest('.ribbon .rbtn, .ribbon .combo__btn, .ribbon .rtheme, .ribbon .rtheme-more, .titlebar .tbtn, .statusbar .sbtn, .tab')) e.preventDefault(); });
    new ResizeObserver(() => fit()).observe(body);
    const onAny = () => refresh();
    RPE.bus.on('doc', onAny); RPE.bus.on('editsel', onAny); RPE.bus.on('backend:status', onAny);
    RPE.bus.on('ui', (e) => {
      const c = e.changed;
      if (c.includes('selectedIds') || c.includes('activeSlideId') || c.includes('activeTab')) renderTabs();
      if (c.includes('activeTab')) renderRibbon();
      refresh();
    });
    renderTabs(); renderRibbon(); initSearch();
  }
  RPE.ribbon = { init, refresh, renderRibbon, fit, renderTabs };
})(window.RPE = window.RPE || {});
