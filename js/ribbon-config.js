/* ribbon-config.js — the frozen ribbon specification, as data.
   To add or change a command: edit the group below, then register a handler with the same
   command id in commands.js (see README → "Adding a ribbon command").

   Item shapes
     {t:'btn', size:'lg'|'sm'|'icon', cmd, args?, label, icon, shortcut?, en?, menu?, split?, swatch?}
     {t:'combo', id, cmd, label, width, options:'fonts'|'sizes'}
     {t:'num', cmd, prop, label}            numeric field bound to the selected object (inches)
     {t:'stack'|'row', items:[…]}           vertical / horizontal arrangement
     {t:'themes'}                           inline theme gallery
     {t:'vsep'}                             thin divider inside a row
   `en` limits when a command is enabled: object | text | shape | plot | table | picture | multi | group
   `menu` is an array of menu items or {kind:'gallery'|'colors'|'tablegrid'|'symbols', …} (or a function returning one). */
(function (RPE) {
  'use strict';
  const T = RPE.themes, U = () => RPE.ui;

  const lg = (cmd, label, icon, o) => Object.assign({ t: 'btn', size: 'lg', cmd, label, icon }, o);
  const sm = (cmd, label, icon, o) => Object.assign({ t: 'btn', size: 'sm', cmd, label, icon }, o);
  const ic = (cmd, label, icon, o) => Object.assign({ t: 'btn', size: 'icon', cmd, label, icon }, o);
  const stack = (...items) => ({ t: 'stack', items });
  const row = (...items) => ({ t: 'row', items });
  const VSEP = { t: 'vsep' };
  const grp = (id, label, icon, items, o) => Object.assign({ id, label, icon, items }, o);
  const M = (label, cmd, args, o) => Object.assign({ label, cmd, args }, o);
  /* Design > Typography: the 4 built-in presets, then the 10 template-linked ones (RPE.typography registry); font preview per row. */
  const typographyMenu = () => {
    const R = RPE.typography, ty = R ? R.forDoc(RPE.store.doc) : null;
    if (!R) return [];
    const row = (p) => M(p.name, 'design.typography', { id: p.id }, { font: p.head, descFont: p.body, desc: p.head === p.body ? p.head : p.head + ' / ' + p.body, checked: () => ty.id === p.id });
    return [{ head: 'Built-in' }].concat(R.listLegacy().map(row), [{ sep: true }, { head: 'Template presets' }], R.listTemplates().map(row));
  };
  /* Design > Colors: the 5 built-in palettes, then the 10 template-linked ones (RPE.palettes registry); scrolls (.menu--scroll) when long. */
  const paletteMenu = () => {
    const R = RPE.palettes, cur = R ? R.forDoc(RPE.store.doc) : null;
    if (!R) return [];
    const row = (p) => M(p.name, 'design.palette', { id: p.id }, { swatches: R.swatches(p), checked: () => cur.id === p.id });
    return [{ head: 'Built-in' }].concat(R.listLegacy().map(row), [{ sep: true }, { head: 'Template palettes' }], R.listTemplates().map(row));
  };
  const SEP = { sep: true };

  /* both entry points open the SAME picker (RPE.layoutPicker); `current` marks the active slide's layout (Design > Layouts only) */
  const layoutGallery = (cmd, current) => () => ({ kind: 'layouts', cmd, current: !!current, items: RPE.layouts ? RPE.layouts.list().map((l) => ({ label: l.name, cmd, args: { layout: l.id } })) : [] });   // items feed the ribbon search index only
  const shapeGallery = (cmd, ids) => () => ({ kind: 'gallery', cols: 5, head: 'Shapes', items: U().SHAPES.filter((s) => !ids || ids.includes(s.id)).map((s) => ({ label: s.label, cmd, args: { shape: s.id }, preview: 'shape:' + s.id })) });
  const colorMenu = (cmd, none, args) => ({ kind: 'colors', cmd, none, args });

  /* Scientific Figures: the four entry points, identical on Insert and Figures. Built per tab so each tab owns its objects. */
  const plotTypeMenu = () => Object.keys(RPE.plots.KINDS).map((k) => M(RPE.plots.KINDS[k].label + ' plot', 'fig.create', { kind: k }, { icon: RPE.plots.KINDS[k].icon }));
  const sciFigures = () => grp('scientific', 'Scientific Figures', 'flask-conical', [
    lg('fig.create', 'Plot', 'chart-line', { split: true, accent: true, menu: plotTypeMenu, tip: 'Plot: open the plot editor and build a chart from your data. The arrow chooses a plot type.' }),
    lg('insert.figure', 'Multi-panel Figure', 'layout-grid', { accent: true, tip: 'Multi-panel Figure: arrange several plots in one figure with panel letters.' }),
    lg('insert.pythonPlot', 'Python Figure', 'terminal', { accent: true, tip: 'Python Figure: write a Matplotlib script and insert its output. Scripts run on your computer.' }),
    lg('insert.pgfplots', 'LaTeX / PGFPlots', 'sigma', { accent: true, tip: 'LaTeX / PGFPlots: compile LaTeX source with your local TeX installation and insert the result.' })
  ], { accent: true });
  /* Export: only what the backend can produce (PNG, PDF, Python script, LaTeX source of LaTeX figures). Availability per figure comes from fig.export's reason(). */
  const exportItems = (en) => [
    lg('fig.export', 'PNG', 'image', { args: { format: 'png' }, en, tip: 'Export PNG at the figure\u2019s own size and DPI' }),
    lg('fig.export', 'PDF', 'file-text', { args: { format: 'pdf' }, en, tip: 'Export PDF at the figure\u2019s own size' }),
    lg('fig.export', 'Python Source', 'terminal', { args: { format: 'py' }, en, tip: 'Export the figure as a runnable Python script' }),
    lg('fig.export', 'LaTeX Source', 'braces', { args: { format: 'tex' }, en, tip: 'Export the complete .tex file of a LaTeX / PGFPlots figure' })
  ];

  const arrangeMenu = [
    M('Bring to Front', 'arrange.order', { op: 'front' }, { icon: 'bring-to-front' }), M('Bring Forward', 'arrange.order', { op: 'forward' }, { icon: 'move-up' }),
    M('Send Backward', 'arrange.order', { op: 'backward' }, { icon: 'move-down' }), M('Send to Back', 'arrange.order', { op: 'back' }, { icon: 'send-to-back' })
  ];
  const alignMenu = [
    M('Align Left', 'arrange.align', { op: 'left' }, { icon: 'align-start-vertical' }), M('Align Center', 'arrange.align', { op: 'center' }, { icon: 'align-center-vertical' }), M('Align Right', 'arrange.align', { op: 'right' }, { icon: 'align-end-vertical' }), SEP,
    M('Align Top', 'arrange.align', { op: 'top' }, { icon: 'align-start-horizontal' }), M('Align Middle', 'arrange.align', { op: 'middle' }, { icon: 'align-center-horizontal' }), M('Align Bottom', 'arrange.align', { op: 'bottom' }, { icon: 'align-end-horizontal' }), SEP,
    M('Distribute Horizontally', 'arrange.distribute', { axis: 'x' }, { icon: 'align-horizontal-distribute-center' }), M('Distribute Vertically', 'arrange.distribute', { axis: 'y' }, { icon: 'align-vertical-distribute-center' })
  ];

  const sizeGroup = grp('size', 'Size', 'proportions', [stack({ t: 'num', cmd: 'object.size', prop: 'h', label: 'Height' }, { t: 'num', cmd: 'object.size', prop: 'w', label: 'Width' })]);
  const arrangeGroup = grp('arrange', 'Arrange', 'layers', [lg('arrange.order', 'Arrange', 'layers', { menu: arrangeMenu, en: 'object' }), stack(sm('arrange.align', 'Align', 'align-center-vertical', { menu: alignMenu, en: 'object' }), sm('arrange.group', 'Group', 'group', { en: 'multi' }), sm('arrange.ungroup', 'Ungroup', 'ungroup', { en: 'group' }))]);
  const fillOutline = [colorMenu('shape.fill', 'No Fill'), colorMenu('shape.outline', 'No Outline')];

  const TABS = [
    { id: 'file', label: 'File', backstage: true },

    { id: 'home', label: 'Home', groups: [
      grp('clipboard', 'Clipboard', 'clipboard-paste', [
        lg('clip.paste', 'Paste', 'clipboard-paste', { split: true, shortcut: 'Ctrl+V', menu: [M('Paste', 'clip.paste', null, { icon: 'clipboard-paste', shortcut: 'Ctrl+V' }), M('Paste as Plain Text', 'clip.pastePlain', null, { icon: 'clipboard-type' })] }),
        stack(sm('clip.cut', 'Cut', 'scissors', { en: 'object', shortcut: 'Ctrl+X' }), sm('clip.copy', 'Copy', 'copy', { en: 'object', shortcut: 'Ctrl+C' }), sm('clip.formatPainter', 'Format Painter', 'paintbrush', { en: 'object' }))
      ]),
      grp('slides', 'Slides', 'layout-template', [
        lg('slide.new', 'New Slide', 'file-plus-2', { split: true, shortcut: 'Ctrl+M', menu: layoutGallery('slide.new') }),
        lg('slide.layout', 'Layout', 'layout-template', { menu: layoutGallery('slide.layout', true) })
      ]),
      grp('font', 'Font', 'a-large-small', [
        stack(
          row({ t: 'combo', id: 'fontFamily', cmd: 'font.family', label: 'Font', width: 136, options: 'fonts' }, { t: 'combo', id: 'fontSize', cmd: 'font.size', label: 'Font size', width: 52, options: 'sizes' },
            ic('font.grow', 'Increase Font Size', 'a-arrow-up', { en: 'text' }), ic('font.shrink', 'Decrease Font Size', 'a-arrow-down', { en: 'text' })),
          row(ic('font.bold', 'Bold', 'bold', { en: 'text', shortcut: 'Ctrl+B' }), ic('font.italic', 'Italic', 'italic', { en: 'text', shortcut: 'Ctrl+I' }), ic('font.underline', 'Underline', 'underline', { en: 'text', shortcut: 'Ctrl+U' }), ic('font.strike', 'Strikethrough', 'strikethrough', { en: 'text' }), ic('font.subscript', 'Subscript', 'subscript', { en: 'text', shortcut: 'Ctrl+=' }), ic('font.superscript', 'Superscript', 'superscript', { en: 'text', shortcut: 'Ctrl+Shift+=' }), VSEP,
            ic('font.color', 'Font Color', 'baseline', { en: 'text', split: true, swatch: 'font', menu: colorMenu('font.color', 'Automatic') }), ic('font.highlight', 'Text Highlight Color', 'highlighter', { en: 'text', split: true, swatch: 'highlight', menu: colorMenu('font.highlight', 'No Highlight') }))
        )
      ]),
      grp('paragraph', 'Paragraph', 'align-left', [
        stack(
          row(ic('para.bullets', 'Bullets', 'list', { en: 'text' }), ic('para.numbering', 'Numbering', 'list-ordered', { en: 'text' }), ic('para.outdent', 'Decrease List Level', 'indent-decrease', { en: 'text' }), ic('para.indent', 'Increase List Level', 'indent-increase', { en: 'text' })),
          row(ic('para.align', 'Align Left', 'align-left', { args: { value: 'left' }, en: 'text' }), ic('para.align', 'Center', 'align-center', { args: { value: 'center' }, en: 'text' }), ic('para.align', 'Align Right', 'align-right', { args: { value: 'right' }, en: 'text' }), ic('para.align', 'Justify', 'align-justify', { args: { value: 'justify' }, en: 'text' }), VSEP,
            ic('para.spacing', 'Line and Paragraph Spacing', 'chevrons-up-down', { en: 'text', menu: [
              { head: 'Line spacing' }, M('1.0', 'para.lineSpacing', { value: 1 }, { checked: () => RPE.commands.isChecked('para.lineSpacing', { value: 1 }) }), M('1.15', 'para.lineSpacing', { value: 1.15 }), M('1.5', 'para.lineSpacing', { value: 1.5 }), M('2.0', 'para.lineSpacing', { value: 2 }), SEP,
              { head: 'Space after paragraph' }, M('0 pt', 'para.spaceAfter', { value: 0 }), M('6 pt', 'para.spaceAfter', { value: 6 }), M('12 pt', 'para.spaceAfter', { value: 12 })] }))
        )
      ]),
      grp('drawing', 'Drawing', 'shapes', [
        lg('shape.insert', 'Shapes', 'shapes', { menu: shapeGallery('shape.insert') }),
        stack(sm('shape.fill', 'Shape Fill', 'paint-bucket', { split: true, swatch: 'fill', en: 'object', menu: fillOutline[0] }), sm('shape.outline', 'Shape Outline', 'pen-line', { split: true, swatch: 'outline', en: 'object', menu: fillOutline[1] })),
        lg('arrange.order', 'Arrange', 'layers', { menu: arrangeMenu, en: 'object' }),
        stack(sm('arrange.align', 'Align', 'align-center-vertical', { menu: alignMenu, en: 'object' }), sm('arrange.group', 'Group', 'group', { en: 'multi', shortcut: 'Ctrl+G' }), sm('arrange.ungroup', 'Ungroup', 'ungroup', { en: 'group', shortcut: 'Ctrl+Shift+G' }))
      ]),
      grp('editing', 'Editing', 'search', [
        stack(sm('edit.find', 'Find', 'search', { shortcut: 'Ctrl+F' }), sm('edit.replace', 'Replace', 'replace', { shortcut: 'Ctrl+H' }),
          sm('edit.select', 'Select', 'mouse-pointer-2', { menu: [M('Select All', 'edit.select', { mode: 'all' }, { icon: 'square-dashed-mouse-pointer', shortcut: 'Ctrl+A' }), M('Select All Text Boxes', 'edit.select', { mode: 'text' }, { icon: 'text-cursor-input' }), M('Select Plots and Figures', 'edit.select', { mode: 'plots' }, { icon: 'chart-line' }), SEP, M('Deselect All', 'edit.select', { mode: 'none' }, { icon: 'square-x' })] }))
      ])
    ] },

    { id: 'insert', label: 'Insert', groups: [
      grp('tables', 'Tables', 'table', [lg('insert.table', 'Table', 'table', { menu: { kind: 'tablegrid', cmd: 'insert.table' } })]),
      grp('images', 'Images', 'image', [lg('insert.picture', 'Picture', 'image', { args: { source: 'device' }, menu: [M('This Device…', 'insert.picture', { source: 'device' }, { icon: 'monitor' }), M('Image Placeholder', 'insert.picture', { source: 'placeholder' }, { icon: 'image-plus' })] })]),
      sciFigures(),
      grp('shapes', 'Shapes and Illustrations', 'shapes', [
        lg('shape.insert', 'Shapes', 'shapes', { menu: shapeGallery('shape.insert') }),
        lg('insert.illustration', 'Illustrations', 'pen-tool', { menu: [{ head: 'Annotations' }, M('Callout', 'shape.insert', { shape: 'callout' }, { icon: 'message-square' }), M('Block Arrow', 'shape.insert', { shape: 'arrow' }, { icon: 'arrow-right' }), M('Brace', 'shape.insert', { shape: 'brace' }, { icon: 'braces' }), M('Scale Bar', 'shape.insert', { shape: 'scalebar' }, { icon: 'ruler' })] })
      ]),
      grp('links', 'Links', 'link', [lg('insert.link', 'Link', 'link', {})]),
      grp('text', 'Text and Symbols', 'type', [lg('insert.textbox', 'Text Box', 'text-cursor-input'), stack(sm('insert.symbol', 'Symbol', 'omega', { menu: { kind: 'symbols', cmd: 'insert.symbol' } }), sm('insert.symbolLibrary', 'Add symbol', 'circle-plus'))])
    ] },

    { id: 'design', label: 'Design', groups: [
      grp('templates', 'Templates', 'layout-template', [{ t: 'templates' }]),
      grp('typography', 'Typography', 'type', [lg('design.typography', 'Typography', 'type', { menu: () => typographyMenu() })]),
      grp('colors', 'Colors', 'swatch-book', [lg('design.palette', 'Colors', 'swatch-book', { menu: () => paletteMenu() })]),
      grp('layouts', 'Layouts', 'layout-template', [lg('slide.layout', 'Layouts', 'layout-template', { menu: layoutGallery('slide.layout', true) })]),
      grp('setup', 'Slide Setup', 'proportions', [
        lg('design.slideSize', 'Slide Size', 'proportions', { menu: () => T.SIZES.map((s) => M(s.name, 'design.slideSize', { id: s.id }, { checked: () => { const d = RPE.store.doc.size; return Math.round(d.w / d.h * 100) === Math.round(s.w / s.h * 100) || Math.round(d.h / d.w * 100) === Math.round(s.w / s.h * 100); } })).concat([SEP, M('Page Setup…', 'design.pageSetup', null, { icon: 'settings-2' })]) }),
        lg('design.orientation', 'Orientation', 'rectangle-horizontal', { menu: [M('Landscape', 'design.orientation', { value: 'landscape' }, { icon: 'rectangle-horizontal', checked: () => RPE.store.doc.size.w >= RPE.store.doc.size.h }), M('Portrait', 'design.orientation', { value: 'portrait' }, { icon: 'rectangle-vertical', checked: () => RPE.store.doc.size.w < RPE.store.doc.size.h })] })
      ])
    ] },

    { id: 'figures', label: 'Figures', groups: [
      sciFigures(),
      grp('formatting', 'Formatting', 'axis-3d', [
        lg('fig.axes', 'Axes', 'axis-3d', { en: 'plot', menu: [M('Show Grid', 'plot.axes', { op: 'grid' }, { checked: () => RPE.commands.isChecked('plot.axes', { op: 'grid' }) }), M('Open Axes (no top/right spine)', 'plot.axes', { op: 'despine' }, { checked: () => RPE.commands.isChecked('plot.axes', { op: 'despine' }) }), M('Ticks Inside', 'plot.axes', { op: 'ticksIn' }, { checked: () => RPE.commands.isChecked('plot.axes', { op: 'ticksIn' }) }), SEP, M('Axis Labels and Title…', 'plot.edit', { tab: 'settings' }, { icon: 'pencil-line' })] }),
        lg('fig.legend', 'Legend', 'tags', { en: 'plot', menu: [M('Show Legend', 'plot.legend', { op: 'toggle' }, { checked: () => RPE.commands.isChecked('plot.legend', { op: 'toggle' }) }), SEP, { head: 'Position' }, M('Best', 'plot.legend', { op: 'pos', value: 'best' }), M('Upper Left', 'plot.legend', { op: 'pos', value: 'upper left' }), M('Upper Right', 'plot.legend', { op: 'pos', value: 'upper right' }), M('Lower Left', 'plot.legend', { op: 'pos', value: 'lower left' }), M('Lower Right', 'plot.legend', { op: 'pos', value: 'lower right' }), M('Outside Right', 'plot.legend', { op: 'pos', value: 'outside' })] }),
        lg('fig.fonts', 'Fonts and Typography', 'a-large-small', { en: 'plot', menu: [{ head: 'Family' }, M('Sans-serif (Outfit)', 'plot.font', { family: 'sans' }), M('Serif (Georgia)', 'plot.font', { family: 'serif' }), M('Monospace', 'plot.font', { family: 'mono' }), SEP, { head: 'Size' }, M('9 pt', 'plot.font', { size: 9 }), M('10 pt', 'plot.font', { size: 10 }), M('12 pt', 'plot.font', { size: 12 }), M('14 pt', 'plot.font', { size: 14 }), M('16 pt', 'plot.font', { size: 16 })] })
      ]),
      grp('export', 'Export Figure', 'download', exportItems('plot'))
    ] },

    { id: 'present', label: 'Present', groups: [
      grp('start', 'Start', 'play', [lg('present.start', 'From Beginning', 'play', { args: { from: 'beginning' }, shortcut: 'F5' }), lg('present.start', 'From Current Slide', 'circle-play', { args: { from: 'current' }, shortcut: 'Shift+F5' })]),
      grp('tools', 'Presenter Tools', 'monitor-speaker', [lg('present.tools', 'Presenter Tools', 'monitor-speaker', { menu: [M('Start with Presenter View', 'present.start', { from: 'current', presenter: true }, { icon: 'monitor-speaker' }), M('Start with Laser Pointer', 'present.start', { from: 'current', laser: true }, { icon: 'crosshair' }), SEP, M('Keyboard shortcuts in Present mode', 'present.shortcuts', null, { icon: 'keyboard' })] })]),
      grp('export', 'Export', 'file-output', [lg('present.export', 'Export Presentation', 'file-output', { menu: [M('PowerPoint (.pptx)', 'present.export', { format: 'pptx' }, { icon: 'file-text' }), M('PDF', 'present.export', { format: 'pdf' }, { icon: 'file-text' }), SEP, M('Project file (.json)', 'file.exportJson', null, { icon: 'download', desc: 'Editor state with all figure images' })] })])
    ] },

    { id: 'review', label: 'Review', groups: [
      grp('proofing', 'Proofing', 'spell-check', [lg('review.proofing', 'Proofing', 'spell-check')]),
      grp('accessibility', 'Accessibility', 'accessibility', [lg('review.accessibility', 'Check Accessibility', 'accessibility')]),
      grp('research', 'Research Checks', 'microscope', [lg('review.check', 'Check for Overflowing Content', 'scan-text', { args: { kind: 'overflow' } }), lg('review.check', 'Check for Very Small Text', 'a-arrow-down', { args: { kind: 'smalltext' } }), lg('review.check', 'Check for Missing Captions', 'captions', { args: { kind: 'captions' } })], { accent: true })
    ] },

    { id: 'view', label: 'View', groups: [
      grp('views', 'Presentation Views', 'panel-left', [lg('view.mode', 'Normal', 'panel-left', { args: { mode: 'normal' }, toggle: true }), lg('view.mode', 'Slide Sorter', 'layout-grid', { args: { mode: 'sorter' }, toggle: true })]),
      grp('guides', 'Guides', 'ruler', [stack(sm('view.snap', 'Snap', 'magnet', { toggle: true, check: true }), sm('view.grid', 'Grid', 'grid-3x3', { toggle: true, check: true }), sm('view.guides', 'Guides', 'separator-vertical', { toggle: true, check: true }))]),
      grp('zoom', 'Zoom', 'zoom-in', [lg('view.zoomDialog', 'Zoom', 'zoom-in'), lg('view.fit', 'Fit Slide to Window', 'scan', { toggle: true })]),
      grp('workspace', 'Workspace', 'panel-top-close', [lg('view.collapseRibbon', 'Collapse Ribbon', 'chevron-up', { toggle: true, shortcut: 'Ctrl+F1' })])
    ] }
  ];

  /* Contextual tabs: appear only for a matching selection. `for` lists selection kinds. */
  const CONTEXT = [
    { id: 'textFormat', label: 'Text Format', for: ['text'], groups: [
      grp('textalign', 'Text', 'align-vertical-justify-start', [stack(sm('text.valign', 'Align Top', 'align-vertical-justify-start', { args: { value: 'top' }, toggle: true }), sm('text.valign', 'Align Middle', 'align-vertical-justify-center', { args: { value: 'middle' }, toggle: true }), sm('text.valign', 'Align Bottom', 'align-vertical-justify-end', { args: { value: 'bottom' }, toggle: true })), lg('text.edit', 'Edit Text', 'pencil-line')]),
      grp('boxstyle', 'Box Style', 'paint-bucket', [stack(sm('shape.fill', 'Shape Fill', 'paint-bucket', { split: true, swatch: 'fill', menu: fillOutline[0] }), sm('shape.outline', 'Shape Outline', 'pen-line', { split: true, swatch: 'outline', menu: fillOutline[1] }))]),
      arrangeGroup, sizeGroup
    ] },
    { id: 'pictureFormat', label: 'Picture Format', for: ['image'], groups: [
      grp('adjust', 'Adjust', 'image', [
        lg('picture.replace', 'Replace Picture', 'image-up'),
        lg('picture.crop', 'Crop', 'crop', { toggle: true }),
        lg('picture.adjust', 'Corrections', 'sliders-horizontal', { tip: 'Open the Brightness, Contrast, Saturation, Grayscale and Tint panel' }),
        stack(sm('picture.alt', 'Alt Text', 'accessibility'), sm('picture.fit', 'Reset Aspect', 'proportions'), sm('picture.adjustReset', 'Reset Adjustments', 'rotate-ccw', { tip: 'Remove all image adjustments (brightness, contrast, saturation, tint)' }))
      ]),
      grp('pstyle', 'Picture Style', 'frame', [stack(sm('shape.outline', 'Picture Border', 'pen-line', { split: true, swatch: 'outline', menu: fillOutline[1] }), sm('caption.add', 'Add Caption', 'captions'))]),
      arrangeGroup, sizeGroup
    ] },
    { id: 'shapeFormat', label: 'Shape Format', for: ['shape', 'mixed'], groups: [
      grp('insertshape', 'Insert Shapes', 'shapes', [lg('shape.change', 'Edit Shape', 'shapes', { menu: shapeGallery('shape.change'), en: 'shape' })]),
      grp('styles', 'Shape Styles', 'paint-bucket', [stack(sm('shape.fill', 'Shape Fill', 'paint-bucket', { split: true, swatch: 'fill', menu: fillOutline[0] }), sm('shape.outline', 'Shape Outline', 'pen-line', { split: true, swatch: 'outline', menu: fillOutline[1] }), sm('shape.weight', 'Shape Weight', 'minus', { menu: [1, 2, 3, 4, 6].map((w) => M(w + ' pt', 'shape.weight', { value: w })) }))]),
      grp('shapetext', 'Text', 'type', [stack(sm('text.edit', 'Edit Text', 'pencil-line', { en: 'shape' }), sm('text.valign', 'Align Middle', 'align-vertical-justify-center', { args: { value: 'middle' }, toggle: true, en: 'text' }))]),
      arrangeGroup, sizeGroup
    ] },
    { id: 'plotTools', label: 'Plot Tools', for: ['plot'], groups: [
      grp('data', 'Data', 'chart-line', [lg('plot.edit', 'Edit Plot', 'chart-line', { accent: true, tip: 'Edit Plot: reopen this figure in its editor (data, style, export)' }), lg('plot.changeType', 'Change Type', 'chart-column', { gate: 'plot.changeType', tip: 'Change Type: switch this plot to another plot type in the plot editor', menu: () => Object.keys(RPE.plots.KINDS).map((k) => M(RPE.plots.KINDS[k].label, 'plot.changeType', { kind: k }, { icon: RPE.plots.KINDS[k].icon })) })]),
      grp('axeslegend', 'Axes and Legend', 'axis-3d', [
        lg('fig.axes', 'Axes', 'axis-3d', { menu: [M('Show Grid', 'plot.axes', { op: 'grid' }, { checked: () => RPE.commands.isChecked('plot.axes', { op: 'grid' }) }), M('Open Axes (no top/right spine)', 'plot.axes', { op: 'despine' }, { checked: () => RPE.commands.isChecked('plot.axes', { op: 'despine' }) }), M('Ticks Inside', 'plot.axes', { op: 'ticksIn' }, { checked: () => RPE.commands.isChecked('plot.axes', { op: 'ticksIn' }) }), SEP, M('Axis Labels and Title…', 'plot.edit', { tab: 'settings' }, { icon: 'pencil-line' })] }),
        lg('fig.legend', 'Legend', 'tags', { menu: [M('Show Legend', 'plot.legend', { op: 'toggle' }, { checked: () => RPE.commands.isChecked('plot.legend', { op: 'toggle' }) }), SEP, M('Best', 'plot.legend', { op: 'pos', value: 'best' }), M('Upper Left', 'plot.legend', { op: 'pos', value: 'upper left' }), M('Upper Right', 'plot.legend', { op: 'pos', value: 'upper right' }), M('Lower Left', 'plot.legend', { op: 'pos', value: 'lower left' }), M('Lower Right', 'plot.legend', { op: 'pos', value: 'lower right' }), M('Outside Right', 'plot.legend', { op: 'pos', value: 'outside' })] })
      ]),
      grp('typo', 'Typography', 'a-large-small', [lg('fig.fonts', 'Fonts', 'a-large-small', { menu: [M('Sans-serif (Outfit)', 'plot.font', { family: 'sans' }), M('Serif (Georgia)', 'plot.font', { family: 'serif' }), M('Monospace', 'plot.font', { family: 'mono' }), SEP, M('10 pt', 'plot.font', { size: 10 }), M('12 pt', 'plot.font', { size: 12 }), M('14 pt', 'plot.font', { size: 14 })] })]),
      grp('pexport', 'Export', 'download', exportItems()),
      grp('pcap', 'Accessibility', 'accessibility', [stack(sm('picture.alt', 'Alt Text', 'accessibility'), sm('caption.add', 'Add Caption', 'captions'))]),
      arrangeGroup, sizeGroup
    ] },
    { id: 'tableTools', label: 'Table Tools', for: ['table'], groups: [
      grp('rowscols', 'Rows and Columns', 'table-properties', [stack(sm('table.row', 'Add Row', 'between-horizontal-end', { args: { op: 'add' } }), sm('table.col', 'Add Column', 'between-vertical-end', { args: { op: 'add' } })), stack(sm('table.row', 'Remove Last Row', 'trash-2', { args: { op: 'del' } }), sm('table.col', 'Remove Last Column', 'trash-2', { args: { op: 'del' } }))]),
      grp('tstyle', 'Table Style', 'table', [stack(sm('table.style', 'Header Row', 'table', { args: { key: 'headerRow' }, toggle: true, check: true }), sm('table.style', 'Banded Rows', 'rows-3', { args: { key: 'banded' }, toggle: true, check: true }))]),
      grp('talign', 'Alignment', 'align-left', [row(ic('para.align', 'Align Left', 'align-left', { args: { value: 'left' } }), ic('para.align', 'Center', 'align-center', { args: { value: 'center' } }), ic('para.align', 'Align Right', 'align-right', { args: { value: 'right' } })), row(ic('font.bold', 'Bold', 'bold'), ic('font.grow', 'Increase Font Size', 'a-arrow-up'), ic('font.shrink', 'Decrease Font Size', 'a-arrow-down'))]),
      grp('cformat', 'Cell Format', 'paint-bucket', [
        stack(
          sm('shape.fill', 'Cell Fill', 'paint-bucket', { split: true, swatch: 'fill', menu: colorMenu('shape.fill', 'No Fill') }),
          sm('table.clearFormat', 'Clear Format', 'ban')
        ),
        stack(
          sm('text.valign', 'Align Top', 'align-vertical-justify-start', { args: { value: 'top' }, toggle: true }),
          sm('text.valign', 'Align Middle', 'align-vertical-justify-center', { args: { value: 'middle' }, toggle: true }),
          sm('text.valign', 'Align Bottom', 'align-vertical-justify-end', { args: { value: 'bottom' }, toggle: true })
        )
      ]),
      grp('tborder', 'Borders', 'square-dashed', [
        lg('table.border', 'Border', 'square-dashed', { menu: [
          M('No Border', 'table.border', { width: 0, color: null }, { icon: 'square-dashed' }),
          { sep: true },
          M('Thin (1 px)', 'table.border', { width: 1 }),
          M('Medium (2 px)', 'table.border', { width: 2 }),
          M('Thick (3 px)', 'table.border', { width: 3 }),
          { sep: true },
          { head: 'Border color' },
          ...(() => { const items = []; const colors = [['accent', 'Accent'], ['text', 'Text'], ['#000000', 'Black'], ['#FFFFFF', 'White']]; colors.forEach(([v, l]) => items.push(M(l, 'table.border', { color: v }, { icon: 'square' }))); return items; })()
        ] })
      ]),
      grp('tcap', 'Caption', 'captions', [lg('caption.add', 'Add Caption', 'captions')]),
      arrangeGroup, sizeGroup
    ] }
  ];

  RPE.ribbonConfig = { TABS, CONTEXT };
})(window.RPE = window.RPE || {});
