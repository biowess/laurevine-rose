/* layouts.js — the shared slide-layout catalog (single source for Home > New Slide, Design > Layouts and the picker thumbnails).

   26 distinct layout types, deduplicated from what the 10 academic templates actually build (all share one 26-slide skeleton:
   kicker + title + accent rule + content region from y=160; cards / numbered rows / full-bleed accent slides for dividers and quotes).
   Every generator emits ordinary editable objects (text / shape / image / table) at the 1280x720 design grid, scaled to doc.size.
   Colours are theme TOKENS of the deck's CURRENT palette (accent, title, text, muted, surface, border, card, onAccent), fonts are
   never set (text follows its role in the deck's current typography preset), and text boxes are EMPTY placeholders: the prompt
   shown in the editor comes from `slot` (see PROMPTS). Decoration shapes carry slot 'deco' so applying another layout can
   remove them without ever touching user content. Pure data + small helpers; no DOM access. */
(function (RPE) {
  'use strict';
  const T = RPE.themes || {};
  const uid = (p) => (RPE.store && RPE.store.uid) ? RPE.store.uid(p) : p + '_' + Math.random().toString(36).slice(2, 8);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const strip = (h) => String(h == null ? '' : h).replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();

  /* Editor hint text per placeholder slot (renderer: PROMPTS[slot] || PROMPTS[role]). */
  const PROMPTS = {
    kicker: 'Add section label', title: 'Click to add title', subtitle: 'Click to add subtitle', body: 'Click to add text',
    caption: 'Click to add caption', meta1: 'Add presenter and affiliation', meta2: 'Add event and date', sectionNo: 'Add section number',
    colHeading: 'Add heading', colTitle: 'Add heading', colText: 'Add description', colItems: 'Add key points',
    itemTitle: 'Add title', itemText: 'Add description', number: 'No.', value: 'Add value', when: 'Add date',
    stat: 'Add key figure', statLabel: 'Add label', statDetail: 'Add detail', takeaway: 'Add takeaway',
    panelTitle: 'Add panel heading', author: 'Add attribution', name: 'Add name', roleLine: 'Add role',
    contact: 'Add contact details', notes: 'Add acknowledgements', references: 'Add references', category: 'Add category',
    figure: 'Figure placeholder'
  };
  if (T.PROMPTS) Object.keys(PROMPTS).forEach((k) => { if (!T.PROMPTS[k]) T.PROMPTS[k] = PROMPTS[k]; });

  /* ---------- theme tokens of the CURRENT deck ---------- */
  function theme(doc) { return (T.theme ? T.theme(doc) : null) || {}; }
  const lum = (hex) => {
    const c = (T.hexToRgb ? T.hexToRgb(hex) : [0, 0, 0]).map((v) => { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
    return .2126 * c[0] + .7152 * c[1] + .0722 * c[2];
  };
  const mix = (a, b, t) => { const A = T.hexToRgb(a), B = T.hexToRgb(b); return T.rgbToHex(A[0] + (B[0] - A[0]) * t, A[1] + (B[1] - A[1]) * t, A[2] + (B[2] - A[2]) * t); };
  /* Token names the renderer/exporter resolve for this deck; where a deck has no persisted palette (surface/border/card/onAccent
     tokens absent) the value is derived from the deck's current theme colours instead. */
  function tokens(doc) {
    const th = theme(doc), bg = th.bg || '#FFFFFF', nb = th.neutrals || [];
    return {
      accent: 'accent', accent2: 'accent2', text: 'text', title: 'title', muted: 'muted', bg: 'bg',
      surface: th.surface ? 'surface' : (nb[2] || mix(bg, th.text || '#000000', .06)),
      border: th.border ? 'border' : mix(bg, th.muted || '#888888', .4),
      card: th.card ? 'card' : bg,
      onAccent: th.onAccent ? 'onAccent' : (lum(th.accent || '#000000') > .5 ? '#111111' : '#FFFFFF')
    };
  }
  /* token name or hex -> hex (thumbnails) */
  const NAMES = ['accent', 'accent2', 'text', 'title', 'muted', 'bg', 'surface', 'border', 'card', 'onAccent'];
  function colorOf(doc, c) {
    if (!c || c === 'transparent') return null;
    return NAMES.includes(c) ? (theme(doc)[c] || '#888888') : c;
  }

  /* ---------- generator context ---------- */
  function ctx(doc) {
    const size = (doc && doc.size) || { w: 1280, h: 720 };
    const W = size.w, H = size.h, sx = W / 1280, sy = H / 720, fk = Math.min(1, sx), tk = tokens(doc), objs = [];
    const box = (x, y, w, h) => {
      let X = clamp(Math.round(x * sx), 0, W - 1), Y = clamp(Math.round(y * sy), 0, H - 1);
      return { x: X, y: Y, w: Math.max(1, Math.min(Math.round(w * sx), W - X)), h: Math.max(1, Math.min(Math.round(h * sy), H - Y)) };
    };
    const c = { W, H, tk, objs };
    c.shape = (kind, x, y, w, h, o) => { o = o || {}; objs.push(Object.assign({ id: uid('o'), type: 'shape', shape: kind, slot: 'deco' }, box(x, y, w, h), { fill: o.fill || tk.accent, stroke: o.stroke || 'transparent', strokeWidth: o.stroke ? 1 : 0, html: '', fontSize: 16, align: 'center', vAlign: 'middle', lineHeight: 1.2 })); };
    c.rule = (x, y, w, h, fill) => c.shape('rect', x, y, w, h, { fill: fill || tk.accent });
    c.card = (x, y, w, h, fill) => c.shape('rect', x, y, w, h, { fill: fill || tk.card, stroke: tk.border });
    c.t = (role, slot, x, y, w, h, o) => {
      o = o || {};
      const t = Object.assign({ id: uid('o'), type: 'text', role, slot }, box(x, y, w, h), { html: '', fontSize: Math.max(9, Math.round((o.fs || 16) * fk)), align: o.align || 'left', vAlign: o.v || 'top', lineHeight: o.lh || 1.2, color: o.color || tk.text, list: o.list || null });
      if (o.bold && !['kicker', 'title', 'subtitle', 'meta', 'caption'].includes(role)) t.bold = true;   // known roles follow the typography preset
      objs.push(t);
    };
    c.fig = (x, y, w, h, slot) => { const b = box(x, y, w, h); objs.push(Object.assign({ id: uid('o'), type: 'image', role: 'figure', slot: slot || 'figure', name: 'Figure placeholder', alt: '', src: null }, b, { aspect: +(b.w / b.h).toFixed(3) })); };
    c.table = (x, y, w, h, rows, cols) => {
      const cells = []; for (let r = 0; r < rows; r++) { cells.push([]); for (let k = 0; k < cols; k++) cells[r].push(r === 0 ? 'Column ' + (k + 1) : ''); }
      objs.push(Object.assign({ id: uid('o'), type: 'table', slot: 'table' }, box(x, y, w, h), { headerRow: true, banded: true, fontSize: Math.max(10, Math.round(16 * fk)), cells }));
    };
    /* shared content-slide head: kicker + title + accent rule (the skeleton every template uses) */
    c.head = () => {
      c.t('kicker', 'kicker', 72, 44, 1000, 24, { fs: 12, color: tk.accent, bold: true });
      c.t('title', 'title', 72, 68, 1136, 52, { fs: 32, v: 'middle', color: tk.title });
      c.rule(72, 126, 64, 3);
    };
    /* heading + text inside a card (itemTitle / itemText) */
    c.item = (x, y, w, ht, hd, bd, tfs, bfs) => {
      c.t('body', 'itemTitle', x, y, w, ht, { fs: tfs || 15, bold: true, color: tk.accent });
      c.t('body', 'itemText', x, y + ht + 4, w, hd, { fs: bfs || 13 });
    };
    return c;
  }

  /* ---------- the 26 layouts ---------- */
  const DEFS = [];
  function def(id, name, category, rank, build, layout) { DEFS.push({ id, name, category, rank, primary: rank <= 12, layout: layout || id, build }); }
  const cols5 = (i) => 72 + i * 230.5;   // five equal columns, 214 wide, gap 16.5

  def('blank', 'Blank', 'Basic', 4, () => {});

  def('title', 'Title Slide', 'Opening', 1, (c) => {
    const k = c.tk;
    c.rule(72, 140, 72, 4);
    c.t('kicker', 'kicker', 72, 160, 1000, 26, { fs: 13, color: k.accent, bold: true });
    c.t('title', 'title', 72, 196, 1100, 140, { fs: 40, color: k.title, lh: 1.15 });
    c.t('subtitle', 'subtitle', 72, 352, 1000, 60, { fs: 20, color: k.muted });
    c.rule(72, 450, 1136, 1, k.border);
    c.t('meta', 'meta1', 72, 480, 520, 110, { fs: 16 });
    c.t('meta', 'meta2', 640, 480, 520, 110, { fs: 16 });
  });

  def('section', 'Section Divider', 'Opening', 3, (c) => {
    const k = c.tk;
    c.rule(0, 0, 1280, 720, k.accent);
    c.t('kicker', 'sectionNo', 140, 180, 1000, 32, { fs: 16, color: k.onAccent, bold: true });
    c.t('title', 'title', 140, 230, 1000, 110, { fs: 44, color: k.onAccent, lh: 1.1 });
    c.t('subtitle', 'subtitle', 140, 360, 880, 90, { fs: 20, color: k.onAccent });
  });

  def('titleContent', 'Title and Content', 'Content', 2, (c) => {
    c.head();
    c.t('body', 'body', 72, 160, 1136, 490, { fs: 20, list: 'bullet', lh: 1.25 });
  });

  def('twoContent', 'Two Columns', 'Content', 5, (c) => {
    c.head();
    [0, 1].forEach((i) => {
      const x = 72 + i * 586;
      c.card(x, 160, 550, 490); c.rule(x, 160, 550, 4);
      c.t('body', 'colHeading', x + 20, 176, 510, 32, { fs: 16, bold: true, color: c.tk.title });
      c.rule(x + 20, 214, 510, 1, c.tk.border);
      c.t('body', 'body', x + 20, 226, 510, 410, { fs: 18, list: 'bullet', lh: 1.25 });
    });
  });

  def('threePart', 'Three Columns', 'Content', 8, (c) => {
    c.head();
    [0, 1, 2].forEach((i) => {
      const x = 72 + i * 392;
      c.card(x, 160, 360, 490); c.rule(x, 160, 360, 48);
      c.t('body', 'colTitle', x + 16, 166, 328, 36, { fs: 14, bold: true, color: c.tk.onAccent, v: 'middle' });
      c.t('body', 'colText', x + 20, 224, 320, 110, { fs: 14 });
      c.rule(x + 20, 354, 320, 1, c.tk.border);
      c.t('body', 'colItems', x + 20, 372, 320, 260, { fs: 14, color: c.tk.muted, list: 'bullet' });
    });
  });

  def('titleFigure', 'Figure', 'Figures & Data', 6, (c) => {
    c.head();
    c.fig(72, 160, 1136, 450);
    c.t('caption', 'caption', 72, 622, 1136, 40, { fs: 13, color: c.tk.muted });
  });

  def('contentFigure', 'Content with Figure', 'Figures & Data', 7, (c) => {
    c.head();
    c.t('body', 'body', 72, 160, 520, 490, { fs: 20, list: 'bullet', lh: 1.25 });
    c.fig(624, 160, 584, 490);
  });

  def('figureInsights', 'Figure + 3 Points', 'Figures & Data', 10, (c) => {
    c.head();
    c.fig(72, 160, 740, 480);
    [0, 1, 2].forEach((i) => {
      const y = 160 + i * 150;
      c.card(836, y, 372, 130); c.rule(836, y, 5, 130);
      c.item(858, y + 10, 336, 26, 82, null, 14, 13);
    });
  });

  def('chartText', 'Chart + Two Notes', 'Figures & Data', 19, (c) => {
    c.head();
    c.fig(72, 160, 700, 480);
    [0, 1].forEach((i) => {
      const y = 160 + i * 250;
      c.card(800, y, 408, 230); c.rule(800, y, 408, 4);
      c.t('body', 'colHeading', 820, y + 16, 368, 28, { fs: 14, bold: true, color: c.tk.accent });
      c.t('body', 'colText', 820, y + 50, 368, 166, { fs: 13 });
    });
  });

  def('table', 'Table', 'Figures & Data', 9, (c) => {
    c.head();
    c.table(72, 170, 1136, 400, 5, 4);
  });

  def('agenda', 'Agenda', 'Structure', 11, (c) => {
    c.head();
    for (let i = 0; i < 5; i++) {
      const y = 160 + i * 98;
      c.card(72, y, 1136, 84); c.rule(72, y, 64, 84);
      c.t('title', 'number', 72, y, 64, 84, { fs: 22, color: c.tk.onAccent, align: 'center', v: 'middle' });
      c.t('body', 'itemTitle', 160, y + 10, 1000, 32, { fs: 18, bold: true, color: c.tk.title });
      c.t('body', 'itemText', 160, y + 44, 1000, 30, { fs: 13, color: c.tk.muted });
    }
  });

  def('objectives', 'Objectives', 'Structure', 16, (c) => {
    c.head();
    for (let i = 0; i < 4; i++) {
      const y = 160 + i * 122;
      c.card(72, y, 1136, 106); c.rule(72, y, 6, 106);
      c.t('body', 'itemTitle', 100, y + 12, 1080, 28, { fs: 16, bold: true, color: c.tk.accent });
      c.t('body', 'itemText', 100, y + 46, 1080, 50, { fs: 14 });
    }
  });

  def('statistic', 'Key Statistic', 'Content', 15, (c) => {
    const k = c.tk;
    c.card(72, 60, 1136, 600);
    c.t('kicker', 'kicker', 120, 100, 1040, 24, { fs: 12, color: k.accent, bold: true });
    c.rule(120, 134, 1040, 2);
    c.t('title', 'stat', 120, 170, 480, 100, { fs: 84, color: k.accent, v: 'middle', lh: 1 });
    c.t('body', 'statLabel', 120, 282, 480, 40, { fs: 18, bold: true, color: k.title });
    c.t('body', 'statDetail', 120, 336, 480, 70, { fs: 14, color: k.muted });
    c.t('body', 'body', 640, 170, 520, 260, { fs: 16, lh: 1.3 });
    c.rule(120, 470, 1040, 140, k.surface);
    c.t('body', 'takeaway', 141, 484, 998, 112, { fs: 16, lh: 1.3 });
  });

  def('process', 'Process Steps', 'Structure', 13, (c) => {
    c.head();
    c.rule(94, 189, 1092, 2, c.tk.border);
    for (let i = 0; i < 5; i++) {
      const x = cols5(i);
      c.shape('ellipse', x, 168, 44, 44, { fill: c.tk.accent });
      c.t('title', 'number', x, 168, 44, 44, { fs: 16, color: c.tk.onAccent, align: 'center', v: 'middle' });
      c.card(x, 230, 214, 400);
      c.t('body', 'itemTitle', x + 14, 244, 186, 50, { fs: 15, bold: true, color: c.tk.accent });
      c.t('body', 'itemText', x + 14, 300, 186, 316, { fs: 13 });
    }
  });

  def('timeline', 'Timeline', 'Structure', 14, (c) => {
    c.head();
    c.rule(72, 299, 1136, 3, c.tk.border);
    for (let i = 0; i < 5; i++) {
      const x = cols5(i);
      c.t('title', 'when', x, 236, 214, 44, { fs: 20, color: c.tk.accent, v: 'bottom' });
      c.shape('ellipse', x, 290, 22, 22, { fill: c.tk.accent });
      c.t('body', 'itemTitle', x, 332, 214, 32, { fs: 15, bold: true, color: c.tk.title });
      c.t('body', 'itemText', x, 370, 214, 250, { fs: 13 });
    }
  });

  def('flow', 'Flow + Notes', 'Structure', 22, (c) => {
    c.head();
    for (let i = 0; i < 5; i++) {
      const y = 160 + i * 98;
      c.card(72, y, 560, 80, i === 2 ? c.tk.surface : c.tk.card);
      if (i < 4) c.rule(351, y + 80, 2, 18);
      c.t('body', 'itemTitle', 86, y + 9, 340, 26, { fs: 16, bold: true, color: c.tk.title });
      c.t('body', 'itemText', 86, y + 38, 400, 34, { fs: 12, color: c.tk.muted });
      c.t('body', 'value', 470, y + 18, 150, 32, { fs: 16, bold: true, color: c.tk.accent, align: 'right' });
    }
    c.card(664, 160, 544, 472); c.rule(664, 160, 544, 40);
    c.t('body', 'panelTitle', 684, 166, 504, 28, { fs: 14, bold: true, color: c.tk.onAccent, v: 'middle' });
    c.t('body', 'body', 684, 216, 504, 400, { fs: 14, lh: 1.3 });
  });

  def('concepts', 'Four Concepts', 'Structure', 23, (c) => {
    c.head();
    for (let i = 0; i < 4; i++) {
      const x = 72 + i * 288;
      c.card(x, 160, 272, 190); c.rule(x, 160, 272, 4);
      c.t('body', 'itemTitle', x + 16, 176, 240, 40, { fs: 15, bold: true, color: c.tk.accent });
      c.t('body', 'itemText', x + 16, 222, 240, 116, { fs: 13 });
    }
    c.card(72, 372, 1136, 268); c.rule(72, 372, 1136, 40);
    c.t('body', 'panelTitle', 92, 378, 1096, 28, { fs: 14, bold: true, color: c.tk.onAccent, v: 'middle' });
    c.t('body', 'body', 92, 426, 1096, 200, { fs: 14, lh: 1.3 });
  });

  def('balance', 'Strengths & Limitations', 'Content', 20, (c) => {
    c.head();
    [0, 1].forEach((i) => {
      const x = 72 + i * 580;
      c.card(x, 160, 556, 490);
      c.shape('rect', x, 160, 556, 48, i === 0 ? { fill: c.tk.accent } : { fill: c.tk.surface, stroke: c.tk.accent });
      c.t('body', 'colTitle', x + 20, 166, 516, 36, { fs: 14, bold: true, color: i === 0 ? c.tk.onAccent : c.tk.title, v: 'middle' });
      c.t('body', 'body', x + 20, 224, 516, 410, { fs: 16, list: 'bullet', lh: 1.25 });
    });
  });

  def('quote', 'Quote', 'Opening', 17, (c) => {
    const k = c.tk;
    c.rule(0, 0, 1280, 720, k.accent);
    c.objs.push(Object.assign({ id: uid('o'), type: 'text', role: 'title', slot: 'deco' }, { x: Math.round(140 * c.W / 1280), y: Math.round(130 * c.H / 720), w: Math.round(100 * c.W / 1280), h: Math.round(90 * c.H / 720) }, { html: '\u201C', fontSize: Math.max(9, Math.round(80 * Math.min(1, c.W / 1280))), align: 'left', vAlign: 'top', lineHeight: 1, color: k.onAccent, list: null }));
    c.t('title', 'body', 140, 230, 1000, 220, { fs: 28, color: k.onAccent, lh: 1.3 });
    c.t('subtitle', 'author', 140, 505, 1000, 40, { fs: 18, color: k.onAccent });
  });

  def('takeaways', 'Key Takeaways', 'Structure', 12, (c) => {
    c.head();
    for (let i = 0; i < 3; i++) {
      const y = 160 + i * 160;
      c.card(72, y, 1136, 140); c.rule(72, y, 72, 140);
      c.t('title', 'number', 72, y, 72, 140, { fs: 28, color: c.tk.onAccent, align: 'center', v: 'middle' });
      c.t('body', 'itemTitle', 168, y + 16, 1020, 32, { fs: 18, bold: true, color: c.tk.title });
      c.t('body', 'itemText', 168, y + 56, 1020, 72, { fs: 14 });
    }
  });

  def('team', 'Team', 'Content', 24, (c) => {
    c.head();
    for (let i = 0; i < 4; i++) {
      const x = 72 + i * 290;
      c.card(x, 160, 266, 480);
      c.fig(x + 63, 182, 140, 140, 'photo');
      c.t('body', 'name', x + 14, 338, 238, 28, { fs: 16, bold: true, color: c.tk.title, align: 'center' });
      c.t('body', 'roleLine', x + 14, 370, 238, 24, { fs: 13, color: c.tk.accent, align: 'center' });
      c.t('body', 'itemText', x + 14, 404, 238, 220, { fs: 12, color: c.tk.muted, align: 'center' });
    }
  });

  def('closing', 'Questions / Closing', 'Opening', 18, (c) => {
    const k = c.tk;
    c.card(72, 60, 1136, 600);
    c.t('kicker', 'kicker', 120, 120, 1040, 24, { fs: 12, color: k.accent, bold: true });
    c.t('title', 'title', 120, 160, 1040, 80, { fs: 44, color: k.title, v: 'middle' });
    c.rule(120, 250, 1040, 2);
    c.t('body', 'contact', 120, 280, 520, 180, { fs: 16, lh: 1.3 });
    c.t('body', 'notes', 660, 280, 500, 280, { fs: 14, color: k.muted, lh: 1.3 });
  });

  def('references', 'References', 'Content', 21, (c) => {
    c.head();
    c.card(72, 160, 1136, 480);
    c.t('body', 'references', 100, 182, 1080, 440, { fs: 14, list: 'number', lh: 1.3 });
  });

  def('appendix', 'Appendix Grid', 'Content', 25, (c) => {
    c.head();
    for (let i = 0; i < 4; i++) {
      const x = 72 + (i % 2) * 580, y = 160 + Math.floor(i / 2) * 250;
      c.card(x, y, 556, 230); c.rule(x, y, 556, 4);
      c.t('body', 'category', x + 20, y + 16, 516, 22, { fs: 11, bold: true, color: c.tk.accent });
      c.t('body', 'itemTitle', x + 20, y + 42, 516, 32, { fs: 16, bold: true, color: c.tk.title });
      c.t('body', 'itemText', x + 20, y + 80, 516, 136, { fs: 13 });
    }
  });

  /* Title with figure: stored as layout 'title' (as in every template), so numbering / header / footer rules treat it as an opening slide. */
  def('coverFigure', 'Cover with Figure', 'Opening', 26, (c) => {
    const k = c.tk;
    c.fig(704, 0, 576, 720);
    c.rule(72, 140, 72, 4);
    c.t('kicker', 'kicker', 72, 160, 590, 26, { fs: 13, color: k.accent, bold: true });
    c.t('title', 'title', 72, 196, 590, 200, { fs: 38, color: k.title, lh: 1.15 });
    c.t('subtitle', 'subtitle', 72, 410, 590, 90, { fs: 20, color: k.muted });
    c.rule(72, 540, 590, 1, k.border);
    c.t('meta', 'meta1', 72, 560, 590, 90, { fs: 16 });
  }, 'title');

  /* ---------- registry API ---------- */
  const LEGACY = { titleOnly: 'titleContent' };   // ids from the retired 8-layout list that no longer exist as a type
  const byId = {}; DEFS.forEach((d) => { byId[d.id] = d; });
  const sorted = DEFS.slice().sort((a, b) => a.rank - b.rank);
  const get = (id) => byId[id] || byId[LEGACY[id]] || null;
  const meta = (d) => ({ id: d.id, name: d.name, category: d.category, rank: d.rank, primary: d.primary, layout: d.layout });
  const list = () => sorted.map(meta);
  const primary = () => sorted.filter((d) => d.primary).map(meta);
  const more = () => sorted.filter((d) => !d.primary).map(meta);

  /* Fresh, empty, editable objects for a layout in the deck's current theme / slide size. */
  function build(id, doc) {
    const d = get(id) || byId.titleContent, c = ctx(doc);
    d.build(c);
    return c.objs;
  }
  function newSlide(id, doc) { const d = get(id) || byId.titleContent; return { id: uid('s'), layout: d.layout, notes: '', objects: build(d.id, doc) }; }
  const promptFor = (o) => PROMPTS[o && o.slot] || (o && PROMPTS[o.role]) || '';

  /* Apply a layout to an existing slide. Generated leftovers (decoration shapes, still-empty placeholders) are replaced; user
     content is never deleted: text / images / figures / tables are moved into the matching placeholder (same slot or role first,
     then reading order by short-vs-long text) and anything that has no matching placeholder stays exactly where it is.
     Returns { moved, kept } counts. Caller wraps this in ONE S.mutate (single undo step). */
  const SHORT = new Set(['colHeading', 'colTitle', 'itemTitle', 'number', 'value', 'when', 'stat', 'statLabel', 'name', 'roleLine', 'category', 'panelTitle', 'author', 'sectionNo', 'meta1', 'meta2', 'statDetail']);
  const KEYS = ['title', 'kicker', 'subtitle', 'caption'];
  const isImg = (o) => o.type === 'image' || o.type === 'plot' || o.type === 'figure';
  function apply(slide, id, doc) {
    const d = get(id) || byId.titleContent, fresh = build(d.id, doc);
    const generated = (o) => o.slot && ((o.slot === 'deco' && (o.type === 'shape' || o.type === 'text') && ['', '\u201C'].includes(strip(o.html))) ||
      (o.type === 'text' && !strip(o.html)) || (isImg(o) && o.type === 'image' && !o.src) || (o.type === 'table' && o.slot === 'table' && !(o.cells || []).some((r, i) => r.some((v) => v && !(i === 0 && /^Column \d+$/.test(v))))));
    const keep = slide.objects.filter((o) => !generated(o)), used = new Set(), place = new Set();
    const rd = (a, b) => (a.y - b.y) || (a.x - b.x);
    const texts = keep.filter((o) => o.type === 'text' && o.slot !== 'deco' && strip(o.html));
    const phText = fresh.filter((o) => o.type === 'text' && o.slot !== 'deco');
    const geom = (o, p) => { o.x = p.x; o.y = p.y; o.w = p.w; o.h = p.h; o.slot = p.slot; if (!o.role) o.role = p.role; used.add(o.id); place.add(p.id); };
    // text pass 1: unique roles (title / kicker / subtitle / caption) by slot or role
    phText.forEach((p) => {
      if (!KEYS.includes(p.slot)) return;
      const o = texts.find((t) => !used.has(t.id) && (t.slot === p.slot || t.role === p.slot));
      if (o) geom(o, p);
    });
    // text pass 2: everything else in reading order; long text -> body-like slots, short -> heading-like slots
    texts.filter((o) => !used.has(o.id)).sort(rd).forEach((o) => {
      const long = o.role === 'body' || o.role === 'text' || !!o.list || strip(o.html).length >= 60 || /<\/p>\s*<p|<br/i.test(o.html || '');
      const p = phText.find((q) => !place.has(q.id) && !KEYS.includes(q.slot) && SHORT.has(q.slot) !== long);
      if (p) geom(o, p);
    });
    // images / plots / figures: contain-fit into the figure placeholders, reading order
    const phImg = fresh.filter(isImg);
    keep.filter(isImg).sort(rd).forEach((o) => {
      const p = phImg.find((q) => !place.has(q.id)); if (!p) return;
      const ar = o.aspect || (o.w / Math.max(1, o.h)) || 1;
      let w = p.w, h = Math.round(w / ar); if (h > p.h) { h = p.h; w = Math.round(h * ar); }
      o.x = p.x + Math.round((p.w - w) / 2); o.y = p.y + Math.round((p.h - h) / 2); o.w = Math.max(1, w); o.h = Math.max(1, h);
      o.slot = p.slot; used.add(o.id); place.add(p.id);
    });
    // table
    const phTab = fresh.find((o) => o.type === 'table'), tab = keep.find((o) => o.type === 'table');
    if (phTab && tab) {
      const k = phTab.w / Math.max(1, tab.w);
      if (Array.isArray(tab.colW)) tab.colW = tab.colW.map((v) => Math.round(v * k * 100) / 100);
      tab.x = phTab.x; tab.y = phTab.y; tab.w = phTab.w; tab.h = Math.min(tab.h, phTab.h); tab.slot = 'table'; used.add(tab.id); place.add(phTab.id);
    }
    const deco = fresh.filter((o) => o.slot === 'deco');
    const empty = fresh.filter((o) => o.slot !== 'deco' && !place.has(o.id));
    slide.objects = deco.concat(empty, keep);
    slide.layout = d.layout;
    return { moved: used.size, kept: keep.filter((o) => !used.has(o.id)).length };
  }

  /* every generated object lies inside the slide (used by tests / sanity checks) */
  const inBounds = (objs, size) => objs.every((o) => o.x >= 0 && o.y >= 0 && o.w > 0 && o.h > 0 && o.x + o.w <= size.w && o.y + o.h <= size.h);

  RPE.layouts = { PROMPTS, list, primary, more, get, build, newSlide, apply, promptFor, tokens, colorOf, inBounds, count: DEFS.length };
  if (typeof module !== 'undefined' && module.exports) module.exports = RPE.layouts;
})(window.RPE = window.RPE || {});
