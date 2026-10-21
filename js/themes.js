/* themes.js — design-system data: fonts, themes, palettes, type presets, slide layouts and sizes.
   Pure data + small lookup helpers. No DOM access. */
(function (RPE) {
  'use strict';

  const SANS = "'Outfit','Segoe UI',system-ui,-apple-system,'Helvetica Neue',Arial,sans-serif";

  const FONTS = [
    { name: 'Outfit', css: SANS },
    { name: 'Spline Sans', css: "'Spline Sans',system-ui,sans-serif" },
    { name: 'Arimo', css: "'Arimo',Arial,Helvetica,sans-serif" },
    { name: 'Source Sans 3', css: "'Source Sans 3','Source Sans Pro',sans-serif" },
    { name: 'OpenDyslexic', css: "'OpenDyslexic',sans-serif" },
    { name: 'TeX Gyre Termes', css: "'TeX Gyre Termes','Times New Roman',Times,serif" },
    { name: 'Cormorant Garamond', css: "'Cormorant Garamond',Garamond,Georgia,serif" },
    { name: 'Amiri', css: "'Amiri',serif" },
    { name: 'Cairo', css: "'Cairo',sans-serif" },
    { name: 'Noto Sans Arabic', css: "'Noto Sans Arabic',sans-serif" },
    { name: 'Tajawal', css: "'Tajawal',sans-serif" },
    { name: 'Scheherazade New', css: "'Scheherazade New',serif" },
    { name: 'Inter', css: "'Inter',system-ui,sans-serif" },
    { name: 'Roboto', css: "'Roboto',system-ui,sans-serif" },
    { name: 'Open Sans', css: "'Open Sans',sans-serif" },
    { name: 'Lato', css: "'Lato',sans-serif" },
    { name: 'Montserrat', css: "'Montserrat',sans-serif" },
    { name: 'Poppins', css: "'Poppins',sans-serif" },
    { name: 'Raleway', css: "'Raleway',sans-serif" },
    { name: 'Oswald', css: "'Oswald',sans-serif" },
    { name: 'Fira Sans', css: "'Fira Sans',sans-serif" },
    { name: 'Plus Jakarta Sans', css: "'Plus Jakarta Sans',sans-serif" },
    { name: 'Merriweather', css: "'Merriweather',Georgia,serif" },
    { name: 'Playfair Display', css: "'Playfair Display',Georgia,serif" },
    { name: 'Lora', css: "'Lora',Georgia,serif" },
    { name: 'PT Serif', css: "'PT Serif',Georgia,serif" },
    { name: 'Bitter', css: "'Bitter',serif" },
    { name: 'Cinzel', css: "'Cinzel',Georgia,serif" },
    { name: 'Libre Baskerville', css: "'Libre Baskerville',Baskerville,serif" },
    { name: 'EB Garamond', css: "'EB Garamond',Garamond,Georgia,serif" },
    { name: 'JetBrains Mono', css: "'JetBrains Mono',monospace" },
    { name: 'Fira Code', css: "'Fira Code',monospace" },
    { name: 'Inconsolata', css: "'Inconsolata',monospace" },
    { name: 'Source Code Pro', css: "'Source Code Pro',monospace" },
    { name: 'Space Mono', css: "'Space Mono',monospace" },
    { name: 'Caveat', css: "'Caveat',cursive" },
    { name: 'Pacifico', css: "'Pacifico',cursive" },
    { name: 'Space Grotesk', css: "'Space Grotesk',sans-serif" }
  ];

  const LEGACY_FONTS = {
    'Calibri': "Calibri,Carlito,'Segoe UI',sans-serif",
    'Arial': "Arial,'Helvetica Neue',sans-serif",
    'Georgia': "Georgia,'Times New Roman',serif",
    'Times New Roman': "'Times New Roman',Times,serif",
    'Trebuchet MS': "'Trebuchet MS','Lucida Grande',sans-serif",
    'Verdana': 'Verdana,Geneva,sans-serif',
    'Cambria': 'Cambria,Georgia,serif',
    'Garamond': "Garamond,'EB Garamond',Georgia,serif",
    'Courier New': "'Courier New',Courier,monospace"
  };

  const cssFont = (name) => {
    const f = FONTS.find((x) => x.name.toLowerCase() === (name || '').toLowerCase());
    if (f) return f.css;
    if (name && LEGACY_FONTS[name]) return LEGACY_FONTS[name];
    return name ? `'${name}',${SANS}` : SANS;
  };

  const THEMES = [
    { id: 'journal', name: 'Burgundy Journal', bg: '#FFFFFF', title: '#702D3B', text: '#292A2D', muted: '#6F7075', accent: '#702D3B', accent2: '#A65C68', type: 'outfit', palette: 'burgundy', decor: 'rule', dark: false, neutrals: ['#FFFFFF', '#000000', '#EEECE1', '#3D353A'] },
    { id: 'slate', name: 'Slate Lab', bg: '#FFFFFF', title: '#1F3A4D', text: '#25303A', muted: '#667582', accent: '#2F6F8F', accent2: '#8DB3C6', type: 'outfit', palette: 'okabe', decor: 'topbar', dark: false, neutrals: ['#FFFFFF', '#000000', '#E7ECEF', '#1F3A4D'] },
    { id: 'field', name: 'Field Notes', bg: '#FBFAF5', title: '#2C4A3B', text: '#2B2F2C', muted: '#6A7068', accent: '#3F7A5C', accent2: '#A5BFA8', type: 'journal', palette: 'burgundy', decor: 'rule', dark: false, neutrals: ['#FBFAF5', '#1F2420', '#E6E8E2', '#2C4A3B'] },
    { id: 'midnight', name: 'Colloquium Dark', bg: '#1E2128', title: '#F4E6EA', text: '#E7E8EB', muted: '#A9ADB8', accent: '#D58A99', accent2: '#A65C68', type: 'outfit', palette: 'okabe', decor: 'rule', dark: true, neutrals: ['#FFFFFF', '#000000', '#2D323F', '#D9DCE5'] },
    { id: 'mono', name: 'Print Mono', bg: '#FFFFFF', title: '#111111', text: '#222222', muted: '#666666', accent: '#333333', accent2: '#999999', type: 'classic', palette: 'grayscale', decor: 'footer', dark: false, neutrals: ['#FFFFFF', '#000000', '#E8E8E8', '#333333'] },
    { id: 'office', name: 'Office', bg: '#FFFFFF', title: '#255B98', text: '#262626', muted: '#595959', accent: '#4472C4', accent2: '#ED7D31', type: 'outfit', palette: 'office', decor: 'rule', dark: false, neutrals: ['#FFFFFF', '#000000', '#E7E6E6', '#44546A'] }
  ];

  const PALETTES = [
    { id: 'office', name: 'Office', colors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'] },
    { id: 'burgundy', name: 'Burgundy Lab', colors: ['#702D3B', '#2F6F8F', '#C28B3C', '#5E8C61', '#A65C68', '#6B5B95'] },
    { id: 'okabe', name: 'Okabe–Ito (colour-blind safe)', colors: ['#0072B2', '#E69F00', '#009E73', '#D55E00', '#56B4E9', '#CC79A7'] },
    { id: 'viridis', name: 'Viridis', colors: ['#440154', '#414487', '#2A788E', '#22A884', '#7AD151', '#FDE725'] },
    { id: 'grayscale', name: 'Print grayscale', colors: ['#1A1A1A', '#3A3A3A', '#5A5A5A', '#7A7A7A', '#A0A0A0', '#C5C5C5'] }
  ];

  const TYPES = [
    { id: 'outfit', name: 'Outfit', head: 'Outfit', body: 'Outfit' },
    { id: 'journal', name: 'Journal Serif', head: 'Georgia', body: 'Outfit' },
    { id: 'classic', name: 'Classic Serif', head: 'Georgia', body: 'Georgia' },
    { id: 'technical', name: 'Technical', head: 'Outfit', body: 'Courier New' }
  ];

  const SIZES = [
    { id: '16:9', name: 'Widescreen (16:9)', w: 1280, h: 720 },
    { id: '16:10', name: 'Widescreen (16:10)', w: 1152, h: 720 },
    { id: '4:3', name: 'Standard (4:3)', w: 960, h: 720 },
    { id: 'a4', name: 'A4 Landscape', w: 1018, h: 720 }
  ];

  const STANDARD_COLORS = ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0'];
  const STANDARD_COLOR_NAMES = ['Dark Red', 'Red', 'Orange', 'Yellow', 'Light Green', 'Green', 'Light Blue', 'Blue', 'Dark Blue', 'Purple'];

  function hexToRgb(h) {
    if (!h || typeof h !== 'string') return [0, 0, 0];
    let s = h.trim().replace(/^#/, '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length !== 6) return [0, 0, 0];
    const n = parseInt(s, 16);
    if (isNaN(n)) return [0, 0, 0];
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    const toH = (c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0').toUpperCase();
    return '#' + toH(r) + toH(g) + toH(b);
  }

  function tintColor(hex, factor) {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(r + (255 - r) * factor, g + (255 - g) * factor, b + (255 - b) * factor);
  }

  function shadeColor(hex, factor) {
    const [r, g, b] = hexToRgb(hex);
    return rgbToHex(r * (1 - factor), g * (1 - factor), b * (1 - factor));
  }

  function themeMatrix(doc) {
    const th = (doc && typeof doc === 'object' && doc.themeId) ? byId(THEMES, doc.themeId) : THEMES[0];
    const sp = (RPE.palettes && doc && typeof doc === 'object') ? RPE.palettes.snapshotOf(doc) : null;   // persisted palette wins
    const pal = (doc && typeof doc === 'object' && doc.paletteId) ? byId(PALETTES, doc.paletteId) : (th && th.palette ? byId(PALETTES, th.palette) : PALETTES[0]);
    const neutrals = sp ? [sp.roles.bg, sp.roles.text, sp.roles.surface, sp.roles.border] : ((th && th.neutrals) || ['#FFFFFF', '#000000', '#E7E6E6', '#44546A']);
    const pcolors = sp ? sp.chart : (pal && pal.colors && pal.colors.length) ? pal.colors : ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'];

    const accents = [];
    for (let i = 0; i < 6; i++) {
      accents.push(pcolors[i] || (i === 0 ? th.accent : i === 1 ? th.accent2 : tintColor(th.accent, (i - 1) * 0.15)));
    }

    const baseCols = [
      { name: 'White, Background 1', color: neutrals[0], val: neutrals[0] },
      { name: 'Black, Text 1', color: neutrals[1], val: neutrals[1] },
      { name: 'Background 2', color: neutrals[2], val: neutrals[2] },
      { name: 'Text 2', color: neutrals[3], val: neutrals[3] },
      { name: 'Accent 1', color: accents[0], val: accents[0] },
      { name: 'Accent 2', color: accents[1], val: accents[1] },
      { name: 'Accent 3', color: accents[2], val: accents[2] },
      { name: 'Accent 4', color: accents[3], val: accents[3] },
      { name: 'Accent 5', color: accents[4], val: accents[4] },
      { name: 'Accent 6', color: accents[5], val: accents[5] }
    ];

    const shades = [];
    for (let r = 0; r < 5; r++) {
      const row = [];
      for (let c = 0; c < 10; c++) {
        const base = baseCols[c].color;
        const colName = baseCols[c].name;
        let color = base;
        let label = '';
        if (c === 0) {
          const f = [0.05, 0.15, 0.25, 0.35, 0.50][r];
          const pct = [5, 15, 25, 35, 50][r];
          color = shadeColor(base, f);
          label = `${colName}, Darker ${pct}%`;
        } else if (c === 1) {
          const f = [0.50, 0.35, 0.25, 0.15, 0.05][r];
          const pct = [50, 35, 25, 15, 5][r];
          color = tintColor(base, f);
          label = `${colName}, Lighter ${pct}%`;
        } else if (c === 2) {
          const f = [0.10, 0.25, 0.50, 0.75, 0.90][r];
          const pct = [10, 25, 50, 75, 90][r];
          color = shadeColor(base, f);
          label = `${colName}, Darker ${pct}%`;
        } else {
          if (r === 0) { color = tintColor(base, 0.80); label = `${colName}, Lighter 80%`; }
          else if (r === 1) { color = tintColor(base, 0.60); label = `${colName}, Lighter 60%`; }
          else if (r === 2) { color = tintColor(base, 0.40); label = `${colName}, Lighter 40%`; }
          else if (r === 3) { color = shadeColor(base, 0.25); label = `${colName}, Darker 25%`; }
          else { color = shadeColor(base, 0.50); label = `${colName}, Darker 50%`; }
        }
        row.push({ name: label, color, val: color });
      }
      shades.push(row);
    }

    return { base: baseCols, shades };
  }

  /* Layout slots use fractions of the slide size so every slide size works. */
  const LAYOUTS = [
    { id: 'title', name: 'Title Slide', slots: [
      { role: 'title', x: .09, y: .27, w: .82, h: .24, fs: 46 },
      { role: 'subtitle', x: .09, y: .55, w: .82, h: .16, fs: 22 }] },
    { id: 'titleContent', name: 'Title and Content', slots: [
      { role: 'title', x: .05, y: .075, w: .9, h: .14, fs: 34 },
      { role: 'body', x: .05, y: .26, w: .9, h: .62, fs: 24, list: 'bullet' }] },
    { id: 'section', name: 'Section Header', slots: [
      { role: 'title', x: .09, y: .34, w: .82, h: .2, fs: 44 },
      { role: 'subtitle', x: .09, y: .57, w: .82, h: .12, fs: 22 }] },
    { id: 'twoContent', name: 'Two Content', slots: [
      { role: 'title', x: .05, y: .075, w: .9, h: .14, fs: 34 },
      { role: 'body', x: .05, y: .26, w: .43, h: .62, fs: 22, list: 'bullet' },
      { role: 'body', x: .52, y: .26, w: .43, h: .62, fs: 22, list: 'bullet' }] },
    { id: 'contentFigure', name: 'Content with Figure', slots: [
      { role: 'title', x: .05, y: .075, w: .9, h: .14, fs: 34 },
      { role: 'body', x: .05, y: .26, w: .38, h: .62, fs: 22, list: 'bullet' },
      { role: 'figure', x: .47, y: .26, w: .48, h: .62 }] },
    { id: 'titleFigure', name: 'Title and Figure', slots: [
      { role: 'title', x: .05, y: .075, w: .9, h: .14, fs: 34 },
      { role: 'figure', x: .05, y: .24, w: .9, h: .64 }] },
    { id: 'titleOnly', name: 'Title Only', slots: [
      { role: 'title', x: .05, y: .075, w: .9, h: .14, fs: 34 }] },
    { id: 'blank', name: 'Blank', slots: [] }
  ];

  const byId = (list, id, dflt) => list.find((x) => x.id === id) || list[dflt || 0];

  const PROMPTS = { title: 'Click to add title', subtitle: 'Click to add subtitle', body: 'Click to add text', text: 'Type here', caption: 'Click to add caption', footnote: 'Click to add note', 'hf-header': 'Add header', 'hf-footer': 'Add footer' };

  RPE.themes = {
    FONTS, cssFont, THEMES, PALETTES, TYPES, SIZES, LAYOUTS, STANDARD_COLORS, STANDARD_COLOR_NAMES, PROMPTS,
    hexToRgb, rgbToHex, tintColor, shadeColor, themeMatrix,
    theme: (doc) => byId(THEMES, doc ? doc.themeId : null),
    palette: (doc) => byId(PALETTES, doc ? doc.paletteId : null),
    type: (doc) => byId(TYPES, doc ? doc.typeId : null),
    layout: (id) => byId(LAYOUTS, id, 1),
    /* Build placeholder objects for a layout at a given slide size. */
    layoutObjects(layoutId, size) {
      const L = byId(LAYOUTS, layoutId, 1);
      return L.slots.map((s) => {
        const base = { id: RPE.store.uid('o'), x: Math.round(s.x * size.w), y: Math.round(s.y * size.h), w: Math.round(s.w * size.w), h: Math.round(s.h * size.h), role: s.role, slot: s.role };
        if (s.role === 'figure') return Object.assign(base, { type: 'image', name: 'Figure placeholder', alt: '', src: null });
        return Object.assign(base, { type: 'text', html: '', fontSize: s.fs, align: 'left', list: s.list || null, lineHeight: 1.2, vAlign: s.role === 'title' ? 'middle' : 'top' });
      });
    }
  };
})(window.RPE = window.RPE || {});
