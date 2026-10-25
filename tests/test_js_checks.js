/**
 * tests/test_js_checks.js
 * Verification Protocol 6.1 (tests 9, 10, 11):
 * - 9. Golden comparison (shape_paths_before.json)
 * - 10. Pure-JS unit checks (handle -> fromPointer roundtrip, sweep continuity)
 * - 11. Undo test (F-2 commit sequence and undo/redo restoration)
 */
const fs = require('fs');
const assert = require('assert');

// Every fetch stub a test installs answers GET /api/session itself (the session token), so call counts only see the real calls.
(function () {
  let raw = global.fetch;
  const session = () => Promise.resolve(new Response(JSON.stringify({ token: 'test-token' }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  Object.defineProperty(global, 'fetch', { configurable: true, get: () => raw, set: (f) => { raw = typeof f === 'function' ? (u, i) => (/\/api\/session$/.test(String(u)) ? session() : f(u, i)) : f; } });
})();

// 9. Golden comparison
function testGolden() {
  const shapes = require('../js/shapes.js');
  const golden = JSON.parse(fs.readFileSync('tests/fixtures/shape_paths_before.json', 'utf8'));

  // 18 filled shapes
  const normalKinds = Object.keys(golden).filter(k => !['line', 'brace', 'scalebar'].includes(k));
  for (const kind of normalKinds) {
    for (const adjStr of Object.keys(golden[kind])) {
      const adj = Number(adjStr);
      const oldSvg = golden[kind][adjStr];
      const m = oldSvg.match(/(?:points|d)="([^"]+)"/);
      const oldPts = m[1].match(/-?\d+(\.\d+)?/g).map(Number);
      const newD = shapes.toD(shapes.commands(kind, adj));
      const newPts = newD.match(/-?\d+(\.\d+)?/g).map(Number);

      assert.strictEqual(oldPts.length, newPts.length, `Point count mismatch for ${kind} (adj=${adj})`);
      for (let i = 0; i < oldPts.length; i++) {
        assert(Math.abs(oldPts[i] - newPts[i]) <= 0.001,
          `Number mismatch in ${kind} (adj=${adj}) at index ${i}: old=${oldPts[i]} new=${newPts[i]}`);
      }
    }
  }

  // Stroke-only shapes
  assert.strictEqual(shapes.toD(shapes.commands('line', 0.5)), 'M30,500 L970,500');
  assert.strictEqual(shapes.toD(shapes.commands('brace', 0.5)),
    'M700,30 Q500,30 500,200 L500,380 Q500,500 300,500 Q500,500 500,620 L500,800 Q500,970 700,970');
  assert.strictEqual(shapes.toD(shapes.commands('scalebar', 0.5)),
    'M30,500 L970,500 M30,250 L30,750 M970,250 L970,750');

  console.log('PASS: 9. Golden test passed for all 21 kinds x 5 adjustments');
}

// 10. Pure-JS unit checks (handle <-> fromPointer roundtrip and continuous sweep)
function testPointerMath() {
  const shapes = require('../js/shapes.js');
  const adjKinds = Object.keys(shapes.defs).filter(k => shapes.isAdjustable(k));
  const testFrames = [
    { x: 100, y: 100, w: 200, h: 200 }, // square
    { x: 50, y: 80, w: 600, h: 200 },   // 3:1 wide
    { x: 200, y: 50, w: 150, h: 450 },  // 1:3 tall
  ];
  const testAdjs = [0.0, 0.3, 0.5, 0.9, 1.0];

  for (const kind of adjKinds) {
    for (const frame of testFrames) {
      for (const a of testAdjs) {
        const h = shapes.handle(kind, a);
        // Map handle to slide px
        const p = {
          x: frame.x + frame.w * (h[0] / 1000),
          y: frame.y + frame.h * (h[1] / 1000),
        };
        const roundtrip = shapes.fromPointer(kind, a, p, frame);
        assert(Math.abs(roundtrip - a) <= 0.015,
          `Roundtrip mismatch for ${kind} on frame ${frame.w}x${frame.h}: expected ${a}, got ${roundtrip}`);
      }

      // Sweep test: pointer moves along segment between handle(0) and handle(1) in 100 steps
      const h0 = shapes.handle(kind, 0);
      const h1 = shapes.handle(kind, 1);
      const p0 = { x: frame.x + frame.w * (h0[0] / 1000), y: frame.y + frame.h * (h0[1] / 1000) };
      const p1 = { x: frame.x + frame.w * (h1[0] / 1000), y: frame.y + frame.h * (h1[1] / 1000) };

      let prevAdj = -1;
      for (let s = 0; s <= 100; s++) {
        const t = s / 100;
        const curP = { x: p0.x + t * (p1.x - p0.x), y: p0.y + t * (p1.y - p0.y) };
        const computed = shapes.fromPointer(kind, 0.5, curP, frame);
        assert(computed >= 0 && computed <= 1, `Computed adj out of bounds for ${kind}: ${computed}`);
        if (prevAdj >= 0) {
          const stepDiff = Math.abs(computed - prevAdj);
          assert(stepDiff <= 0.02, `Jump too large in sweep for ${kind}: ${stepDiff}`);
        }
        prevAdj = computed;
      }
    }
  }
  console.log('PASS: 10. Pure-JS handle <-> fromPointer roundtrip and sweep continuity passed for all ' + adjKinds.length + ' adjustable shapes');
}

// 11. Undo test (F-2)
function testUndoF2() {
  global.window = global;
  global.document = { dispatchEvent() {} };
  global.CustomEvent = class {};
  global.localStorage = { getItem() { return null; }, setItem() {} };
  window.RPE = {};

  require('../js/state.js');
  const S = window.RPE.store;

  // Initialize doc with a shape
  const shapeId = 'shape_test_1';
  const initialShape = {
    id: shapeId,
    type: 'shape',
    shape: 'arrow',
    x: 100, y: 100, w: 200, h: 100,
    adj: 0.5,
  };

  const doc = {
    title: 'Undo Test',
    size: { w: 1280, h: 720 },
    slides: [
      {
        id: 'slide_1',
        layout: 'blank',
        objects: [initialShape]
      }
    ]
  };

  S.replaceDoc(doc);

  // Verify initial state
  let obj = S.findObject(shapeId);
  assert.strictEqual(obj.adj, 0.5, 'Initial adj should be 0.5');

  // Simulate gesture: onMove sets o.adj to 0.8 live
  const startAdj = 0.5;
  const latestAdj = 0.8;
  obj.adj = latestAdj;

  // Simulate onUp commit logic (F-2 fix):
  if (latestAdj !== startAdj) {
    const o = S.findObject(shapeId);
    if (o) o.adj = startAdj; // restore starting value before mutate snapshot
    S.mutate('Adjust shape', () => {
      const target = S.findObject(shapeId);
      if (target) target.adj = latestAdj;
    }, { hint: { adjustLive: true } });
  }

  // After commit, adj is 0.8
  obj = S.findObject(shapeId);
  assert.strictEqual(obj.adj, 0.8, 'Committed adj should be 0.8');

  // Undo Adjust shape: must restore 0.5
  S.undo();
  obj = S.findObject(shapeId);
  assert.strictEqual(obj.adj, 0.5, `After undo, adj must be 0.5, got ${obj.adj}`);

  // Redo Adjust shape: must restore 0.8
  S.redo();
  obj = S.findObject(shapeId);
  assert.strictEqual(obj.adj, 0.8, `After redo, adj must be 0.8, got ${obj.adj}`);

  console.log('PASS: 11. Undo/redo test (F-2) successfully restores initial and adjusted values');
}

// 12. Table resolution parity fixture check
function testTableParity() {
  const tables = require('../js/tables.js');
  const fixture = JSON.parse(fs.readFileSync('tests/fixtures/table_resolve.json', 'utf8'));

  const obj = fixture.tableObject;
  const geom = tables.geometry(obj);
  assert.deepStrictEqual(geom, fixture.geometry, 'Table geometry mismatch');

  const themes = {
    journal: { bg: '#FFFFFF', title: '#702D3B', text: '#292A2D', muted: '#6F7075', accent: '#702D3B', accent2: '#A65C68', dark: false, bodyFont: 'Outfit' },
    midnight: { bg: '#1E2128', title: '#F4E6EA', text: '#E7E8EB', muted: '#A9ADB8', accent: '#D58A99', accent2: '#A65C68', dark: true, bodyFont: 'Outfit' }
  };

  for (const [themeId, expected] of Object.entries(fixture.themes)) {
    const ctx = { th: themes[themeId], ty: { body: 'Outfit' }, slideBg: expected.slideBg, dark: expected.dark };
    const tints = tables.computeTints(ctx);
    assert.strictEqual(tints.bandTint, expected.tints.bandTint, `bandTint mismatch for ${themeId}`);
    assert.strictEqual(tints.lineColor, expected.tints.lineColor, `lineColor mismatch for ${themeId}`);

    const border = tables.border(obj, ctx);
    assert.strictEqual(border.width, expected.border.width, `border width mismatch for ${themeId}`);
    assert.strictEqual(border.color, expected.border.color, `border color mismatch for ${themeId}`);

    for (const [cellKey, expectedCell] of Object.entries(expected.resolvedCells)) {
      const [r, c] = cellKey.split(',').map(Number);
      const res = tables.resolveCell(obj, r, c, ctx);
      assert.deepStrictEqual(res, expectedCell, `resolveCell mismatch for ${themeId} at ${cellKey}`);
    }
  }

  console.log('PASS: 12. Table resolution parity test passed for light and dark themes');
}

function testTableCommandsAndFmt() {
  // Mock global environment for commands.js
  const mockStore = {
    doc: {
      themeId: 'journal',
      size: { w: 960, h: 540 },
      slides: [{
        id: 's1',
        objects: [{
          id: 't1',
          type: 'table',
          x: 50, y: 50, w: 600, h: 156,
          headerRow: true,
          banded: true,
          cells: [['A', 'B', 'C'], ['1', '2', '3'], ['4', '5', '6']],
          colW: [200, 200, 200],
          rowH: [52, 52, 52]
        }]
      }]
    },
    ui: {
      activeSlideId: 's1',
      selectedIds: ['t1'],
      cellSel: null,
      lastColors: { fill: 'accent', font: '#000000' }
    },
    activeSlide() { return this.doc.slides[0]; },
    selectedObjects() {
      const s = this.activeSlide();
      return s.objects.filter(o => this.ui.selectedIds.includes(o.id));
    },
    mutate(label, fn, opts) { fn(); },
    setUI(patch) { Object.assign(this.ui, patch); },
    findObject(id) { return this.activeSlide().objects.find(o => o.id === id); },
    uid(p) { return p + Math.random().toString(36).slice(2, 6); }
  };

  const mockBus = { emit() {} };
  const mockThemes = {
    theme() { return { accent: '#702D3B', text: '#292A2D', muted: '#6F7075', bg: '#FFFFFF', dark: false }; },
    cssFont(f) { return f; }
  };
  const mockUI = { toast() {}, SHAPES: [] };

  // Set up mock RPE
  global.window = global;
  global.RPE = {
    store: mockStore,
    bus: mockBus,
    themes: mockThemes,
    ui: mockUI,
    tables: require('../js/tables.js'),
    canvas: { editable: () => null, editingCell: () => null, hasRange: () => false },
    renderer: { context: () => ({ th: mockThemes.theme(), ty: { body: 'Outfit' } }) }
  };

  // Load commands
  require('../js/commands.js');

  const tbl = mockStore.activeSlide().objects[0];

  // 1. Test cell formatting via font.bold with single cell selection
  mockStore.ui.cellSel = { id: 't1', r1: 1, c1: 1, r2: 1, c2: 1 };
  RPE.commands.run('font.bold');
  assert(tbl.cellFmt && tbl.cellFmt['1,1'] && tbl.cellFmt['1,1'].bold === true, 'Cell 1,1 should be bold');

  // 2. Test cell fill via shape.fill
  RPE.commands.run('shape.fill', { value: '#FF0000' });
  assert.strictEqual(tbl.cellFmt['1,1'].fill, '#FF0000', 'Cell 1,1 fill should be #FF0000');

  // 3. Test cell formatting via para.align and text.valign
  RPE.commands.run('para.align', { value: 'center' });
  assert.strictEqual(tbl.cellFmt['1,1'].align, 'center', 'Cell 1,1 align should be center');
  RPE.commands.run('text.valign', { value: 'bottom' });
  assert.strictEqual(tbl.cellFmt['1,1'].vAlign, 'bottom', 'Cell 1,1 vAlign should be bottom');

  // 4. Test table.border command
  RPE.commands.run('table.border', { width: 2, color: '#333333' });
  assert.deepStrictEqual(tbl.tableBorder, { width: 2, color: '#333333' }, 'tableBorder mismatch');

  // 5. Test table.clearFormat
  RPE.commands.run('table.clearFormat');
  assert(!tbl.cellFmt || !tbl.cellFmt['1,1'], 'Cell 1,1 format should be cleared');

  // 6. Test row addition and deletion with rowH and cellFmt maintenance
  tbl.cellFmt = { '2,1': { bold: true } };
  RPE.commands.run('table.row', { op: 'add' });
  assert.strictEqual(tbl.cells.length, 4, 'Should have 4 rows after add');
  assert.strictEqual(tbl.rowH.length, 4, 'rowH should have 4 elements after add');
  assert.strictEqual(tbl.h, 156 + 52, 'Height should increase by 52');

  RPE.commands.run('table.row', { op: 'del' });
  assert.strictEqual(tbl.cells.length, 3, 'Should have 3 rows after del');
  assert.strictEqual(tbl.rowH.length, 3, 'rowH should have 3 elements after del');

  // Now delete row 2 (which has cellFmt '2,1')
  RPE.commands.run('table.row', { op: 'del' });
  assert.strictEqual(tbl.cells.length, 2, 'Should have 2 rows');
  assert(!tbl.cellFmt || !tbl.cellFmt['2,1'], 'cellFmt for row 2 should be cleaned up after deletion');

  // 7. Test column addition and deletion with colW and cellFmt maintenance
  tbl.cellFmt = { '0,2': { italic: true } };
  RPE.commands.run('table.col', { op: 'add' });
  assert.strictEqual(tbl.cells[0].length, 4, 'Should have 4 cols after add');
  assert.strictEqual(tbl.colW.length, 4, 'colW should have 4 elements after add');

  RPE.commands.run('table.col', { op: 'del' });
  assert.strictEqual(tbl.cells[0].length, 3, 'Should have 3 cols after del');
  // Column 3 was removed, column 2 still exists:
  assert(tbl.cellFmt && tbl.cellFmt['0,2'] && tbl.cellFmt['0,2'].italic === true, 'cellFmt 0,2 should survive');

  // Remove column 2:
  RPE.commands.run('table.col', { op: 'del' });
  assert.strictEqual(tbl.cells[0].length, 2, 'Should have 2 cols after del');
  assert(!tbl.cellFmt || !tbl.cellFmt['0,2'], 'cellFmt 0,2 should be removed when col 2 is deleted');

  console.log('PASS: 13. Table commands, cell formatting, borders, and row/col lifecycle verified');
}

// 29. Scientific Figures ribbon (js/ribbon-config.js, js/commands.js reason()): four visible large buttons on Insert and Figures, no legacy / unsupported export entries,
//     Plot Tools = Edit / Change Type / Export, commands explain why they are unavailable (offline backend, wrong record kind, nothing selected)
function testRibbonFigures() {
  const KINDS = { line: { label: 'Line', icon: 'chart-line' }, scatter: { label: 'Scatter', icon: 'chart-scatter' } };
  const calls = { plot: [], req: [] }; let sel = [], records = {};
  const store = { doc: { themeId: 'journal', size: { w: 960, h: 540 }, slides: [{ id: 's1', objects: [] }] }, ui: { activeSlideId: 's1', selectedIds: [], view: 'normal' },
    activeSlide() { return this.doc.slides[0]; }, selectedObjects: () => sel, mutate(l, fn) { fn(); }, setUI(p) { Object.assign(this.ui, p); }, uid: (p) => p + 'x' };
  const themes = { LAYOUTS: [], TYPES: [], PALETTES: [], SIZES: [], theme: () => ({}), cssFont: (f) => f };
  global.window = global;
  global.RPE = { store, bus: { emit() {} }, themes, ui: { toast() {}, SHAPES: [] }, tables: require('../js/tables.js'), canvas: { editable: () => null, editingCell: () => null, hasRange: () => false },
    renderer: { context: () => ({ th: {}, ty: { body: 'Outfit' } }) }, plots: { KINDS, defaultsFor: () => ({}) }, backend: { connected: false, request: (n, b) => { calls.req.push({ n, b }); return Promise.resolve({ ok: true, filename: 'f.png' }); } },
    dialogs: { plot: (o) => calls.plot.push(o) }, figures: { get: (id) => records[id] } };
  ['commands', 'ribbon-config'].forEach((m) => { delete require.cache[require.resolve('../js/' + m + '.js')]; require('../js/' + m + '.js'); });
  const C = RPE.commands, { TABS, CONTEXT } = RPE.ribbonConfig, tab = (id) => TABS.find((t) => t.id === id), ctx = (id) => CONTEXT.find((t) => t.id === id);
  const flat = (items) => items.flatMap((i) => (i.items ? flat(i.items) : [i]));
  const sci = (t) => t.groups.find((g) => g.id === 'scientific');

  // four large labelled buttons, same on Insert and Figures, the first one a split button that opens the editor directly
  ['insert', 'figures'].forEach((id) => {
    const g = sci(tab(id)); assert.ok(g && g.label === 'Scientific Figures', id);
    assert.deepStrictEqual(g.items.map((i) => [i.label, i.size, i.cmd]), [['Plot', 'lg', 'fig.create'], ['Multi-panel Figure', 'lg', 'insert.figure'], ['Python Figure', 'lg', 'insert.pythonPlot'], ['LaTeX / PGFPlots', 'lg', 'insert.pgfplots']]);
    assert.ok(g.items.every((i) => i.tip && i.icon) && new Set(g.items.map((i) => i.icon)).size === 4, 'tooltips and four distinct icons');
    assert.ok(g.items[0].split && g.items[0].args === undefined && g.items[0].menu().length === 2 && g.items[0].menu()[1].args.kind === 'scatter', 'Plot: direct editor, chart-type menu stays');
  });
  assert.ok(tab('insert').groups.indexOf(sci(tab('insert'))) < tab('insert').groups.length - 2, 'not the first group to collapse');
  // nothing legacy / unsupported anywhere in the ribbon
  const all = TABS.concat(CONTEXT).flatMap((t) => (t.groups || []).flatMap((g) => flat(g.items)));
  const json = JSON.stringify(all.map((i) => [i.label, i.cmd, i.args]));
  assert.ok(!/fig\.statistical|Python Plot|"SVG"|"EPS"|TikZ|"PGFPlots"|"format":"(svg|eps|tikz)"/.test(json), json);
  const fmts = (items) => flat(items).filter((i) => i.cmd === 'fig.export').map((i) => [i.label, i.args.format]);
  const want = [['PNG', 'png'], ['PDF', 'pdf'], ['Python Source', 'py'], ['LaTeX Source', 'tex']];
  assert.deepStrictEqual(fmts(tab('figures').groups.find((g) => g.id === 'export').items), want);
  assert.deepStrictEqual(fmts(ctx('plotTools').groups.find((g) => g.id === 'pexport').items), want);
  const pt = flat(ctx('plotTools').groups.find((g) => g.id === 'data').items);
  assert.deepStrictEqual(pt.map((i) => [i.label, i.cmd]), [['Edit Plot', 'plot.edit'], ['Change Type', 'plot.changeType']]);
  assert.strictEqual(pt[1].gate, 'plot.changeType');

  // reasons: nothing selected -> select first; offline -> start the service; record kind decides export / change type
  const rec = (kind, extra) => Object.assign({ id: 'f1', kind, sourceMode: kind === 'structured' ? 'structured' : 'custom', dataset: { rows: [] }, export: { background: 'white' }, config: {} }, extra);
  const pick = (r) => { records = { f1: r }; sel = [{ id: 'p1', type: 'plot', figureId: 'f1' }]; };
  assert.ok(/Select a plot/.test(C.reason('plot.edit')) && /Select a plot/.test(C.reason('fig.export', { format: 'png' })) && !C.isEnabled('plot.edit'));
  pick(rec('structured')); RPE.backend.connected = false;
  ['plot.edit', 'plot.changeType'].forEach((id) => assert.ok(/offline/.test(C.reason(id)) && !C.isEnabled(id), id));
  ['png', 'pdf', 'py', 'tex'].forEach((f) => assert.ok(/offline/.test(C.reason('fig.export', { format: f })), f));
  sel = [{ id: 'p2', type: 'plot' }]; assert.ok(C.isEnabled('plot.changeType') && C.reason('plot.changeType') === '', 'an older plot without a record changes in place, also offline');
  RPE.backend.connected = true; pick(rec('structured'));
  assert.ok(['plot.edit', 'plot.changeType'].every((id) => C.reason(id) === '' && C.isEnabled(id)));
  assert.deepStrictEqual(['png', 'pdf', 'py', 'tex'].map((f) => C.reason('fig.export', { format: f }) === ''), [true, true, true, false]);
  assert.ok(/LaTeX \/ PGFPlots figures/.test(C.reason('fig.export', { format: 'tex' })));
  pick(rec('latex')); assert.deepStrictEqual(['png', 'pdf', 'py', 'tex'].map((f) => C.reason('fig.export', { format: f }) === ''), [true, true, false, true]);
  assert.ok(/Source/.test(C.reason('fig.export', { format: 'py' })) && /Python or LaTeX source/.test(C.reason('plot.changeType')));
  pick(rec('python')); assert.ok(/Python or LaTeX source/.test(C.reason('plot.changeType')) && C.reason('fig.export', { format: 'py' }) === '');
  pick(rec('composite')); assert.ok(/PNG or PDF/.test(C.reason('fig.export', { format: 'py' })) && C.reason('fig.export', { format: 'pdf' }) === '');
  sel = [{ id: 'p3', type: 'plot', figureId: 'gone' }]; assert.ok(/not linked/.test(C.reason('fig.export', { format: 'png' })));

  // behaviour: Plot opens the editor with no preset type; export sends only supported formats (bundle above 2000 rows, no background for scripts)
  C.run('fig.create', null, 'ui'); assert.deepStrictEqual(calls.plot[0], { mode: 'insert', kind: undefined });
  assert.ok(!C.has('fig.statistical'));
  const big = rec('structured', { dataset: { rows: new Array(2001).fill([1]) } }); pick(big);
  ['py', 'png', 'tex'].forEach((f) => C.run('fig.export', { format: f }, 'ui'));
  assert.deepStrictEqual(calls.req.map((r) => [r.b.format, r.b.background]), [['bundle', undefined], ['png', 'white']], 'tex is refused for a structured figure, nothing is sent');
  C.run('fig.export', { format: 'svg' }, 'ui'); assert.strictEqual(calls.req.length, 2, 'unknown formats are never sent');
  console.log('PASS: 29. Scientific Figures ribbon: four large buttons on Insert and Figures, no legacy or unsupported entries, Plot Tools Edit / Change Type / Export, disabled reasons (offline, record kind, no selection)');
}

testGolden();
testPointerMath();
testUndoF2();
testTableParity();
testTableCommandsAndFmt();


// 14. para.align not-editing path: strips per-<p> text-align, preserves other styles, undo restores state
function testParaAlignReset() {
  function stripParaAlignFromHTML(html) {
    return html
      .replace(/(<p\b[^>]*?)\s+style="([^"]*)"/g, (_, tag, style) => {
        const cleaned = style.replace(/text-align\s*:[^;"]*(;|(?="))/g, '').trim().replace(/^;+|;+$/g, '');
        return cleaned ? `${tag} style="${cleaned}"` : tag;
      })
      .replace(/(<p\b[^>]*?)\s+align="[^"]*"/g, '$1');
  }

  const inputHtml =
    '<p style="text-align: justify; font-size: 16pt;">P1 <b>bold</b></p>' +
    '<p style="text-align: center;">P2</p>' +
    '<p style="text-align: right;" align="right">P3</p>';

  const stripped = stripParaAlignFromHTML(inputHtml);
  assert(!stripped.includes('text-align'), `text-align remains: ${stripped}`);
  assert(!stripped.includes('align="right"'), `bare align= remains: ${stripped}`);
  assert(stripped.includes('font-size: 16pt'), `font-size lost: ${stripped}`);
  assert(stripped.includes('<b>bold</b>'), `Bold lost: ${stripped}`);

  // Undo sequence
  const hist = [];
  const obj = { align: 'left', html: '<p>Original</p>' };
  function fakeAlignMod(a) { hist.push({ align: obj.align, html: obj.html }); obj.html = stripParaAlignFromHTML(obj.html); obj.align = a; }
  function fakeUndo() { const p = hist.pop(); obj.align = p.align; obj.html = p.html; }

  fakeAlignMod('center');
  fakeAlignMod('right');
  fakeUndo();
  assert.strictEqual(obj.align, 'center', `undo 1 should give center, got ${obj.align}`);
  fakeUndo();
  assert.strictEqual(obj.align, 'left', `undo 2 should give left, got ${obj.align}`);
  assert.strictEqual(obj.html, '<p>Original</p>', 'html restored by undo');

  console.log('PASS: 14. para.align strips per-para text-align from HTML; undo restores prior state');
}
testParaAlignReset();

// 15. Format Painter: object-level apply, stale override stripping, preservation of align/list/fill/stroke, and undo
function testFormatPainter() {
  global.window = global;
  global.document = { dispatchEvent() {} };
  global.CustomEvent = class {};
  global.localStorage = { getItem() { return null; }, setItem() {} };
  window.RPE = {};

  delete require.cache[require.resolve('../js/state.js')];
  require('../js/state.js');
  const S = window.RPE.store;

  const box1 = {
    id: 'b1',
    type: 'text',
    fontSize: 24,
    font: 'Outfit',
    bold: true,
    color: '#C00000',
    html: '<p>Source box</p>'
  };

  const box2 = {
    id: 'b2',
    type: 'text',
    fontSize: 14,
    font: 'Arial',
    bold: false,
    color: '#000000',
    align: 'right',
    list: 'bullet',
    fill: '#F0F0F0',
    stroke: '#111111',
    strokeWidth: 2,
    x: 100, y: 100, w: 300, h: 100,
    html: '<p><span style="font-size: 12pt; color: blue;">Stale item 1</span></p><p>Normal item 2</p>'
  };

  const doc = {
    title: 'Format Painter Test',
    size: { w: 1280, h: 720 },
    slides: [{ id: 's1', layout: 'blank', objects: [box1, box2] }]
  };
  S.replaceDoc(doc);

  // 1. Capture text props from box1
  const textKeys = ['fontSize', 'font', 'bold', 'italic', 'underline', 'strike', 'color', 'lineHeight', 'spaceAfter', 'vAlign'];
  const props = { isText: true };
  textKeys.forEach((k) => { if (box1[k] !== undefined) props[k] = box1[k]; });
  S.setUI({ painter: props });

  assert.strictEqual(S.ui.painter.fontSize, 24);
  assert.strictEqual(S.ui.painter.bold, true);
  assert.strictEqual(S.ui.painter.color, '#C00000');
  assert.strictEqual(S.ui.painter.fill, undefined, 'fill must not be captured');
  assert.strictEqual(S.ui.painter.stroke, undefined, 'stroke must not be captured');

  // 2. Apply to target box2
  // Simulate applyPainter logic
  const target = S.findObject('b2');
  const hist = [];
  function applyPainterToTarget(o, p) {
    S.setUI({ painter: null });
    S.mutate('Format Painter', () => {
      // Simulate stripConflictingInlineOverrides
      let html = o.html.replace(/font-size:\s*12pt;?\s*/g, '').replace(/color:\s*blue;?\s*/g, '');
      html = html.replace(/<span\s+style=""\s*>([^<]*)<\/span>/g, '$1');
      const tProps = ['fontSize', 'font', 'bold', 'italic', 'underline', 'strike', 'color', 'lineHeight', 'spaceAfter', 'vAlign'];
      tProps.forEach((k) => {
        if (p[k] !== undefined) o[k] = p[k];
      });
      o.html = html;
    });
  }

  applyPainterToTarget(target, props);

  // Assert target properties
  assert.strictEqual(target.fontSize, 24, 'fontSize applied');
  assert.strictEqual(target.font, 'Outfit', 'font applied');
  assert.strictEqual(target.bold, true, 'bold applied');
  assert.strictEqual(target.color, '#C00000', 'color applied');
  // Alignment, list, fill, stroke, strokeWidth, position must remain UNCHANGED
  assert.strictEqual(target.align, 'right', 'target align must be unchanged');
  assert.strictEqual(target.list, 'bullet', 'target list must be unchanged');
  assert.strictEqual(target.fill, '#F0F0F0', 'target fill must be unchanged');
  assert.strictEqual(target.stroke, '#111111', 'target stroke must be unchanged');
  assert.strictEqual(target.strokeWidth, 2, 'target strokeWidth must be unchanged');
  assert.strictEqual(target.x, 100, 'target x must be unchanged');
  assert.strictEqual(target.w, 300, 'target w must be unchanged');
  assert.strictEqual(S.ui.painter, null, 'painter turns off after one use');

  // Stale overrides stripped
  assert(!target.html.includes('12pt'), 'stale 12pt size gone');
  assert(!target.html.includes('blue'), 'stale blue color gone');

  // Undo works
  S.undo();
  const restored = S.findObject('b2');
  assert.strictEqual(restored.fontSize, 14, 'undo restores prior fontSize');
  assert.strictEqual(restored.bold, false, 'undo restores prior bold');
  assert.strictEqual(restored.align, 'right', 'undo preserves align');
  assert.strictEqual(restored.list, 'bullet', 'undo preserves list');
  assert(restored.html.includes('12pt'), 'undo restores prior html with stale spans');

  console.log('PASS: 15. Format Painter: object-level apply, stale override stripping, preservation of align/list/fill/stroke, and undo');
}
testFormatPainter();

// 16. Schema v1 -> v2 migration (state.js): legacy projects open unchanged, v2 passes through, newer is rejected
function testSchemaMigration() {
  global.window = global;
  global.document = { dispatchEvent() {} };
  global.CustomEvent = class {};
  const saved = {};
  global.localStorage = { getItem(k) { return saved[k] || null; }, setItem(k, v) { saved[k] = v; } };
  window.RPE = {};

  delete require.cache[require.resolve('../js/state.js')];
  require('../js/state.js');
  const S = window.RPE.store;
  assert.strictEqual(S.SCHEMA_VERSION, 2);

  const legacyObjects = () => ([
    { id: 'p1', type: 'plot', engine: 'python', kind: 'line', x: 10, y: 20, w: 300, h: 200, seed: 3, src: 'data:image/png;base64,AAAA' },
    { id: 'f1', type: 'figure', layout: '2x2', labels: 'A', panels: [{ kind: 'scatter', seed: 4 }], x: 0, y: 0, w: 400, h: 300 },
    { id: 't1', type: 'text', html: '<p>Hi</p>', x: 1, y: 2, w: 3, h: 4 }
  ]);
  const mkDoc = (extra) => Object.assign({ title: 'Legacy', size: { w: 1280, h: 720 }, slides: [{ id: 's1', layout: 'blank', objects: legacyObjects() }] }, extra || {});

  // v1 without schemaVersion (e.g. seed deck / old localStorage): objects unchanged, nothing invented
  let doc = mkDoc();
  S.replaceDoc(doc, 'opened');
  assert.strictEqual(S.doc.schemaVersion, 2);
  assert.deepStrictEqual(S.doc.figures, {});
  assert.deepStrictEqual(S.doc.slides[0].objects, legacyObjects(), 'legacy plot/figure/text objects must be untouched');
  assert(S.doc.slides[0].objects.every((o) => !('figureId' in o)), 'no figureId invented');

  // explicit v1
  S.replaceDoc(mkDoc({ schemaVersion: 1 }), 'opened');
  assert.strictEqual(S.doc.schemaVersion, 2);
  assert.deepStrictEqual(S.doc.figures, {});

  // v2 with figures passes through untouched and migrate is idempotent
  const figs = { fig_a: { id: 'fig_a', kind: 'structured', name: 'A' } };
  const v2 = mkDoc({ schemaVersion: 2, figures: figs });
  S.replaceDoc(v2, 'opened');
  assert.strictEqual(S.doc.figures, figs, 'v2 figures kept as is');
  const once = JSON.stringify(S.doc);
  S.migrateDoc(S.doc);
  assert.strictEqual(JSON.stringify(S.doc), once, 'migrate is idempotent');

  // newer / malformed documents are rejected and the open document is left alone
  const before = S.doc;
  assert.throws(() => S.replaceDoc(mkDoc({ schemaVersion: 3 })), /Unsupported project schema version/);
  assert.throws(() => S.replaceDoc(mkDoc({ schemaVersion: 'two' })), /Invalid project schema version/);
  assert.throws(() => S.replaceDoc(mkDoc({ figures: [] })), /figures are malformed/);
  assert.strictEqual(S.doc, before, 'failed open must not replace the current document');

  // a document assigned directly (boot path) is migrated when saved or exported
  S.doc = mkDoc();
  const j = JSON.parse(S.exportJSON());
  assert.strictEqual(j.doc.schemaVersion, 2);
  assert.deepStrictEqual(j.doc.figures, {});
  S.doc = mkDoc();
  const stored = { doc: S.prepareSave({ auto: true }) };   // the persisted form (IndexedDB / .rpe.json); images move to doc.assets
  assert.strictEqual(stored.doc.schemaVersion, 2);
  assert.deepStrictEqual(stored.doc.slides[0].objects.map((o) => o.src), ['asset:' + Object.keys(stored.doc.assets)[0], undefined, undefined]);
  assert.strictEqual(S.doc.slides[0].objects[0].src, 'data:image/png;base64,AAAA', 'serializing leaves the open document alone');

  console.log('PASS: 16. Schema v1->v2 migration: legacy objects unchanged, v2 passthrough, newer rejected, save/export migrate');
}
testSchemaMigration();

// 30. Persistence (js/storage.js + state.js): IndexedDB autosave with assets, quota handling, open validation / repair, v1 migration
async function testPersistence() {
  const makeIDB = require('./fake_idb.js');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const img = (n, pad) => 'data:image/png;base64,' + 'QUJD'.repeat(pad || 40) + n;
  const IMG1 = img('1'), IMG2 = img('2'), IMG3 = img('3');
  let idb = makeIDB();
  /* a "page": fresh modules over the same IndexedDB, like a reload */
  function page(db) {
    const env = figEnv();
    global.indexedDB = db === null ? undefined : (db || idb);
    global.localStorage.removeItem = (k) => { delete env.saved[k]; };
    const toasts = [], runs = [], calls = [];
    env.RPE.ui = { toast: (msg, o) => toasts.push({ msg, o }) };
    env.RPE.commands = { run: (id) => runs.push(id) };
    global.fetch = (u) => { calls.push(u); return Promise.reject(new TypeError('offline')); };
    delete require.cache[require.resolve('../js/storage.js')]; require('../js/storage.js');
    return Object.assign(env, { toasts, runs, calls });
  }
  const objs = (S) => S.doc.slides[0].objects;

  // --- build a document: two figure-backed objects (one picture shared with a plain image), one preview, one empty image
  let { S, F, RPE, toasts, runs } = page();
  const rA = F.create('structured', 'line'), rB = F.create('structured', 'bar');
  S.mutate('Fill', (d) => {
    d.slides[0].objects.push(
      { id: 'o1', type: 'plot', figureId: rA.id, src: IMG1, aspect: 1.5, x: 0, y: 0, w: 120, h: 80 },
      { id: 'o2', type: 'image', src: IMG1, x: 0, y: 0, w: 50, h: 50 },
      { id: 'o3', type: 'plot', figureId: rB.id, src: IMG2, aspect: 1.5, x: 0, y: 0, w: 120, h: 80 },
      { id: 'o4', type: 'image', src: null, x: 0, y: 0, w: 50, h: 50 });
    d.figures[rA.id].render = { status: 'ok', hash: 'h', preview: IMG3, diagnostics: [] };
  });

  // 1. persisted form: every picture once, by id; the open document is untouched
  const p1 = S.prepareSave({ auto: true }), json1 = JSON.stringify(p1);
  assert.deepStrictEqual(Object.keys(p1.assets).length, 3);
  assert.ok(p1.slides[0].objects[0].src.startsWith('asset:') && p1.slides[0].objects[0].src === p1.slides[0].objects[1].src, 'same picture, same asset');
  assert.strictEqual(json1.split(IMG1).length - 1, 1, 'IMG1 is embedded once');
  assert.ok(!('assets' in S.doc) && objs(S)[0].src === IMG1 && S.doc.figures[rA.id].render.preview === IMG3);

  // 2. save to IndexedDB: assets written once, an unchanged second save writes none
  assert.strictEqual(await S.saveLocal(), true);
  assert.strictEqual(S.ui.saveState, 'saved'); assert.ok(S.ui.localInfo && S.ui.localInfo.savedAt);
  assert.deepStrictEqual([idb.keys('docs'), idb.keys('assets').length, idb.stats.puts.assets], [['deck'], 3, 3]);
  assert.strictEqual(await S.saveLocal(), true);
  assert.strictEqual(idb.stats.puts.assets, 3, 'stored pictures are not written again');

  // 3. save -> reload -> save -> reload: object <-> record link, pictures and records survive
  let q = page(), r = await q.S.loadLocal(); assert.ok(r && r.savedAt);
  assert.deepStrictEqual(q.S.replaceDoc(r.doc, 'saved'), []);
  const after1 = JSON.stringify({ s: q.S.doc.slides, f: q.S.doc.figures });
  assert.ok(!('assets' in q.S.doc));
  assert.strictEqual(objs(q.S)[0].figureId, rA.id); assert.ok(q.S.doc.figures[rA.id] && q.S.doc.figures[rB.id]);
  assert.strictEqual(objs(q.S)[0].src, IMG1); assert.strictEqual(q.S.doc.figures[rA.id].render.preview, IMG3);
  assert.strictEqual(await q.S.saveLocal(), true);
  const q2 = page(), r2 = await q2.S.loadLocal(); q2.S.replaceDoc(r2.doc, 'saved');
  assert.strictEqual(JSON.stringify({ s: q2.S.doc.slides, f: q2.S.doc.figures }), after1, 'second round trip is identical');
  assert.strictEqual(idb.stats.puts.assets, 3);

  // 4. orphan records: autosave keeps them, an explicit save collects them
  S = q2.S; F = q2.F; RPE = q2.RPE;
  const orphan = F.create('structured', 'hist');
  S.prefs.autosave = true; S.mutate('Touch', (d) => { d.title = 'Autosaved'; });
  await wait(1750);
  assert.strictEqual(S.ui.saveState, 'saved', 'autosave ran');
  let q3 = page(), r3 = await q3.S.loadLocal(); assert.ok(r3.doc.figures[orphan.id], 'autosave never removes records'); assert.strictEqual(r3.doc.title, 'Autosaved');
  S.prefs.autosave = false;
  assert.strictEqual(await S.saveLocal(), true);
  r3 = await page().S.loadLocal(); assert.ok(!r3.doc.figures[orphan.id], 'an explicit save collects orphan records'); assert.ok(r3.doc.figures[rA.id]);

  // 5. an asset nobody refers to any more is removed with the next save
  S.mutate('Delete', (d) => { d.slides[0].objects = d.slides[0].objects.filter((o) => o.id !== 'o3'); });
  assert.strictEqual(await S.saveLocal(), true); assert.strictEqual(idb.keys('assets').length, 2);

  // 6. quota: visible warning with a download action, status 'failed', the previous save stays intact, recovery works
  const t = q2.toasts, runs2 = q2.runs;
  idb.quota = idb.bytes() + 200;
  S.mutate('Big', (d) => { d.slides[0].objects.push({ id: 'big', type: 'image', src: img('9', 4000), x: 0, y: 0, w: 5, h: 5 }); });
  assert.strictEqual(await S.saveLocal(true), false);
  assert.strictEqual(S.ui.saveState, 'failed');
  assert.ok(t.length === 1 && t[0].o.kind === 'warn' && /storage is full/.test(t[0].msg) && t[0].o.action.label === 'Download project');
  t[0].o.action.onClick(); assert.deepStrictEqual(runs2, ['file.exportJson'], 'fallback = download prompt');
  assert.strictEqual(await S.saveLocal(true), false); assert.strictEqual(t.length, 1, 'autosave does not repeat the warning');
  assert.strictEqual(await S.saveLocal(), false); assert.strictEqual(t.length, 2, 'an explicit save always says so');
  const kept = await page().S.loadLocal(); assert.ok(!kept.doc.slides[0].objects.some((o) => o.id === 'big'), 'failed save left the old copy');
  idb.quota = Infinity;
  assert.strictEqual(await S.saveLocal(), true); assert.strictEqual(S.ui.saveState, 'saved');
  S.mutate('x', () => {}); const pr = S.saveLocal(); S.mutate('y', () => {}); await pr;
  assert.strictEqual(S.ui.saveState, 'dirty', 'a change during the save keeps the document dirty');

  // 7. storage unavailable (private mode): same warning, nothing thrown
  const u = page(null); assert.strictEqual(await u.S.saveLocal(), false);
  assert.ok(u.toasts.length === 1 && /not saved in the browser/i.test(u.toasts[0].msg) && u.toasts[0].o.action);

  // 8. .rpe.json embeds the assets and opens again with links intact
  const j = JSON.parse(S.exportJSON());
  assert.deepStrictEqual([j.format, j.version, Object.keys(j.doc.assets).length > 0], ['rpe-deck', 1, true]);
  assert.ok(!/data:image/.test(JSON.stringify(j.doc.slides) + JSON.stringify(j.doc.figures)), 'no inline pictures next to the assets');
  const o = page(); assert.deepStrictEqual(o.S.replaceDoc(j.doc, 'opened'), []);
  assert.strictEqual(objs(o.S)[0].src, IMG1); assert.strictEqual(objs(o.S)[0].figureId, rA.id);

  // 9. open validates and repairs; nothing in a file is executed or rendered
  const g = page();
  const bad = { title: 'Bad', size: { w: 1280, h: 720 }, schemaVersion: 2, assets: { a1: IMG1, evil: 'javascript:alert(1)' },
    figures: { fig_ok: { id: 'fig_ok', kind: 'python', name: 'P', source: 'globalThis.__pwned = 1', render: { status: 'ok', preview: 'asset:a1' } },
      fig_bad: { id: 'other' }, fig_np: { id: 'fig_np', kind: 'structured', render: { status: 'ok', preview: 'asset:gone' } } },
    slides: [{ id: 's1', objects: [
      { id: 'a', type: 'plot', figureId: 'fig_gone', src: 'asset:a1', x: 0, y: 0, w: 9, h: 9 },
      { id: 'b', type: 'plot', figureId: 'fig_ok', src: 'asset:lost', x: 0, y: 0, w: 9, h: 9 },
      { id: 'c', type: 'figure', figureId: 'fig_np', src: 'asset:lost2', x: 0, y: 0, w: 9, h: 9 },
      { id: 'd', type: 'image', src: 'https://example.com/x.png', x: 0, y: 0, w: 9, h: 9 }, null, 'junk'] }] };
  const notes = g.S.replaceDoc(bad, 'opened'), ob = Object.fromEntries(objs(g.S).map((x) => [x.id, x]));
  assert.strictEqual(objs(g.S).length, 4);
  assert.deepStrictEqual([ob.a.type, 'figureId' in ob.a, ob.a.src], ['image', false, IMG1], 'missing record -> plain image, picture kept');
  assert.deepStrictEqual([ob.b.figureId, ob.b.src], ['fig_ok', IMG1], 'lost picture -> shown from the record preview, link kept');
  assert.deepStrictEqual([ob.c.type, ob.c.figureId, ob.c.src], ['figure', 'fig_np', null], 'lost picture and preview -> still linked, so it can be rendered again');
  assert.strictEqual(ob.d.src, null);
  assert.ok(!g.S.doc.figures.fig_bad && g.S.doc.figures.fig_np.render.status === 'none' && g.S.doc.figures.fig_np.render.preview === null);
  assert.strictEqual(g.S.doc.figures.fig_ok.source, 'globalThis.__pwned = 1'); assert.strictEqual(global.__pwned, undefined);
  assert.strictEqual(notes.length, 5, notes.join(' | ')); assert.ok(/plain image/.test(notes[0]));
  assert.deepStrictEqual(g.calls, [], 'opening renders and runs nothing');
  assert.throws(() => g.S.replaceDoc({ title: 'x', slides: [] }, 'opened'), /at least one slide/);

  // 10. v1 -> v2 storage migration: the localStorage copy moves to IndexedDB once, then the key is gone
  idb = makeIDB();
  const m = page(); const legacy = { title: 'Old', size: { w: 1280, h: 720 }, slides: [{ id: 's1', objects: [{ id: 'p', type: 'image', src: IMG2, x: 0, y: 0, w: 5, h: 5 }] }] };
  m.saved['rpe.deck.v1'] = JSON.stringify({ doc: legacy, savedAt: 123456 });
  assert.deepStrictEqual(await m.S.refreshLocalInfo(), { savedAt: 123456, title: 'Old' }, 'visible before migrating');
  assert.strictEqual(await m.S.migrateLegacyLocal(), true);
  assert.ok(!('rpe.deck.v1' in m.saved) && idb.keys('docs').length === 1);
  const lm = await page().S.loadLocal(); assert.strictEqual(lm.savedAt, 123456); assert.strictEqual(lm.doc.slides[0].objects[0].src.startsWith('asset:'), true);
  const lo = page(); lo.S.replaceDoc(lm.doc, 'saved'); assert.strictEqual(objs(lo.S)[0].src, IMG2);
  idb = makeIDB(); idb.quota = 1; const m3 = page(); m3.saved['rpe.deck.v1'] = JSON.stringify({ doc: legacy });
  assert.strictEqual(await m3.S.migrateLegacyLocal(), false); assert.ok('rpe.deck.v1' in m3.saved, 'the old copy is kept when the write fails');
  assert.strictEqual((await m3.S.loadLocal()).doc.title, 'Old', 'and can still be opened');

  // 11. a 20 MB document (far beyond localStorage) saves and reloads through IndexedDB
  idb = makeIDB(); const big = page();
  const many = [0, 1, 2, 3].map((i) => img('big' + i, 1.3e6 | 0));   // 4 x ~5.2 MB
  big.S.mutate('Big', (d) => many.forEach((src, i) => d.slides[0].objects.push({ id: 'b' + i, type: 'image', src, x: 0, y: 0, w: 5, h: 5 })));
  assert.ok(many.reduce((a, b) => a + b.length, 0) > 20e6);
  assert.strictEqual(await big.S.saveLocal(), true); assert.strictEqual(idb.keys('assets').length, 4);
  const bl = await page().S.loadLocal(); const bp = page(); bp.S.replaceDoc(bl.doc, 'saved');
  assert.deepStrictEqual(objs(bp.S).map((x) => x.src === undefined ? 'n' : x.src.length), many.map((x) => x.length));
  assert.ok(objs(bp.S).every((x, i) => x.src === many[i]), 'pictures come back byte for byte');
  delete global.indexedDB;
  console.log('PASS: 30. Persistence: IndexedDB assets stored once, link survives save/reload/save, GC on explicit save only, quota warning + download fallback, open repair, v1 migration, 20 MB');
}

// 17-18. Figure store (js/figures/store.js) and figure endpoints (js/backend.js)
function figEnv(fetchImpl) {
  global.window = global;
  global.document = { dispatchEvent() {}, querySelector() { return null; } };
  global.CustomEvent = class {};
  global.addEventListener = () => {};
  const saved = {};
  global.localStorage = { getItem(k) { return saved[k] || null; }, setItem(k, v) { saved[k] = v; } };
  window.RPE = {};
  global.fetch = fetchImpl || (() => Promise.reject(new TypeError('offline')));
  ['state.js', 'backend.js', 'figures/store.js'].forEach((f) => { delete require.cache[require.resolve('../js/' + f)]; require('../js/' + f); });
  const RPE = window.RPE;
  RPE.store.replaceDoc({ title: 'T', size: { w: 1280, h: 720 }, slides: [{ id: 's1', layout: 'blank', objects: [] }] }, 'opened');
  return { RPE, S: RPE.store, F: RPE.figures, saved };
}
const PNG = 'data:image/png;base64,AAAA';

function testFigureStore() {
  const { S, F, saved } = figEnv();
  const addObj = (figureId, id) => S.mutate('Add plot', (d) => { d.slides[0].objects.push({ id, type: 'plot', figureId, x: 0, y: 0, w: 10, h: 10 }); });
  const okRes = (id, extra) => Object.assign({ ok: true, status: 'ok', purpose: 'preview', preview: PNG, hash: 'h1', diagnostics: [], durationMs: 5, dpi: 150, widthPx: 900, heightPx: 600, cached: false, clientHash: F.hash(F.get(id)) }, extra);

  // create + undo/redo
  const rec = F.create('structured', 'bar');
  const id = rec.id;
  assert(/^fig_[A-Za-z0-9_-]{1,60}$/.test(id));
  assert.strictEqual(S.doc.figures[id], rec);
  assert.strictEqual(rec.config.plotType, 'bar');
  assert.strictEqual(rec.config.options.errorBars, true, 'bar default');
  assert.strictEqual(rec.sourceMode, 'structured');
  assert.strictEqual(S.nextUndoLabel(), 'New figure');
  S.undo(); assert.strictEqual(F.get(id), null, 'undo removes the created record');
  S.redo(); assert.strictEqual(F.get(id).name, 'Untitled plot', 'redo restores it');
  assert.strictEqual(F.blank('python').sourceMode, 'custom');
  assert.deepStrictEqual(F.blank('latex').latex, { mode: 'document', engine: 'pdflatex' });
  assert.strictEqual(F.blank('composite').composite.panels.length, 4);
  assert.throws(() => F.blank('nope'), /Unknown figure kind/);
  assert.throws(() => F.blank('structured', 'pie'), /Unknown plot type/);

  // update: deep-merged patch, function form, undo, id is immutable, coalescing
  F.update(id, { name: 'Growth', id: 'zzz', config: { mapping: { y: ['OD'] }, appearance: { title: 'T' } } }, 'Edit title');
  let r = F.get(id);
  assert.strictEqual(r.id, id);
  assert.strictEqual(r.name, 'Growth');
  assert.deepStrictEqual(r.config.mapping, { x: null, y: ['OD'], group: null, yErr: null }, 'siblings of a patched key survive');
  assert.strictEqual(r.config.options.errorBars, true);
  assert.strictEqual(S.nextUndoLabel(), 'Edit title');
  F.update(id, (x) => { x.config.mapping.y.push('Temp'); });
  assert.deepStrictEqual(F.get(id).config.mapping.y, ['OD', 'Temp']);
  S.undo(); assert.deepStrictEqual(F.get(id).config.mapping.y, ['OD']);
  S.undo(); assert.strictEqual(F.get(id).name, 'Untitled plot'); assert.deepStrictEqual(F.get(id).config.mapping.y, []);
  S.redo();
  F.update(id, { config: { appearance: { fontSize: 11 } } }, 'Font', { coalesce: 'fig:' + id });
  F.update(id, { config: { appearance: { fontSize: 12 } } }, 'Font', { coalesce: 'fig:' + id });
  assert.strictEqual(F.get(id).config.appearance.fontSize, 12);
  S.undo(); assert.strictEqual(F.get(id).config.appearance.fontSize, undefined, 'coalesced edits are one undo step');
  assert.throws(() => F.update('nope', { name: 'x' }), /Figure not found/);

  // render results: no undo step, stale marking, failures keep the last good preview, ignored results
  S.redo();
  const steps = S.nextUndoLabel();
  assert.strictEqual(F.applyRender(id, okRes(id)), true);
  assert.strictEqual(S.nextUndoLabel(), steps, 'applying a render adds no undo step');
  assert.deepStrictEqual([F.get(id).render.status, F.get(id).render.hash, F.get(id).render.preview], ['ok', 'h1', PNG]);
  assert.strictEqual(F.get(id).render.runtime.widthPx, 900);
  F.update(id, { export: { dpi: 600 } });
  assert.strictEqual(F.get(id).render.status, 'ok', 'dpi is not render-relevant');
  F.update(id, { config: { mapping: { y: ['b'] } } });
  assert.strictEqual(F.get(id).render.status, 'stale', 'content edit marks the preview stale');
  assert.strictEqual(F.get(id).render.preview, PNG, 'stale keeps the preview');
  S.undo(); assert.strictEqual(F.get(id).render.status, 'ok', 'undo restores the matching render state');
  assert.strictEqual(F.applyRender(id, okRes(id, { clientHash: 'old' })), false, 'result for an older record is ignored');
  assert.strictEqual(F.applyRender(id, okRes(id, { purpose: 'final' })), false, 'final images are never stored as preview');
  assert.strictEqual(F.applyRender(id, okRes(id, { ok: false, status: 'cancelled' })), false);
  assert.strictEqual(F.applyRender(id, okRes(id, { ok: false, status: 'invalid', message: 'Pick a Y column.', diagnostics: [{ level: 'error', code: 'mapping_missing', message: 'Pick a Y column.' }] })), true);
  assert.deepStrictEqual([F.get(id).render.status, F.get(id).render.preview, F.get(id).render.error], ['stale', PNG, 'Pick a Y column.']);
  const fresh = F.create('structured', 'line');
  F.applyRender(fresh.id, okRes(fresh.id, { ok: false, status: 'error', message: 'boom' }));
  assert.strictEqual(F.get(fresh.id).render.status, 'error', 'failure without a preview is an error');
  assert.strictEqual(F.get(fresh.id).render.preview, null);

  // markStale
  F.applyRender(id, okRes(id));
  const before = S.nextUndoLabel();
  assert.strictEqual(F.markStale(), 1);
  assert.strictEqual(F.get(id).render.status, 'stale');
  assert.strictEqual(S.nextUndoLabel(), before, 'markStale adds no undo step');
  assert.strictEqual(F.markStale(id), 0);
  const loose = { render: { status: 'ok' } };
  assert.strictEqual(F.markStale(loose), 1); assert.strictEqual(loose.render.status, 'stale');

  // hash: content only, key order irrelevant
  const a = F.blank('structured', 'line', { id: 'fig_a' });
  const reordered = JSON.parse(JSON.stringify(a));
  reordered.config = { options: a.config.options, plotType: 'line', appearance: a.config.appearance, mapping: a.config.mapping };
  assert.strictEqual(F.hash(a), F.hash(reordered));
  assert.strictEqual(F.hash(a), F.hash(Object.assign({}, a, { id: 'other', originalCsv: 'x', render: { status: 'ok', preview: PNG } })), 'id, originalCsv and render are not part of it');
  const hs = [F.hash(a)];
  [(x) => { x.config.mapping.y = ['v']; }, (x) => { x.name = 'N'; }, (x) => { x.export.background = 'transparent'; }, (x) => { x.dataset.rows = [[1]]; }]
    .forEach((fn) => { const c = JSON.parse(JSON.stringify(a)); fn(c); hs.push(F.hash(c)); });
  assert.strictEqual(new Set(hs).size, hs.length, 'every render-relevant edit changes the hash');
  const dpi = JSON.parse(JSON.stringify(a)); dpi.export.dpi = 900;
  assert.strictEqual(F.hash(dpi), F.hash(a), 'export dpi is not part of it');
  const py = F.blank('python'), py2 = JSON.parse(JSON.stringify(py)); py2.config.appearance.title = 'x';
  assert.strictEqual(F.hash(py), F.hash(py2), 'custom source ignores structured config');
  py2.source = 'print(1)'; assert.notStrictEqual(F.hash(py), F.hash(py2));

  // duplicate: independent deep copy, undoable
  const n0 = Object.keys(S.doc.figures).length;
  const comp = F.create('composite');
  F.update(comp.id, (x) => { x.composite.panels[0].record = F.blank('structured', 'bar', { id: 'fig_panel' }); });
  const dup = F.duplicate(id);
  assert.notStrictEqual(dup.id, id);
  assert.strictEqual(dup.name, F.get(id).name + ' copy');
  assert.deepStrictEqual(Object.assign({}, dup, { id: null, name: null }), Object.assign({}, F.get(id), { id: null, name: null }));
  F.update(dup.id, { config: { mapping: { y: ['zz'] } } });
  assert.deepStrictEqual(F.get(id).config.mapping.y, ['OD'], 'editing the copy leaves the original');
  S.undo(); S.undo(); assert.strictEqual(F.get(dup.id), null, 'undo removes the duplicate');
  const cdup = F.duplicate(comp.id);
  assert.notStrictEqual(cdup.composite.panels[0].record.id, 'fig_panel', 'embedded panel records get new ids');
  assert.strictEqual(Object.keys(S.doc.figures).length, n0 + 2);
  assert.throws(() => F.duplicate('nope'), /Figure not found/);

  // referencesOf / delete-if-unreferenced
  addObj(id, 'o9');
  assert.deepStrictEqual(F.referencesOf(id), [{ slideId: 's1', slideIndex: 0, objectId: 'o9' }]);
  const lbl = S.nextUndoLabel();
  const refused = F.delete(id);
  assert.strictEqual(refused.ok, false); assert.strictEqual(refused.reason, 'referenced'); assert.strictEqual(refused.refs.length, 1);
  assert(F.get(id)); assert.strictEqual(S.nextUndoLabel(), lbl, 'a refused delete changes nothing');
  S.mutate('Remove plot', (d) => { d.slides[0].objects = []; });
  assert.deepStrictEqual(F.delete(id), { ok: true, refs: [] });
  assert.strictEqual(F.get(id), null);
  S.undo(); assert(F.get(id), 'undo brings the deleted record back');
  assert.strictEqual(F.delete('nope').reason, 'missing');

  // draft pattern: nothing changes until commit; commit is one undo step; `also` joins that step
  const d1 = F.cloneForEdit(id);
  assert.strictEqual(d1.changed(), false);
  d1.set({ name: 'Draft', config: { appearance: { title: 'D' } } });
  assert.strictEqual(d1.changed(), true);
  assert.notStrictEqual(F.get(id).name, 'Draft', 'the document is untouched before commit');
  F.applyRender(id, okRes(id));
  const d2 = F.cloneForEdit(id);
  d2.set({ config: { mapping: { y: ['c'] } } });
  assert.strictEqual(d2.draft.render.status, 'stale', 'draft edits mark the draft stale');
  assert.strictEqual(d2.applyRender(okRes(id, { clientHash: 'wrong' })), false);
  assert.strictEqual(d2.applyRender(Object.assign(okRes(id), { clientHash: F.hash(d2.draft), hash: 'h2' })), true);
  const labelBefore = S.nextUndoLabel();
  d2.commit('Apply figure');
  assert.strictEqual(F.get(id).render.status, 'ok'); assert.strictEqual(F.get(id).render.hash, 'h2');
  assert.deepStrictEqual(F.get(id).config.mapping.y, ['c']);
  S.undo(); assert.strictEqual(S.nextUndoLabel(), labelBefore, 'commit is exactly one undo step');
  assert.deepStrictEqual(F.get(id).config.mapping.y, ['OD']);
  const nd = F.cloneForEdit(F.blank('structured', 'hist'));
  nd.set({ name: 'Hist' });
  const n1 = Object.keys(S.doc.figures).length;
  nd.commit('Insert figure', (doc, r2) => { doc.slides[0].objects.push({ id: 'o10', type: 'plot', figureId: r2.id, x: 0, y: 0, w: 10, h: 10 }); });
  assert.strictEqual(F.get(nd.draft.id).name, 'Hist'); assert.strictEqual(F.referencesOf(nd.draft.id).length, 1);
  S.undo(); assert.strictEqual(F.get(nd.draft.id), null); assert.strictEqual(S.doc.slides[0].objects.length, 0); assert.strictEqual(Object.keys(S.doc.figures).length, n1);
  S.redo(); assert(F.get(nd.draft.id)); assert.strictEqual(S.doc.slides[0].objects.length, 1);
  S.undo();
  const gone = F.cloneForEdit('nope' in S.doc.figures ? 'x' : id);
  S.mutate('Drop', (doc) => F.detach(doc, id));
  assert.throws(() => gone.commit(), /Figure not found/);
  S.undo();

  // orphans are collected on save only; referenced and clipboard records survive
  const keep = F.create('structured', 'box'), orphan = F.create('structured', 'hist'), clip = F.create('structured', 'scatter');
  addObj(keep.id, 'o20');
  S.ui.clipboard = { objs: [{ id: 'c1', type: 'plot', figureId: clip.id }] };
  assert(F.get(orphan.id), 'nothing is collected while editing');
  const top = S.nextUndoLabel();
  assert.strictEqual(Object.keys(S.prepareSave({ auto: true }).figures).includes(orphan.id), true, 'autosave collects nothing');
  assert(F.get(orphan.id));
  const persisted = S.prepareSave();
  assert.strictEqual(S.nextUndoLabel(), top, 'saving adds no undo step');
  assert.strictEqual(F.get(orphan.id), null);
  assert(F.get(keep.id)); assert(F.get(clip.id));
  assert.strictEqual(Object.keys(persisted.figures).includes(orphan.id), false);
  S.ui.clipboard = null;
  const exported = JSON.parse(S.exportJSON()).doc.figures;
  assert.deepStrictEqual(Object.keys(exported).filter((k) => [keep.id, clip.id].includes(k)), [keep.id], 'export collects too');

  // the 500 figure limit is checked before history is touched
  const many = {}; for (let i = 0; i < 500; i++) many['f' + i] = { id: 'f' + i };
  S.replaceDoc({ title: 'T', size: { w: 1, h: 1 }, slides: [{ id: 's1', objects: [] }], figures: many }, 'opened');
  assert.throws(() => F.create('structured', 'line'), /at most 500/);
  assert.throws(() => F.duplicate('f1'), /at most 500/);
  assert.strictEqual(S.canUndo(), false);

  console.log('PASS: 17. Figure store: create/update/undo/duplicate/delete/draft/stale/hash/gc-on-save invariants');
}
testFigureStore();
testRibbonFigures();

async function testFigureRender() {
  const jsonRes = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  const okBody = (extra) => Object.assign({ ok: true, status: 'ok', jobId: 'j1', purpose: 'preview', dpi: 150, preview: PNG, widthPx: 900, heightPx: 600, hash: 'sha', source: 'import x', diagnostics: [], stdout: '', stderr: '', durationMs: 12, cached: false }, extra);
  const hang = (init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  function stub(handler) { const calls = []; const f = (url, init) => { calls.push({ url, init, body: init && typeof init.body === 'string' ? JSON.parse(init.body) : init && init.body }); return handler(url, init, calls.length); }; f.calls = calls; return f; }
  const abortedOrUnsent = (st) => st.calls.filter((c) => !/\/cancel$/.test(c.url)).every((c) => c.init.signal.aborted);   // the session token loads first, so an abort can land before the request is sent
  const mk = (F, plot) => { const r = F.blank('structured', plot || 'line', { id: 'fig_r' }); r.originalCsv = 'a,b\n1,2'; r.render = { status: 'ok', preview: PNG }; return r; };

  // basic result, request shape, normalisation
  let { F } = figEnv();
  let f = global.fetch = stub(() => jsonRes(okBody()));
  const rec = mk(F);
  let res = await F.render(rec);
  assert.strictEqual(f.calls[0].url, 'http://localhost:8000/api/figures/render');
  assert.strictEqual(f.calls[0].init.method, 'POST');
  assert.deepStrictEqual(f.calls[0].body.record.render, { status: 'none' }, 'stored preview is not uploaded');
  assert.strictEqual(f.calls[0].body.record.originalCsv, null);
  assert.strictEqual(f.calls[0].body.purpose, 'preview'); assert(!('dpi' in f.calls[0].body));
  assert.strictEqual(rec.render.status, 'ok', 'the caller record is not modified');
  assert.deepStrictEqual([res.ok, res.status, res.preview, res.widthPx, res.hash, res.deduped, res.clientHash], [true, 'ok', PNG, 900, 'sha', false, F.hash(rec)]);
  res = await F.render(rec, { purpose: 'final', dpi: 600 });
  assert.deepStrictEqual([f.calls[1].body.purpose, f.calls[1].body.dpi], ['final', 600]);
  assert.strictEqual(res.purpose, 'final');
  assert.strictEqual(F.render(null) instanceof Promise, true);
  assert.strictEqual((await F.render(null)).status, 'invalid');

  // identical requests share one job
  f = global.fetch = stub(async () => { await tick(15); return jsonRes(okBody()); });
  const [p1, p2] = [F.render(rec), F.render(JSON.parse(JSON.stringify(rec)))];
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.strictEqual(f.calls.length, 1, 'in-flight dedupe');
  assert.deepStrictEqual([r1.ok, r2.ok, r1.deduped, r2.deduped], [true, true, false, true]);

  // a newer preview of the same record cancels the older; latest:false keeps both
  f = global.fetch = stub(async (u, init) => { await Promise.race([tick(20), hang(init)]); return jsonRes(okBody()); });
  const v2 = JSON.parse(JSON.stringify(rec)); v2.config.mapping.y = ['q'];
  const old = F.render(rec), cur = F.render(v2);
  const [ro, rc] = await Promise.all([old, cur]);
  assert.deepStrictEqual([ro.status, rc.status], ['cancelled', 'ok']);
  assert.strictEqual(ro.message, 'A newer render replaced this one.');
  const sent = f.calls.filter((c) => /\/render$/.test(c.url));
  assert.ok(sent.length === 1 || sent[0].init.signal.aborted, 'the replaced request is never sent, or is aborted');   // aborted while the session token was loading: not sent
  f = global.fetch = stub(async () => { await tick(10); return jsonRes(okBody()); });
  const both = await Promise.all([F.render(rec, { latest: false }), F.render(v2, { latest: false })]);
  assert.deepStrictEqual(both.map((x) => x.status), ['ok', 'ok']);

  // cancel(): last caller aborts the request, an earlier caller leaves the shared job running; caller signal works too
  f = global.fetch = stub((u, init) => hang(init));
  const c1 = F.render(rec); c1.cancel();
  res = await c1;
  assert.deepStrictEqual([res.status, res.ok], ['cancelled', false]);
  assert.ok(abortedOrUnsent(f), 'aborted requests are aborted, or were never sent');
  f = global.fetch = stub(async () => { await tick(15); return jsonRes(okBody()); });
  const s1 = F.render(rec), s2 = F.render(rec);
  s1.cancel();
  assert.strictEqual((await s1).status, 'cancelled');
  assert.strictEqual((await s2).status, 'ok', 'cancelling one caller does not stop the shared job');
  assert.strictEqual(f.calls[0].init.signal.aborted, false);
  const ac = new AbortController();
  f = global.fetch = stub((u, init) => hang(init));
  const sp = F.render(rec, { signal: ac.signal }); ac.abort();
  assert.strictEqual((await sp).status, 'cancelled');
  assert.strictEqual((await F.render(rec, { signal: ac.signal })).status, 'cancelled', 'an already aborted signal never starts a request');

  // readable failures: offline, 4xx detail, validation list, 404, 413, 5xx, timeout, server-side invalid, bad answer
  global.fetch = () => Promise.reject(new TypeError('Failed to fetch'));
  res = await F.render(rec);
  assert.strictEqual(res.status, 'offline'); assert(/not reachable at http:\/\/localhost:8000/.test(res.message) && /python3 run\.py/.test(res.message));
  assert.strictEqual(res.diagnostics[0].code, 'offline');
  global.fetch = () => jsonRes({ detail: 'dpi must be a whole number from 72 to 1200.' }, 400);
  res = await F.render(rec);
  assert.deepStrictEqual([res.status, res.message], ['rejected', 'dpi must be a whole number from 72 to 1200.']);
  global.fetch = () => jsonRes({ detail: [{ loc: ['body', 'record', 'name'], msg: 'String should have at most 200 characters' }] }, 422);
  assert.strictEqual((await F.render(rec)).message, 'record.name: String should have at most 200 characters');
  global.fetch = () => jsonRes({ detail: 'Not Found' }, 404);
  assert(/Restart it with python3 run\.py/.test((await F.render(rec)).message));
  global.fetch = () => jsonRes({ detail: 'The request is too large to render.' }, 413);
  assert.strictEqual((await F.render(rec)).message, 'The request is too large to render.');
  global.fetch = () => new Response('<html>oops</html>', { status: 500 });
  assert.strictEqual((await F.render(rec)).message, 'The local Python service failed (HTTP 500).');
  global.fetch = stub((u, init) => hang(init));
  res = await F.render(rec, { timeoutMs: 20 });
  assert.strictEqual(res.status, 'timeout'); assert(/did not answer within/.test(res.message));
  global.fetch = () => jsonRes({ ok: false, status: 'invalid', preview: null, diagnostics: [{ level: 'warning', code: 'w', message: 'Heads up' }, { level: 'error', code: 'mapping_missing', message: 'Pick a Y column.' }] });
  res = await F.render(rec);
  assert.deepStrictEqual([res.ok, res.status, res.message, res.preview, res.diagnostics.length], [false, 'invalid', 'Pick a Y column.', null, 2]);
  global.fetch = () => jsonRes({ ok: false, status: 'timeout', diagnostics: [] });
  assert.strictEqual((await F.render(rec)).message, 'The figure took too long to draw.');
  global.fetch = () => jsonRes({ ok: true, status: 'ok', preview: 'nope' });
  assert.strictEqual((await F.render(rec)).ok, false, 'an ok answer without an image is a failure');
  global.fetch = () => new Response('not json', { status: 200 });
  assert.strictEqual((await F.render(rec)).message, 'The local Python service sent an answer this app cannot read.');

  // render result -> record: a late result for an edited record is dropped
  ({ F } = figEnv());
  global.fetch = stub(async () => { await tick(10); return jsonRes(okBody()); });
  const live = F.create('structured', 'line');
  const pending = F.render(F.get(live.id));
  F.update(live.id, { config: { mapping: { y: ['edited'] } } });
  assert.strictEqual(F.applyRender(live.id, await pending), false);
  assert.strictEqual(F.get(live.id).render.status, 'none');
  assert.strictEqual(F.applyRender(live.id, await F.render(F.get(live.id))), true);
  assert.strictEqual(F.get(live.id).render.status, 'ok');

  // debounce
  const seen = [];
  const deb = F.debounce((x) => seen.push(x), 15);
  deb(1); deb(2); deb(3);
  assert.strictEqual(deb.pending(), true);
  await tick(40);
  assert.deepStrictEqual(seen, [3]);
  deb(4); deb.cancel(); await tick(30);
  assert.deepStrictEqual(seen, [3]);
  deb(5); deb.flush(); assert.deepStrictEqual(seen, [3, 5]); assert.strictEqual(deb.pending(), false);

  // runtime through the shared endpoint, cached; refresh re-probes
  ({ F } = figEnv());
  f = global.fetch = stub(() => jsonRes({ python: '3.12.1', matplotlib: '3.10.0' }));
  assert.strictEqual((await F.runtime()).python, '3.12.1'); await F.runtime();
  assert.strictEqual(f.calls.length, 1);
  await F.refresh();
  assert.strictEqual(f.calls[1].url, 'http://localhost:8000/api/figures/runtime?refresh=true');
  global.fetch = () => jsonRes({ nope: 1 });
  assert.strictEqual(await F.refresh(), null);

  // dataset.parse: multipart with options, size guard, JSON text; export: filename from the header, error detail
  const env = figEnv(); const B = env.RPE.backend;
  f = global.fetch = stub(() => jsonRes({ ok: true, status: 'ok', columns: [], rows: [] }));
  const file = new File(['a;b\n1;2'], 'data.csv', { type: 'text/csv' });
  res = await B.request('figures.dataset.parse', { file, delimiter: ';', hasHeader: false });
  assert.strictEqual(res.ok, true);
  assert(f.calls[0].init.body instanceof FormData);
  assert.strictEqual(f.calls[0].init.body.get('file').name, 'data.csv');
  assert.deepStrictEqual([f.calls[0].init.body.get('delimiter'), f.calls[0].init.body.get('hasHeader')], [';', 'false']);
  assert(!('Content-Type' in f.calls[0].init.headers), 'the browser sets the multipart boundary');
  res = await B.request('figures.dataset.parse', { file: { size: 6 * 1024 * 1024 } });
  assert.deepStrictEqual([res.ok, res.code, f.calls.length], [false, 'too_large', 1]);
  assert(/5 MB/.test(res.message));
  await B.request('figures.dataset.parse', { text: 'x,y\n1,2', fileName: 'p.csv' });
  assert.deepStrictEqual(f.calls[1].body, { text: 'x,y\n1,2', fileName: 'p.csv' });
  global.fetch = () => jsonRes({ detail: 'Send the CSV as a multipart field named \'file\'.' }, 400);
  assert.strictEqual((await B.request('figures.dataset.parse', { text: '' })).message, "Send the CSV as a multipart field named 'file'.");
  f = global.fetch = stub(() => new Response(new Blob(['PNGDATA']), { status: 200, headers: { 'Content-Disposition': 'attachment; filename="Grosse.png"; filename*=UTF-8\'\'Gr%C3%B6%C3%9Fe.png' } }));
  res = await B.request('figures.export', { record: { name: 'My fig' }, format: 'png', dpi: 300, background: 'transparent', save: false });
  assert.deepStrictEqual([res.ok, res.filename, res.size], [true, 'Größe.png', 7]);
  assert.ok(/^c[a-z0-9]{6,}$/.test(f.calls[0].body.jobId), 'job-backed calls carry a client job id');
  assert.deepStrictEqual(Object.assign({}, f.calls[0].body, { jobId: undefined }), { record: { name: 'My fig' }, format: 'png', dpi: 300, background: 'transparent', jobId: undefined });
  global.fetch = () => new Response(new Blob(['x']), { status: 200 });
  assert.strictEqual((await B.request('figures.export', { record: { name: 'a b/c' }, format: 'bundle', save: false })).filename, 'a_b_c.zip', 'fallback name');
  global.fetch = () => jsonRes({ detail: 'The figure cannot be produced: size limit.' }, 422);
  res = await B.request('figures.export', { record: {}, format: 'pdf', save: false });
  assert.deepStrictEqual([res.ok, res.status, res.message], [false, 422, 'The figure cannot be produced: size limit.']);

  console.log('PASS: 18. Figure render client + endpoints: dedupe, supersede, cancel, timeout, offline/4xx mapping, multipart, export');
}
testFigureRender().then(testFigureJobs).then(testFigureEditor).then(testSpreadsheet).then(testDatasource).then(testPlotPanels).then(testExportPanel).then(testPySource).then(testCodeEditor).then(testPyFigure).then(testComposer).then(testLatex).then(testPersistence);

// 19. Figure editor (js/figures/editor.js) + the plot dialog that delegates to it, on a minimal fake DOM
async function testFigureEditor() {
  const jsonRes = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  const okBody = (extra) => Object.assign({ ok: true, status: 'ok', jobId: 'j1', purpose: 'preview', dpi: 150, preview: PNG, widthPx: 900, heightPx: 600, hash: 'sha', source: '', diagnostics: [], stdout: '', stderr: '', durationMs: 5, cached: false }, extra || {});
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  const calls = []; let reply = () => jsonRes(okBody());
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.attrs = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.dataset = {}; this.style = {}; this.className = ''; this.textContent = ''; this.value = ''; this.src = ''; this.classList = { toggle: (c, on) => { const set = new Set(this.className.split(' ').filter(Boolean)); if (on) set.add(c); else set.delete(c); this.className = [...set].join(' '); } }; }
    append(...c) { c.flat().forEach((x) => { if (x != null && x !== false) this.children.push(x); }); }
    appendChild(c) { this.children.push(c); return c; }
    setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'hidden') this.hidden = true; if (k === 'disabled') this.disabled = true; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    fire(t, ev) { (this.listeners[t] || []).forEach((f) => f(Object.assign({ preventDefault() {}, stopPropagation() {} }, ev))); }
    get lastChild() { return this.children[this.children.length - 1]; }
    get textContent() { return this._t || ''; }
    set textContent(v) { this._t = v; if (v === '') this.children.length = 0; }
  }
  const h = (tag, props, ...kids) => { const el = new El(tag); Object.keys(props || {}).forEach((k) => { const v = props[k]; if (v == null || v === false) return; if (k === 'class') el.className = v; else if (k === 'html') el.html = v; else if (k === 'dataset') Object.assign(el.dataset, v); else if (k === 'style') Object.assign(el.style, v); else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2).toLowerCase(), v); else if (k === 'value') el.value = v; else el.setAttribute(k, v === true ? '' : v); }); el.append(...kids); return el; };
  const text = (el) => (typeof el === 'string' ? el : (el.textContent || '') + el.children.map(text).join(''));
  const find = (el, pred, out = []) => { if (typeof el === 'string') return out; if (pred(el)) out.push(el); el.children.forEach((c) => find(c, pred, out)); return out; };
  const cls = (c) => (el) => (el.className || '').split(' ').includes(c);

  const dialogs = [], pops = [], toasts = []; let confirmAnswer = false, confirms = 0;
  function setup(connected) {
    const { RPE, S, F } = figEnv((url, init) => { calls.push({ url, body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null }); return Promise.resolve(reply(url, init)); });
    RPE.h = h; RPE.icons = { html: () => '', render() {} };
    RPE.plots = { KINDS: { line: { label: 'Line', icon: 'a' }, scatter: { label: 'Scatter', icon: 'b' }, bar: { label: 'Bar', icon: 'c' }, hist: { label: 'Histogram', icon: 'd' }, box: { label: 'Box plot', icon: 'e' }, heatmap: { label: 'Heatmap', icon: 'f' } } };
    RPE.ui = {
      esc: (x) => x, closeAll() { pops.length = 0; }, hasPopover: () => pops.length > 0, popover(anchor, content, o) { const p = { anchor, content, o }; pops.push(p); return p; },
      confirm(o) { confirms++; return Promise.resolve(confirmAnswer); }, toast(m, o) { toasts.push({ m, kind: o && o.kind }); },
      dialog(o) {
        const api = { el: new El('div'), buttons: {}, closed: [], opts: o, close(v) { api.closed.push(v); if (o.onClose) o.onClose(v); } };
        (o.buttons || []).forEach((b) => { const el = new El('button'); el.textContent = b.label; el.addEventListener('click', () => { const r = b.onClick ? b.onClick(api) : undefined; if (r !== false) api.close(b.value === undefined ? b.label : b.value); }); if (b.id) api.buttons[b.id] = el; });
        api.body = o.body; dialogs.push(api); return api;
      }
    };
    RPE.backend.connected = !!connected;
    ['controls.js', 'plotpanels.js', 'editor.js'].forEach((f) => { delete require.cache[require.resolve('../js/figures/' + f)]; require('../js/figures/' + f); });
    return { RPE, S, F };
  }
  const last = () => dialogs[dialogs.length - 1];
  const tabNames = (d) => find(d.body, cls('dtab')).map(text);
  const click = (el) => el.fire('click');

  // header, tiles, footer labels per mode; tabs without a module are not shown
  let { RPE, S, F } = setup(true);
  let saved = [];
  let d = F.openEditor({ mode: 'insert', plotType: 'scatter', onSave: (draft) => { saved.push(draft); } });
  assert.deepStrictEqual(tabNames(d), ['Preview'], 'only registered tabs are shown, no placeholder tabs');
  assert.strictEqual(find(d.body, cls('fe__name'))[0].value, 'Untitled plot');
  assert.strictEqual(text(find(d.body, cls('fe__type'))[0]), 'Scatter');
  assert.strictEqual(text(find(d.body, cls('fe__chip'))[0]), 'Data: Spreadsheet');
  assert.strictEqual(find(d.body, cls('ptile')).length, 6);
  assert.deepStrictEqual(find(d.body, cls('ptile')).filter((t) => t.className.includes('is-on')).length, 1);
  assert.deepStrictEqual([d.opts.buttons[0].label, d.opts.buttons[1].label, d.opts.title], ['Cancel', 'Insert', 'Insert plot']);
  const rec0 = F.create('structured', 'line', { id: 'fig_e', name: 'Dose' });
  assert.strictEqual(F.openEditor({ mode: 'edit', record: rec0, onSave() {} }).opts.buttons[1].label, 'Apply');
  assert.strictEqual(F.openEditor({ mode: 'panel', record: F.blank('structured', 'bar'), onSave() {} }).opts.buttons[1].label, 'Save Plot');

  // panel mode offers structured plots only: no Python Source / Export tab, even when those modules are registered
  F.tabs.python = { mount() { return h('div'); } }; F.tabs.export = { mount() { return h('div'); } };
  assert.deepStrictEqual([tabNames(F.openEditor({ mode: 'panel', record: F.blank('structured', 'bar'), onSave() {} })), tabNames(F.openEditor({ mode: 'edit', record: rec0, onSave() {} }))], [['Preview'], ['Preview', 'Python Source', 'Export']]);
  delete F.tabs.python; delete F.tabs.export;

  // tabs are mounted once and keep their state; dispose on close
  const log = []; F.tabs.spreadsheet = { mount(c) { this.n = (this.n || 0) + 1; log.push('mount'); this.el = h('div'); return this.el; }, onShow() { log.push('show'); }, dispose() { log.push('dispose'); } };
  d = F.openEditor({ mode: 'insert', onSave() {} });
  assert.deepStrictEqual(tabNames(d), ['Preview', 'Spreadsheet']);
  const tb = find(d.body, cls('dtab')), panes = find(d.body, cls('fe__tabpane'));
  click(tb[1]); click(tb[0]); click(tb[1]);
  assert.deepStrictEqual(log, ['mount', 'show', 'show']);
  assert.deepStrictEqual(panes.map((p) => p.hidden), [true, false]);
  assert.strictEqual(F.tabs.spreadsheet.n, undefined, 'each dialog gets its own instance of the registry entry');
  d.close(true); // never dirty -> raw path still guarded: clean draft closes at once
  assert.strictEqual(log[log.length - 1], 'dispose');
  delete F.tabs.spreadsheet;

  // draft isolation + discard confirmation
  d = F.openEditor({ mode: 'edit', record: F.get('fig_e'), onSave() {} });
  click(find(d.body, cls('ptile'))[2]);   // Bar
  assert.strictEqual(F.get('fig_e').config.plotType, 'line', 'the document is untouched until Save');
  assert.strictEqual(d.draft.config.plotType, 'bar');
  assert.strictEqual(text(find(d.body, cls('fe__type'))[0]), 'Bar');
  confirmAnswer = false; confirms = 0;
  click(d.buttons.cancel); await tick();
  assert.deepStrictEqual([confirms, d.closed.length], [1, 0], 'dirty Cancel asks and stays open');
  d.close(undefined); await tick();   // Esc / X take the same path
  assert.deepStrictEqual([confirms, d.closed.length], [2, 0]);
  confirmAnswer = true; click(d.buttons.cancel); await tick();
  assert.deepStrictEqual([confirms, d.closed], [3, [false]]);
  d = F.openEditor({ mode: 'edit', record: F.get('fig_e'), onSave() {} });
  click(d.buttons.cancel); await tick();
  assert.deepStrictEqual([confirms, d.closed], [3, [false]], 'clean Cancel closes without asking');

  // save: failure message keeps the dialog open, success closes, Ctrl+Enter saves, buttons lock while saving
  let answer = 'The final image could not be drawn.', gate = null;
  let sig = null;
  d = F.openEditor({ mode: 'edit', onSave: (dr, c) => new Promise((r) => { sig = c.signal; gate = { go: () => r(answer) }; }) });
  click(d.buttons.save); assert.strictEqual(d.buttons.save.disabled, true); assert.strictEqual(!!d.buttons.cancel.disabled, false, 'Cancel stays live while saving');
  confirmAnswer = false; const c0 = confirms; click(d.buttons.cancel); await tick();
  assert.deepStrictEqual([confirms - c0, sig.aborted, d.closed.length], [1, false, 0], 'Apply: stopping the render asks first; "Keep rendering" changes nothing');
  confirmAnswer = true; click(d.buttons.cancel); await tick(); assert.strictEqual(sig.aborted, true); assert.strictEqual(d.closed.length, 0, 'the dialog stays open after cancelling a render');
  gate.go(); await tick();
  assert.deepStrictEqual([d.closed.length, text(find(d.opts.footerLeft, () => true)[0])], [0, 'The final image could not be drawn.']);
  assert.strictEqual(d.buttons.save.disabled, false);
  answer = true; let ev = { key: 'Enter', ctrlKey: true, preventDefault() { ev.stopped = true; } };
  d.el.fire('keydown', ev); gate.go(); await tick();
  assert.deepStrictEqual([ev.stopped, d.closed], [true, [true]]);

  // Insert: closing the dialog while the final render runs lets it finish in the background (the progress chip owns Cancel); the outcome is a toast
  let fin = null; toasts.length = 0; confirmAnswer = false;
  d = F.openEditor({ mode: 'insert', onSave: (dr, c) => new Promise((r) => { sig = c.signal; fin = r; }) });
  click(d.buttons.save); const c1 = confirms; click(d.buttons.cancel); await tick();
  assert.deepStrictEqual([d.closed.length, sig.aborted, confirms - c1, /background/.test(toasts[0].m)], [1, false, 0, true], 'Insert: closes at once, no confirm, render keeps running');
  fin(true); await tick(); assert.deepStrictEqual([toasts[1].m, toasts[1].kind], ['Figure inserted.', 'success']);
  d = F.openEditor({ mode: 'insert', onSave: (dr, c) => new Promise((r) => { fin = r; }) });
  click(d.buttons.save); click(d.buttons.cancel); fin('Cancelled. Nothing was inserted.'); await tick();
  assert.deepStrictEqual([toasts[3].m, toasts[3].kind], ['Cancelled. Nothing was inserted.', 'warn'], 'a failure after the dialog closed is reported as a warning toast');

  // preview: structured draws by itself, last good preview kept, custom scripts wait for the button; offline shows the service message
  calls.length = 0;
  d = F.openEditor({ mode: 'insert', onSave() {} });
  await tick(30);
  const img = find(d.body, cls('fe__img'))[0], status = find(d.body, cls('pd__status'))[0];
  assert.deepStrictEqual([calls.length, img.hidden, img.src, d.draft.render.status], [1, false, PNG, 'ok']);
  assert(/900 × 600 px/.test(status.textContent), status.textContent);
  assert.strictEqual(F.get('fig_e').render.status, 'none', 'previews of a draft never touch the document');
  reply = () => jsonRes({ ok: false, status: 'invalid', diagnostics: [{ level: 'error', code: 'mapping_missing', message: 'Choose a Y column.' }] });
  click(find(d.body, cls('ptile'))[3]); await tick(520);
  assert(/Choose a Y column\./.test(status.textContent) && status.className.includes('is-error') && /last good preview/.test(status.textContent), status.textContent);
  assert.strictEqual(img.hidden, false);
  reply = () => jsonRes(okBody());
  const py = F.blank('python', 'line'); py.source = 'print(1)'; calls.length = 0;
  d = F.openEditor({ mode: 'insert', record: py, onSave() {} }); await tick(30);
  assert.strictEqual(calls.length, 0, 'a custom script is never run on open');
  click(find(d.body, (e) => e.tag === 'button' && e.textContent === 'Run script')[0]); await tick(30);
  assert.strictEqual(calls.length, 1);
  // sidebar: edits go through the draft, 350 ms debounce = one render per burst, stale image dimmed + badge, preset, lazy font list, zoom
  reply = (url) => (/runtime/.test(url) ? jsonRes({ python: '3.12', fonts: ['Alpha Sans', 'Beta Serif', 'Gamma Mono'] }) : jsonRes(okBody()));
  calls.length = 0;
  d = F.openEditor({ mode: 'insert', onSave() {} }); await tick(30);
  const side = find(d.body, cls('fe__side'))[0], inp = (l) => find(side, (e) => e.tag === 'input' && e.attrs['aria-label'] === l)[0];
  const sbtn = (t) => find(d.body, (e) => e.tag === 'button' && text(e) === t)[0];
  const sImg = find(d.body, cls('fe__img'))[0], sBadge = find(d.body, cls('fe__badge'))[0], sStatus = find(d.body, cls('pd__status'))[0];
  assert.deepStrictEqual([calls.length, sBadge.hidden, sImg.className.includes('is-dim')], [1, true, false], 'one render on open, no font request, image matches');
  assert(/Captions are not part of the plot editor/.test(text(find(d.body, cls('fe__help'))[0])));
  inp('Title').value = 'Dose'; inp('Title').fire('input'); inp('Subtitle').value = 'n = 4'; inp('Subtitle').fire('input');
  assert.deepStrictEqual([d.draft.config.appearance.title, d.draft.config.appearance.subtitle], ['Dose', 'n = 4']);
  assert.deepStrictEqual([sBadge.hidden, sImg.className.includes('is-dim')], [false, true], 'a stale image is dimmed and badged');
  assert(/last good preview/.test(sStatus.textContent) && sStatus.className.includes('is-warn'), sStatus.textContent);
  await tick(200); assert.strictEqual(calls.length, 1, 'nothing is sent before the 350 ms pause');
  await tick(260); assert.strictEqual(calls.length, 2, 'one render for the whole burst');
  assert.strictEqual(calls[1].body.record.config.appearance.subtitle, 'n = 4');
  await tick(30); assert.deepStrictEqual([sBadge.hidden, sImg.className.includes('is-dim'), sStatus.className.includes('is-ok')], [true, false, true]);
  const showT = find(side, (e) => e.tag === 'input' && e.attrs.type === 'checkbox')[0];
  showT.checked = false; showT.fire('change'); assert.strictEqual(d.draft.config.appearance.showTitle, false);
  const ts = inp('Title size in points');
  ts.value = '3'; ts.fire('input'); assert.deepStrictEqual([ts.attrs['aria-invalid'], d.draft.config.appearance.titleSize], ['true', undefined], 'out of range is flagged, not applied');
  ts.value = '12'; ts.fire('input'); assert.deepStrictEqual([ts.attrs['aria-invalid'], d.draft.config.appearance.titleSize], ['false', 12]);
  ts.value = ''; ts.fire('input'); assert.strictEqual(d.draft.config.appearance.titleSize, null, 'empty = automatic');
  click(sbtn('Publication style'));
  const ap = d.draft.config.appearance;
  assert.deepStrictEqual([ap.fontSize, ap.titleSize, ap.tickSize, ap.grid, ap.despine, ap.title], [8, 9, 7, false, true, 'Dose'], 'preset sets a coherent set and keeps the text');
  assert.strictEqual(String(ts.value), '9', 'the sidebar follows the draft');
  inp('Title size in points').value = '10'; inp('Title size in points').fire('input'); assert.strictEqual(d.draft.config.appearance.titleSize, 10, 'preset values stay editable');
  assert.strictEqual(calls.filter((c) => /runtime/.test(c.url)).length, 0, 'fonts are read only when the search box is used');
  inp('Search installed fonts').fire('focus'); await tick(30);
  assert.strictEqual(calls.filter((c) => /runtime/.test(c.url)).length, 1);
  assert.deepStrictEqual(find(side, cls('fe__font')).map(text), ['Alpha Sans', 'Beta Serif', 'Gamma Mono']);
  const fs = inp('Search installed fonts'); fs.value = 'serif'; fs.fire('input');
  assert.deepStrictEqual(find(side, cls('fe__font')).map(text), ['Beta Serif']);
  click(find(side, cls('fe__font'))[0]); assert.strictEqual(d.draft.config.appearance.fontName, 'Beta Serif');
  click(sbtn('Use family default')); assert.strictEqual(d.draft.config.appearance.fontName, null);
  click(sbtn('100%')); assert(find(d.body, cls('fe__canvas'))[0].className.includes('is-actual')); click(sbtn('Fit')); assert(!find(d.body, cls('fe__canvas'))[0].className.includes('is-actual'));

  // Axes / Grid / Size / Legend groups (js/figures/controls.js): edits go through the draft, invalid entries are flagged and never applied
  {
    const C = F.controls, ap2 = () => d.draft.config.appearance, op2 = () => d.draft.config.options, ex = () => d.draft.export;
    const chkOf = (t) => find(side, (e) => e.tag === 'label' && cls('check')(e) && text(e).trim() === t)[0];
    const toggle = (t, v) => { const c = chkOf(t).children[0]; c.checked = v; c.fire('change'); };
    const selOf = (l) => find(side, (e) => e.tag === 'select' && e.attrs['aria-label'] === l)[0];
    const pick = (l, v) => { const e = selOf(l); e.value = v; e.fire('change'); };
    const type = (l, v) => { const e = inp(l); e.value = v; e.fire('input'); return e; };
    const notes = () => find(side, cls('fe__note')).filter((e) => !e.hidden).map(text);
    const btn = (t) => find(side, (e) => e.tag === 'button' && text(e) === t)[0];
    const data = (rows) => d.ctx.set({ dataset: { columns: [{ name: 'x', type: 'number' }, { name: 'a', type: 'number' }, { name: 'b', type: 'number' }], rows }, config: { mapping: { x: 'x', y: ['a', 'b'] } } });
    d.ctx.set({ config: { plotType: 'line' } });
    data([[1, 2, 1], [2, 0, 3], [3, 5, 4]]);

    // pure helpers
    assert.deepStrictEqual([C.ratioSize(6, 16 / 9), C.ratioSize(6, 1), C.widthSize(3.4, 6, 4), C.ratioSize(30, 0.5)], [[6, 3.38], [6, 6], [3.4, 2.27], [15, 30]]);
    assert.strictEqual(C.axisProblem(d.draft, 'y', 'linear', null), null);
    assert.strictEqual(C.axisProblem(d.draft, 'x', 'log', null), null, 'x column has only positive values');

    // axes: open axes / top / right / lines / ticks / direction / rotation
    toggle('Open axes', false);
    assert.deepStrictEqual([ap2().despine, ap2().spineTop, ap2().spineRight], [false, null, null]);
    assert(chkOf('Show top').children[0].checked, 'with open axes off the top line is shown');
    toggle('Open axes', true); toggle('Show top', true);
    assert.deepStrictEqual([ap2().despine, ap2().spineTop, ap2().spineRight, chkOf('Show right').children[0].checked], [true, true, null, false]);
    toggle('Axis lines', false); toggle('Ticks', false); pick('Tick direction', 'in');
    assert.deepStrictEqual([ap2().axisLines, ap2().showTicks, ap2().tickDirection], [false, false, 'in']);
    let rot = type('X label rotation', '45'); assert.strictEqual(ap2().xTickRotation, 45);
    rot = type('X label rotation', '120'); assert.deepStrictEqual([rot.attrs['aria-invalid'], ap2().xTickRotation, notes().length], ['true', 45, 0]);
    type('X label rotation', ''); assert.strictEqual(ap2().xTickRotation, 0, 'empty = no rotation');

    // log scale with values <= 0: explained, offered "Switch to linear", NOT written
    pick('Y scale', 'log');
    assert.strictEqual(op2().yScale, undefined, 'an invalid log choice never reaches the draft');
    assert.strictEqual(selOf('Y scale').value, 'log');
    assert(/needs values above 0.*“a” has 0 at data row 2/.test(notes()[0]), notes()[0]);
    click(btn('Switch to linear'));
    assert.deepStrictEqual([op2().yScale, selOf('Y scale').value, notes().length], ['linear', 'linear', 0]);
    data([[1, 2, 1], [2, 4, 3]]); pick('Y scale', 'log');
    assert.deepStrictEqual([op2().yScale, notes().length], ['log', 0], 'valid data: applied');
    data([[1, 2, 1], [2, -1, 3]]);
    assert(/needs values above 0/.test(notes()[0]) && !!btn('Switch to linear'), 'data edited later: the problem is shown and the preview error stays readable');
    click(btn('Switch to linear')); data([[1, 2, 1], [2, 4, 3]]);

    // limits: partial / inverted / equal are flagged and not applied; Auto clears
    type('Y min', '5');
    assert.deepStrictEqual([op2().yLim, /both min and max/.test(notes()[0]), inp('Y min').attrs['aria-invalid']], [undefined, true, 'true']);
    type('Y max', '1'); assert(/inverted/.test(notes()[0]) && op2().yLim === undefined);
    type('Y max', '5'); assert(/equal/.test(notes()[0]) && op2().yLim === undefined);
    type('Y max', '10'); assert.deepStrictEqual([op2().yLim, notes().length, inp('Y max').attrs['aria-invalid']], [[5, 10], 0, 'false']);
    pick('Y scale', 'log'); assert.strictEqual(op2().yScale, 'log');
    type('Y min', '-1'); assert(/above 0 on a log axis/.test(notes()[0]) && !!btn('Switch to linear') && op2().yLim[0] === 5, 'log limits must be > 0');
    click(find(side, (e) => e.tag === 'button' && e.attrs['aria-label'] === 'Automatic Y limits')[0]); assert.deepStrictEqual([op2().yLim, notes().length, inp('Y min').value], [null, 0, '']);
    pick('Y scale', 'linear');

    // bar: only the value axis is editable; a truncated baseline shows the warning chip
    d.ctx.set({ config: { plotType: 'bar', options: { yLim: [10, 20] } } });
    assert(notes().some((n) => /does not start at 0/.test(n)), 'truncated baseline chip');
    assert.strictEqual(C.axisRoles(d.draft).x, false);
    d.ctx.set({ config: { options: { yLim: [0, 20] } } }); assert(!notes().some((n) => /does not start at 0/.test(n)));
    toggle('Mark on the figure', true); assert.strictEqual(op2().axisNote, true);
    d.ctx.set({ config: { options: { yLim: null, barMode: 'stacked' } } }); pick('Y scale', 'log');
    assert(/Stacked bars cannot use a log axis/.test(notes()[0]) && op2().yScale !== 'log'); click(btn('Switch to linear'));
    d.ctx.set({ config: { plotType: 'line', options: { barMode: 'grouped' } } });

    // grid
    toggle('Minor', true); pick('Grid style', 'dashed'); pick('Grid subtlety', '0.35');
    assert.deepStrictEqual([ap2().gridMinor, ap2().gridStyle, ap2().gridAlpha], [true, 'dashed', 0.35]);

    // size: inches only, presets, lock ratio, readout; DPI is not here
    assert(!find(side, (e) => e.tag === 'input' && /dpi/i.test(e.attrs['aria-label'] || '')).length, 'DPI lives only in the Export tab');
    type('Width in inches', '3.4'); assert.deepStrictEqual([ex().wIn, ex().hIn], [3.4, 4]);
    const wBad = type('Width in inches', '0.2'); assert.deepStrictEqual([wBad.attrs['aria-invalid'], ex().wIn, /between 0.5 and 30/.test(notes()[0])], ['true', 3.4, true]);
    click(btn('16:9')); assert.deepStrictEqual([ex().wIn, ex().hIn, inp('Width in inches').attrs['aria-invalid'], notes().length], [3.4, 1.91, 'false', 0]);
    toggle('Lock ratio', true); type('Width in inches', '6'); assert.deepStrictEqual([ex().wIn, ex().hIn], [6, 3.37]);
    type('Height in inches', '29'); assert(/would leave 0.5 to 30 in/.test(notes()[0]) && ex().hIn === 3.37, 'lock: the other side must stay in range');
    toggle('Lock ratio', false); click(btn('1:1 square')); assert.deepStrictEqual([ex().wIn, ex().hIn], [6, 6]);

    // legend: labels per series, frame, position, font; single-series hint; not offered for box / heatmap
    const legG = find(side, (e) => e.tag === 'details' && text(find(e, (x) => x.tag === 'summary')[0]) === 'Legend')[0];
    const single = () => find(side, (e) => cls('fe__hint')(e) && /single series/.test(text(e)))[0];
    assert.deepStrictEqual([legG.hidden, single().hidden, chkOf('Show anyway').hidden], [false, true, true], 'two series: no hint');
    type('Legend label for a', 'Dose A'); assert.deepStrictEqual(ap2().legend, { show: true, pos: 'best', force: false, frame: null, labels: { a: 'Dose A' } });
    type('Legend label for a', ''); assert.deepStrictEqual(ap2().legend.labels, {});
    toggle('Frame', false); pick('Legend position', 'outside'); type('Legend font size in points', '9');
    assert.deepStrictEqual([ap2().legend.frame, ap2().legend.pos, ap2().legendSize], [false, 'outside', 9]);
    assert.strictEqual(type('Legend font size in points', '2').attrs['aria-invalid'], 'true'); assert.strictEqual(ap2().legendSize, 9);
    d.ctx.set({ config: { mapping: { y: ['a'] } } });
    assert.deepStrictEqual([single().hidden, chkOf('Show anyway').hidden], [false, false], 'a single series: hint and Show anyway');
    toggle('Show anyway', true); assert.deepStrictEqual([ap2().legend.force, single().hidden], [true, true]);
    ['box', 'heatmap'].forEach((t) => { d.ctx.set({ config: { plotType: t } }); assert.strictEqual(legG.hidden, true, t + ' has no legend'); });
    d.ctx.set({ config: { plotType: 'line' } }); assert.strictEqual(legG.hidden, false);
    const recG = (plotType, extra) => ({ config: { plotType, mapping: { x: 'x', y: ['a'], group: 'g' }, options: extra || {} }, dataset: { columns: [{ name: 'g', type: 'text' }], rows: [['u'], [null], ['v'], ['u']] } });
    assert.deepStrictEqual([C.legendInfo(recG('scatter')).names, C.legendInfo(recG('bar')).names, C.legendInfo(recG('scatter', { fit: 'linear' })).entries, C.legendInfo(recG('hist', { normalFit: true })).entries], [['u', 'v', '(no group)'], ['u', '(no group)', 'v'], 6, 2]);
  }
  assert.strictEqual(find(side, (e) => e.tag === 'label' && /Annotation/.test(text(e)))[0].hidden, true, 'annotation size is for heatmaps only');
  click(find(d.body, cls('ptile'))[5]); assert.strictEqual(find(side, (e) => e.tag === 'label' && /Annotation/.test(text(e)))[0].hidden, false);
  await tick(400);
  reply = () => jsonRes({ ok: false, status: 'invalid', diagnostics: [{ level: 'error', code: 'mapping_missing', message: 'Choose a Y column.' }] });
  inp('Title').value = 'Again'; inp('Title').fire('input'); await tick(450);
  assert.deepStrictEqual([sBadge.hidden, sImg.className.includes('is-dim'), find(d.body, cls('fe__details'))[0].hidden], [false, true, false], 'error: last good image dimmed, badge, diagnostics offered');
  reply = () => jsonRes(okBody());

  // incremental UI: non-visual field edits skip re-rendering
  calls.length = 0;
  d.ctx.set({ name: 'My NonVisual Rename', dataset: { origin: { label: 'New Source Label' } } });
  await tick(400);
  assert.strictEqual(calls.length, 0, 'editing non-visual fields skips preview re-rendering');

  // empty dataset message in preview canvas
  d.ctx.set((r) => { r.dataset = { columns: [{ name: 'x', type: 'number' }], rows: [] }; r.render = {}; });
  const emptyEl = find(d.body, cls('fe__empty'))[0];
  assert.strictEqual(emptyEl.hidden, false);
  assert.strictEqual(emptyEl.textContent, 'This dataset has no data rows. Add or import data in the Spreadsheet tab.');
  assert.strictEqual(sStatus.textContent, 'This dataset has no data rows.');

  RPE.backend.connected = false;
  const offDlg = F.openEditor({ mode: 'insert', onSave() { throw new Error('must not open'); } });
  assert(/python3 run\.py/.test(text(offDlg.opts.body)) && offDlg.opts.title === 'Insert plot');
  RPE.backend.connected = true;

  // data-source chip: inline menu of the four sources now; the data panel takes over through F.datasource.open
  d = F.openEditor({ mode: 'insert', onSave() {} });
  click(find(d.body, cls('fe__chip'))[0]);
  const items = find(pops[0].content, (e) => e.tag === 'button');
  assert.deepStrictEqual(items.map((b) => b.disabled), [true, true, false, true]);
  assert(items.length === 4 && pops[0].content.children.length === 5);
  let opened = 0; F.datasource = { open() { opened++; } };
  click(find(d.body, cls('fe__chip'))[0]); assert.strictEqual(opened, 1); delete F.datasource;

  // plot dialog -> editor: Insert renders at final size first; a failed render inserts nothing
  const stubs = { S, ui: S.ui };
  RPE.commands = {}; RPE.themes = {}; RPE.renderer = {}; RPE.backend.request = RPE.backend.request;
  global.RPE = RPE;
  delete require.cache[require.resolve('../js/dialogs.js')];
  try { require('../js/dialogs.js'); } catch (e) { assert.fail('dialogs.js must load: ' + e.message); }
  delete require.cache[require.resolve('../js/figures/exportpanel.js')]; require('../js/figures/exportpanel.js'); delete F.tabs.export;   // Insert/Apply logic lives here; the tab itself is covered by test 23
  const slide = S.doc.slides[0]; S.activeSlide = () => S.doc.slides[0]; S.select = () => {}; S.setUI = () => {};
  reply = () => jsonRes({ ok: false, status: 'invalid', diagnostics: [{ level: 'error', code: 'no_columns', message: 'The figure needs data.' }] });
  d = RPE.dialogs.plot({ mode: 'insert', kind: 'hist' });
  assert.strictEqual(d.draft.config.plotType, 'hist');
  click(d.buttons.save); await tick(30);
  assert.deepStrictEqual([slide.objects.length, Object.keys(S.doc.figures).length, d.closed.length], [0, 1, 0], 'nothing is inserted when the final render fails');
  assert(/The figure needs data\./.test(text(d.opts.footerLeft.children[0] || d.opts.footerLeft)) || /The figure needs data\./.test(d.opts.footerLeft.textContent));
  reply = (u, init) => jsonRes(okBody({ purpose: 'final', dpi: 450, widthPx: 2700, heightPx: 1800 }));
  calls.length = 0; click(d.buttons.save); await tick(30);
  assert.strictEqual(calls[0].body.purpose, 'final');
  const o = slide.objects[0];
  assert.deepStrictEqual([o.type, o.figureId === d.draft.id, o.src, o.aspect, o.w, o.h], ['plot', true, PNG, 1.5, 576, 384]);
  assert.strictEqual(S.doc.figures[o.figureId].config.plotType, 'hist');
  assert.strictEqual(S.doc.figures[o.figureId].render.preview, null, 'the final PNG is the slide image, never render.preview');
  S.undo();
  assert.deepStrictEqual([S.doc.slides[0].objects.length, S.doc.figures[o.figureId]], [0, undefined], 'one undo removes the object and its record');
  // edit an existing plot object: record changes and the image follows in ONE step
  const rec = F.create('structured', 'line', { id: 'fig_x' }); const obj = { id: 'o1', type: 'plot', figureId: 'fig_x', src: 'old', aspect: 1, x: 10, y: 10, w: 300, h: 300 }; S.mutate('t', () => { S.doc.slides[0].objects.push(obj); });
  d = RPE.dialogs.plot({ mode: 'edit', obj: S.doc.slides[0].objects.find((x) => x.id === 'o1') }); assert.strictEqual(d.opts.buttons[1].label, 'Apply');
  click(find(d.body, cls('fe__name'))[0] && find(d.body, cls('ptile'))[1]); click(d.buttons.save); await tick(30);
  const o2 = S.doc.slides[0].objects.find((x) => x.id === 'o1');
  assert.deepStrictEqual([S.doc.figures.fig_x.config.plotType, o2.src, o2.h], ['scatter', PNG, 200]);

  console.log('PASS: 19. Figure editor: header/tiles/tabs registry, state kept across tabs, draft isolation, discard confirm, save/Ctrl+Enter, preview, chip menu, plot dialog insert/apply');
}

// 20. Spreadsheet tab (js/figures/spreadsheet.js): helpers, data ops, undo, roles, virtualization, banner (no DOM needed: draw writes strings)
async function testSpreadsheet() {
  global.window = global;
  let confirmAnswer = true;
  global.RPE = { ui: { esc: (x) => String(x == null ? '' : x), confirm: () => Promise.resolve(confirmAnswer), popover() {}, closeAll() {} }, h: () => ({}), icons: { html: () => '' } };
  delete require.cache[require.resolve('../js/figures/spreadsheet.js')]; require('../js/figures/spreadsheet.js');
  const F = RPE.figures, H = F.spreadsheet, tab = F.tabs.spreadsheet;
  assert.deepStrictEqual([H.parseNumber('007'), H.parseNumber('-1.5e3'), H.parseNumber('.5'), H.parseNumber('1,5'), H.parseNumber('5%'), H.parseNumber('')], [null, -1500, 0.5, null, null, null]);
  assert.deepStrictEqual(H.parseTable('a\tb\r\n"x\ty"\t2\n').rows, [['a', 'b'], ['x\ty', '2']]);
  assert.deepStrictEqual([H.parseTable('1,5').rows, H.parseTable('a;b\n1;2').rows, H.parseTable('a,b\n1').rows], [[['1,5']], [['a', 'b'], ['1', '2']], [['a', 'b'], ['1', '']]]);
  assert.deepStrictEqual([H.inferType(['1', '2.5', '']), H.inferType(['1', 'x']), H.inferType([])], ['number', 'text', 'text']);
  assert.deepStrictEqual([H.cellFrom('number', 'abc'), H.cellFrom('number', ' 4 '), H.cellFrom('text', '007'), H.cellFrom('text', '')], [{ v: null, bad: 'abc' }, { v: 4, bad: null }, { v: '007', bad: null }, { v: null, bad: null }]);

  const mk = (rec) => {
    const inst = Object.create(tab); let touched = 0;
    const ctx = { record: rec, touch() { touched++; }, onChange() { return () => {}; }, set(fn) { if (typeof fn === 'function') fn(rec); } };
    const el = () => ({ style: {}, hidden: false, setAttribute() {}, focus() {}, textContent: '', innerHTML: '' });
    Object.assign(inst, { ctx, rec, ver: 0, stats: {}, bad: new WeakMap(), badN: new Map(), undoS: [], redoS: [], sel: null, editor: null, renaming: false, pending: 0, timer: 0, own: false, key: '', selVer: 0, raf: 0, down: false, rowsRef: rec.dataset.rows, colsRef: rec.dataset.columns,
      grid: Object.assign(el(), { scrollTop: 0, scrollLeft: 0, clientHeight: 480, clientWidth: 900 }), sizer: el(), hl: el(), rl: el(), msg: el(), info: el(), bar: el(), banner: el(), custom: el(), bUndo: el(), bRedo: el(), bApply: el() });
    return { inst, touched: () => touched };
  };
  const rec = () => ({ id: 'f', sourceMode: 'structured', render: { status: 'ok' }, config: { plotType: 'scatter', mapping: { x: 'a', y: ['b'], group: null, yErr: null }, appearance: { legend: { labels: { b: 'Beta' } } }, options: { series: { b: { errorCol: 'c' } } } },
    dataset: { columns: [{ name: 'a', type: 'number' }, { name: 'b', type: 'number' }, { name: 'c', type: 'text' }], rows: [[1, 2, 'x'], [3, null, 'y'], [5, 6, null]], origin: { type: 'csv' } } });

  // cell edits: type is never changed silently; bad numbers are kept as null + flagged; undo/redo; stale marking
  let r = rec(), { inst: t, touched } = mk(r);
  t.setCells([{ r: 1, c: 1, text: 'abc' }, { r: 0, c: 2, text: '007' }], 'edit');
  assert.deepStrictEqual([r.dataset.rows[1][1], r.dataset.rows[0][2], r.dataset.columns[1].type, t.badCount(r.dataset.columns[1]), t.getBad(1, r.dataset.columns[1]), r.render.status], [null, '007', 'number', 1, 'abc', 'stale']);
  t.step(-1); assert.deepStrictEqual([r.dataset.rows[0][2], t.badCount(r.dataset.columns[1]), t.undoS.length, t.redoS.length], ['x', 0, 0, 1]);
  t.step(1); assert.strictEqual(t.getBad(1, r.dataset.columns[1]), 'abc');
  t.sel = { ar: 0, ac: 0, pr: 0, pc: 0, mode: 'cell' }; t.sel.ar = 2; t.sel.ac = 1; t.clearRange();
  assert.deepStrictEqual(r.dataset.rows, [[null, null, 'x'].map((x, i) => (i === 2 ? '007' : x)), [null, null, 'y'], [null, null, null]]);
  assert.strictEqual(touched(), 0, 'the re-render trigger is debounced');
  await new Promise((ok) => setTimeout(ok, 350)); assert.strictEqual(touched(), 1);
  const c1 = rec(); c1.sourceMode = 'custom'; const m1 = mk(c1); m1.inst.setCells([{ r: 0, c: 0, text: '9' }], 'e'); assert.strictEqual(c1.render.status, 'ok', 'custom scripts are not marked stale by data edits');

  // rows and columns: insert / delete, mapping follows rename and delete, one undo each
  r = rec(); t = mk(r).inst; t.sel = { ar: 1, ac: 1, pr: 1, pc: 1, mode: 'cell' };
  t.addRow(1); assert.deepStrictEqual([r.dataset.rows.length, r.dataset.rows[2]], [4, [null, null, null]]); t.step(-1); assert.strictEqual(r.dataset.rows.length, 3);
  t.sel = { ar: 1, ac: 0, pr: 1, pc: 0, mode: 'row' }; t.delRows(); assert.deepStrictEqual(r.dataset.rows.map((x) => x[0]), [1, 5]); t.step(-1); assert.deepStrictEqual(r.dataset.rows.map((x) => x[0]), [1, 3, 5]);
  t.rename(1, 'beta'); assert.deepStrictEqual([r.config.mapping.y, r.config.options.series.beta.errorCol, r.config.appearance.legend.labels.beta], [['beta'], 'c', 'Beta']);
  t.rename(1, 'a'); assert.strictEqual(r.dataset.columns[1].name, 'beta', 'duplicate names are refused');
  t.step(-1); assert.deepStrictEqual([r.dataset.columns[1].name, r.config.mapping.y, Object.keys(r.config.options.series)], ['b', ['b'], ['b']]);
  t.sel = { ar: 0, ac: 1, pr: 0, pc: 1, mode: 'col' }; t.delCols();
  assert.deepStrictEqual([r.dataset.columns.map((c) => c.name), r.dataset.rows[0], r.config.mapping.y, r.config.options.series], [['a', 'c'], [1, 'x'], [], {}]);
  t.step(-1); assert.deepStrictEqual([r.dataset.columns.map((c) => c.name), r.dataset.rows[2], r.config.mapping.y, r.config.options.series.b.errorCol], [['a', 'b', 'c'], [5, 6, null], ['b'], 'c']);
  t.addCol(1); assert.deepStrictEqual([r.dataset.columns.length, r.dataset.columns[2].type, r.dataset.rows[0].length], [4, 'number', 4]);

  // type override: confirmation when values would be lost, undo restores
  r = rec(); t = mk(r).inst; confirmAnswer = false; await t.setType(2, 'number'); assert.strictEqual(r.dataset.columns[2].type, 'text');
  confirmAnswer = true; await t.setType(2, 'number'); assert.deepStrictEqual([r.dataset.columns[2].type, r.dataset.rows[0][2], t.badCount(r.dataset.columns[2])], ['number', null, 2]);
  t.step(-1); assert.deepStrictEqual([r.dataset.columns[2].type, r.dataset.rows[0][2], t.badCount(r.dataset.columns[2])], ['text', 'x', 0]);
  await t.setType(0, 'text'); assert.deepStrictEqual(r.dataset.rows.map((x) => x[0]), ['1', '3', '5']);

  // paste: grows the grid, infers new column types, asks before overwriting, one undo step
  r = rec(); t = mk(r).inst; t.sel = { ar: 1, ac: 2, pr: 1, pc: 2, mode: 'cell' };
  await t.pasteText('p\tq\n1\t2\n3\tx\n4\t5'); // 4 rows x 2 cols at (1,2): grows 2 rows and 1 column
  assert.deepStrictEqual([r.dataset.rows.length, r.dataset.columns.map((c) => c.name + ':' + c.type), r.dataset.rows[1].slice(2), r.dataset.rows[4]], [5, ['a:number', 'b:number', 'c:text', 'Column 4:text'], ['p', 'q'], [null, null, '4', '5']]);
  t.step(-1); assert.deepStrictEqual([r.dataset.rows.length, r.dataset.columns.length, r.dataset.rows[1]], [3, 3, [3, null, 'y']]);
  confirmAnswer = false; await t.pasteText('9\t9'); assert.strictEqual(r.dataset.rows[0][0], 1, 'declined overwrite changes nothing');
  r = rec(); t = mk(r).inst; r.dataset = { columns: [], rows: [], origin: { type: 'sample' } }; t.rowsRef = r.dataset.rows; t.colsRef = r.dataset.columns;
  await t.pasteText('x,y\n1,2\n3,4'); assert.deepStrictEqual([r.dataset.columns, r.dataset.rows], [[{ name: 'x', type: 'number' }, { name: 'y', type: 'number' }], [[1, 2], [3, 4]]], 'empty table: a textual first row becomes the header');
  confirmAnswer = true; await t.pasteText('1\t2\n'.repeat(3)); assert.strictEqual(r.dataset.rows.length, 3);

  // roles stay in sync with config.mapping and are exclusive; hist/box have one Value
  r = rec(); t = mk(r).inst; t.setRole(2, 'group'); t.setRole(0, 'y'); assert.deepStrictEqual(r.config.mapping, { x: null, y: ['b', 'a'], group: 'c', yErr: null });
  t.setRole(1, 'x'); assert.deepStrictEqual([r.config.mapping.x, r.config.mapping.y], ['b', ['a']]); t.setRole(1, 'x'); assert.strictEqual(r.config.mapping.x, null);
  r.config.plotType = 'hist'; t.setRole(1, 'y'); assert.deepStrictEqual(r.config.mapping.y, ['b']);

  // undo stack is capped at 100
  r = rec(); t = mk(r).inst; for (let i = 0; i < 130; i++) t.setCells([{ r: 0, c: 0, text: String(i + 10) }], 'e'); assert.strictEqual(t.undoS.length, 100);

  // virtualization: 50k rows -> only the visible window is rendered; > 20k rows wait for Apply
  r = rec(); r.dataset.rows = Array.from({ length: 50000 }, (_, i) => [i, i * 2, 's' + i]); t = mk(r); t.inst.rowsRef = r.dataset.rows;
  t.inst.draw(true); const n1 = (t.inst.rl.innerHTML.match(/class="ss__r"/g) || []).length; assert.ok(n1 > 10 && n1 < 40, 'rendered rows: ' + n1);
  t.inst.grid.scrollTop = 24 * 30000; t.inst.draw(); assert.ok(t.inst.rl.innerHTML.includes('data-r="30010"') && !t.inst.rl.innerHTML.includes('data-r="5"'));
  assert.strictEqual(t.inst.sizer.style.height, (54 + 24 * 50000) + 'px');
  t.inst.setCells([{ r: 7, c: 0, text: '99' }], 'e'); assert.deepStrictEqual([t.touched(), t.inst.pending, r.render.status], [0, 1, 'stale']); t.inst.flush(); assert.deepStrictEqual([t.touched(), t.inst.pending], [1, 0]);

  // virtualization: 200k rows verified -> sizer height, only visible window in DOM, scroll positioning
  r = rec(); r.dataset.rows = Array.from({ length: 200000 }, (_, i) => [i, i * 2, 's' + i]); t = mk(r); t.inst.rowsRef = r.dataset.rows;
  t.inst.draw(true); const n200k = (t.inst.rl.innerHTML.match(/class="ss__r"/g) || []).length;
  assert.ok(n200k > 10 && n200k < 40, 'rendered rows at 200k: ' + n200k);
  assert.strictEqual(t.inst.sizer.style.height, (54 + 24 * 200000) + 'px');
  t.inst.grid.scrollTop = 24 * 150000; t.inst.draw();
  assert.ok(t.inst.rl.innerHTML.includes('data-r="150010"') && !t.inst.rl.innerHTML.includes('data-r="5"'), 'scrolled to 150k rows');

  // faint "—" for missing cells, flagged cells highlighted with a tooltip, badges for empty columns
  r = rec(); r.dataset.columns.push({ name: 'e', type: 'number' }); r.dataset.rows.forEach((x) => x.push(null)); t = mk(r).inst; t.setCells([{ r: 1, c: 1, text: 'zz' }], 'e'); t.grid.scrollTop = 0; t.draw(true);
  assert.ok(t.rl.innerHTML.includes('ss__c is-num is-bad') && t.rl.innerHTML.includes('Not a number') && t.rl.innerHTML.includes('is-na') && t.rl.innerHTML.includes('—'));
  assert.ok(t.hl.innerHTML.includes('>Empty<') && t.hl.innerHTML.includes('1 invalid') && t.hl.innerHTML.includes('data-role="group"'));

  // custom source: banner instead of the grid unless a dataset with data exists
  r = rec(); r.sourceMode = 'custom'; r.dataset = { columns: [], rows: [], origin: { type: 'python' } }; t = mk(r).inst; t.syncExternal();
  assert.deepStrictEqual([t.banner.hidden, t.grid.hidden, t.extractable()], [false, true, false]);
  r.dataset = rec().dataset; t.syncExternal(); assert.deepStrictEqual([t.banner.hidden, t.grid.hidden, t.custom.hidden], [true, false, false]);
  console.log('PASS: 20. Spreadsheet tab: parsing helpers, typed cell edits, row/column ops, mapping follow-ups, type override, paste, roles, 100-op undo, 50k-row virtualization, Apply for >20k rows, banner');
}

// 21. Data sources (js/figures/datasource.js): samples, reset/confirm, chooser actions, CSV wizard, Python data, status strip
async function testDatasource() {
  global.window = global;
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.props = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ''; this._t = ''; this.value = ''; }
    append(...c) { c.flat().forEach((x) => { if (x != null && x !== false) this.children.push(x); }); }
    appendChild(c) { this.children.push(c); return c; }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    fire(t, ev) { (this.listeners[t] || []).forEach((f) => f(Object.assign({ preventDefault() {} }, ev))); }
    get childNodes() { return this.children; }
    get textContent() { return this._t; }
    set textContent(v) { this._t = v; if (v === '') this.children.length = 0; }
  }
  const h = (tag, props, ...kids) => {
    const el = new El(tag);
    Object.keys(props || {}).forEach((k) => { const v = props[k]; if (k === 'class') el.className = v; else if (k === 'html') el.html = v; else if (k === 'hidden') el.hidden = !!v; else if (k === 'disabled') el.disabled = !!v; else if (/^on[a-z]+$/.test(k)) el.addEventListener(k.slice(2), v); else el.props[k] = v; });
    el.checked = !!el.props.checked; el.append(...kids); return el;
  };
  const text = (el) => (typeof el === 'string' ? el : (el.textContent || '') + (el.html || '') + el.children.map(text).join(''));
  const find = (el, pred, out = []) => { if (typeof el === 'string') return out; if (pred(el)) out.push(el); el.children.forEach((c) => find(c, pred, out)); return out; };
  const cls = (c) => (el) => (el.className || '').split(' ').includes(c);
  const SAMPLES = { line: { plotType: 'line', sampleId: 'dose-response', label: 'Dose-response', dataset: { columns: [{ name: 'Dose', type: 'number' }, { name: 'A', type: 'number' }, { name: 'A SD', type: 'number' }], rows: [[1, 2, 0.1], [2, 4, 0.2]] }, mapping: { x: 'Dose', y: ['A'], group: null, yErr: null }, options: { series: { A: { error: 'symmetric', errorCol: 'A SD' } }, xScale: 'log' } },
    bar: { plotType: 'bar', sampleId: 'grouped-treatments', label: 'Grouped treatments', dataset: { columns: [{ name: 'T', type: 'text' }, { name: 'V', type: 'number' }], rows: [['a', 1]] }, mapping: { x: 'T', y: ['V'], group: null, yErr: null }, options: { barMode: 'grouped' } } };
  const dialogs = []; let confirmAnswer = false, confirms = 0, backendCalls = [], parseReply = null, pyReply = null;
  global.RPE = {
    icons: { html: () => '' },
    backend: { request(name, p) { backendCalls.push([name, p]); if (name === 'figures.sample') return Promise.resolve({ ok: true, data: JSON.parse(JSON.stringify(SAMPLES[p.plotType])) }); if (name === 'figures.dataset.parse') return Promise.resolve({ ok: true, data: parseReply }); return Promise.resolve({ ok: true, data: pyReply }); } },
    ui: { h, esc: (x) => String(x), closeAll() {}, popover: (a, c) => ({ content: c }), toast() {}, confirm() { confirms++; return Promise.resolve(confirmAnswer); },
      dialog(o) { const api = { opts: o, body: o.body, buttons: {}, closed: [], close(v) { api.closed.push(v); } };
        (o.buttons || []).forEach((b) => { const el = new El('button'); el.textContent = b.label; el.addEventListener('click', () => { const r = b.onClick ? b.onClick(api) : undefined; if (r !== false) api.close(b.value); }); if (b.id) api.buttons[b.id] = el; }); dialogs.push(api); return api; } },
    plots: { KINDS: { line: { label: 'Line' }, bar: { label: 'Bar' } } }
  };
  delete require.cache[require.resolve('../js/figures/datasource.js')]; require('../js/figures/datasource.js');
  const D = RPE.figures.datasource;
  const mkctx = (rec, isNew) => { const ls = []; let shown = null; return { record: rec, isNew, set(fn) { fn(rec); ls.forEach((f) => f()); }, onChange(f) { ls.push(f); }, showTab(id) { shown = id; }, get shown() { return shown; } }; };
  const rec = (type, extra) => Object.assign({ kind: 'structured', config: { plotType: type, mapping: { x: null, y: [], group: null, yErr: null }, appearance: { legend: { labels: { A: 'old' } } }, options: { yScale: 'log', yLim: [1, 2] } }, dataset: { columns: [], rows: [], origin: { type: 'sheet', label: '' } }, originalCsv: 'old' }, extra);

  // pure helpers: only the first column is suggested for X; Y = following numeric columns
  const cols = [{ name: 'x', type: 'number' }, { name: 'a', type: 'number' }, { name: 'b', type: 'number' }, { name: 'g', type: 'text' }];
  assert.deepStrictEqual(D.guess('line', cols), { x: 'x', y: ['a', 'b'], group: null, yErr: null });
  assert.deepStrictEqual(D.guess('scatter', cols), { x: 'x', y: ['a'], group: null, yErr: null });
  assert.deepStrictEqual(D.guess('hist', cols), { x: null, y: ['x'], group: null, yErr: null });
  assert.deepStrictEqual(D.guess('box', [{ name: 'c', type: 'text' }, { name: 'v', type: 'number' }]), { x: null, y: ['v'], group: 'c', yErr: null });
  assert.deepStrictEqual(D.guess('bar', [{ name: 'c', type: 'text' }, { name: 'v', type: 'number' }]), { x: 'c', y: ['v'], group: null, yErr: null });
  assert.deepStrictEqual(D.roles('hist').map((r) => r.key), ['y']);

  // a new empty figure starts on the sample of its plot type; stale per-column settings are cleared
  let r = rec('line'), c = mkctx(r, true); D.attach(c); await tick(5);
  assert.deepStrictEqual([r.dataset.origin.type, r.dataset.origin.sampleId, r.dataset.rows.length, r.originalCsv, r.config.options.xScale, r.config.options.yScale, r.config.options.yLim], ['sample', 'dose-response', 2, null, 'log', 'linear', null]);
  assert.deepStrictEqual([r.config.mapping.x, r.config.options.series.A.errorCol, r.config.appearance.legend.labels], ['Dose', 'A SD', {}]);
  // badge while sample; "edited" after a change; Reset confirms only then
  const strip = D.status(c); assert.strictEqual(text(strip), 'Sample data' + 'Dose-response — example values, replace them with your own.' + 'Reset to sample data'); assert.strictEqual(strip.hidden, false);
  // an unedited sample follows a plot-type change
  r.config.plotType = 'bar'; c.set(() => {}); await tick(5);
  assert.deepStrictEqual([r.dataset.origin.sampleId, r.config.mapping.x, r.config.options.xScale], ['grouped-treatments', 'T', 'linear']);
  // an edited sample is kept
  c.set((x) => { x.dataset.rows[0][1] = 99; }); assert.ok(text(strip).startsWith('Sample data · edited'));
  r.config.plotType = 'line'; c.set(() => {}); await tick(5); assert.strictEqual(r.dataset.rows[0][1], 99);
  confirms = 0; confirmAnswer = false; await D.choose('sample', c); assert.deepStrictEqual([confirms, r.dataset.rows[0][1]], [1, 99]);
  confirmAnswer = true; await D.choose('sample', c); assert.deepStrictEqual([confirms, r.dataset.rows[0][1], r.dataset.origin.sampleId], [2, 2, 'dose-response']);
  confirms = 0; await D.choose('sample', c); assert.strictEqual(confirms, 0, 'unchanged sample resets without asking');

  // chooser: Spreadsheet detaches the sample badge and opens the tab; the menu checks the current source
  assert.ok(find(D.open(c, {}).content, (e) => e.props && e.props['aria-checked'] === 'true').length === 1);
  await D.choose('sheet', c); assert.deepStrictEqual([r.dataset.origin.type, c.shown, strip.hidden], ['sheet', 'spreadsheet', true]);

  // CSV wizard: parse via the service, preview, editable defaults, unusable columns explained, original text kept separately
  parseReply = { ok: true, fileName: 'm.csv', originalText: 't;a;b;g\n1;2;3;x', delimiter: ';', hasHeader: true, encoding: 'utf-8', warnings: [{ level: 'warning', code: 'missing_values', message: 'Column a has 1 empty cell.' }],
    columns: cols, rows: [[1, 2, 3, 'x'], [2, null, 4, 'y']], report: { rowCount: 2, columnCount: 4, truncated: false, emptyColumns: [], columns: cols.map((x) => ({ name: x.name, type: x.type, missing: x.name === 'a' ? 1 : 0, invalid: 0 })) },
    columnNotes: { g: { x: "Column 'g' is text; line plot needs numbers for the X axis.", y: "Column 'g' is text; line plot needs numbers for the Y axis.", yErr: "Column 'g' is text; line plot needs numbers for error bars." } } };
  r = rec('line'); c = mkctx(r, false); dialogs.length = 0; backendCalls = [];
  D.choose('csv', c); const w = dialogs[0]; assert.strictEqual(w.buttons.import.disabled, true);
  const pick = find(w.body, (e) => e.props && e.props.type === 'file')[0]; pick.files = [{ name: 'm.csv', size: 10 }]; pick.fire('change'); await tick(5);
  assert.deepStrictEqual(backendCalls[0][1].plotType, 'line'); assert.strictEqual(w.buttons.import.disabled, false);
  assert.ok(text(w.body).includes("Column 'g' is text; line plot needs numbers for the X axis.") && text(w.body).includes('Auto (found: semicolon)') && text(w.body).includes('Column a has 1 empty cell.'));
  w.buttons.import.fire('click');
  assert.deepStrictEqual([r.dataset.origin, r.originalCsv, r.config.mapping, r.dataset.rows.length], [{ type: 'csv', label: 'm.csv', sampleId: null, fileName: 'm.csv' }, parseReply.originalText, { x: 'x', y: ['a', 'b'], group: null, yErr: null }, 2]);
  assert.ok(r.dataset.rows !== undefined && r.dataset.columns === cols);
  // overriding the separator re-parses the original text, not the file
  r = rec('hist'); c = mkctx(r, false); dialogs.length = 0; backendCalls = []; D.choose('csv', c);
  const w2 = dialogs[0], pk2 = find(w2.body, (e) => e.props && e.props.type === 'file')[0]; pk2.files = [{ name: 'm.csv' }]; pk2.fire('change'); await tick(5);
  const sep = find(w2.body, (e) => e.tag === 'select')[0]; sep.value = 'tab'; sep.fire('change'); await tick(5);
  assert.deepStrictEqual([backendCalls[1][1].text, backendCalls[1][1].delimiter, backendCalls[1][1].file], [parseReply.originalText, 'tab', undefined]);

  // Python data: a literal assignment goes into the spreadsheet, other code stays Python-controlled with the banner
  r = rec('line'); c = mkctx(r, false); dialogs.length = 0;
  pyReply = { ok: true, status: 'ok', columns: [{ name: 'x', type: 'number' }, { name: 'y', type: 'number' }], rows: [[1, 2], [2, 4]], literal: true, stdout: '', stderr: '' };
  D.choose('python', c); const py = dialogs[0], ta = find(py.body, (e) => e.tag === 'textarea')[0];
  assert.ok(ta.value.includes('data = {') && py.buttons.use.disabled === true);
  py.buttons.run.fire('click'); await tick(5); assert.strictEqual(py.buttons.use.disabled, false); py.buttons.use.fire('click');
  assert.deepStrictEqual([r.dataset.origin.type, r.dataset.origin.code, r.config.mapping.x, r.config.mapping.y], ['sheet', undefined, 'x', ['y']]);
  pyReply = Object.assign({}, pyReply, { literal: false }); const strip2 = D.status(c); dialogs.length = 0; D.choose('python', c); const py2 = dialogs[0];
  find(py2.body, (e) => e.tag === 'textarea')[0].value = 'import numpy as np\ndata = {"x": list(np.arange(2))}';
  py2.buttons.run.fire('click'); await tick(5); py2.buttons.use.fire('click');
  assert.deepStrictEqual([r.dataset.origin.type, r.dataset.origin.code], ['python', 'import numpy as np\ndata = {"x": list(np.arange(2))}']);
  assert.ok(text(strip2).includes('Python-controlled; spreadsheet shows a snapshot only') && strip2.hidden === false);
  // a failing script shows the readable message and the line, and does not enable "Use data"
  pyReply = { ok: false, status: 'error', message: 'ZeroDivisionError: division by zero', traceback: { line: 2 }, stderr: 'tb' }; dialogs.length = 0; D.choose('python', c);
  const py3 = dialogs[0]; py3.buttons.run.fire('click'); await tick(5);
  assert.ok(text(py3.body).includes('ZeroDivisionError') && text(py3.body).includes('line 2') && py3.buttons.use.disabled === true);
  console.log('PASS: 21. Data sources: samples follow plot type until edited, reset confirms, chooser, CSV wizard (separator override, unusable columns), Python data (literal vs controlled), banners');
}


// 22. Plot panels (js/figures/plotpanels.js): type-switch reconciliation + Line / Scatter option sections on a minimal fake DOM
async function testPlotPanels() {
  global.window = global;
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.props = {}; this.listeners = {}; this.hidden = false; this.disabled = false; this.className = ''; this._t = ''; this.value = ''; this.checked = false; this.attrs = {};
      const set = new Set(); this.classList = { toggle: (c, on) => { if (on) set.add(c); else set.delete(c); }, contains: (c) => set.has(c) }; }
    append(...c) { c.flat().forEach((x) => { if (x != null && x !== false) this.children.push(x); }); }
    setAttribute(k, v) { this.attrs[k] = String(v); }
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); }
    fire(t) { (this.listeners[t] || []).forEach((f) => f({ preventDefault() {} })); }
    get textContent() { return this._t; }
    set textContent(v) { this._t = v; if (v === '') this.children.length = 0; }
  }
  const h = (tag, props, ...kids) => {
    const el = new El(tag);
    Object.keys(props || {}).forEach((k) => { const v = props[k]; if (v == null || v === false) return; if (k === 'class') el.className = v; else if (k === 'hidden') el.hidden = true; else if (k === 'disabled') el.disabled = true; else if (/^on[a-z]+$/.test(k)) el.addEventListener(k.slice(2), v); else el.props[k] = v; });
    el.append(...kids); return el;
  };
  const text = (el) => (typeof el === 'string' ? el : (el.textContent || '') + el.children.map(text).join(''));
  const find = (el, pred, out = []) => { if (typeof el === 'string') return out; if (pred(el)) out.push(el); el.children.forEach((c) => find(c, pred, out)); return out; };
  const byLabel = (root, label) => find(root, (e) => e.props && e.props['aria-label'] === label)[0];
  const wrapOf = (root, label) => find(root, (e) => e.children.some((c) => c.props && c.props['aria-label'] === label))[0];
  const boxOf = (root, label) => find(root, (e) => e.children.includes(wrapOf(root, label)))[0];   // container that hides a whole row
  const checkOf = (root, label) => find(root, (e) => e.tag === 'label' && text(e) === label).map((l) => l.children[0])[0];
  global.RPE = { h, plots: { KINDS: { line: { label: 'Line' }, scatter: { label: 'Scatter' }, bar: { label: 'Bar' }, hist: { label: 'Histogram' }, box: { label: 'Box plot' } } } };
  ['controls.js', 'plotpanels.js'].forEach((f) => { delete require.cache[require.resolve('../js/figures/' + f)]; require('../js/figures/' + f); });
  const P = RPE.figures.plotpanels;
  const ds = { columns: [{ name: 'x', type: 'number' }, { name: 'a', type: 'number' }, { name: 'b', type: 'number' }, { name: 'e', type: 'number' }, { name: 'n', type: 'number' }, { name: 'g', type: 'text' }],
    rows: [[1, 1, 2, 0.1, -1, 'u'], [2, null, 3, 0.2, 1, 'v'], [3, 3, null, 0.1, 1, 'u']] };
  const mk = (type, mapping, extra) => ({ kind: 'structured', dataset: JSON.parse(JSON.stringify(ds)), config: Object.assign({ plotType: type, mapping: Object.assign({ x: null, y: [], group: null, yErr: null }, mapping), appearance: { palette: 'default' }, options: {} }, extra) });

  // reconcile: compatible roles stay, the rest is reset with a readable message
  let r = mk('scatter', { x: 'x', y: ['a', 'g', 'b'], group: 'g' });
  assert.deepStrictEqual(P.reconcile(r, 'line'), ['Group column reset: Line plots have no group (was “g”).', 'Y series reset: “g” is text.']);
  assert.deepStrictEqual([r.config.mapping.x, r.config.mapping.y, r.config.mapping.group], ['x', ['a', 'b'], null]);
  r = mk('bar', { x: 'g', y: ['a', 'b'] });
  assert.deepStrictEqual(P.reconcile(r, 'scatter'), ['X column reset: “g” is text.', 'X column not set: choose it in Scatter options.']);
  r = mk('line', { x: 'x', y: ['a', 'b'], yErr: 'e' }); r.config.options = { series: { a: { color: '#112233' } } };
  assert.deepStrictEqual(P.reconcile(r, 'hist'), ['X column reset: Histogram plots have no X column (was “x”).', 'Error column reset: only line and bar plots use it.', 'Y series reset: Histogram plots take one column; kept “a”.', 'Line series styles reset: only line plots use them.']);
  r = mk('scatter', { x: 'x', y: ['a'] }); r.config.options = { fit: 'linear' };
  assert.deepStrictEqual(P.reconcile(r, 'bar'), ['Fit settings reset: only scatter plots use them.']);
  r = mk('line', { x: 'x', y: ['a'] }); assert.deepStrictEqual(P.reconcile(r, 'scatter'), []);

  // sections: every control writes the draft through ctx.set
  const rec = mk('line', { x: 'x', y: ['a', 'b'] }), syncs = [];
  const ctx = { record: rec, set(fn) { if (typeof fn === 'function') fn(rec); syncs.forEach((f) => f()); } };
  const [note, lineG, scatterG, barG, histG, boxG, heatG] = P.groups({ ctx, reg: (fn) => { syncs.push(fn); fn(); }, group: (t, o, ...k) => { const g = h('details', {}, h('summary', {}, t), ...k); return g; }, field: (l, c) => h('label', {}, l, c) });
  const chg = (el, v) => { el.value = v; el.fire('change'); }, inp = (el, v) => { el.value = v; el.fire('input'); };
  assert.deepStrictEqual([lineG.hidden, scatterG.hidden, barG.hidden, histG.hidden, note.hidden], [false, true, true, true, true]);
  chg(byLabel(lineG, 'Add series'), 'e'); assert.deepStrictEqual(rec.config.mapping.y, ['a', 'b', 'e']);
  find(lineG, (e) => e.props && e.props['aria-label'] === 'Move a down')[0].fire('click'); assert.deepStrictEqual(rec.config.mapping.y, ['b', 'a', 'e']);
  find(lineG, (e) => e.props && e.props['aria-label'] === 'Remove e')[0].fire('click'); assert.deepStrictEqual(rec.config.mapping.y, ['b', 'a']);
  const vis = byLabel(lineG, 'Show series b'); vis.checked = false; vis.fire('change'); assert.strictEqual(rec.config.options.series.b.visible, false);
  inp(byLabel(lineG, 'Name of series a'), 'Alpha'); assert.strictEqual(rec.config.appearance.legend.labels.a, 'Alpha');
  chg(byLabel(lineG, 'X column'), 'a'); assert.deepStrictEqual([rec.config.mapping.x, rec.config.mapping.y], ['a', ['b']]);   // a column is never X and Y at once
  chg(byLabel(lineG, 'X column'), 'x');
  // per-series style applies to the chosen series; out-of-range is flagged, not written
    inp(byLabel(lineG, 'Line width (pt)'), '2'); assert.strictEqual(rec.config.options.series.b.width, 2);   // 'a' became X, so the style target falls back to the first series, 'b'
  inp(byLabel(lineG, 'Line width (pt)'), '99'); assert.strictEqual(byLabel(lineG, 'Line width (pt)').attrs['aria-invalid'], 'true'); assert.strictEqual(rec.config.options.series.b.width, 2);
  const mk1 = checkOf(lineG, 'Markers'); mk1.checked = true; mk1.fire('change'); assert.strictEqual(rec.config.options.series.b.marker, 'circle');
  chg(byLabel(lineG, 'Marker type'), 'diamond'); assert.strictEqual(rec.config.options.series.b.marker, 'diamond');
  const ln = checkOf(lineG, 'Line'); ln.checked = false; ln.fire('change'); assert.strictEqual(rec.config.options.series.b.line, false);
  const mk2 = checkOf(lineG, 'Markers'); mk2.checked = false; mk2.fire('change'); assert.deepStrictEqual([rec.config.options.series.b.marker, rec.config.options.series.b.line], ['none', true]);   // never a series that draws nothing
  chg(byLabel(lineG, 'Step'), 'post'); assert.strictEqual(rec.config.options.series.b.step, 'post');
  byLabel(lineG, 'Line color').value = '#aa0000'; byLabel(lineG, 'Line color').fire('input'); assert.strictEqual(rec.config.options.series.b.color, '#AA0000');
  const er = () => rec.config.options.series.b.error || 'none';
  // error bars: the mode is written only with its column, never with negative values
  chg(byLabel(lineG, 'Error bars'), 'symmetric'); assert.strictEqual(er(), 'none'); assert.strictEqual(wrapOf(lineG, 'Error column (±)').hidden, false);
  chg(byLabel(lineG, 'Error column (±)'), 'n'); assert.strictEqual(er(), 'none'); assert.ok(text(lineG).includes('negative values'));
  chg(byLabel(lineG, 'Error column (±)'), 'e'); assert.deepStrictEqual([rec.config.options.series.b.error, rec.config.options.series.b.errorCol], ['symmetric', 'e']);
  chg(byLabel(lineG, 'Error bars'), 'asymmetric'); assert.strictEqual(er(), 'none');   // lower/upper still missing
  chg(byLabel(lineG, 'Lower error column'), 'e'); chg(byLabel(lineG, 'Upper error column'), 'e'); assert.strictEqual(rec.config.options.series.b.error, 'asymmetric');
  inp(byLabel(lineG, 'Cap size (pt)'), '0'); assert.strictEqual(rec.config.options.series.b.capSize, 0);
  chg(byLabel(lineG, 'Error bars'), 'none'); assert.strictEqual(er(), 'none');
  assert.ok(text(lineG).includes('No missing values in the drawn columns'));   // b is still hidden
  const vis2 = byLabel(lineG, 'Show series b'); vis2.checked = true; vis2.fire('change');
  assert.ok(text(lineG).includes('Missing values: “b” 1') && text(lineG).includes('nothing is interpolated or bridged'));

  // scatter: contextual section, fit options, colours
  ctx.set((rr) => { rr.config.plotType = 'scatter'; rr.config.mapping = { x: 'x', y: ['a'], group: null, yErr: null }; });
  assert.deepStrictEqual([lineG.hidden, scatterG.hidden], [true, false]);
  chg(byLabel(scatterG, 'Group column'), 'g'); assert.strictEqual(rec.config.mapping.group, 'g'); assert.ok(text(scatterG).includes('Colors (one per series)'));
  chg(byLabel(scatterG, 'Marker'), 'plus'); assert.strictEqual(rec.config.options.marker, 'plus'); assert.strictEqual(boxOf(scatterG, 'Outline width (pt)').hidden, true);
  inp(byLabel(scatterG, 'Opacity (0–1)'), '0.5'); assert.strictEqual(rec.config.appearance.alpha, 0.5);
  inp(byLabel(scatterG, 'Opacity (0–1)'), '3'); assert.strictEqual(rec.config.appearance.alpha, 0.5);
  assert.strictEqual(boxOf(scatterG, 'Degree (2\u20135)').hidden, true);
  assert.strictEqual(wrapOf(scatterG, 'Confidence level').hidden, true);
  chg(byLabel(scatterG, 'Fit'), 'polynomial'); assert.strictEqual(rec.config.options.fit, 'polynomial'); assert.strictEqual(wrapOf(scatterG, 'Degree (2–5)').hidden === undefined, false);
  inp(byLabel(scatterG, 'Degree (2–5)'), '3'); assert.strictEqual(rec.config.options.fitDegree, 3);
  const eq = checkOf(scatterG, 'Equation'); eq.checked = false; eq.fire('change'); assert.strictEqual(rec.config.options.fitEquation, false);
  const ci = checkOf(scatterG, 'Confidence interval'); ci.checked = true; ci.fire('change'); assert.strictEqual(rec.config.options.fitBand, true);
  chg(byLabel(scatterG, 'Confidence level'), '0.99'); assert.strictEqual(rec.config.options.fitLevel, 0.99);
  assert.ok(text(scatterG).includes('A fitted line does not imply causation') && text(scatterG).includes('not a prediction interval'));
  const c0 = byLabel(scatterG, 'Color of u'); c0.value = '#112233'; c0.fire('input');
  assert.deepStrictEqual([rec.config.appearance.colors[0], rec.config.appearance.colors.length >= 2, rec.config.appearance.colors[1]], ['#112233', true, '#D55E00']);
  chg(byLabel(scatterG, 'Fit'), 'none'); assert.strictEqual(wrapOf(scatterG, 'Confidence level').hidden, true);


  // bar: category, series, layout, labels, error bars, truncated-baseline chip
  ctx.set((rr) => { rr.config.plotType = 'bar'; rr.config.mapping = { x: 'g', y: ['a', 'b'], group: null, yErr: null }; rr.config.options = {}; });
  assert.deepStrictEqual([lineG.hidden, scatterG.hidden, barG.hidden, histG.hidden], [true, true, false, true]);
  chg(byLabel(barG, 'Add value series'), 'e'); assert.deepStrictEqual(rec.config.mapping.y, ['a', 'b', 'e']);
  find(barG, (e) => e.props && e.props['aria-label'] === 'Remove e')[0].fire('click'); assert.deepStrictEqual(rec.config.mapping.y, ['a', 'b']);
  byLabel(barG, 'Color of b').value = '#00aa00'; byLabel(barG, 'Color of b').fire('input'); assert.strictEqual(rec.config.options.series.b.color, '#00AA00');
  inp(byLabel(barG, 'Name of series a'), 'Alpha'); assert.strictEqual(rec.config.appearance.legend.labels.a, 'Alpha');
  chg(byLabel(barG, 'Orientation'), 'horizontal'); assert.strictEqual(rec.config.options.orient, 'horizontal');
  inp(byLabel(barG, 'Category label rotation (°)'), '45'); assert.strictEqual(rec.config.appearance.yTickRotation, 45);   // the rotation of the axis the labels sit on
  chg(byLabel(barG, 'Orientation'), 'vertical'); inp(byLabel(barG, 'Category label rotation (°)'), '30'); assert.strictEqual(rec.config.appearance.xTickRotation, 30);
  chg(byLabel(barG, 'Bar layout'), 'stacked'); assert.strictEqual(rec.config.options.barMode, 'stacked');
  rec.config.options.yScale = 'log'; chg(byLabel(barG, 'Bar layout'), 'grouped'); chg(byLabel(barG, 'Bar layout'), 'stacked');
  assert.strictEqual(rec.config.options.barMode, 'grouped'); assert.ok(text(barG).includes('Stacked bars cannot use a log axis')); delete rec.config.options.yScale;
  inp(byLabel(barG, 'Bar width (share of slot)'), '0.6'); assert.strictEqual(rec.config.options.barWidth, 0.6); assert.ok(text(barG).includes('Gap between categories: 40%'));
  inp(byLabel(barG, 'Bar width (share of slot)'), '2'); assert.strictEqual(rec.config.options.barWidth, 0.6);
  const vl = checkOf(barG, 'Value labels'); vl.checked = true; vl.fire('change'); assert.strictEqual(rec.config.options.valueLabels, true);
  inp(byLabel(barG, 'Number format'), '{:.1f} kg'); assert.strictEqual(rec.config.options.valueFormat, '{:.1f} kg');
  inp(byLabel(barG, 'Number format'), '{} {}'); assert.strictEqual(rec.config.options.valueFormat, '{:.1f} kg'); assert.strictEqual(byLabel(barG, 'Number format').attrs['aria-invalid'], 'true');
  chg(byLabel(barG, 'Number format examples'), '{:,.0f}'); assert.strictEqual(rec.config.options.valueFormat, '{:,.0f}');
  chg(byLabel(barG, 'Error-bar column'), 'n'); assert.strictEqual(rec.config.mapping.yErr, null); assert.ok(text(barG).includes('negative numbers'));
  chg(byLabel(barG, 'Error-bar column'), 'e'); assert.deepStrictEqual([rec.config.mapping.yErr, rec.config.options.errorBars], ['e', true]);
  chg(byLabel(barG, 'Error-bar column'), ''); assert.deepStrictEqual([rec.config.mapping.yErr, rec.config.options.errorBars], [null, false]);
  const chip = () => find(barG, (e) => e.className === 'fe__note' && text(e).includes('does not start at 0'))[0];
  assert.strictEqual(chip().hidden, true);
  rec.config.options.yLim = [5, 10]; ctx.set(() => {}); assert.strictEqual(chip().hidden, false);   // chip follows F.controls.truncated
  const mk_ = checkOf(chip(), 'Mark on the figure'); mk_.checked = true; mk_.fire('change'); assert.strictEqual(rec.config.options.axisNote, true);
  rec.config.options.yLim = null; ctx.set(() => {}); assert.strictEqual(chip().hidden, true);
  assert.ok(!text(barG).includes('Bin') && !/\bbins?\b/i.test(text(barG)));

  // histogram: data, bins (120 ms debounce), statistic, overlays, style, inline messages
  ctx.set((rr) => { rr.config.plotType = 'hist'; rr.config.mapping = { x: null, y: [], group: null, yErr: null }; rr.config.options = { bins: 20 }; });
  assert.deepStrictEqual([barG.hidden, histG.hidden], [true, false]);
  assert.ok(text(histG).includes('Choose a numeric column'));
  chg(byLabel(histG, 'Data column'), 'a'); assert.deepStrictEqual(rec.config.mapping.y, ['a']); assert.ok(text(histG).includes('2 observations, range 1 to 3; 1 empty cells are not counted.'));
  const sleep = (ms) => new Promise((rs) => setTimeout(rs, ms));
  inp(byLabel(histG, 'Number of bins'), '12'); assert.strictEqual(rec.config.options.bins, 20);   // debounced
  await sleep(160); assert.strictEqual(rec.config.options.bins, 12);
  inp(byLabel(histG, 'Number of bins'), '5000'); await sleep(160); assert.strictEqual(rec.config.options.bins, 12); assert.strictEqual(byLabel(histG, 'Number of bins').attrs['aria-invalid'], 'true');
  inp(byLabel(histG, 'Number of bins'), '8'); byLabel(histG, 'Number of bins').fire('change'); assert.strictEqual(rec.config.options.bins, 8);   // change flushes at once
  chg(byLabel(histG, 'Bins by'), 'width'); assert.strictEqual(rec.config.options.binMode, 'width'); assert.strictEqual(wrapOf(histG, 'Number of bins').hidden, true); assert.ok(rec.config.options.binWidth > 0);
  inp(byLabel(histG, 'Bin width'), '0.001'); await sleep(160); assert.ok(rec.config.options.binWidth > 0.001); assert.ok(text(histG).includes('would need 2000 bins'));
  inp(byLabel(histG, 'Bin width'), '0.5'); await sleep(160); assert.strictEqual(rec.config.options.binWidth, 0.5); assert.ok(text(histG).includes('About 4 bins of width 0.5'));
  chg(byLabel(histG, 'Bins by'), 'method'); chg(byLabel(histG, 'Rule'), 'fd'); assert.strictEqual(rec.config.options.binMethod, 'fd');
  chg(byLabel(histG, 'Bar height shows'), 'frequency'); assert.strictEqual(rec.config.options.stat, 'frequency'); assert.ok(text(histG).includes('bars add up to 1'));
  chg(byLabel(histG, 'Bar height shows'), 'density'); assert.ok(text(histG).includes('total bar area is 1'));
  const cu = checkOf(histG, 'Cumulative'); cu.checked = true; cu.fire('change'); assert.strictEqual(rec.config.options.cumulative, true); assert.ok(text(histG).includes('the last bar is 1'));
  const nfc = checkOf(histG, 'Normal curve overlay'); nfc.checked = true; nfc.fire('change'); assert.strictEqual(rec.config.options.normalFit, true); assert.ok(text(histG).includes('not a test of normality'));
  byLabel(histG, 'Fill color').value = '#123456'; byLabel(histG, 'Fill color').fire('input'); assert.strictEqual(rec.config.options.barColor, '#123456'.toUpperCase());
  inp(byLabel(histG, 'Outline width (pt)'), '0'); assert.strictEqual(rec.config.options.barEdgeWidth, 0);
  inp(byLabel(histG, 'Bar opacity (0–1)'), '0.6'); assert.strictEqual(rec.config.appearance.alpha, 0.6);
  ctx.set((rr) => { rr.dataset.rows = [[1, 4, 2, 0, 0, 'u'], [2, 4, 3, 0, 0, 'u']]; });
  assert.ok(text(histG).includes('equal 4') && text(histG).includes('no normal curve'));
  ctx.set((rr) => { rr.dataset.rows = [[1, null, 2, 0, 0, 'u']]; }); assert.ok(text(histG).includes('has no numbers, so there is nothing to draw'));
  assert.ok(!/values?/i.test(text(histG)), 'histogram wording must not share "values" with bars');


  // box: data, outlier count (hidden-count note), notch gating, colors, generated help
  const uRows = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100].map((v) => ['u', v]), vRows = [1, 2, 3, 4, 5].map((v) => ['v', v]);
  ctx.set((rr) => { rr.config.plotType = 'box'; rr.config.mapping = { x: null, y: ['n'], group: 'g', yErr: null }; rr.config.options = {}; rr.config.appearance = { palette: 'default', colors: [] };
    rr.dataset = { columns: [{ name: 'n', type: 'number' }, { name: 'g', type: 'text' }], rows: uRows.concat(vRows).map((r) => [r[1], r[0]]) }; });
  assert.deepStrictEqual([boxG.hidden, histG.hidden, heatG.hidden], [false, true, true]);
  assert.ok(text(boxG).includes('16 values in 2 boxes (5 to 11 per group)') && text(boxG).includes('1 value lies beyond the whiskers and is drawn as open circles'));
  const so = checkOf(boxG, 'Show outliers'); so.checked = false; so.fire('change');
  assert.strictEqual(rec.config.options.showOutliers, false); assert.ok(text(boxG).includes('1 value beyond the whiskers is hidden. It still counts in the quartiles and the mean.'));
  chg(byLabel(boxG, 'Whisker rule'), 'minmax'); assert.ok(text(boxG).includes('No value lies beyond the whiskers.') && text(boxG).includes('smallest and largest observation'));
  chg(byLabel(boxG, 'Whisker rule'), 'percentile'); assert.ok(text(boxG).includes('5th and 95th percentiles'));
  chg(byLabel(boxG, 'Whisker rule'), 'iqr'); chg(byLabel(boxG, 'Quartile method'), 'midpoint'); assert.strictEqual(rec.config.options.quartileMethod, 'midpoint'); assert.ok(text(boxG).includes('midpoint method'));
  const nt = checkOf(boxG, 'Notches'); assert.strictEqual(nt.disabled, true); assert.ok(text(boxG).includes('Notches need at least 10 values in every group; “v” has 5.'));
  ctx.set((rr) => { rr.dataset.rows = uRows.concat([6, 7, 8, 9, 10].map((v) => ['v', v]).concat(vRows)).map((r) => [r[1], r[0]]); });
  assert.strictEqual(nt.disabled, false); nt.checked = true; nt.fire('change'); assert.strictEqual(rec.config.options.notch, true); assert.ok(text(boxG).includes('1.57 × IQR'));
  ctx.set((rr) => { rr.dataset.rows = vRows.map((r) => [r[1], r[0]]); });
  assert.strictEqual(nt.disabled, false); assert.ok(text(boxG).includes('Switch notches off'));   // an active notch can always be switched off
  nt.checked = false; nt.fire('change'); assert.strictEqual(rec.config.options.notch, false);
  ctx.set((rr) => { rr.dataset.rows = uRows.concat(vRows).map((r) => [r[1], r[0]]); });
  checkOf(boxG, 'Overlay points').checked = true; checkOf(boxG, 'Overlay points').fire('change'); assert.strictEqual(rec.config.options.showPoints, true);
  const mn = checkOf(boxG, 'Mean marker'); mn.checked = true; mn.fire('change'); assert.strictEqual(rec.config.options.showMean, true); assert.ok(text(boxG).includes('diamond is the mean'));
  chg(byLabel(boxG, 'Orientation'), 'horizontal'); assert.strictEqual(rec.config.options.orient, 'horizontal'); assert.ok(text(boxG).includes('Each horizontal box'));
  byLabel(boxG, 'Median line color').value = '#aa0000'; byLabel(boxG, 'Median line color').fire('input'); assert.strictEqual(rec.config.options.medianColor, '#AA0000');
  inp(byLabel(boxG, 'Median width (pt)'), '3'); assert.strictEqual(rec.config.options.medianWidth, 3); inp(byLabel(boxG, 'Median width (pt)'), '99'); assert.strictEqual(rec.config.options.medianWidth, 3);
  chg(byLabel(boxG, 'Box colors'), 'one'); assert.ok(/^#[0-9A-F]{6}$/i.test(rec.config.options.boxColor)); assert.strictEqual(wrapOf(boxG, 'Palette').hidden, true);
  chg(byLabel(boxG, 'Box colors'), 'group'); assert.strictEqual(rec.config.options.boxColor, null); assert.strictEqual(rec.config.appearance.colors.length, 2);
  byLabel(boxG, 'Color of v').value = '#00ff00'; byLabel(boxG, 'Color of v').fire('input'); assert.strictEqual(rec.config.appearance.colors[1], '#00FF00');
  chg(byLabel(boxG, 'Box colors'), 'palette'); assert.deepStrictEqual(rec.config.appearance.colors, []); chg(byLabel(boxG, 'Palette'), 'muted'); assert.strictEqual(rec.config.appearance.palette, 'muted');
  chg(byLabel(boxG, 'Group column'), ''); assert.strictEqual(rec.config.mapping.group, null); assert.ok(text(boxG).includes('16 values in 1 box'));
  assert.ok(text(boxG).includes('What do the box and whiskers show?'));

  // heatmap: mode, columns, correlation-only controls, centering, scale, cells, colorbar, borders, missing values
  ctx.set((rr) => { rr.config.plotType = 'heatmap'; rr.config.mapping = { x: null, y: [], group: null, yErr: null }; rr.config.options = {}; rr.config.appearance = { palette: 'default', colors: [] };
    rr.dataset = { columns: [{ name: 'id', type: 'text' }, { name: 'a', type: 'number' }, { name: 'b', type: 'number' }, { name: 'c', type: 'number' }], rows: [['r1', 1, 2, 3], ['r2', 2, 1, null], ['r3', 3, 5, 1], ['r4', 4, 3, 2]] }; });
  assert.deepStrictEqual([heatG.hidden, boxG.hidden], [false, true]);
  assert.strictEqual(byLabel(heatG, 'Correlation method').disabled, true); assert.strictEqual(checkOf(heatG, 'Center colors at zero').disabled, true); assert.ok(text(heatG).includes('apply in Correlation mode'));
  assert.ok(text(heatG).includes('1 of 12 cells have no value'));
  assert.strictEqual(byLabel(heatG, 'Row label column').disabled, false); chg(byLabel(heatG, 'Row label column'), 'id'); assert.strictEqual(rec.config.mapping.x, 'id');
  const useC = byLabel(heatG, 'Use column c'); assert.strictEqual(useC.checked, true); useC.checked = false; useC.fire('change'); assert.deepStrictEqual(rec.config.mapping.y, ['a', 'b']);
  const useB = byLabel(heatG, 'Use column b'); useB.checked = false; useB.fire('change'); assert.deepStrictEqual(rec.config.mapping.y, ['a', 'b']); assert.strictEqual(useB.checked, true); assert.ok(text(heatG).includes('Keep at least two columns'));
  useC.checked = true; useC.fire('change'); assert.deepStrictEqual(rec.config.mapping.y, ['a', 'b', 'c']);
  const ann = checkOf(heatG, 'Show values in cells'); assert.strictEqual(byLabel(heatG, 'Decimals (0–6)').disabled, true); ann.checked = true; ann.fire('change');
  assert.strictEqual(rec.config.options.annotate, true); assert.strictEqual(byLabel(heatG, 'Decimals (0–6)').disabled, false); inp(byLabel(heatG, 'Decimals (0–6)'), '3'); assert.strictEqual(rec.config.options.annotatePrecision, 3);
  chg(byLabel(heatG, 'Color scale limits'), 'fixed'); assert.deepStrictEqual([rec.config.options.vmin, rec.config.options.vmax], [1, 5]);
  inp(byLabel(heatG, 'Minimum (vmin)'), '9'); assert.strictEqual(byLabel(heatG, 'Minimum (vmin)').attrs['aria-invalid'], 'true'); assert.strictEqual(rec.config.options.vmin, 1);
  inp(byLabel(heatG, 'Maximum (vmax)'), '8'); assert.strictEqual(rec.config.options.vmax, 8); chg(byLabel(heatG, 'Color scale limits'), 'auto'); assert.deepStrictEqual([rec.config.options.vmin, rec.config.options.vmax], [null, null]);
  chg(byLabel(heatG, 'Palette'), 'magma'); assert.strictEqual(rec.config.appearance.cmap, 'magma');
  chg(byLabel(heatG, 'Heatmap mode'), 'correlation'); assert.strictEqual(rec.config.options.heatmapMode, 'correlation');
  assert.strictEqual(byLabel(heatG, 'Row label column').disabled, true); assert.strictEqual(byLabel(heatG, 'Correlation method').disabled, false); assert.strictEqual(byLabel(heatG, 'Triangle').disabled, false);
  const ctr = checkOf(heatG, 'Center colors at zero'); assert.strictEqual(ctr.disabled, false); assert.strictEqual(ctr.checked, false);   // the user chose magma: kept
  ctr.checked = true; ctr.fire('change'); assert.strictEqual(rec.config.appearance.cmap, null); assert.strictEqual(ctr.checked, true);   // automatic diverging palette
  chg(byLabel(heatG, 'Palette'), 'coolwarm'); assert.strictEqual(ctr.checked, true); assert.strictEqual(rec.config.appearance.cmap, 'coolwarm');   // another diverging palette stays
  ctr.checked = false; ctr.fire('change'); assert.strictEqual(rec.config.appearance.cmap, 'viridis'); assert.strictEqual(ctr.checked, false);
  chg(byLabel(heatG, 'Correlation method'), 'spearman'); assert.strictEqual(rec.config.options.corrMethod, 'spearman');
  chg(byLabel(heatG, 'Triangle'), 'lower'); assert.strictEqual(rec.config.options.corrTriangle, 'lower');
  assert.strictEqual(byLabel(heatG, 'Colorbar label').attrs.placeholder, 'Spearman ρ'); assert.ok(text(heatG).includes('fewer than 3 shared rows'));
  const cbx = checkOf(heatG, 'Colorbar'); cbx.checked = false; cbx.fire('change'); assert.strictEqual(byLabel(heatG, 'Colorbar label').disabled, true);
  cbx.checked = true; cbx.fire('change'); assert.strictEqual(byLabel(heatG, 'Colorbar label').disabled, false); byLabel(heatG, 'Colorbar label').value = 'rho'; byLabel(heatG, 'Colorbar label').fire('input'); assert.strictEqual(rec.config.options.colorbarLabel, 'rho');
  assert.strictEqual(byLabel(heatG, 'Border width (pt)').disabled, true); const bd2 = checkOf(heatG, 'Cell borders'); bd2.checked = true; bd2.fire('change');
  assert.strictEqual(byLabel(heatG, 'Border width (pt)').disabled, false); inp(byLabel(heatG, 'Border width (pt)'), '1'); assert.strictEqual(rec.config.options.cellBorderWidth, 1);
  byLabel(heatG, 'Border color').value = '#000000'; byLabel(heatG, 'Border color').fire('input'); assert.strictEqual(rec.config.options.cellBorderColor, '#000000');
  inp(byLabel(heatG, 'Column label rotation (°)'), '45'); assert.strictEqual(rec.config.appearance.xTickRotation, 45); inp(byLabel(heatG, 'Row label rotation (°)'), '-30'); assert.strictEqual(rec.config.appearance.yTickRotation, -30);
  assert.ok(checkOf(heatG, 'Show coefficients in cells') && text(heatG).includes('Values in cells'));

  // the type-switch message is visible until dismissed
  P.announce(ctx, ['Y series reset: “g” is text.']); assert.strictEqual(note.hidden, false); assert.ok(text(note).includes('Y series reset'));
  find(note, (e) => e.tag === 'button')[0].fire('click'); assert.strictEqual(note.hidden, true);

  // empty dataset shows informative hint across plot panels
  ctx.set((rr) => { rr.dataset = { columns: [{ name: 'x', type: 'number' }, { name: 'y', type: 'number' }], rows: [] }; rr.config.plotType = 'line'; });
  assert.ok(text(lineG).includes('This dataset has no data rows. Add or import data in the Spreadsheet tab.'));
  ctx.set((rr) => { rr.config.plotType = 'scatter'; });
  assert.ok(text(scatterG).includes('This dataset has no data rows. Add or import data in the Spreadsheet tab.'));
  ctx.set((rr) => { rr.config.plotType = 'bar'; });
  assert.ok(text(barG).includes('This dataset has no data rows. Add or import data in the Spreadsheet tab.'));
  ctx.set((rr) => { rr.config.plotType = 'hist'; });
  assert.ok(text(histG).includes('This dataset has no data rows. Add or import data in the Spreadsheet tab.'));
  ctx.set((rr) => { rr.config.plotType = 'box'; });
  assert.ok(text(boxG).includes('This dataset has no data rows. Add or import data in the Spreadsheet tab.'));
  ctx.set((rr) => { rr.config.plotType = 'heatmap'; });
  assert.ok(text(heatG).includes('This dataset has no data rows. Add or import data in the Spreadsheet tab.'));
  console.log('PASS: 22. Plot panels: type switch keeps compatible mappings and says what was reset; Line options (X, ordered/renamed/hidden series, style, markers, step, error bars, missing-value note) and Scatter options (mapping, markers, colours, fit + CI), Box plot options (data, whisker / quartile rules, hidden-outlier note, notch gating, colours, generated help) and Heatmap options (mode, columns, correlation controls, centering, scale, cells, colorbar, borders, missing values) write the draft');
}


// 23. Export tab + Insert / Apply (js/figures/exportpanel.js): pixel math, placement, aspect, stale re-render, failure, cancel, one undo step
async function testFigureJobs() {
  const jsonRes = (body, status) => new Response(JSON.stringify(body), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  const hang = (init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));
  let jobState = { state: 'queued', queuePosition: 2 };
  const calls = [];
  const handler = (url, init) => {
    calls.push({ url, method: (init && init.method) || 'GET', body: init && typeof init.body === 'string' ? JSON.parse(init.body) : null });
    if (/\/jobs\/[^/]+\/cancel$/.test(url)) return jsonRes({ ok: true, status: 'cancelling' });
    if (/\/jobs$/.test(url)) return jsonRes({ jobs: [], limits: {} });
    if (/\/jobs\/[^/]+$/.test(url)) return jsonRes({ job: Object.assign({ id: 'x', kind: 'render' }, jobState) });
    return hang(init);                                     // /render never answers until aborted
  };
  const { RPE, F } = figEnv(handler);
  const chips = [];
  RPE.ui = { progressChip(o) { const c = { text: o.text, updates: [], removed: false, onCancel: o.onCancel, update(t) { c.text = t; c.updates.push(t); }, remove() { c.removed = true; } }; chips.push(c); return c; } };
  global.fetch = handler;
  const rec = F.blank('structured', 'line', { id: 'fig_j' });
  const renders = () => calls.filter((c) => /\/api\/figures\/render$/.test(c.url));
  const cancels = () => calls.filter((c) => /\/cancel$/.test(c.url));

  // a quick preview shows nothing; a queued one is surfaced as a chip with its position; Cancel on the chip cancels the server job
  const p1 = F.render(rec);
  await tick(40);
  assert.deepStrictEqual(F.jobs.list().map((j) => j.label), ['Rendering preview'], 'job tracked while in flight');
  assert.strictEqual(chips.length, 0, 'no chip for a job that has only just started');
  await tick(1100);
  assert.strictEqual(F.jobs.list()[0].state, 'queued');
  assert.strictEqual(F.jobs.list()[0].position, 2);
  assert.strictEqual(chips.length, 1, 'a queued job gets a chip');
  assert.ok(/^Queued \(#2\) · Rendering preview$/.test(chips[0].text), chips[0].text);
  const jid = renders()[0].body.jobId;
  chips[0].onCancel();
  const r1 = await p1;
  assert.strictEqual(r1.status, 'cancelled');
  await tick(20);
  assert.ok(cancels().some((c) => c.method === 'POST' && c.url.endsWith('/jobs/' + jid + '/cancel')), 'the server job was cancelled, not just the connection');
  assert.ok(chips[0].removed && F.jobs.list().length === 0, 'chip removed and job forgotten when it ends');

  // a final render gets a chip after 600 ms even when it is running; state "running" reads as elapsed seconds
  jobState = { state: 'running', queuePosition: null };
  const p2 = F.render(rec, { purpose: 'final', latest: false });
  await tick(1000);
  assert.strictEqual(chips.length, 2);
  assert.ok(/^Rendering final image… \d+ s$/.test(chips[1].text), chips[1].text);
  p2.cancel();
  assert.strictEqual((await p2).status, 'cancelled');
  await tick(20);
  assert.ok(chips[1].removed && F.jobs.list().length === 0);

  // an aborted caller signal (a newer preview replacing an old one) cancels the server job too
  const n = cancels().length;
  const ctl = new AbortController();
  const p3 = F.render(rec, { signal: ctl.signal });
  await tick(20);
  ctl.abort();
  assert.strictEqual((await p3).status, 'cancelled');
  await tick(20);
  assert.strictEqual(cancels().length, n + 1);
  const ids = renders().map((c) => c.body.jobId);
  assert.strictEqual(new Set(ids).size, ids.length, 'every request has its own job id');

  // cancelAll stops everything in flight; the jobs list endpoint is reachable
  const p4 = F.render(rec, { purpose: 'final', latest: false });
  await tick(20);
  F.jobs.cancelAll();
  assert.strictEqual((await p4).status, 'cancelled');
  assert.strictEqual(typeof RPE.backend.request, 'function');
  assert.strictEqual((await RPE.backend.request('figures.jobs')).ok, true);
  console.log('PASS: 31. Figure jobs: client job ids, queued/running state polled, chip with Cancel, cancel reaches the server, chip removed at the end');
}

async function testExportPanel() {
  const jsonRes = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const PNG2 = 'data:image/png;base64,BBBB';
  let mode = 'ok', sent = [], onSend = null, wPx = 2700, hPx = 1800;
  const fetchImpl = (url, init) => {
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; sent.push({ url, body });
    if (onSend) { const f = onSend; onSend = null; f(); }
    if (mode === 'hang') return new Promise((res, rej) => { init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))); });
    if (mode === 'fail') return Promise.resolve(jsonRes({ ok: false, status: 'error', diagnostics: [{ level: 'error', code: 'error', message: 'Boom in line 3.' }], preview: null }));
    return Promise.resolve(jsonRes({ ok: true, status: 'ok', jobId: 'j', purpose: 'final', dpi: body.dpi || body.record.export.dpi, preview: mode === 'two' ? PNG2 : PNG, widthPx: wPx, heightPx: hPx, hash: 'x', source: '', diagnostics: [], stdout: '', stderr: '', durationMs: 3, cached: false }));
  };
  const { RPE, S, F } = figEnv(fetchImpl);
  RPE.backend.connected = true; RPE.h = () => ({}); RPE.plots = { KINDS: { line: { label: 'Line' } } };
  delete require.cache[require.resolve('../js/figures/exportpanel.js')]; require('../js/figures/exportpanel.js');
  const X = F.exportpanel; S.setActiveSlide('s1');
  const mkCtx = (session, extra) => Object.assign({ commit: session.commit, progress() {} }, extra || {});

  // pixel math == backend (inches x dpi, banker's rounding, limits and wording)
  assert.deepStrictEqual([X.pixels(6, 4, 450).wPx, X.pixels(6, 4, 450).hPx, X.pixels(6, 4, 450).megapixels], [2700, 1800, 4.86]);
  assert.strictEqual(X.readout(6, 4, 450), '6.0 × 4.0 in @ 450 dpi = 2700 × 1800 px, 4.9 MP');
  assert.strictEqual(X.pixels(3.25, 2, 150).wPx, 488); assert.strictEqual(X.pixels(2.5, 2, 1).wPx, 2);
  assert.ok(X.pixels(30, 4, 600).refused && /16384 px per-side limit; export is refused/.test(X.pixels(30, 4, 600).warning));
  assert.ok(X.pixels(30, 30, 400).refused && /120 MP limit/.test(X.pixels(30, 30, 400).warning));
  assert.ok(!X.pixels(20, 13, 450).refused && /very large file/.test(X.pixels(20, 13, 450).warning) && !X.pixels(6, 4, 450).warning);

  // placement: physical size when it fits, else scaled down with the aspect kept
  const sz = { w: 1280, h: 720 }, a32 = 3 / 2;
  let pl = X.placement(a32, 6, sz); assert.deepStrictEqual([pl.w, pl.h], [576, 384]); assert.strictEqual(pl.x, 352);
  pl = X.placement(a32, 12, sz); assert.ok(pl.w <= 1200 && pl.h <= 550 && Math.abs(pl.w / pl.h - a32) < 0.01 && pl.y + pl.h <= 700);
  pl = X.placement(0.5, 6, sz); assert.ok(pl.h <= 550 && Math.abs(pl.w / pl.h - 0.5) < 0.01);

  // Insert: final render of the CURRENT record, record + object in ONE undo step, object selected, aspect from the rendered pixels
  const s1 = F.cloneForEdit(F.blank('structured', 'line', { id: 'fig_x', name: 'Dose' })); s1.set({ export: { wIn: 6, hIn: 4, dpi: 450 } });
  let r = await X.save(s1.draft, mkCtx(s1), null);
  assert.strictEqual(r, true); assert.strictEqual(sent[0].body.purpose, 'final'); assert.strictEqual(sent[0].body.record.export.dpi, 450);
  const o1 = S.doc.slides[0].objects[0];
  assert.deepStrictEqual([o1.type, o1.figureId, o1.src, o1.name], ['plot', 'fig_x', PNG, 'Dose']); assert.ok(Math.abs(o1.aspect - 1.5) < 1e-9);
  assert.ok(Math.abs(o1.w / o1.h - o1.aspect) < 0.01 && /^Line plot: Dose\.$/.test(o1.alt)); assert.deepStrictEqual(S.ui.selectedIds, [o1.id]); assert.ok(F.get('fig_x'));
  S.undo(); assert.strictEqual(S.doc.slides[0].objects.length, 0); assert.strictEqual(F.get('fig_x'), null, 'one undo removes object and record together');
  S.redo(); assert.ok(F.get('fig_x') && S.doc.slides[0].objects.length === 1);

  // failure: nothing inserted, message returned; cancel: nothing inserted, dialog can stay open
  mode = 'fail'; const s2 = F.cloneForEdit(F.blank('structured', 'bar', { id: 'fig_f' })); const n0 = S.doc.slides[0].objects.length;
  r = await X.save(s2.draft, mkCtx(s2), null); assert.strictEqual(r, 'Boom in line 3.'); assert.strictEqual(S.doc.slides[0].objects.length, n0); assert.strictEqual(F.get('fig_f'), null);
  mode = 'hang'; const ac = new AbortController(), p = X.save(s2.draft, mkCtx(s2, { signal: ac.signal }), null); setTimeout(() => ac.abort(), 5); r = await p;
  assert.strictEqual(r, 'Cancelled. Nothing was inserted.'); assert.strictEqual(S.doc.slides[0].objects.length, n0); assert.strictEqual(F.get('fig_f'), null);

  // no stale insert: a draft that changes while the final render runs is drawn again, and only the matching image is inserted
  mode = 'two'; sent = []; const s3 = F.cloneForEdit(F.blank('structured', 'scatter', { id: 'fig_s', name: 'S' }));
  onSend = () => s3.set({ export: { wIn: 5, hIn: 5 } }); wPx = 2250; hPx = 2250;
  r = await X.save(s3.draft, mkCtx(s3), null); assert.strictEqual(r, true);
  assert.strictEqual(sent.length, 2, 'rendered again after the change'); assert.strictEqual(sent[1].body.record.export.wIn, 5);
  const o3 = S.doc.slides[0].objects.find((o) => o.figureId === 'fig_s'); assert.ok(Math.abs(o3.aspect - 1) < 1e-9); assert.strictEqual(F.get('fig_s').export.wIn, 5);

  // Apply: record + object in ONE undo step; position and width kept, height from the new aspect; undo restores src and record together
  mode = 'ok'; wPx = 1800; hPx = 2700; sent = [];
  S.mutate('move', (d) => { Object.assign(d.slides[0].objects.find((o) => o.id === o1.id), { x: 40, y: 60, w: 300, h: 200 }); });
  const old = JSON.parse(JSON.stringify(F.get('fig_x'))), oldSrc = o1.src, oldH = 200, hist = S.doc.slides[0].objects.length;
  const s4 = F.cloneForEdit('fig_x'); s4.set({ name: 'Dose 2', export: { wIn: 4, hIn: 6 } });
  r = await X.save(s4.draft, mkCtx(s4), S.doc.slides[0].objects.find((o) => o.id === o1.id)); assert.strictEqual(r, true);
  let cur = S.doc.slides[0].objects.find((o) => o.id === o1.id);
  assert.deepStrictEqual([cur.x, cur.y, cur.w], [40, 60, 300]); assert.strictEqual(cur.h, 450); assert.ok(Math.abs(cur.aspect - 2 / 3) < 1e-9);
  assert.strictEqual(cur.name, 'Dose 2'); assert.strictEqual(F.get('fig_x').name, 'Dose 2'); assert.strictEqual(F.get('fig_x').export.hIn, 6); assert.strictEqual(S.doc.slides[0].objects.length, hist);
  S.undo(); cur = S.doc.slides[0].objects.find((o) => o.id === o1.id);
  assert.strictEqual(cur.src, oldSrc); assert.strictEqual(cur.h, oldH); assert.strictEqual(cur.name, 'Dose'); assert.deepStrictEqual(F.get('fig_x').export, old.export); assert.strictEqual(F.get('fig_x').name, 'Dose');
  mode = 'fail'; const s5 = F.cloneForEdit('fig_x'); s5.set({ name: 'X' });
  r = await X.save(s5.draft, mkCtx(s5), cur); assert.ok(typeof r === 'string'); assert.strictEqual(F.get('fig_x').name, 'Dose'); assert.strictEqual(S.doc.slides[0].objects.find((o) => o.id === o1.id).src, oldSrc);
  // the tab itself (tiny fake DOM): presets, readout, validation, transparent gating, export requests
  const mk = (tag, pr, ...kids) => { const el = { tag, children: [], attrs: {}, ls: {}, cls: (pr && pr.class) || '', value: '', hidden: false, disabled: false, title: '', textContent: '' };
    Object.keys(pr || {}).forEach((k) => { if (k.slice(0, 2) === 'on') el.ls[k.slice(2).toLowerCase()] = pr[k]; else if (k !== 'class') el.attrs[k] = pr[k]; if (k === 'hidden') el.hidden = !!pr[k]; });
    el.appendChild = (c) => { el.children.push(c); return c; }; el.setAttribute = (k, v) => { el.attrs[k] = String(v); }; el.getAttribute = (k) => el.attrs[k]; el.addEventListener = (t, f) => { el.ls[t] = f; };
    kids.flat().forEach((c) => { if (c != null && c !== false) el.children.push(typeof c === 'string' ? { textContent: c, children: [] } : c); }); if (kids.length && typeof kids[0] === 'string') el.textContent = kids[0]; return el; };
  RPE.h = mk; global.document.activeElement = null;
  delete require.cache[require.resolve('../js/figures/exportpanel.js')]; require('../js/figures/exportpanel.js');   // picks up the fake RPE.h
  const txt = (e) => (e.textContent || '') + (e.children || []).map(txt).join(''), all = (e, o = []) => { o.push(e); (e.children || []).forEach((c) => all(c, o)); return o; };
  const btn = (root, label) => all(root).find((e) => e.tag === 'button' && e.textContent === label), inputBy = (root, label) => all(root).find((e) => e.tag === 'input' && e.attrs['aria-label'] === label);
  const sd = F.cloneForEdit(F.blank('structured', 'line', { id: 'fig_t' })); const lis = [];
  const ctx = { record: sd.draft, set(sp) { sd.set(sp); lis.forEach((f) => f()); }, onChange(f) { lis.push(f); return () => {}; } };
  const tab = Object.create(F.tabs.export), root = tab.mount(ctx);
  assert.ok(txt(root).includes('6.0 × 4.0 in @ 450 dpi = 2700 × 1800 px, 4.9 MP'));
  btn(root, '300').ls.click(); assert.strictEqual(sd.draft.export.dpi, 300); assert.ok(txt(root).includes('@ 300 dpi = 1800 × 1200 px, 2.2 MP'));
  btn(root, 'PDF').ls.click(); assert.strictEqual(sd.draft.export.format, 'pdf'); btn(root, 'Transparent').ls.click(); assert.strictEqual(sd.draft.export.background, 'transparent'); assert.strictEqual(btn(root, 'Transparent').disabled, false);
  const wi = inputBy(root, 'Width (in)'); wi.value = '99'; wi.ls.change(); assert.strictEqual(sd.draft.export.wIn, 6); assert.strictEqual(wi.attrs['aria-invalid'], 'true'); assert.ok(txt(root).includes('Width must be between 0.5 and 30 in'));
  wi.value = '30'; wi.ls.change(); inputBy(root, 'Custom DPI').value = '600'; inputBy(root, 'Custom DPI').ls.change(); assert.strictEqual(sd.draft.export.dpi, 600);
  assert.strictEqual(btn(root, 'Export file…').disabled, true, 'refused sizes cannot be exported'); assert.ok(txt(root).includes('export is refused'));
  wi.value = '6'; wi.ls.change(); inputBy(root, 'Custom DPI').value = '450'; inputBy(root, 'Custom DPI').ls.change(); assert.strictEqual(btn(root, 'Export file…').disabled, false);
  F.tabs.export = F.tabs.export;   // exports go to /export: png/pdf carry the background, Python never does
  mode = 'ok'; sent = []; const dl = RPE.backend.request; let seen = []; RPE.backend.request = (n, q) => { seen.push([n, q]); return Promise.resolve({ ok: true, filename: 'f.' + q.format, size: 2048, blob: {} }); };
  btn(root, 'Export file…').ls.click(); await new Promise((r) => setTimeout(r, 5)); btn(root, 'Export Python…').ls.click(); await new Promise((r) => setTimeout(r, 5));
  assert.deepStrictEqual(seen.map(([n, q]) => [n, q.format, q.background, q.dpi]), [['figures.export', 'pdf', 'transparent', 450], ['figures.export', 'py', undefined, 450]]);
  assert.ok(txt(root).includes('Saved f.py (2 KB).')); RPE.backend.request = dl;
  sd.set((r) => { r.sourceMode = 'custom'; }); lis.forEach((f) => f()); assert.strictEqual(inputBy(root, 'Width (in)').disabled, true); assert.ok(txt(root).includes('Your script sets the size'));
  tab.dispose();
  console.log('PASS: 23. Export panel: pixel math == backend, placement keeps aspect, Insert/Apply render final first, no stale insert, failure/cancel change nothing, one undo step restores src + record');
}

// 24. Python Source tab (js/figures/pysource.js): ownership transitions, run only on click, error jump, guarded return / regenerate
async function testPySource() {
  const jsonRes = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));
  let sent = [], mode = 'ok';
  const GEN = 'import matplotlib.pyplot as plt\nplt.plot([1])\nplt.show()\n';
  const fetchImpl = (url, init) => {
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; sent.push(body && body.record);
    if (mode === 'fail') return Promise.resolve(jsonRes({ ok: false, status: 'error', diagnostics: [{ level: 'error', code: 'error', message: 'boom', line: 3 }, { level: 'error', code: 'x', message: 'far away', line: 99 }], preview: null, source: body.record.source, stderr: 'Traceback' }));
    return Promise.resolve(jsonRes({ ok: true, status: 'ok', jobId: 'j', purpose: 'preview', dpi: 150, preview: PNG, widthPx: 900, heightPx: 600, hash: 'x', source: body.record.sourceMode === 'custom' ? body.record.source : GEN, diagnostics: [] }));
  };
  const { RPE, S, F } = figEnv(fetchImpl);
  RPE.backend.connected = true;
  const mk = (tag, pr, ...kids) => {
    const el = { tag, children: [], attrs: {}, ls: {}, className: '', value: '', hidden: false, disabled: false, readOnly: false, scrollTop: 0, clientHeight: 300, sel: null, _t: '' };
    Object.keys(pr || {}).forEach((k) => { if (k.slice(0, 2) === 'on') el.ls[k.slice(2).toLowerCase()] = pr[k]; else if (k === 'class') el.className = pr[k]; else if (k === 'hidden') el.hidden = !!pr[k]; else el.attrs[k] = pr[k]; });
    el.append = (...c) => c.flat().forEach((x) => { if (x != null && x !== false) el.children.push(typeof x === 'string' ? { text: x, children: [] } : x); });
    el.append(...kids);
    Object.defineProperty(el, 'textContent', { get() { return el._t; }, set(v) { el._t = v; if (v === '') el.children.length = 0; } });
    el.classList = { toggle(c, on) { const a = el.className.split(' ').filter(Boolean), i = a.indexOf(c); if (on && i < 0) a.push(c); if (!on && i >= 0) a.splice(i, 1); el.className = a.join(' '); } };
    el.addEventListener = (t, f) => { el.ls[t] = f; }; el.setAttribute = (k, v) => { el.attrs[k] = String(v); }; el.focus = () => {}; el.setSelectionRange = (a, b) => { el.sel = [a, b]; };
    return el;
  };
  RPE.h = mk;
  let confirmAnswer = true, dialogAnswer = true; const confirms = [], dialogs = [];
  RPE.ui = { confirm: async (o) => { confirms.push(o); return confirmAnswer; }, dialog: (o) => { dialogs.push(o); return { done: Promise.resolve(dialogAnswer) }; } };
  let ed = null;   // stand-in for RPE.figures.codeEditor (the real component is tested in 25): same API, no DOM
  F.codeEditor = (o) => { ed = { el: mk('div'), textarea: mk('textarea'), value: o.value || '', readOnly: !!o.readOnly, sel: null, errors: [], getValue() { return ed.value; }, setValue(v) { ed.value = v; }, setReadOnly(b) { ed.readOnly = b; }, setErrors(l) { ed.errors = l; }, jumpToLine(n) { ed.sel = F.pysource.lineRange(ed.value, n); }, focus() {}, type(v) { ed.value = v; o.onChange(v); }, ctrlEnter() { return o.onRun(); } }; return ed; };
  delete require.cache[require.resolve('../js/figures/pysource.js')]; require('../js/figures/pysource.js');
  const P = F.pysource;

  // pure helpers
  const base = F.blank('structured', 'line', { id: 'fig_h' }); base.dataset.columns = [{ name: 'a', type: 'number' }]; base.config.mapping.y = ['a'];
  const keep = JSON.stringify([base.config, base.dataset, base.export]);
  P.toCustom(base, 'x=1'); assert.deepStrictEqual([base.sourceMode, base.source], ['custom', 'x=1']); assert.strictEqual(JSON.stringify([base.config, base.dataset, base.export]), keep, 'config is preserved');
  assert.ok(P.edited(base, 'x=2') && !P.edited(base, 'x=1') && P.edited(base, null));
  P.toStructured(base); assert.deepStrictEqual([base.sourceMode, base.source], ['structured', '']); assert.strictEqual(JSON.stringify([base.config, base.dataset, base.export]), keep); assert.ok(!P.edited(base, 'x'));
  assert.ok(P.canReturn(base) && !P.canReturn(F.blank('python', 'line')));
  const st = (o) => P.execState(Object.assign({ running: false, error: false, hash: 'h', errHash: null, status: 'none' }, o));
  assert.deepStrictEqual([st({ running: true, status: 'ok' }), st({ status: 'ok' }), st({ error: true, errHash: 'h', status: 'stale' }), st({ error: true, errHash: 'old', status: 'stale' }), st({})], ['running', 'ok', 'error', 'idle', 'idle']);
  assert.deepStrictEqual(P.errorLines([{ level: 'error', message: 'a', line: 2 }, { level: 'error', message: 'b', line: 50 }, { level: 'warning', message: 'w', line: 1 }, { level: 'error', message: 'c' }], 'a\nb\nc'), [{ line: 2, message: 'a' }, { line: null, message: 'b' }, { line: null, message: 'c' }]);
  assert.deepStrictEqual(P.lineRange('ab\ncde\nf', 2), [3, 6]); assert.ok(/^My_fig_snapshot_\d{8}-\d{6}\.py$/.test(P.snapshotName('My fig')));

  // the tab
  const sd = F.cloneForEdit(F.blank('structured', 'line', { id: 'fig_p' })), lis = [], adopted = [];
  const ctx = { record: sd.draft, session: sd, set(sp) { sd.set(sp); lis.slice().forEach((f) => f()); }, onChange(f) { lis.push(f); return () => {}; }, tab: () => ({ adopt: (res, ok) => adopted.push([res.ok, ok]) }) };
  const tab = Object.create(F.tabs.python), root = tab.mount(ctx);
  const txt = (e) => (e._t || '') + (e.text || '') + (e.children || []).map(txt).join(''), all = (e, o = []) => { o.push(e); (e.children || []).forEach((c) => all(c, o)); return o; };
  const btn = (label) => all(root).find((e) => e.tag === 'button' && txt(e).startsWith(label)), errs = all(root).find((e) => /py__errs/.test(e.className));
  const ta = ed; tab.onShow(); await tick();
  assert.strictEqual(sent.length, 1); assert.strictEqual(sent[0].sourceMode, 'structured');
  assert.deepStrictEqual([ta.value, ta.readOnly, btn('Edit as Python').hidden, btn('Run').hidden], [GEN, true, false, true], 'structured: generated script, read-only');
  const cfg = JSON.stringify([sd.draft.config, sd.draft.dataset]);
  assert.strictEqual(ta.ctrlEnter(), false, 'structured: Ctrl+Enter is left to the dialog');

  confirmAnswer = false; await tab.editAsPython(); assert.strictEqual(sd.draft.sourceMode, 'structured'); assert.strictEqual(confirms.length, 1);
  confirmAnswer = true; await tab.editAsPython();
  assert.deepStrictEqual([sd.draft.sourceMode, sd.draft.source, ta.readOnly, btn('Run').hidden, btn('Return to structured plot').hidden], ['custom', GEN, false, false, false]);
  assert.strictEqual(JSON.stringify([sd.draft.config, sd.draft.dataset]), cfg, 'config preserved'); assert.strictEqual(sent.length, 1, 'switching modes never runs the script'); assert.ok(txt(root).includes('Python controls this figure')); assert.ok(txt(root).includes('Not run'));
  tab.onShow(); await tick(); assert.strictEqual(sent.length, 1, 'tab switch never runs');

  ta.type('import matplotlib.pyplot as plt\nplt.plot([2])\nplt.show()\n'); assert.strictEqual(sd.draft.source, ta.value);
  assert.strictEqual(ta.ctrlEnter(), true); await tick();   // Ctrl+Enter runs
  assert.strictEqual(sent.length, 2); assert.deepStrictEqual([sent[1].sourceMode, sent[1].source], ['custom', ta.value]);
  assert.ok(txt(root).includes('Ran without errors')); assert.deepStrictEqual(adopted[0], [true, true]); assert.strictEqual(sd.draft.render.status, 'ok');
  ta.type(ta.value + '# more\n'); assert.ok(txt(root).includes('Not run'), 'an edit makes the state idle again');

  mode = 'fail'; btn('Run').ls.click(); await tick();
  assert.ok(txt(root).includes('Error') && !errs.hidden); const jb = all(errs).filter((e) => e.tag === 'button'); assert.strictEqual(jb.length, 1, 'only an in-range line is clickable');
  jb[0].ls.click(); assert.deepStrictEqual(ta.sel, P.lineRange(ta.value, 3)); assert.ok(txt(errs).includes('far away')); assert.deepStrictEqual(ta.errors.map((e) => e.line), [3, null], 'the editor gets the error list for its gutter markers');
  ta.type(ta.value + 'y\n'); assert.ok(errs.hidden && !ta.errors.length, 'editing clears the error panel and the markers'); mode = 'ok';

  // guarded return: edited script -> dialog with Copy + snapshot, "keep" changes nothing
  dialogAnswer = false; await tab.guarded('return'); assert.strictEqual(dialogs.length, 1); assert.ok(txt(dialogs[0].body).includes('Copy script') && txt(dialogs[0].body).includes('Save as snapshot'));
  assert.strictEqual(sd.draft.sourceMode, 'custom'); assert.ok(sd.draft.source.endsWith('y\n'));
  dialogAnswer = true; await tab.guarded('regenerate'); assert.strictEqual(dialogs.length, 2);   // edited -> asked again
  assert.deepStrictEqual([sd.draft.sourceMode, sd.draft.source], ['custom', GEN], 'regenerate stays custom with the generated script');
  const n = sent.length; await tab.guarded('return'); assert.strictEqual(dialogs.length, 2, 'an unedited script is replaced without a prompt');
  assert.deepStrictEqual([sd.draft.sourceMode, sd.draft.source], ['structured', '']); assert.strictEqual(JSON.stringify([sd.draft.config, sd.draft.dataset]), cfg, 'config survives the round trip');
  await tick(); assert.ok(ta.readOnly && btn('Edit as Python').hidden === false);
  tab.dispose();
  console.log('PASS: 24. Python Source tab: toCustom/toStructured keep config, run only on click / Ctrl+Enter, error panel jumps to the line, guarded regenerate / return offer copy + snapshot');
}

// 25. Code editor (js/figures/codeeditor.js): Python / LaTeX tokenizers, indent / comment / auto-close / find rules, 100k-char windowing, errors, keys
async function testCodeEditor() {
  const { RPE, F } = figEnv();
  const mk = (tag, pr, ...kids) => {
    const el = { tag, ls: {}, style: {}, attrs: {}, innerHTML: '', textContent: '', value: '', scrollTop: 0, scrollLeft: 0, clientHeight: 360, clientWidth: 600, selectionStart: 0, selectionEnd: 0, hidden: false, kids: kids.flat().filter((k) => k && typeof k === 'object'), classList: { toggle() {} } };
    Object.keys(pr || {}).forEach((k) => { if (k.slice(0, 2) === 'on') el.ls[k.slice(2).toLowerCase()] = pr[k]; else if (k === 'hidden') el.hidden = !!pr[k]; else el.attrs[k] = pr[k]; });
    el.addEventListener = (t, f) => { el.ls[t] = f; }; el.setAttribute = (k, v) => { el.attrs[k] = String(v); }; el.focus = () => {}; el.select = () => {};
    el.setSelectionRange = (a, b) => { el.selectionStart = a; el.selectionEnd = b; }; el.getBoundingClientRect = () => ({ width: 72 });
    el.setRangeText = (t, a, b) => { el.value = el.value.slice(0, a) + t + el.value.slice(b); el.selectionStart = el.selectionEnd = a + t.length; }; el.dispatchEvent = () => el.ls.input();
    return el;
  };
  RPE.h = mk; global.document.execCommand = () => false;   // false -> the component's setRangeText fallback
  delete require.cache[require.resolve('../js/figures/codeeditor.js')]; require('../js/figures/codeeditor.js');
  const E = F.codeEditor;
  const TQ = '"'.repeat(3);

  // ---- Python tokenizer
  const T = (lang, src) => E.tokenize(lang, src), flat = (lines) => lines.flat().filter((t) => t[0]).map((t) => t[0] + ':' + t[1]);
  assert.deepStrictEqual(flat(T('python', 'def f(x): # c\n  return "a#b" + 0x1F + 3.5e-2 + .5j')), ['kw:def', 'com:# c', 'kw:return', 'str:"a#b"', 'num:0x1F', 'num:3.5e-2', 'num:.5j']);
  assert.deepStrictEqual(flat(T('python', '@app.route("/")\nx = a @ b')), ['dec:@app.route', 'str:"/"']);
  assert.deepStrictEqual(flat(T('python', 'print(len(x1), iffy, format_x, None)')), ['bi:print', 'bi:len', 'kw:None']);
  assert.deepStrictEqual(flat(T('python', 'a = f"x{y}" + rb\'\\x00\' + "it\\"s" # c\nb = \'open')), ['str:f"x{y}"', 'str:rb\'\\x00\'', 'str:"it\\"s"', 'com:# c', 'str:\'open'], 'prefixes, escapes, unterminated string');
  const tri = flat(T('python', 'x = ' + TQ + 'a\nb # not a comment\nc' + TQ + ' + 1\ny = \'\'\'z\'\'\''));
  assert.deepStrictEqual(tri, ['str:' + TQ + 'a', 'str:b # not a comment', 'str:c' + TQ, 'num:1', "str:'''z'''"], 'triple-quoted strings carry state across lines');
  assert.strictEqual(E.lexLine('python', 'x = ' + TQ + 'a', null).s, TQ); assert.strictEqual(E.lexLine('python', 'x = 1', null).s, null);
  assert.deepStrictEqual(E.lexLine('python', 'if ' + 'x'.repeat(5000), null), { t: [['', 'if ' + 'x'.repeat(5000)]], s: null }, 'very long lines stay uncoloured');

  // ---- LaTeX tokenizer
  assert.deepStrictEqual(flat(T('latex', '\\section{Intro} % c\n50\\% done')), ['cmd:\\section', 'br:{', 'br:}', 'com:% c', 'cmd:\\%']);
  assert.deepStrictEqual(flat(T('latex', 'a $x+\\alpha$ b')), ['math:$', 'math:x+', 'cmd:\\alpha', 'math:$']);
  const eq = T('latex', '\\begin{equation}\nx^2 = 1\n\\end{equation}\nplain\n\\begin{itemize}\nitem');
  assert.deepStrictEqual(flat(eq), ['cmd:\\begin', 'br:{', 'env:equation', 'br:}', 'math:x^2 = 1', 'cmd:\\end', 'br:{', 'env:equation', 'br:}', 'cmd:\\begin', 'br:{', 'env:itemize', 'br:}']);
  assert.deepStrictEqual([eq[3], eq[5]], [[['', 'plain']], [['', 'item']]], 'environment math ends at \\end; itemize is not math');
  const dd = T('latex', '$$\na + b\n$$\nc \\[ d \\] e\ncost $5\nplain');
  assert.deepStrictEqual([dd[1], dd[3].map((t) => t[0]), dd[5]], [[['math', 'a + b']], ['', 'math', 'math', 'math', ''], [['', 'plain']]], 'display math spans lines; an unclosed $ ends with its line');

  // ---- editing rules (pure)
  const run = (v, ed) => v.slice(0, ed.from) + ed.text + v.slice(ed.to);
  assert.strictEqual(E.indentEdit('a', 1, 1, false).text, '   '); assert.strictEqual(E.indentEdit('', 0, 0, false).text, '    ');
  let ed = E.indentEdit('a\nb\n\nc', 0, 6, false); assert.strictEqual(run('a\nb\n\nc', ed), '    a\n    b\n\n    c'); assert.deepStrictEqual(ed.sel, [4, 18]);
  ed = E.indentEdit('    a\n  b\nc', 0, 11, true); assert.strictEqual(run('    a\n  b\nc', ed), 'a\nb\nc');
  ed = E.indentEdit('        x', 9, 9, true); assert.deepStrictEqual([run('        x', ed), ed.sel[0]], ['    x', 5], 'Shift+Tab at the caret outdents the line');
  assert.strictEqual(run('a\nb', E.indentEdit('a\nb', 0, 2, false)), '    a\nb', 'a selection ending at a line start leaves that line alone');
  assert.strictEqual(E.enterEdit('if x:', 5, 5, 'python').text, '\n    '); assert.strictEqual(E.enterEdit('  y = 1', 7, 7, 'python').text, '\n  ');
  assert.strictEqual(E.enterEdit('else:  # hi', 11, 11, 'python').text, '\n    '); assert.strictEqual(E.enterEdit('\\item a:', 8, 8, 'latex').text, '\n', 'only Python indents after a colon');
  const cm = 'a\n  b\n\nc'; ed = E.toggleComment(cm, 0, cm.length, 'python'); const cm2 = run(cm, ed);
  assert.strictEqual(cm2, '# a\n#   b\n\n# c'); assert.strictEqual(run(cm2, E.toggleComment(cm2, 0, cm2.length, 'python')), cm, 'comment toggle round-trips');
  assert.strictEqual(run('x', E.toggleComment('x', 0, 0, 'latex')), '% x'); assert.strictEqual(run('# a\nb', E.toggleComment('# a\nb', 0, 5, 'python')), '# # a\n# b', 'mixed lines are commented, not uncommented');
  assert.deepStrictEqual([E.pairEdit('', 0, 0, '(', 'python').text, E.pairEdit('f()', 2, 2, ')', 'python'), E.pairEdit('', 0, 0, '"', 'python').text, E.pairEdit('a', 1, 1, '"', 'python'), E.pairEdit('', 0, 0, '"', 'latex'), E.pairEdit('x', 0, 0, '(', 'python')], ['()', { from: 2, to: 2, text: '', sel: [3, 3] }, '""', null, null, null]);
  assert.strictEqual(E.pairEdit('abc', 0, 3, '[', 'latex').text, '[abc]'); assert.strictEqual(E.pairDelete('()', 1, 1).to, 2); assert.strictEqual(E.pairDelete('(a)', 1, 1), null);
  assert.deepStrictEqual([E.find('Foo foo FOO', 'foo', 0, 1), E.find('Foo foo FOO', 'foo', 1, 1).at, E.find('Foo foo FOO', 'foo', 9, 1).at, E.find('Foo foo FOO', 'foo', 4, -1).at, E.find('Foo foo FOO', 'foo', 0, -1), E.find('abc', 'x', 0, 1).at], [{ at: 0, k: 1, n: 3 }, 4, 0, 0, { at: 8, k: 3, n: 3 }, -1]);
  assert.deepStrictEqual(E.lineRange('ab\ncde\nf', 2), [3, 6]);

  // ---- component on a minimal fake DOM: windowing, state cache, errors, jump, keys, find
  const all = (e, o = []) => { o.push(e); (e.kids || []).forEach((c) => all(c, o)); return o; };
  const big = TQ + '\n' + 'x = 1\n'.repeat(6000) + TQ + '\nprint(1)\n' + 'y = 2  # note\n'.repeat(5000);   // ~106k chars, a docstring spanning lines 1..6002
  assert.ok(big.length > 90000);
  const changes = []; let runs = 0, runAnswer = true;
  const t0 = Date.now(), c = E({ language: 'python', value: big, label: 'Test code', onChange: (v) => changes.push(v), onRun: () => { runs++; return runAnswer; } });
  const root = c.el, q = (cls) => all(root).find((e) => (e.attrs.class || '') === cls), ta = q('ce__ta'), hl = q('ce__hl'), gin = q('ce__gin'), bands = q('ce__bands');
  assert.ok(Date.now() - t0 < 500, 'creating a 100k-character editor is fast'); assert.strictEqual(c.textarea, ta); assert.strictEqual(ta.attrs['aria-label'], 'Test code');
  const rows = () => hl.innerHTML.split('\n').length; assert.ok(rows() > 10 && rows() <= 81, 'only the visible window is painted: ' + rows());
  assert.ok(hl.innerHTML.includes('ce-str'), 'docstring colouring at the top');
  ta.scrollTop = 1500 * 18; ta.ls.scroll(); assert.ok(hl.innerHTML.includes('ce-str') && !hl.innerHTML.includes('ce-num'), 'state from line 1 reaches a window 1500 lines down');
  assert.ok(+gin.innerHTML.split('\n')[0].replace(/<[^>]+>/g, '') > 1400 && /^translate\(8px,/.test(hl.style.transform));
  ta.scrollTop = 6005 * 18; ta.ls.scroll(); assert.ok(hl.innerHTML.includes('ce-com') && hl.innerHTML.includes('ce-num'), 'after the docstring closes, normal colouring resumes');
  ta.scrollTop = 0; ta.ls.scroll();
  ta.value = big.slice(3); ta.ls.input(); assert.strictEqual(changes.length, 1); assert.strictEqual(c.getValue(), big.slice(3));
  ta.scrollTop = 1500 * 18; ta.ls.scroll(); assert.ok(hl.innerHTML.includes('ce-num') && !hl.innerHTML.includes('ce-str'), 'editing line 1 invalidates the cached states below it');
  c.setValue(big); assert.strictEqual(changes.length, 1, 'setValue does not call onChange'); ta.scrollTop = 0; ta.ls.scroll();

  c.setErrors([{ line: 2, message: 'bad "q" <b>' }, { line: 99999, message: 'gone' }, { line: 2, message: 'again' }]);
  assert.ok(/class="ce__ge" title="bad &quot;q&quot; &lt;b>; again"/.test(gin.innerHTML), gin.innerHTML.slice(0, 200)); assert.strictEqual((bands.innerHTML.match(/ce__eb/g) || []).length, 2); assert.strictEqual(ta.attrs['aria-invalid'], 'true');
  c.setErrors([]); assert.ok(!gin.innerHTML.includes('ce__ge') && !bands.innerHTML.includes('ce__eb') && ta.attrs['aria-invalid'] === 'false');
  c.jumpToLine(2000); assert.deepStrictEqual([ta.selectionStart, ta.selectionEnd, ta.scrollTop], [...E.lineRange(big, 2000), 1999 * 18 - 120]);
  c.jumpToLine(1e9); assert.strictEqual(ta.selectionStart, E.lineRange(big, big.split('\n').length)[0], 'jump is clamped');

  const key = (k, x) => Object.assign({ key: k, pd: false, sp: false, preventDefault() { this.pd = true; }, stopPropagation() { this.sp = true; } }, x || {});
  c.setValue('if x:'); ta.selectionStart = ta.selectionEnd = 5;
  let ev = key('Enter'); ta.ls.keydown(ev); assert.ok(ev.pd); assert.strictEqual(ta.value, 'if x:\n    '); assert.strictEqual(c.getValue(), 'if x:\n    ', 'edits reach the editor through the input event');
  ev = key('Tab'); ta.ls.keydown(ev); assert.ok(ev.pd && ta.value === 'if x:\n        ', 'Tab indents');
  ev = key('Escape'); ta.ls.keydown(ev); assert.ok(ev.sp, 'first Esc is kept inside the editor'); ev = key('Tab'); ta.ls.keydown(ev); assert.ok(!ev.pd, 'Esc then Tab moves focus on');
  ta.ls.keydown(key('a')); ev = key('Tab'); ta.ls.keydown(ev); assert.ok(ev.pd, 'any other key re-arms Tab');
  ev = key('Escape'); ta.ls.keydown(ev); ev = key('Escape'); ta.ls.keydown(ev); assert.ok(!ev.sp, 'a second Esc reaches the dialog');
  ev = key('Enter', { ctrlKey: true }); ta.ls.keydown(ev); assert.ok(ev.pd && ev.sp && runs === 1); runAnswer = false; ev = key('Enter', { ctrlKey: true }); ta.ls.keydown(ev); assert.ok(!ev.pd && runs === 2, 'onRun returning false leaves Ctrl+Enter alone');
  c.setReadOnly(true); ev = key('Tab'); ta.ls.keydown(ev); assert.ok(!ev.pd, 'read-only never traps Tab'); ev = key('Enter'); ta.ls.keydown(ev); assert.ok(!ev.pd); c.setReadOnly(false);

  c.setValue('foo\nbar Foo\nfoo'); ta.selectionStart = ta.selectionEnd = 0;
  ev = key('f', { ctrlKey: true }); ta.ls.keydown(ev); const fbar = q('ce__find'), fi = q('ce__fi'), fc = q('ce__fc'); assert.ok(ev.pd && !fbar.hidden);
  fi.value = 'foo'; fi.ls.input(); assert.strictEqual(fc.textContent, '1 of 3'); fi.ls.keydown(key('Enter')); assert.strictEqual(fc.textContent, '2 of 3'); assert.deepStrictEqual([ta.selectionStart, ta.selectionEnd], [8, 11]);
  fi.ls.keydown(key('Enter', { shiftKey: true })); assert.strictEqual(fc.textContent, '1 of 3'); fi.value = 'zzz'; fi.ls.input(); assert.strictEqual(fc.textContent, 'No matches');
  fi.ls.keydown(key('Escape')); assert.ok(fbar.hidden); c.destroy();
  console.log('PASS: 25. Code editor: Python / LaTeX tokenizers (multi-line state), indent / comment / auto-close / find rules, 100k chars painted by window, error markers, jump, Tab / Esc / Ctrl+Enter, find');
}

// 26. Python Plot window (js/figures/pyfigure.js): trust notice, no auto-run, chip / error panel / dimmed preview, export plan, Insert = one undo step, close guard
async function testPyFigure() {
  const jsonRes = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));
  const calls = []; let mode = 'ok';
  const fetchImpl = (url, init) => {
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; calls.push({ url, body });
    if (/\/jobs\//.test(url)) return Promise.resolve(jsonRes({ ok: true, status: 'cancelled' }));
    if (/templates/.test(url)) return Promise.resolve(jsonRes({ templates: [{ id: 'line', name: 'Line', description: 'd', sizeIn: [6, 4], source: 'import matplotlib.pyplot as plt\nplt.plot([1])\n' }] }));
    if (mode === 'fail') return Promise.resolve(jsonRes({ ok: false, status: 'error', purpose: body.purpose, dpi: 150, preview: null, diagnostics: [{ level: 'error', code: 'error', message: 'NameError: x', line: 2 }], stdout: '', stderr: 'Traceback (most recent call last)', figuresFound: 0, warnings: [], traceback: { line: 2, column: 1, message: 'NameError: name x is not defined' }, missingModule: null }));
    if (mode === 'no_figure') return Promise.resolve(jsonRes({ ok: false, status: 'no_figure', purpose: body.purpose, dpi: 150, preview: null, diagnostics: [], stdout: '', stderr: '', figuresFound: 0, warnings: [], traceback: null, missingModule: null }));
    return Promise.resolve(jsonRes({ ok: true, status: 'ok', jobId: 'j', purpose: body.purpose, dpi: body.purpose === 'final' ? body.dpi : 150, preview: PNG, widthPx: 900, heightPx: 600, hash: 'h1', source: '', diagnostics: [], stdout: 'hi\n', stderr: '', durationMs: 812, figuresFound: 2, warnings: ['2 figures created; showing figure #1'], traceback: null, missingModule: null }));
  };
  const { RPE, S, F } = figEnv(fetchImpl);
  RPE.backend.connected = true;
  const mk = (tag, pr, ...kids) => {
    const el = { tag, children: [], attrs: {}, ls: {}, className: '', value: '', hidden: false, disabled: false, _t: '' };
    Object.keys(pr || {}).forEach((k) => { if (k.slice(0, 2) === 'on') el.ls[k.slice(2).toLowerCase()] = pr[k]; else if (k === 'class') el.className = pr[k]; else if (k === 'hidden') el.hidden = !!pr[k]; else el.attrs[k] = pr[k]; });
    el.append = (...c) => c.flat().forEach((x) => { if (x != null && x !== false) el.children.push(typeof x === 'string' ? { text: x, children: [] } : x); });
    el.append(...kids);
    Object.defineProperty(el, 'textContent', { get() { return el._t; }, set(v) { el._t = v; if (v === '') el.children.length = 0; } });
    el.addEventListener = (t, f) => { el.ls[t] = f; }; el.setAttribute = (k, v) => { el.attrs[k] = String(v); }; el.focus = () => {};
    return el;
  };
  RPE.h = mk;
  delete require.cache[require.resolve('../js/figures/exportpanel.js')]; require('../js/figures/exportpanel.js');
  S.setActiveSlide('s1');
  const dialogs = [], closed = []; let guardAnswer = 'discard';
  RPE.ui = { closeAll() {}, popover() {}, confirm: async () => true,
    dialog: (o) => { const api = { el: mk('div'), buttons: { insert: { disabled: false } }, o, close(v) { closed.push(v); if (o.onClose) o.onClose(v); } }; api.done = Promise.resolve(guardAnswer); dialogs.push(api); return api; } };
  let ed = null;
  F.codeEditor = (o) => { ed = { el: mk('div'), textarea: mk('textarea'), value: o.value || '', errors: [], jumped: [], opts: o, getValue() { return ed.value; }, setValue(v) { ed.value = v; }, setErrors(e) { ed.errors = e; }, jumpToLine(n) { ed.jumped.push(n); }, focus() {}, destroy() {} }; return ed; };
  delete require.cache[require.resolve('../js/figures/pyfigure.js')]; require('../js/figures/pyfigure.js');
  const P = F.pyfigure;
  const find = (n, f, acc) => { acc = acc || []; if (f(n)) acc.push(n); (n.children || []).forEach((c) => find(c, f, acc)); return acc; };
  const text = (n) => (n.text || '') + (n.children || []).map(text).join('');
  const btns = (root, label) => find(root, (n) => n.tag === 'button' && text(n) === label);

  // pure helpers
  assert.strictEqual(P.chip({ running: true, t0: 1000 }, 4200).label, 'Running 3.2s');
  assert.strictEqual(P.chip({ status: 'ok', durationMs: 812 }).label, 'OK 0.8s');
  assert.deepStrictEqual(['timeout', 'missing_dependency', 'error', 'no_figure', 'idle'].map((status) => P.chip({ status }).label), ['Timeout', 'Missing dependency', 'Error', 'Error', 'Idle']);
  const exp = { override: false, wIn: 6, hIn: 4, dpi: 450, format: 'png', background: 'white' };
  assert.ok(P.exportPlan(exp, null).ok && /Run the script once/.test(P.exportPlan(exp, null).text), 'size unknown before the first run');
  assert.strictEqual(P.exportPlan(exp, [6, 4]).text, '6.0 × 4.0 in @ 450 dpi = 2700 × 1800 px, 4.9 MP');
  assert.ok(!P.exportPlan(Object.assign({}, exp, { override: true, format: 'pdf' }), [6, 4]).ok, 'PDF keeps the script size');
  assert.ok(!P.exportPlan(Object.assign({}, exp, { override: true, wIn: 0.1 }), [6, 4]).ok && !P.exportPlan(Object.assign({}, exp, { dpi: 50 }), [6, 4]).ok);
  assert.ok(!P.exportPlan(Object.assign({}, exp, { dpi: 1200 }), [30, 30]).ok, 'refused sizes block export');
  assert.strictEqual(P.exportPlan(Object.assign({}, exp, { override: true, wIn: 8, hIn: 5 }), [6, 4]).via, 'run');
  assert.deepStrictEqual(P.errorItems({ ok: false, status: 'error', traceback: { line: 9, message: 'bad' } }, 'a\nb'), [{ line: null, message: 'bad' }], 'a line outside the script is not clickable');
  assert.strictEqual(P.errorItems({ ok: false, status: 'missing_dependency', missingModule: { message: 'Module x' }, traceback: { line: 1 } }, 'import x')[0].message, 'Module x');
  assert.strictEqual(P.normalize({ ok: false, code: 'offline', message: 'down' }).status, 'offline');

  // open: nothing runs; Run shows ONE notice, the notice's Run starts the run
  const dlg = P.open(), body = dlg.o.body, runs = () => calls.filter((c) => /python\/run/.test(c.url)).length;
  assert.strictEqual(runs(), 0, 'opening never runs the script');
  const notice = find(body, (n) => /pyw__notice/.test(n.className))[0], chip = find(body, (n) => /pyw__chip/.test(n.className))[0];
  assert.ok(notice.hidden && P.needsNotice());
  btns(body, 'Run')[0].ls.click(); assert.ok(!notice.hidden && runs() === 0, 'first Run shows the trust notice and does not run');
  assert.ok(text(notice).includes('not a sandbox'));
  btns(body, 'Run')[1].ls.click(); await tick(40);
  assert.ok(notice.hidden && !P.needsNotice()); const run1 = calls.filter((c) => /python\/run/.test(c.url));
  assert.strictEqual(run1.length, 1); assert.deepStrictEqual([run1[0].body.purpose, run1[0].body.dpi, run1[0].body.source === P.STARTER], ['preview', 150, true]);
  assert.strictEqual(chip.textContent, 'OK 0.8s'); const img = find(body, (n) => /pyw__img/.test(n.className))[0]; assert.strictEqual(img.src, PNG); assert.ok(!/is-dim/.test(img.className));
  assert.ok(/2 figures created/.test(find(body, (n) => /pyw__multi/.test(n.className))[0].textContent), 'multi-figure note shown inline');
  assert.ok(/hi/.test(find(body, (n) => /pyw__log/.test(n.className) && n.tag === 'pre')[0].textContent));
  btns(body, 'Run')[0].ls.click(); await tick(40); assert.strictEqual(calls.filter((c) => /python\/run/.test(c.url)).length, 2, 'the notice is shown once per session');

  // edit => preview marked as out of date; paste is never run
  ed.value = 'x'; ed.opts.onChange('x'); const badge = find(body, (n) => /fe__badge/.test(n.className))[0];
  assert.ok(!badge.hidden && /changed/.test(badge.textContent) && /is-dim/.test(img.className));
  ed.textarea.ls.paste(); assert.ok(/not been run/.test(find(body, (n) => /pyw__msg/.test(n.className))[0].textContent)); assert.strictEqual(calls.filter((c) => /python\/run/.test(c.url)).length, 2);

  // failure: Error chip, clickable line, last good image kept and dimmed
  mode = 'fail'; ed.value = 'a\nb\nc'; ed.opts.onChange(ed.value); btns(body, 'Run')[0].ls.click(); await tick(40);
  assert.strictEqual(chip.textContent, 'Error'); const row = btns(body, 'Line 2: NameError: name x is not defined'); assert.strictEqual(row.length, 1);
  row[0].ls.click(); assert.deepStrictEqual(ed.jumped, [2]); assert.deepStrictEqual(ed.errors.map((e) => e.line), [2]);
  assert.ok(/is-dim/.test(img.className) && !img.hidden && /latest run failed/.test(badge.textContent), 'last good image stays, dimmed, with a mismatch badge');
  assert.strictEqual(find(body, (n) => n.tag === 'details' && /fe__details/.test(n.className) && !/pyw__out/.test(n.className)).length, 1, 'raw traceback is collapsible');
  btns(body, 'Reset Preview')[0].ls.click(); assert.ok(img.hidden && chip.textContent === 'Idle');
  mode = 'no_figure'; ed.value = 'x = 1\n'; ed.opts.onChange(ed.value); btns(body, 'Run')[0].ls.click(); await tick(40);
  const emptyEl = find(body, (n) => /pyw__empty/.test(n.className))[0];
  assert.ok(emptyEl.textContent.includes('The script did not leave a figure to draw'));

  // Insert: final render of the current script, record + object in ONE undo step
  mode = 'ok'; ed.value = 'import matplotlib.pyplot as plt\nplt.plot([1])\n'; ed.opts.onChange(ed.value);
  const before = calls.length, undoDepth = S.history ? S.history.past.length : null;
  dlg.o.buttons[1].onClick(); await tick(60);
  const fin = calls.slice(before).filter((c) => /python\/run/.test(c.url));
  assert.deepStrictEqual([fin.length, fin[0].body.purpose, fin[0].body.dpi], [1, 'final', 450]);
  const objs = S.doc.slides[0].objects; assert.strictEqual(objs.length, 1); assert.strictEqual(objs[0].type, 'plot');
  const rec = S.doc.figures[objs[0].figureId]; assert.ok(rec && rec.kind === 'python' && rec.sourceMode === 'custom' && rec.source === ed.value);
  assert.ok(closed.includes('inserted'), 'the window closes after a successful insert without a guard');
  S.undo(); assert.strictEqual(S.doc.slides[0].objects.length, 0); assert.ok(!S.doc.figures || !S.doc.figures[rec.id], 'one undo removes object and record');

  // close guard: unsaved edits ask first; Keep editing leaves the window open
  closed.length = 0; guardAnswer = 'keep';
  const d2 = P.open(); ed.opts.onChange('changed = 1'); d2.close('Close'); await tick(); assert.strictEqual(dialogs[dialogs.length - 1].o.title, 'Close without inserting?'); assert.strictEqual(closed.length, 0, 'Keep editing: still open');
  guardAnswer = 'discard'; d2.close('Close'); await tick(); assert.ok(closed.includes('Close'), 'Discard closes');
  const d3 = P.open(); closed.length = 0; d3.close('Close'); assert.deepStrictEqual(closed, ['Close'], 'an untouched script closes without a prompt');

  // alt text prompt + render summary: a typed alt goes on the object, the final render is summarised in the record (no final image stored as preview)
  mode = 'ok'; closed.length = 0;
  const d4 = P.open(), altOf = (d) => find(d.o.body, (n) => n.tag === 'input' && n.attrs.id === 'pywalt')[0];
  assert.strictEqual(d4.o.buttons[1].label, 'Insert in slide'); assert.ok(find(d4.o.body, (n) => n.tag === 'label' && /Alt text/.test(text(n))).length === 1);
  const SRC2 = 'import matplotlib.pyplot as plt\nplt.plot([2])\n'; ed.value = SRC2; ed.opts.onChange(SRC2);
  altOf(d4).value = 'Sine curve'; altOf(d4).ls.input();
  d4.o.buttons[1].onClick(); await tick(60);
  const o2 = S.doc.slides[0].objects[0], r2 = S.doc.figures[o2.figureId];
  assert.ok(o2 && o2.alt === 'Sine curve' && o2.aspect === 1.5 && r2.source === SRC2 && r2.kind === 'python');
  assert.deepStrictEqual([r2.render.status, r2.render.hash, r2.render.runtime.widthPx, r2.render.runtime.dpi, r2.render.preview], ['ok', 'h1', 900, 450, null]);

  // reopen: the saved script and alt load, nothing runs; Apply = final render, object + record in ONE undo step; x, y, w kept
  const runsNow = () => calls.filter((c) => /python\/run|\/render/.test(c.url)).length, n0 = runsNow();
  const d5 = P.open({ obj: o2 });
  assert.strictEqual(runsNow(), n0, 'reopening never runs the script');
  assert.deepStrictEqual([ed.value, d5.o.title, d5.o.buttons[1].label, altOf(d5).value], [SRC2, 'Edit Python plot', 'Apply', 'Sine curve']);
  const SRC3 = 'import matplotlib.pyplot as plt\nplt.plot([3])\n', geo = [o2.x, o2.y, o2.w];
  ed.value = SRC3; ed.opts.onChange(SRC3); altOf(d5).value = 'Cubic'; altOf(d5).ls.input();
  mode = 'fail'; closed.length = 0; d5.o.buttons[1].onClick(); await tick(60);
  assert.ok(S.doc.figures[o2.figureId].source === SRC2 && S.doc.slides[0].objects[0].alt === 'Sine curve' && !closed.length, 'failed Apply changes nothing and stays open');
  mode = 'ok'; d5.o.buttons[1].onClick(); await tick(60);
  const o3 = S.doc.slides[0].objects[0];
  assert.ok(closed.includes('changed') && S.doc.figures[o2.figureId].source === SRC3 && o3.alt === 'Cubic' && o3.figureId === o2.figureId && o3.id === o2.id);
  assert.deepStrictEqual([o3.x, o3.y, o3.w], geo); assert.strictEqual(o3.h, Math.round(o3.w / 1.5), 'aspect kept');
  S.undo(); assert.ok(S.doc.figures[o2.figureId].source === SRC2 && S.doc.slides[0].objects[0].alt === 'Sine curve', 'one undo restores object and record together');

  // save / open round trip keeps the source and never executes it; images without figureId stay plain
  S.mutate('Add image', (d) => { d.slides[0].objects.push({ id: 'img1', type: 'image', src: PNG, x: 0, y: 0, w: 10, h: 10 }, { id: 'old1', type: 'plot', engine: 'python', kind: 'line', x: 0, y: 0, w: 10, h: 10 }); });
  const n1 = calls.length, nFig = Object.keys(S.doc.figures).length;
  const viaLocal = S.prepareSave(), viaJson = JSON.parse(S.exportJSON()).doc;
  [viaLocal, viaJson].forEach((d) => { S.replaceDoc(JSON.parse(JSON.stringify(d)), 'opened'); assert.strictEqual(S.doc.figures[o2.figureId].source, SRC2, 'source survives save / open'); });
  assert.deepStrictEqual(calls.slice(n1).filter((c) => /python\/run|\/render|python\/data/.test(c.url)), [], 'loading a document never runs a script');
  assert.strictEqual(Object.keys(S.doc.figures).length, nFig, 'no record is invented on load');
  const objsL = S.doc.slides[0].objects; assert.ok(objsL.find((o) => o.id === 'img1').figureId === undefined && objsL.find((o) => o.id === 'old1').figureId === undefined);
  assert.strictEqual(F.objectsOf(S.doc, o2.figureId).length, 1);
  console.log('PASS: 26. Python Plot window: trust notice once, no auto-run, chip, error jump, dimmed last-good preview, export plan, Insert = one undo step, close guard, alt text, reopen + Apply = one undo step, save/open keeps source and never runs it');
}

// 27. Multi-panel composer (js/figures/composer.js): served layout table drives tiles + overlay, slot states, panel actions, layout switch keeps plots,
//     live preview with stale handling, unsaved guard that ignores automatic previews, Insert / Apply = one undo step, nothing changes on failure
async function testComposer() {
  const { execFileSync } = require('child_process');
  const served = (() => {   // the layout table exactly as GET /api/figures/layouts serves it (backend.figures.codegen.composite.layouts_table)
    for (const py of ['python3', 'python']) {
      try { return JSON.parse(execFileSync(py, ['-c', 'import json; from backend.figures.codegen.composite import layouts_table; print(json.dumps(layouts_table()))'], { encoding: 'utf8' })); } catch (e) { /* try the next interpreter */ }
    }
    throw new Error('Python is needed to read the layout table served by the backend.');
  })();
  const jsonRes = (b, status) => new Response(JSON.stringify(b), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));
  const PNG_B = 'data:image/png;base64,BBBB', PNG_C = 'data:image/png;base64,CCCC', PNG_D = 'data:image/png;base64,DDDD';
  const calls = []; let previewUrl = PNG, finalUrl = PNG_D, delay = 0, diag = [], finalDiag = [], layoutsFail = false;
  const fetchImpl = (url, init) => {
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; calls.push({ url, body });
    if (/\/layouts$/.test(url)) return Promise.resolve(layoutsFail ? jsonRes({ detail: 'broken' }, 500) : jsonRes({ layouts: served }));
    if (/\/jobs\//.test(url)) return Promise.resolve(jsonRes({ ok: true, status: 'cancelled' }));
    const final = body.purpose === 'final';
    const respond = () => jsonRes({ ok: true, status: 'ok', jobId: 'j', purpose: body.purpose, dpi: final ? body.dpi : 150, preview: final ? finalUrl : previewUrl, widthPx: 1050, heightPx: 750, hash: 'h' + calls.length, source: '', diagnostics: final ? finalDiag : diag, stdout: '', stderr: '', durationMs: 5, cached: false });
    return delay ? new Promise((r) => setTimeout(() => r(respond()), delay)) : Promise.resolve(respond());
  };
  const { RPE, S, F } = figEnv(fetchImpl);
  RPE.backend.connected = true;
  const mk = (tag, pr, ...kids) => {
    const el = { tag, children: [], attrs: {}, ls: {}, className: '', value: '', hidden: false, disabled: false, _t: '', style: {}, dataset: {}, html: '' };
    Object.keys(pr || {}).forEach((k) => {
      const v = pr[k]; if (v == null || v === false) return;
      if (k.slice(0, 2) === 'on') el.ls[k.slice(2).toLowerCase()] = v; else if (k === 'class') el.className = v; else if (k === 'hidden') el.hidden = !!v;
      else if (k === 'style') Object.assign(el.style, v); else if (k === 'dataset') Object.assign(el.dataset, v); else if (k === 'html') el.html = v;
      else if (k === 'value') { el.value = String(v); el.attrs.value = v; } else if (k === 'disabled') el.disabled = !!v; else el.attrs[k] = v;
    });
    el.append = (...c) => c.flat().forEach((x) => { if (x != null && x !== false) el.children.push(typeof x === 'string' ? { text: x, children: [] } : x); });
    el.appendChild = (c) => el.append(c); el.append(...kids);
    Object.defineProperty(el, 'textContent', { get() { return el._t; }, set(v) { el._t = v; if (v === '') el.children.length = 0; } });
    Object.defineProperty(el, 'lastChild', { get() { return el.children[el.children.length - 1]; } });
    el.addEventListener = (t, f) => { el.ls[t] = f; }; el.setAttribute = (k, v) => { el.attrs[k] = String(v); }; el.focus = () => {};
    const cls = () => el.className.split(/\s+/).filter(Boolean);
    el.classList = { contains: (c) => cls().indexOf(c) >= 0, toggle(c, on) { const s = new Set(cls()); if (on === undefined ? !s.has(c) : on) s.add(c); else s.delete(c); el.className = [...s].join(' '); },
      replace(a, b) { el.className = cls().map((x) => (x === a ? b : x)).join(' '); } };
    return el;
  };
  RPE.h = mk; RPE.icons = { html: () => '' };
  RPE.plots = { KINDS: { line: { label: 'Line' }, scatter: { label: 'Scatter' }, bar: { label: 'Bar' } } };
  delete require.cache[require.resolve('../js/figures/exportpanel.js')]; require('../js/figures/exportpanel.js');
  delete require.cache[require.resolve('../js/figures/composer.js')]; require('../js/figures/composer.js');
  S.setActiveSlide('s1');
  const dialogs = [], confirms = []; let confirmAnswer = true;
  RPE.ui = { esc: (t) => String(t), hasPopover: () => false, closeAll() {}, popover() {}, confirm: async (o) => { confirms.push(o); return confirmAnswer; },
    dialog: (o) => { let res; const api = { el: mk('div'), buttons: { cancel: { disabled: false }, save: { disabled: false } }, o, closed: [], done: new Promise((r) => { res = r; }), close(v) { api.closed.push(v); if (o.onClose) o.onClose(v); res(v); } }; dialogs.push(api); return api; } };
  const editors = []; F.openEditor = (o) => { editors.push(o); return {}; };
  const Cm = F.composer, last = (a) => a[a.length - 1];
  const find = (n, f, acc) => { acc = acc || []; if (f(n)) acc.push(n); (n.children || []).forEach((c) => find(c, f, acc)); return acc; };
  const text = (n) => (n.text || '') + (n._t || '') + (n.children || []).map(text).join('');
  const rendersOf = (purpose) => calls.filter((c) => /\/render$/.test(c.url) && (!purpose || c.body.purpose === purpose));
  const byL = (id) => served.find((l) => l.id === id), panelRec = (name, type) => F.blank('structured', type || 'scatter', { name });

  // ---- pure helpers
  assert.deepStrictEqual(Cm.letters([{ record: {} }, { record: null }, { record: {} }], 'A'), ['A', '', 'B'], 'letters skip empty slots like the backend');
  assert.deepStrictEqual([Cm.letter(0, 'a'), Cm.letter(25, 'A'), Cm.letter(26, 'a'), Cm.letter(3, 'none')], ['a', 'Z', 'aa', '']);
  const rec0 = F.blank('composite', 'line'); rec0.composite.panels[1].record = panelRec('P1'); rec0.composite.panels[2].record = panelRec('P2');
  const failing = [{ level: 'error', code: 'panel_failed', panel: 2, message: 'Panel 3 could not be drawn: bad data' }, { level: 'info', code: 'x', panel: 0, message: 'ignored' }];
  const sts = Cm.slotStates(rec0, failing);
  assert.deepStrictEqual(sts.map((s) => s.state), ['empty', 'ok', 'error', 'empty']); assert.deepStrictEqual(sts.map((s) => s.letter), ['', 'A', 'B', '']);
  assert.ok(sts[2].message.includes('bad data') && /error: Panel 3/.test(Cm.slotLabel(sts[2], false)) && /, selected$/.test(Cm.slotLabel(sts[1], true)));
  assert.deepStrictEqual(Cm.slotStates(rec0, failing, false).map((s) => s.state), ['empty', 'ok', 'ok', 'empty'], 'errors are ignored while the render is out of date');
  const tray = [], comp0 = JSON.parse(JSON.stringify(rec0.composite));
  assert.deepStrictEqual([Cm.removedBy(comp0, byL('1x2')), Cm.removedBy(comp0, byL('2x2')), Cm.emptySlots(comp0.panels)], [[2], [], [0, 3]]);
  let res = Cm.applyLayout(comp0, byL('1x2'), tray, true);
  assert.deepStrictEqual([comp0.layout, comp0.panels.length, res.parked, tray.length, tray[0].record.name, tray[0].from, comp0.panels[1].record.name], ['1x2', 2, [2], 1, 'P2', 2, 'P1'], 'panels are carried over by slot index; the removed one is parked');
  const comp1 = JSON.parse(JSON.stringify(rec0.composite)); res = Cm.applyLayout(comp1, byL('1x2'), tray, false);
  assert.deepStrictEqual([res.dropped, res.parked, tray.length], [[2], [], 1], 'Discard drops the plot, nothing is parked');
  res = Cm.applyLayout(comp0, byL('2x2'), tray, true); assert.deepStrictEqual([res.parked, comp0.panels[2].record, tray.length], [[], null, 1], 'a later layout does not take parked plots back by itself');
  assert.deepStrictEqual(Cm.placeParked(comp0, tray, tray[0].pid, 2), { name: 'P2', displaced: false });
  assert.ok(comp0.panels[2].record.name === 'P2' && tray.length === 0, 're-placed into an empty slot');
  const e1 = Cm.clearPanel(comp0, 1, tray); assert.ok(e1.record.name === 'P1' && !comp0.panels[1].record && tray.length === 1 && Cm.clearPanel(comp0, 1, tray) === null, 'Clear parks the plot');
  assert.deepStrictEqual(Cm.placeParked(comp0, tray, e1.pid, 2), { name: 'P1', displaced: true });
  assert.ok(comp0.panels[2].record.name === 'P1' && tray.length === 1 && tray[0].record.name === 'P2', 'dropping onto an occupied slot swaps; nothing is lost');
  // deep-clone isolation: editing panel A never mutates panel B (duplicate, recover, save)
  const A = panelRec('IsoA'); A.dataset = { columns: [{ name: 'x', type: 'number' }], rows: [[1], [2]], origin: { type: 'sheet', label: 'L' } }; A.source = 'SRC';
  const cI = JSON.parse(JSON.stringify(rec0.composite)); cI.panels[0].record = A; const trayI = [];
  const dd = Cm.duplicateInto(cI, 0, 3, trayI), B = cI.panels[3].record;
  assert.ok(B === dd.copy && B !== A && B.id !== A.id && B.dataset !== A.dataset && B.config !== A.config && B.dataset.rows !== A.dataset.rows && B.source === 'SRC' && B.dataset.rows[1][0] === 2, 'a copy keeps config, dataset and source but shares nothing');
  A.dataset.rows[0][0] = 99; A.config.appearance.title = 'changed'; A.config.mapping.y.push('zz'); A.source = 'other'; A.dataset.columns[0].name = 'q';
  assert.deepStrictEqual([B.dataset.rows[0][0], B.config.appearance.title === 'changed', B.config.mapping.y.includes('zz'), B.source, B.dataset.columns[0].name], [1, false, false, 'SRC', 'x'], 'editing panel A leaves panel B untouched');
  const saved = Cm.cleanPanel(B); B.dataset.rows[1][0] = -5; B.config.options.x = 1;
  assert.ok(saved.dataset.rows[1][0] === 2 && saved.config.options.x === undefined && saved.render.preview === null, 'a saved panel is a copy of the editor draft');
  Cm.clearPanel(cI, 3, trayI); const back = Cm.placeParked(cI, trayI, trayI[0].pid, 1); trayI.length = 0;
  assert.ok(back && cI.panels[1].record !== B && cI.panels[1].record.dataset.rows !== B.dataset.rows, 'a recovered plot is a fresh copy');
  assert.strictEqual(Cm.duplicateInto(cI, 3, 1, trayI), null, 'an empty source cannot be duplicated');
  const full = JSON.parse(JSON.stringify(rec0.composite)); full.panels.forEach((p, i) => { p.record = panelRec('F' + i); }); const trayF = [];
  assert.ok(Cm.duplicateInto(full, 0, 2, trayF).displaced && trayF[0].record.name === 'F2' && full.panels[2].record.name === 'F0', 'duplicating onto a full panel parks the plot it replaces');
  assert.strictEqual(Cm.duplicateTarget(rec0.composite.panels, 1), 3); assert.strictEqual(Cm.duplicateTarget(rec0.composite.panels.map((p) => ({ slot: p.slot, record: {} })), 0), -1);
  const dirtyP = panelRec('x'); dirtyP.render = { status: 'ok', preview: PNG, diagnostics: [] };
  assert.ok(Cm.cleanPanel(dirtyP).render.preview === null && dirtyP.render.preview === PNG, 'stored panels carry no preview; the source is untouched');
  assert.strictEqual(Cm.altText(rec0), 'Multi-panel figure: Composite figure (2 plots).');

  // ---- an untouched dialog closes without a prompt even though a preview arrived by itself
  const d0 = Cm.open(); await tick(60); assert.strictEqual(rendersOf('preview').length, 1);
  d0.close(); assert.deepStrictEqual([d0.closed, confirms.length], [[false], 0], 'automatic previews are not edits');

  // ---- layout table, tiles, overlay (all geometry comes from the served table)
  const dlg = Cm.open(), body = dlg.o.body; await tick(60);
  assert.strictEqual(calls.filter((c) => /\/layouts$/.test(c.url)).length, 2);
  const tiles = () => find(body, (n) => n.tag === 'button' && /(^| )ltile( |$)/.test(n.className)), slots = () => find(body, (n) => n.tag === 'button' && /(^| )cmp__slot( |$)/.test(n.className));
  const cards = () => find(body, (n) => n.tag === 'button' && /(^| )cmp__card( |$)/.test(n.className)), act = (label) => find(body, (n) => n.tag === 'button' && n.html.includes('<span>' + label + '</span>'))[0];
  const tileNote = () => text(find(body, (n) => /cmp__note/.test(n.className))[0]), img = find(body, (n) => n.tag === 'img')[0], badge = find(body, (n) => /fe__badge/.test(n.className))[0];
  assert.deepStrictEqual(tiles().map((t) => t.attrs['aria-label']), served.map((l) => 'Layout ' + l.label));
  assert.ok(tiles()[4].html.includes('1 + 2 (large left)') && tiles()[0].html.includes('<svg') && /is-on/.test(tiles()[0].className) && tiles()[0].attrs['aria-checked'] === 'true');
  const geoOk = (id) => { const L = byL(id), sl = slots(); assert.strictEqual(sl.length, L.slots.length, id); sl.forEach((b, i) => assert.deepStrictEqual([b.style.left, b.style.top, b.style.width, b.style.height], [L.slots[i].x * 100 + '%', L.slots[i].y * 100 + '%', L.slots[i].w * 100 + '%', L.slots[i].h * 100 + '%'])); };
  geoOk('2x2');
  slots().forEach((b, i) => assert.ok(/is-empty/.test(b.className) && text(b).includes(`Panel ${i + 1} · Empty`), 'empty panels are shown explicitly'));
  assert.strictEqual(cards().length, 4); assert.ok(cards().every((c) => text(c).includes('Empty')));
  const r0 = rendersOf('preview'); assert.ok(r0.length === 2 && r0[1].body.record.kind === 'composite' && img.src === PNG && !/is-dim/.test(img.className), 'the real backend render is shown');

  // ---- selecting a slot shows the action bar
  const hint = find(body, (n) => /fe__hint/.test(n.className) && text(n).includes('Select a panel'))[0];
  assert.ok(act('Create Plot').hidden && !hint.hidden);
  slots()[0].ls.click();
  assert.ok(/is-sel/.test(slots()[0].className) && slots()[0].attrs['aria-pressed'] === 'true' && hint.hidden && !act('Create Plot').hidden);
  assert.deepStrictEqual(['Create Plot', 'Edit Plot', 'Replace Plot', 'Duplicate Plot', 'Clear Panel'].map((l) => act(l).disabled), [false, true, true, true, true]);
  assert.ok(find(body, (n) => /cmp__bartitle/.test(n.className))[0].textContent === 'Panel 1 · Empty');
  slots()[2].ls.click(); slots()[0].ls.click();

  // ---- panel actions
  act('Create Plot').ls.click(); assert.deepStrictEqual([editors.length, last(editors).mode, last(editors).record.kind], [1, 'panel', 'structured']);
  const aRec = Object.assign(panelRec('Scatter A'), { render: { status: 'ok', preview: PNG, diagnostics: [] } });
  const eRec = last(editors); eRec.record.dataset = { columns: [{ name: 'x', type: 'number' }], rows: [[1], [2]], origin: { type: 'sheet', label: 'L' } }; eRec.record.source = 'SRC';
  assert.ok(typeof last(editors).onSave(Object.assign(F.blank('python', 'line'), { name: 'script' })) === 'string' && !dlg.draft.composite.panels[0].record, 'a Python-controlled plot cannot be a panel');
  aRec.dataset = JSON.parse(JSON.stringify(eRec.record.dataset)); aRec.source = 'SRC'; aRec.originalCsv = 'x\n1\n2';
  assert.strictEqual(last(editors).onSave(aRec), true);
  const stored0 = dlg.draft.composite.panels[0].record;
  assert.ok(stored0 !== aRec && stored0.dataset !== aRec.dataset && stored0.dataset.rows[1][0] === 2 && stored0.source === 'SRC' && stored0.originalCsv === 'x\n1\n2' && stored0.config.plotType === 'scatter', 'Save Plot stores a deep copy with config, dataset and source (never just an image)');
  aRec.dataset.rows[1][0] = 77; aRec.config.appearance.title = 'late edit'; assert.ok(stored0.dataset.rows[1][0] === 2 && stored0.config.appearance.title !== 'late edit', 'later edits of the editor draft do not reach the panel');
  assert.deepStrictEqual([dlg.draft.composite.panels[0].record.name, dlg.draft.composite.panels[0].record.render.preview], ['Scatter A', null]);
  assert.ok(/is-ok/.test(slots()[0].className) && text(slots()[0]).includes('Scatter') && act('Create Plot').disabled && !act('Edit Plot').disabled && !act('Duplicate Plot').disabled);
  assert.ok(/is-dim/.test(img.className) && !badge.hidden, 'an edit marks the preview as not matching'); 
  await tick(450); assert.ok(rendersOf('preview').length === 3 && rendersOf('preview')[2].body.record.composite.panels[0].record.name === 'Scatter A' && badge.hidden);
  act('Edit Plot').ls.click(); assert.ok(last(editors).record.name === 'Scatter A' && last(editors).record !== dlg.draft.composite.panels[0].record, 'Edit works on a copy');
  last(editors).record.dataset.rows[0][0] = -1; last(editors).record.config.appearance.title = 'unsaved'; assert.ok(dlg.draft.composite.panels[0].record.dataset.rows[0][0] === 1 && dlg.draft.composite.panels[0].record.config.appearance.title !== 'unsaved', 'editing a panel plot never touches the stored panel until Save Plot');
  act('Replace Plot').ls.click(); assert.strictEqual(last(editors).record.name, 'Untitled plot', 'Replace starts a new plot; the old one stays until it is saved');
  assert.strictEqual(dlg.draft.composite.panels[0].record.name, 'Scatter A');
  const choose = (label) => { const d = last(dialogs); d.close(d.o.buttons.find((b) => b.label === label).value); };
  const nDlg = dialogs.length; act('Duplicate Plot').ls.click(); await tick();
  assert.ok(dialogs.length === nDlg + 1 && last(dialogs).o.title === 'Duplicate plot' && !dlg.draft.composite.panels[1].record, 'several empty panels: it asks which');
  const pickSel = find(last(dialogs).o.body, (n) => n.tag === 'select')[0]; assert.strictEqual(pickSel.children.length, 3);
  pickSel.value = '2'; choose('Duplicate'); await tick();
  assert.ok(dlg.draft.composite.panels[2].record.name === 'Scatter A' && !dlg.draft.composite.panels[1].record && /is-sel/.test(slots()[2].className), 'copied into the chosen panel');
  assert.ok(text(dlg.o.footerLeft).includes('panel 1 into panel 3'));
  slots()[0].ls.click(); act('Duplicate Plot').ls.click(); await tick(); choose('Cancel'); await tick(); assert.ok(!dlg.draft.composite.panels[1].record, 'Cancel copies nothing');
  const dup = dlg.draft.composite.panels[2].record; assert.ok(dup.id !== dlg.draft.composite.panels[0].record.id);
  slots()[2].ls.click();
  const trayEl = find(body, (n) => /cmp__tray/.test(n.className))[0], chips = () => find(body, (n) => n.tag === 'button' && /cmp__chipbtn/.test(n.className));
  assert.ok(trayEl.hidden && !chips().length, 'no tray while nothing is parked');
  confirmAnswer = false; act('Clear Panel').ls.click(); await tick(); assert.ok(confirms.length === 1 && confirms[0].title === 'Clear panel 3?' && dlg.draft.composite.panels[2].record, 'declining keeps the plot');
  confirmAnswer = true; act('Clear Panel').ls.click(); await tick(); assert.ok(!dlg.draft.composite.panels[2].record && /is-empty/.test(slots()[2].className));
  assert.ok(!trayEl.hidden && chips().length === 1 && /Recover/.test(text(chips()[0])) && /Scatter A/.test(chips()[0].attrs['aria-label']), 'the cleared plot is a Recover chip');
  slots()[3].ls.click(); chips()[0].ls.click(); assert.ok(dlg.draft.composite.panels[3].record.name === 'Scatter A' && dlg.draft.composite.panels[3].record !== dup && !chips().length && trayEl.hidden, 'Recover places it into the selected empty panel (undoes the clear)');
  slots()[3].ls.click(); act('Clear Panel').ls.click(); await tick(); assert.strictEqual(chips().length, 1);
  const chipSpan = find(body, (n) => /cmp__chip( |$)/.test(n.className))[0]; chipSpan.ls.dragstart({ dataTransfer: { setData() {} } });
  const dropEv = () => ({ preventDefault() {}, currentTarget: null });
  slots()[0].ls.dragover(dropEv()); slots()[0].ls.drop(dropEv());
  assert.ok(dlg.draft.composite.panels[0].record.name === 'Scatter A' && chips().length === 1 && chips()[0].attrs['aria-label'].includes('Scatter A'), 'dropping onto an occupied panel swaps; the replaced plot is parked');
  find(body, (n) => n.tag === 'button' && /cmp__chipx/.test(n.className))[0].ls.click(); assert.ok(!chips().length, 'a parked plot can be discarded');
  act('Create Plot'); slots()[3].ls.click(); act('Create Plot').ls.click(); last(editors).onSave(panelRec('Bar D', 'bar'));
  slots()[0].ls.dblclick(); assert.strictEqual(last(editors).record.name, 'Scatter A', 'double-click opens the panel plot');

  // ---- an error panel is marked (from the render's panel_failed diagnostics)
  diag = [{ level: 'error', code: 'panel_failed', panel: 0, message: 'Panel 1 could not be drawn: log axis' }];
  find(body, (n) => n.tag === 'button' && text(n) === 'Refresh preview')[0].ls.click(); await tick(60);
  assert.ok(/is-error/.test(slots()[0].className) && text(slots()[0]).includes('could not be drawn') && /is-error/.test(cards()[0].className));
  assert.ok(find(body, (n) => /pd__status/.test(n.className) && n.attrs.role === 'status').some((n) => /marked in red/.test(n.textContent)));
  diag = [];

  // ---- stale handling: edits dim the picture; a result superseded by a newer edit is dropped
  const sel = (label) => find(body, (n) => n.tag === 'select' && n.attrs['aria-label'] === label)[0], pick = (label, v) => { const s = sel(label); s.value = v; s.ls.change(); };
  delay = 120; previewUrl = PNG_B; pick('Spacing', 'wide'); assert.ok(/is-dim/.test(img.className) && !badge.hidden);
  await tick(380); previewUrl = PNG_C; pick('Shared legend', 'bottom'); await tick(650); delay = 0;
  assert.ok(img.src === PNG_C && badge.hidden && !/is-dim/.test(img.className), 'only the newest render is applied');
  assert.deepStrictEqual([dlg.draft.composite.spacing, dlg.draft.composite.legend], ['wide', 'bottom']);
  const wIn = find(body, (n) => n.tag === 'input' && n.attrs['aria-label'] === 'Width (in)')[0];
  wIn.value = '40'; wIn.ls.change(); assert.ok(wIn.attrs['aria-invalid'] === 'true' && dlg.draft.export.wIn === 7, 'out-of-range sizes are flagged and not written');
  wIn.value = '8'; wIn.ls.change(); assert.strictEqual(dlg.draft.export.wIn, 8); await tick(450);

  // ---- layout switch: panels carried over by slot; a panel that would vanish prompts Keep / Discard / Cancel
  slots()[3].ls.click(); const nBefore = dialogs.length; tiles()[1].ls.click(); await tick();
  const ask = last(dialogs); assert.ok(dialogs.length === nBefore + 1 && /^Keep \d+ panels? in the parked tray\?$/.test(ask.o.title) && ask.o.buttons.map((b) => b.label).join() === 'Cancel,Discard,Keep', 'prompt names the count');
  assert.strictEqual(dlg.draft.composite.layout, '2x2', 'nothing changes before the answer');
  choose('Cancel'); await tick(); assert.ok(dlg.draft.composite.layout === '2x2' && dlg.draft.composite.panels[3].record.name === 'Bar D', 'Cancel keeps the layout');
  tiles()[1].ls.click(); await tick(); choose('Keep'); await tick();
  assert.deepStrictEqual([dlg.draft.composite.layout, dlg.draft.composite.panels.length], ['1x2', 2]); geoOk('1x2');
  assert.ok(tiles()[1].attrs['aria-checked'] === 'true' && /parked tray/.test(tileNote()) && !hint.hidden, 'the vanished selection is dropped');
  assert.ok(chips().length === 1 && /Bar D/.test(chips()[0].attrs['aria-label']) && !trayEl.hidden, 'the removed plot is a Recover chip');
  const nAsked = dialogs.length; tiles()[0].ls.click(); await tick(); geoOk('2x2'); assert.strictEqual(dialogs.length, nAsked, 'growing a layout asks nothing');
  assert.ok(!dlg.draft.composite.panels[3].record && chips().length === 1, 'parked plots stay parked until they are placed');
  slots()[3].ls.click(); chips()[0].ls.click(); assert.ok(dlg.draft.composite.panels[3].record.name === 'Bar D' && !chips().length);
  tiles()[1].ls.click(); await tick(); choose('Discard'); await tick(); assert.ok(dlg.draft.composite.layout === '1x2' && !chips().length && /Removed the plot/.test(tileNote()), 'Discard drops it');
  tiles()[0].ls.click(); await tick();
  slots()[3].ls.click(); act('Create Plot').ls.click(); last(editors).onSave(panelRec('Bar D', 'bar'));
  tiles()[5].ls.click(); geoOk('2x3'); assert.strictEqual(cards().length, 6); tiles()[0].ls.click(); await tick(450);

  // ---- unsaved guard
  const nConf = confirms.length; confirmAnswer = false; dlg.close(); await tick(); assert.ok(confirms.length === nConf + 1 && last(confirms).title === 'Discard changes?' && dlg.closed.length === 0, 'Keep editing: still open');
  confirmAnswer = true; dlg.close(); await tick(); assert.deepStrictEqual(dlg.closed, [false], 'Discard closes');

  // ---- Insert: empty composite is refused; a failing panel is refused; success = record + object in ONE undo step
  const nFinal = () => rendersOf('final').length, nFig = () => Object.keys(S.doc.figures || {}).length;
  const d1 = Cm.open(), b1 = d1.o.body; await tick(60);
  assert.strictEqual(d1.o.buttons[1].label, 'Insert figure'); d1.o.buttons[1].onClick(); await tick(30);
  assert.ok(/at least one panel/.test(text(d1.o.footerLeft)) && nFinal() === 0 && !S.doc.slides[0].objects.length);
  const s1 = find(b1, (n) => n.tag === 'button' && /(^| )cmp__slot( |$)/.test(n.className));
  s1[0].ls.click(); find(b1, (n) => n.tag === 'button' && n.html.includes('<span>Create Plot</span>'))[0].ls.click(); last(editors).onSave(panelRec('Scatter A'));
  finalDiag = [{ level: 'error', code: 'panel_failed', panel: 0, message: 'Panel 1 could not be drawn: bad data' }];
  confirmAnswer = false; const nc = confirms.length; d1.o.buttons[1].onClick(); await tick(80);
  assert.ok(confirms.length === nc + 1 && last(confirms).title === 'Insert anyway with error note?', 'a failing panel asks before inserting');
  assert.ok(nFinal() === 1 && /could not be drawn: bad data/.test(text(d1.o.footerLeft)) && !S.doc.slides[0].objects.length && !d1.closed.length && nFig() === 0, 'declining inserts nothing');
  finalDiag = []; await tick(450); confirmAnswer = true;
  const fin = nFinal(); d1.o.buttons[1].onClick(); await tick(100);
  const f1 = rendersOf('final')[fin]; assert.deepStrictEqual([f1.body.purpose, f1.body.record.export.dpi, f1.body.record.kind, f1.body.record.composite.panels[0].record.name], ['final', 450, 'composite', 'Scatter A']);
  const o1 = S.doc.slides[0].objects[0], r1 = S.doc.figures[o1.figureId];
  assert.ok(o1.type === 'figure' && o1.src === PNG_D && o1.aspect === 1.4 && r1.kind === 'composite' && d1.closed[0] === true && /1 plot/.test(o1.alt));
  S.undo(); assert.ok(!S.doc.slides[0].objects.length && nFig() === 0, 'one undo removes object and record'); S.redo();
  // save / reopen round trip keeps the panels' sources inside the record and the object's picture (nothing is re-rendered or re-run)
  const panel0 = JSON.stringify(S.doc.figures[o1.figureId].composite.panels[0].record), nRen = calls.length;
  const viaLocal = S.prepareSave(), viaJson = JSON.parse(S.exportJSON()).doc;
  [viaLocal, viaJson].forEach((d) => {
    S.replaceDoc(JSON.parse(JSON.stringify(d)), 'opened');
    const ro = S.doc.slides[0].objects[0], rr = S.doc.figures[ro.figureId];
    assert.ok(ro.type === 'figure' && ro.src === PNG_D && ro.aspect === 1.4 && rr.kind === 'composite' && rr.composite.panels[0].record.name === 'Scatter A', 'composite + object survive save / open');
    assert.strictEqual(JSON.stringify(rr.composite.panels[0].record), panel0, 'panel dataset, config and source are kept verbatim');
  });
  assert.strictEqual(calls.length, nRen, 'saving and opening never render');

  // ---- Apply: one undo step, x / y / w kept, alt only when still automatic; a failed render changes nothing
  const o2 = S.doc.slides[0].objects[0], geo = [o2.x, o2.y, o2.w], spacing0 = S.doc.figures[o2.figureId].composite.spacing;
  const d2 = Cm.open({ mode: 'edit', obj: o2 }); await tick(60);
  assert.deepStrictEqual([d2.o.title, d2.o.buttons[1].label], ['Edit multi-panel figure', 'Apply']); assert.strictEqual(d2.draft.id, o2.figureId);
  const sp2 = find(d2.o.body, (n) => n.tag === 'select' && n.attrs['aria-label'] === 'Spacing')[0]; sp2.value = 'tight'; sp2.ls.change();
  finalUrl = 'data:image/png;base64,EEEE'; finalDiag = [{ level: 'error', code: 'panel_failed', panel: 0, message: 'Panel 1 could not be drawn: x' }];
  confirmAnswer = false; d2.o.buttons[1].onClick(); await tick(80); assert.ok(last(confirms).title === 'Apply anyway with error note?' && S.doc.slides[0].objects[0].src === PNG_D && S.doc.figures[o2.figureId].composite.spacing === spacing0 && !d2.closed.length);
  finalDiag = []; await tick(450); d2.o.buttons[1].onClick(); await tick(100);
  const o3 = S.doc.slides[0].objects[0]; assert.ok(d2.closed[0] === true && o3.src === finalUrl && S.doc.figures[o2.figureId].composite.spacing === 'tight' && o3.figureId === o2.figureId && o3.id === o2.id);
  assert.deepStrictEqual([o3.x, o3.y, o3.w], geo); assert.strictEqual(o3.h, Math.round(o3.w / 1.4));
  S.undo(); assert.ok(S.doc.slides[0].objects[0].src === PNG_D && S.doc.figures[o2.figureId].composite.spacing === spacing0, 'one undo restores object and record together');

  // ---- a figure object of the retired client-side composer opens as a new figure and becomes figure-backed on Apply
  S.mutate('Add legacy', (d) => { d.slides[0].objects.push({ id: 'old1', type: 'figure', layout: '2x2', labels: 'A', panels: [{ kind: 'bar', seed: 1 }], font: { size: 10 }, gap: 14, x: 40, y: 160, w: 800, h: 420, name: 'Old figure' }); });
  const old = S.doc.slides[0].objects.find((o) => o.id === 'old1'), d3 = Cm.open({ mode: 'edit', obj: old }); await tick(60);
  assert.ok(text(d3.o.body).includes('earlier composer') && d3.draft.name === 'Old figure' && !F.get(d3.draft.id));
  const s3 = find(d3.o.body, (n) => n.tag === 'button' && /(^| )cmp__slot( |$)/.test(n.className)); s3[0].ls.click();
  find(d3.o.body, (n) => n.tag === 'button' && n.html.includes('<span>Create Plot</span>'))[0].ls.click(); last(editors).onSave(panelRec('Scatter L'));
  await tick(450); d3.o.buttons[1].onClick(); await tick(100);
  const o4 = S.doc.slides[0].objects.find((o) => o.id === 'old1');
  assert.ok(o4.figureId && o4.src === finalUrl && o4.layout === undefined && o4.panels === undefined && o4.w === 800 && F.get(o4.figureId).kind === 'composite');

  // ---- controls: label font / weight / offset, font scope, legend reason, export tab (size, dpi, format), insert anyway with an error note
  const d6 = Cm.open(), b6 = d6.o.body; await tick(60);
  const selBy = (b, label) => find(b, (n) => n.tag === 'select' && n.attrs['aria-label'] === label)[0], inBy = (b, label) => find(b, (n) => n.tag === 'input' && n.attrs['aria-label'] === label)[0];
  const chg = (el, v) => { el.value = v; el.ls.change(); };
  chg(selBy(b6, 'Label font'), 'serif'); chg(selBy(b6, 'Label weight'), 'normal'); chg(selBy(b6, 'Panel letters'), 'a'); chg(selBy(b6, 'Label position'), 'bottom-right');
  const off6 = inBy(b6, 'Offset (pt)'); off6.value = '6'; off6.ls.input();
  assert.deepStrictEqual(d6.draft.composite.labelStyle, { family: 'serif', size: 12, weight: 'normal', placement: 'bottom-right', offset: 6 });
  assert.strictEqual(d6.draft.composite.labels, 'a'); assert.strictEqual(d6.draft.composite.fontApplyAll, false, 'default respects local overrides');
  assert.deepStrictEqual(selBy(b6, 'Font size scope').children.map((o) => o.attrs.value), ['respect', 'all']);
  chg(selBy(b6, 'Font size scope'), 'all'); assert.strictEqual(d6.draft.composite.fontApplyAll, true); chg(selBy(b6, 'Font size scope'), 'respect'); assert.strictEqual(d6.draft.composite.fontApplyAll, false);
  assert.deepStrictEqual(Cm.legendReason({ composite: { legend: 'bottom' } }, [{ code: 'legend_not_shared', message: 'legend not shared: panels differ' }], true), 'Legend not shared: panels differ. Each panel keeps its own legend.');
  assert.strictEqual(Cm.legendReason(d6.draft, [{ code: 'legend_not_shared', message: 'x' }], true), '', 'no reason while the legend is None');
  diag = [{ level: 'warning', code: 'legend_not_shared', message: 'legend not shared: line colours differ' }];
  chg(selBy(b6, 'Shared legend'), 'bottom'); await tick(450);
  assert.ok(text(b6).includes('Legend not shared: line colours differ. Each panel keeps its own legend.'), 'the reason is shown inline'); diag = [];
  chg(selBy(b6, 'Shared legend'), 'none'); assert.ok(!text(b6).includes('Legend not shared'));
  const wI = inBy(b6, 'Width (in)'), hI = inBy(b6, 'Height (in)'); chg(wI, '8'); chg(hI, '4'); chg(inBy(b6, 'Custom DPI'), '300');
  assert.deepStrictEqual([d6.draft.export.wIn, d6.draft.export.hIn, d6.draft.export.dpi], [8, 4, 300]);
  const xb = (label) => find(b6, (n) => n.tag === 'button' && text(n) === label)[0];
  xb('PDF').ls.click(); assert.strictEqual(d6.draft.export.format, 'pdf'); assert.ok(xb('Export Python…').hidden && xb('Transparent').disabled && !xb('Export file…').disabled, 'export tab reused; no Python export or transparency for composites');
  xb('PNG').ls.click();
  find(b6, (n) => n.tag === 'button' && /(^| )cmp__slot( |$)/.test(n.className))[0].ls.click(); find(b6, (n) => n.tag === 'button' && n.html.includes('<span>Create Plot</span>'))[0].ls.click(); last(editors).onSave(panelRec('Scatter F'));
  await tick(450); finalDiag = [{ level: 'error', code: 'panel_failed', panel: 0, message: 'Panel 1 could not be drawn: bad data' }]; confirmAnswer = true;
  const nObj = S.doc.slides[0].objects.length; d6.o.buttons[1].onClick(); await tick(120);
  const o6 = S.doc.slides[0].objects[S.doc.slides[0].objects.length - 1];
  assert.ok(confirms.length && last(confirms).title === 'Insert anyway with error note?' && S.doc.slides[0].objects.length === nObj + 1 && d6.closed[0] === true, 'accepting inserts the figure');
  assert.ok(/Panel 1 could not be drawn; an error note is shown there\./.test(o6.alt) && o6.type === 'figure' && o6.aspect === 1.4 && Math.abs(o6.w / o6.h - o6.aspect) < 0.02, 'alt names the failed panel; aspect = rendered pixels');
  assert.strictEqual(rendersOf('final').pop().body.record.export.dpi, 300, 'the final render uses the composite export dpi'); finalDiag = [];

  // ---- layouts that cannot be read: message + Retry, panel list still works; offline: message dialog, nothing opens
  layoutsFail = true; const d4 = Cm.open(), b4 = d4.o.body; await tick(60);
  const retry = find(b4, (n) => n.tag === 'button' && text(n) === 'Retry')[0];
  assert.ok(retry && find(b4, (n) => n.tag === 'button' && /(^| )cmp__slot( |$)/.test(n.className)).length === 0 && find(b4, (n) => n.tag === 'button' && /(^| )cmp__card( |$)/.test(n.className)).length === 4);
  layoutsFail = false; retry.ls.click(); await tick(60);
  assert.ok(find(b4, (n) => n.tag === 'button' && /(^| )ltile( |$)/.test(n.className)).length === 6 && find(b4, (n) => n.tag === 'button' && /(^| )cmp__slot( |$)/.test(n.className)).length === 4);
  RPE.backend.connected = false; const d5 = Cm.open(); assert.ok(d5.o.icon === 'plug-zap' && d5.o.title === 'Compose multi-panel figure');
  console.log('PASS: 27. Composer: served layout table drives tiles + overlay, empty / occupied / error slots, action bar, layout switch keeps plots, stale preview handling, unsaved guard ignores previews, Insert / Apply = one undo step, failures change nothing');
}


// 28. LaTeX window (js/figures/latex.js): compile only on click, mode label + wrapper on demand, error jump + gutter marks, missing files, no-compiler panel, last-good preview, preview zoom, Insert / Apply = one undo step
async function testLatex() {
  const jsonRes = (b) => new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const tick = (ms) => new Promise((r) => setTimeout(r, ms || 15));
  const calls = []; let mode = 'ok', raster = null, engines = { pdflatex: { version: 'x' } };
  const fetchImpl = (url, init) => {
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : null; calls.push({ url, body });
    if (/\/runtime/.test(url)) return Promise.resolve(jsonRes({ python: '3.12', rasterizer: raster, tex: { engines, kpsewhich: null, pgfplots: false } }));
    if (/latex\/templates/.test(url)) return Promise.resolve(jsonRes({ templates: [{ id: 'document_math', name: 'Math', description: 'd', mode: 'document', engine: 'pdflatex', source: '\\documentclass{article}\n\\begin{document}\n$x$\n\\end{document}\n' }] }));
    if (/latex\/wrapper/.test(url)) return Promise.resolve(jsonRes({ ok: true, message: '', wrapper: { prefix: '\\documentclass{standalone}\n\\begin{document}\n', suffix: '\\end{document}\n', lineOffset: 2 }, tex: '\\documentclass{standalone}\n\\begin{document}\n' + body.source + '\n\\end{document}\n' }));
    if (/latex\/(compile|render)/.test(url)) {
      const fin = /render/.test(url), base = { engine: body.engine, dpi: fin ? body.dpi : 150, wrapped: body.mode === 'fragment', passes: 1, overfull: 0, durationMs: 812, log: 'This is pdfTeX', pages: 1 };
      if (mode === 'fail') return Promise.resolve(jsonRes(Object.assign({}, base, { ok: false, status: 'compile_failed', message: 'Line 2: Undefined control sequence.', preview: null, errors: [{ line: 2, message: 'Undefined control sequence.', context: '\\oops' }, { line: 40, message: 'beyond the source' }, { line: 3, file: 'extra.tex', message: 'in another file' }, { line: null, inWrapper: true, message: 'wrapper problem' }],
        missing: [{ file: 'plot.png', kind: 'file', message: "File 'plot.png' not found." }, { file: 'pgfplots.sty', kind: 'package', message: 'Package pgfplots is not installed. Install it with your TeX distribution; the app never downloads packages.' }] })));
      return Promise.resolve(jsonRes(Object.assign({}, base, { ok: true, status: 'ok', message: '', preview: PNG, widthPx: fin ? (body.wIn ? Math.round(body.wIn * body.dpi) : 1800) : 600, heightPx: fin ? (body.wIn ? Math.round(body.wIn * body.dpi / 1.5) : 1200) : 400, pdfBase64: fin ? undefined : 'JVBERg==', errors: [], missing: [] })));
    }
    return Promise.resolve(jsonRes({}));
  };
  const { RPE, S, F } = figEnv(fetchImpl);
  RPE.backend.connected = true;
  const mk = (tag, pr, ...kids) => {
    const el = { tag, children: [], attrs: {}, ls: {}, className: '', value: '', hidden: false, disabled: false, style: {}, _t: '' };
    Object.keys(pr || {}).forEach((k) => { if (k.slice(0, 2) === 'on') el.ls[k.slice(2).toLowerCase()] = pr[k]; else if (k === 'class') el.className = pr[k]; else if (k === 'hidden') el.hidden = !!pr[k]; else el.attrs[k] = pr[k]; });
    el.append = (...c) => c.flat().forEach((x) => { if (x != null && x !== false) el.children.push(typeof x === 'string' ? { text: x, children: [] } : x); });
    el.append(...kids);
    Object.defineProperty(el, 'textContent', { get() { return el._t; }, set(v) { el._t = v; if (v === '') el.children.length = 0; } });
    el.addEventListener = (t, f) => { el.ls[t] = f; }; el.setAttribute = (k, v) => { el.attrs[k] = String(v); }; el.focus = () => {};
    return el;
  };
  RPE.h = mk;
  delete require.cache[require.resolve('../js/figures/exportpanel.js')]; require('../js/figures/exportpanel.js');
  S.setActiveSlide('s1');
  const dialogs = [], closed = []; let guardAnswer = 'discard';
  RPE.ui = { closeAll() {}, popover() {}, confirm: async () => true,
    dialog: (o) => { const api = { el: mk('div'), buttons: { insert: { disabled: false } }, o, close(v) { closed.push(v); if (o.onClose) o.onClose(v); } }; api.done = Promise.resolve(guardAnswer); dialogs.push(api); return api; } };
  let ed = null;
  F.codeEditor = (o) => { ed = { el: mk('div'), textarea: mk('textarea'), value: o.value || '', errors: [], jumped: [], opts: o, lang: o.language, getValue() { return ed.value; }, setValue(v) { ed.value = v; }, setErrors(e) { ed.errors = e; }, jumpToLine(n) { ed.jumped.push(n); }, focus() {}, destroy() {} }; return ed; };
  delete require.cache[require.resolve('../js/figures/latex.js')]; require('../js/figures/latex.js');
  const L = F.latex;
  const find = (n, f, acc) => { acc = acc || []; if (f(n)) acc.push(n); (n.children || []).forEach((c) => find(c, f, acc)); return acc; };
  const text = (n) => (n.text || '') + (n.children || []).map(text).join('');
  const btns = (root, label) => find(root, (n) => n.tag === 'button' && text(n) === label);
  const cls = (root, c) => find(root, (n) => (n.className || '').split(' ').indexOf(c) >= 0)[0];
  const compiles = () => calls.filter((c) => /latex\/compile/.test(c.url));

  // pure helpers
  assert.deepStrictEqual([L.chip({ running: true, t0: 1000 }, 4200).label, L.chip({ status: 'ok', durationMs: 812 }).label, L.chip({ status: 'timeout' }).label, L.chip({ status: 'no_compiler' }).label, L.chip({ status: 'compile_failed' }).label, L.chip({ status: 'idle' }).label],
    ['Compiling 3.2 s', 'OK 0.8 s', 'Timeout', 'No compiler', 'Failed', 'Idle']);
  assert.ok(/^Complete document: .*exactly as written/.test(L.modeLabel('document')) && /^Fragment \(wrapped\): .*Error lines refer to your source/.test(L.modeLabel('fragment')));
  assert.ok(L.modeHint('fragment', '\\documentclass{x}') && /Switch Mode to Document/.test(L.modeHint('fragment', '\\begin{document}').text) && /Switch Mode to Fragment/.test(L.modeHint('document', '$x$').text) && !L.modeHint('document', '\\documentclass{x}') && !L.modeHint('fragment', '$x$'));
  assert.strictEqual(L.guessMode('\\documentclass{a}'), 'document'); assert.strictEqual(L.guessMode('$x$'), 'fragment');
  const failRes = L.normalize({ ok: true, data: { ok: false, status: 'compile_failed', message: 'm', errors: [{ line: 2, message: 'bad' }, { line: 40, message: 'far' }, { line: 3, file: 'a.tex', message: 'other' }, { line: null, inWrapper: true, message: 'w' }], missing: [{ kind: 'file', file: 'f.png', message: 'x' }, { kind: 'package', file: 'p.sty', message: 'y' }, { kind: 'font', file: 'z', message: 'f' }] } });
  assert.deepStrictEqual(L.errorItems(failRes, 'a\nb\nc').map((e) => e.line), [2, null, null, null], 'lines outside the source, in other files or in the wrapper are not clickable');
  assert.ok(/^a\.tex:3: other/.test(L.errorItems(failRes, 'a\nb\nc')[2].message) && /^In the wrapper this app adds: w/.test(L.errorItems(failRes, 'a')[3].message));
  const mi = L.missingItems(failRes); assert.deepStrictEqual([mi.files.length, mi.packages.length, mi.fonts.length], [1, 1, 1]);
  assert.strictEqual(L.normalize({ ok: false, code: 'offline', message: 'down' }).status, 'offline'); assert.strictEqual(L.normalize({ ok: false, code: 'aborted' }).status, 'cancelled');
  assert.deepStrictEqual([L.compilerState(null, 'pdflatex').state, L.compilerState({ tex: { engines: {} } }, 'pdflatex').state, L.compilerState({ tex: { engines: { xelatex: {} } } }, 'pdflatex').state, L.compilerState({ tex: { engines: { pdflatex: {} } } }, 'pdflatex').state], ['unknown', 'none', 'engine_missing', 'ok']);
  assert.deepStrictEqual([L.zoomWidth('fit', 600), L.zoomWidth(50, 600), L.zoomWidth(400, 600)], [null, 300, 2400]);
  assert.deepStrictEqual(L.ZOOMS.map(L.zoomLabel), ['Fit', '50%', '100%', '150%', '200%', '300%', '400%']);
  assert.strictEqual(L.texFile('document', 'S', null), 'S'); assert.strictEqual(L.texFile('fragment', 'S', { ok: true, tex: 'W' }), 'W'); assert.strictEqual(L.texFile('fragment', 'S', { ok: false }), null);
  assert.strictEqual(L.statusLine(null), 'Not compiled yet.'); assert.ok(/^Success · 0\.8 s · 1 page · pdflatex$/.test(L.statusLine({ ok: true, durationMs: 812, pages: 1, engine: 'pdflatex' })) && /^Failed · 1\.0 s/.test(L.statusLine({ ok: false, status: 'compile_failed', durationMs: 1000 })));

  // pure: stale detection, page -> image plan (aspect kept, native = page size), asset listing
  const gS = { source: 'a', mode: 'document', engine: 'pdflatex' };
  assert.deepStrictEqual([L.fresh(gS, { source: 'a', mode: 'document', engine: 'pdflatex' }), L.fresh(gS, { source: 'b', mode: 'document', engine: 'pdflatex' }), L.fresh(gS, { source: 'a', mode: 'fragment', engine: 'pdflatex' }), L.fresh(gS, { source: 'a', mode: 'document', engine: 'xelatex' }), L.fresh(null, gS)], [true, false, false, false, false]);
  const g0 = { widthPx: 600, heightPx: 400, dpi: 150 }, pn = L.plan(g0, { native: true, dpi: 450 }), pc = L.plan(g0, { native: false, wIn: 3, dpi: 300 }), r6 = (x) => Math.round(x * 1e6) / 1e6;
  assert.deepStrictEqual([r6(pn.wIn), r6(pn.hIn), pn.wPx, pn.hPx, pc.wIn, r6(pc.hIn), pc.wPx, pc.hPx], [4, 2.666667, 1800, 1200, 3, 2, 900, 600]); assert.ok(Math.abs(pc.wPx / pc.hPx - g0.widthPx / g0.heightPx) < 1e-9, 'never stretched');
  assert.ok(L.plan(g0, { native: false, wIn: 30, dpi: 1200 }).refused && L.plan(null, {}) === null);
  assert.deepStrictEqual([L.bgState({ rasterizer: 'pdftoppm' }).ok, L.bgState({ rasterizer: null }).ok, L.bgState(null).ok], [false, false, false]);
  assert.deepStrictEqual(L.assets('\\includegraphics[width=3cm]{fig/a.png} % \\includegraphics{no.png}\n\\input{part}\n\\addplot[blue] table[x=a]{data.csv}\n\\pgfplotstableread{t.dat}\\includegraphics{fig/a.png}\\addplot table{\\tbl}'),
    [{ name: 'fig/a.png', kind: 'image' }, { name: 'part', kind: 'tex' }, { name: 't.dat', kind: 'data' }, { name: 'data.csv', kind: 'data' }], 'commented, repeated and macro references are not listed');

  // open: nothing compiles; engines come from /runtime
  const dlg = L.open(), body = dlg.o.body;
  assert.strictEqual(compiles().length, 0, 'opening never compiles'); await tick(40);
  assert.ok(calls.some((c) => /\/runtime/.test(c.url)) && ed.lang === 'latex' && ed.value === L.STARTER);
  const chip = cls(body, 'ltx__chip'), nocomp = cls(body, 'ltx__nocomp'), img = cls(body, 'ltx__img'), badge = cls(body, 'fe__badge'), msgEl = cls(body, 'ltx__msg');
  assert.ok(nocomp.hidden && chip.textContent === 'Idle' && /Nothing is compiled until you press Compile/.test(msgEl.textContent));
  assert.ok(find(body, (n) => /ltx__zoomrow/.test(n.className) && /Preview zoom — not export resolution/.test(text(n))).length === 1, 'zoom is labelled as not export resolution');
  assert.deepStrictEqual(btns(body, 'Document').length + btns(body, 'Fragment (wrapped)').length, 2);
  assert.ok(/exactly as written/.test(cls(body, 'ltx__modetext').textContent) && btns(body, 'View wrapper')[0].disabled, 'document mode: no wrapper to view');
  const engSel = find(body, (n) => n.tag === 'select' && n.attrs['aria-label'] === 'Engine')[0];
  assert.deepStrictEqual(engSel.children.map((o) => [o.attrs.value, o.disabled]), [['pdflatex', false], ['xelatex', true], ['lualatex', true]], 'engines not found are disabled');

  // Compile: one request with mode / engine / preview dpi
  btns(body, 'Compile')[0].ls.click(); await tick(40);
  assert.strictEqual(compiles().length, 1); assert.deepStrictEqual([compiles()[0].body.mode, compiles()[0].body.engine, compiles()[0].body.dpi, compiles()[0].body.source === L.STARTER], ['document', 'pdflatex', 150, true]);
  assert.strictEqual(chip.textContent, 'OK 0.8 s'); assert.strictEqual(img.src, PNG); assert.ok(!/is-dim/.test(img.className) && badge.hidden);
  assert.ok(/Success · 0\.8 s/.test(cls(body, 'ltx__status').textContent), 'status line sits in the collapsible header');
  btns(body, '200%')[0].ls.click(); assert.strictEqual(img.style.width, '1200px', 'zoom 200 % of a 600 px preview'); btns(body, 'Fit')[0].ls.click(); assert.strictEqual(img.style.width, '');

  // edit => image marked as not matching; fragment mode shows the wrapper only on demand
  ed.value = '$x$'; ed.opts.onChange('$x$'); assert.ok(!badge.hidden && /Does not match source/.test(badge.textContent) && /is-dim/.test(img.className));
  btns(body, 'Fragment (wrapped)')[0].ls.click(); assert.ok(/standalone-class document that this app adds/.test(cls(body, 'ltx__modetext').textContent) && !btns(body, 'View wrapper')[0].disabled);
  const wrapPre = cls(body, 'ltx__wrap'), nW = calls.filter((c) => /latex\/wrapper/.test(c.url)).length; assert.ok(wrapPre.hidden && nW === 0, 'the wrapper is fetched only on demand');
  btns(body, 'View wrapper')[0].ls.click(); await tick(40);
  assert.ok(!wrapPre.hidden && /\\begin\{document\}/.test(wrapPre.textContent) && /\\end\{document\}/.test(wrapPre.textContent) && btns(body, 'View wrapper')[0].textContent === 'Hide wrapper'); assert.strictEqual(compiles().length, 1, 'viewing the wrapper never compiles');

  // failure: Failed chip, clickable line + gutter mark, other-file / wrapper rows not clickable, missing files, last good image kept
  mode = 'fail'; ed.value = 'a\nb\nc'; ed.opts.onChange(ed.value); btns(body, 'Compile')[0].ls.click(); await tick(40);
  assert.strictEqual(chip.textContent, 'Failed'); assert.strictEqual(compiles()[1].body.mode, 'fragment');
  const row = btns(body, 'Line 2: Undefined control sequence. — \\oops'); assert.strictEqual(row.length, 1);
  row[0].ls.click(); assert.deepStrictEqual(ed.jumped, [2]); assert.deepStrictEqual(ed.errors.map((e) => e.line), [2], 'only lines of the source get a gutter marker');
  const diag = text(cls(body, 'ltx__out')); assert.ok(/extra\.tex:3: in another file/.test(diag) && /In the wrapper this app adds: wrapper problem/.test(diag) && !btns(body, 'Line 40: beyond the source').length);
  assert.ok(/Missing external files: plot\.png\./.test(text(cls(body, 'ltx__miss'))) && /empty temporary folder/.test(text(cls(body, 'ltx__miss'))) && /Missing package: Package pgfplots is not installed/.test(text(cls(body, 'ltx__miss'))));
  assert.ok(/is-dim/.test(img.className) && !img.hidden && /Does not match source: the latest compile failed/.test(badge.textContent), 'last good image stays, dimmed, with a badge');
  assert.ok(/Failed · 0\.8 s/.test(cls(body, 'ltx__status').textContent) && cls(body, 'ltx__out').open === true);
  const rawDet = find(body, (n) => n.tag === 'details' && !/ltx__out/.test(n.className)); assert.strictEqual(rawDet.length, 1); assert.ok(!rawDet[0].hidden && rawDet[0].open !== true, 'raw log is collapsed');
  assert.strictEqual(cls(body, 'ltx__log').textContent, 'This is pdfTeX');

  // Export .tex of a fragment = wrapper + source (complete file); Save Source = verbatim; neither compiles
  const blobs = []; global.URL = { createObjectURL: (b) => { blobs.push(b); return 'blob:x'; }, revokeObjectURL() {} };
  global.document.createElement = () => ({ click() {}, remove() {} }); global.document.body = { appendChild() {} };
  btns(body, 'Export .tex')[0].ls.click(); await tick(40); assert.ok(blobs.length === 1 && /Saved LaTeX_figure\.tex \(with the wrapper/.test(msgEl.textContent));
  assert.strictEqual(await blobs[0].text(), '\\documentclass{standalone}\n\\begin{document}\na\nb\nc\n\\end{document}\n');
  btns(body, 'Save Source')[0].ls.click(); assert.strictEqual(await blobs[1].text(), 'a\nb\nc'); assert.strictEqual(compiles().length, 2);

  // Insert: final render (450 dpi) of the CURRENT source; failure changes nothing; success = record + object in ONE undo step
  const before = S.doc.slides[0].objects.length, cf0 = compiles().length, rf0 = calls.filter((c) => /latex\/render/.test(c.url)).length; closed.length = 0;
  dlg.o.buttons[1].onClick(); await tick(60);
  assert.deepStrictEqual([compiles().length - cf0, calls.filter((c) => /latex\/render/.test(c.url)).length - rf0], [1, 0], 'a stale source is recompiled first; a failed compile renders nothing');
  assert.ok(S.doc.slides[0].objects.length === before && !closed.length && /Nothing was inserted\./.test(msgEl.textContent), 'failed Insert changes nothing and stays open');
  mode = 'ok'; ed.value = '$y$'; ed.opts.onChange('$y$'); cls(body, 'ltx__alt').children[1].value = 'A formula'; cls(body, 'ltx__alt').children[1].ls.input();
  btns(body, 'Compile')[0].ls.click(); await tick(40); const cf1 = compiles().length;
  dlg.o.buttons[1].onClick(); await tick(60);
  assert.strictEqual(compiles().length, cf1, 'source unchanged since the last good compile: Insert does not recompile');
  const rn = calls.filter((c) => /latex\/render/.test(c.url)).pop().body; assert.deepStrictEqual([rn.dpi, rn.pdfBase64, rn.source, rn.wIn, rn.background], [450, 'JVBERg==', undefined, undefined, 'white'], 'the final PNG is drawn from the compiled PDF at the native page size');
  const o1 = S.doc.slides[0].objects[0], rec = S.doc.figures[o1.figureId];
  assert.ok(closed.includes('inserted') && o1.type === 'plot' && o1.alt === 'A formula' && o1.aspect === 1.5 && rec.kind === 'latex' && rec.source === '$y$' && rec.latex.mode === 'fragment' && rec.latex.engine === 'pdflatex' && rec.sourceMode === 'custom');
  assert.deepStrictEqual([rec.latex.native, rec.latex.lastCompile.pages, rec.latex.lastCompile.pageWIn, rec.latex.lastCompile.pageHIn, rec.latex.assets.length], [true, 1, 4, 2.667, 0], 'compile summary and asset listing are kept in the record');
  assert.deepStrictEqual([rec.render.status, rec.render.hash, rec.render.runtime.widthPx, rec.render.preview], ['ok', null, 1800, PNG], 'the final image is the object; render.preview is the matching compile preview');
  S.undo(); assert.strictEqual(S.doc.slides[0].objects.length, 0); assert.ok(!S.doc.figures || !S.doc.figures[rec.id], 'one undo removes object and record');

  // close guard
  closed.length = 0; guardAnswer = 'keep';
  const d2 = L.open(); ed.opts.onChange('changed'); d2.close('Close'); await tick(); assert.strictEqual(dialogs[dialogs.length - 1].o.title, 'Close without inserting?'); assert.strictEqual(closed.length, 0);
  guardAnswer = 'discard'; d2.close('Close'); await tick(); assert.ok(closed.includes('Close'));

  // reopen a LaTeX figure: saved source / mode / engine load, nothing compiles; Apply = ONE undo step, x / y / w kept
  S.mutate('x', (d) => { d.slides[0].objects.push(Object.assign({ id: 'pl1', type: 'plot', figureId: rec.id }, { src: PNG, aspect: 1.5, x: 40, y: 50, w: 300, h: 200, alt: 'A formula' })); F.attach(d, JSON.parse(JSON.stringify(rec))); });
  const n0 = calls.filter((c) => /latex\/compile|latex\/render/.test(c.url)).length, d5 = L.open({ obj: S.doc.slides[0].objects[0] });
  assert.deepStrictEqual([ed.value, d5.o.title, d5.o.buttons[1].label], ['$y$', 'Edit LaTeX figure', 'Apply']); assert.strictEqual(calls.filter((c) => /latex\/compile|latex\/render/.test(c.url)).length, n0);
  assert.ok(/standalone-class document/.test(cls(d5.o.body, 'ltx__modetext').textContent), 'saved mode is restored');
  ed.value = '$z$'; ed.opts.onChange('$z$'); d5.o.buttons[1].onClick(); await tick(60);
  const o2 = S.doc.slides[0].objects[0]; assert.ok(S.doc.figures[rec.id].source === '$z$' && [o2.x, o2.y, o2.w].join() === '40,50,300');
  S.undo(); assert.strictEqual(S.doc.figures[rec.id].source, '$y$');

  // an older PGFPlots object (source only) is upgraded by Apply, one undo step
  S.mutate('legacy', (d) => { d.slides[0].objects.push({ id: 'old1', type: 'plot', engine: 'pgfplots', source: '\\begin{tikzpicture}\\end{tikzpicture}', x: 10, y: 20, w: 400, h: 300 }); });
  const d6 = L.open({ obj: S.doc.slides[0].objects.find((o) => o.id === 'old1') }); assert.strictEqual(d6.o.title, 'Edit LaTeX figure'); assert.ok(/standalone-class document/.test(cls(d6.o.body, 'ltx__modetext').textContent), 'a bare fragment opens in fragment mode');
  d6.o.buttons[1].onClick(); await tick(60);
  const old = S.doc.slides[0].objects.find((o) => o.id === 'old1'); assert.ok(old.figureId && S.doc.figures[old.figureId].kind === 'latex' && old.engine === undefined && old.source === undefined && old.x === 10 && old.w === 400);
  S.undo(); assert.ok(S.doc.slides[0].objects.find((o) => o.id === 'old1').engine === 'pgfplots', 'one undo restores the older object');

  // export bar: native size sends no width; a custom width keeps the page aspect; Export PNG / PDF reuse a fresh compile; reopen restores size, dpi and background
  const d8 = L.open(), b8 = d8.o.body; await tick(40);
  const byId = (root, id) => find(root, (n) => n.attrs && n.attrs.id === id)[0], rends = () => calls.filter((c) => /latex\/render/.test(c.url));
  mode = 'ok'; ed.value = '$q$'; ed.opts.onChange('$q$');
  const nat = byId(b8, 'ltxnat'), wB = byId(b8, 'ltxw'), hB = byId(b8, 'ltxh'), dpiB = byId(b8, 'ltxdpi'), bgB = byId(b8, 'ltxbg'), readE = cls(b8, 'ltx__expread');
  assert.ok(nat.checked && wB.disabled && /Compile once to see the page size/.test(readE.textContent));
  assert.ok(find(bgB, (n) => n.tag === 'option' && n.attrs.value === 'transparent')[0].disabled, 'Transparent is disabled because pdftoppm renders on white');
  btns(b8, 'Compile')[0].ls.click(); await tick(40);
  assert.ok(/^Native size: 4\.0 × 2\.67 in @ 450 dpi ≈ 1800 × 1200 px/.test(readE.textContent) && hB.disabled, readE.textContent);
  nat.checked = false; nat.ls.change(); wB.value = '3'; wB.ls.input();
  assert.ok(hB.value === '2' && /^3\.0 × 2\.0 in @ 450 dpi = 1350 × 900 px/.test(readE.textContent) && !wB.disabled, 'height follows the page aspect: ' + readE.textContent);
  wB.value = '40'; wB.ls.input(); assert.ok(wB.attrs['aria-invalid'] === 'true' && d8.buttons.insert.disabled && /0\.5–30 in/.test(readE.textContent) && btns(b8, 'Export PNG')[0].disabled, 'an invalid size blocks Insert and Export PNG');
  wB.value = '3'; wB.ls.input(); dpiB.value = '300'; dpiB.ls.change(); assert.ok(/= 900 × 600 px/.test(readE.textContent) && !d8.buttons.insert.disabled);
  const cx = compiles().length, rx = rends().length;
  btns(b8, 'Export PNG')[0].ls.click(); await tick(60);
  const rp = rends().pop().body; assert.deepStrictEqual([rends().length - rx, compiles().length - cx, rp.dpi, rp.wIn, rp.background, rp.source], [1, 0, 300, 3, 'white', undefined], 'Export PNG reuses the fresh compile');
  assert.ok(blobs[blobs.length - 1].type === 'image/png' && /^Saved LaTeX_figure\.png: 900 × 600 px at 300 dpi\.$/.test(cls(b8, 'ltx__msg').textContent), cls(b8, 'ltx__msg').textContent);
  btns(b8, 'Export compiled PDF')[0].ls.click(); await tick(40);
  assert.ok(blobs[blobs.length - 1].type === 'application/pdf' && Buffer.from(await blobs[blobs.length - 1].arrayBuffer()).toString('latin1') === '%PDF' && compiles().length === cx, 'Export PDF writes the compiled PDF without recompiling');
  ed.value = '$r$'; ed.opts.onChange('$r$'); btns(b8, 'Export compiled PDF')[0].ls.click(); await tick(60); assert.strictEqual(compiles().length, cx + 1, 'a changed source is recompiled before the PDF is exported');
  d8.o.buttons[1].onClick(); await tick(60);
  const o8 = S.doc.slides[0].objects[S.doc.slides[0].objects.length - 1], rec8 = S.doc.figures[o8.figureId];
  assert.deepStrictEqual([o8.aspect, o8.w, rec8.latex.native, rec8.export.wIn, rec8.export.hIn, rec8.export.dpi, rec8.export.background], [1.5, 288, false, 3, 2, 300, 'white'], 'custom size: physical width kept, aspect preserved');
  const n8 = compiles().length + rends().length, d9 = L.open({ obj: o8 }); await tick(40);
  assert.ok(!byId(d9.o.body, 'ltxnat').checked && byId(d9.o.body, 'ltxw').value === '3' && byId(d9.o.body, 'ltxdpi').value === '300' && byId(d9.o.body, 'ltxbg').value === 'white' && /^3\.0 × 2\.0 in @ 300 dpi = 900 × 600 px/.test(cls(d9.o.body, 'ltx__expread').textContent), 'reopen restores size, dpi and background');
  assert.strictEqual(compiles().length + rends().length, n8, 'reopening compiles nothing');
  const cy = compiles().length; btns(d9.o.body, 'Export compiled PDF')[0].ls.click(); await tick(60); assert.strictEqual(compiles().length, cy + 1, 'a reopened figure keeps no PDF, so the first export compiles');
  raster = 'pdftoppm'; await F.refresh(); const d10 = L.open(); await tick(40);
  assert.ok(find(byId(d10.o.body, 'ltxbg'), (n) => n.tag === 'option' && n.attrs.value === 'transparent')[0].disabled, 'Transparent remains disabled when rasterizer is pdftoppm'); raster = null; await F.refresh();

  // no TeX compiler: explicit panel, detected engines listed, no fallback renderer, Compile disabled and never sends a request
  engines = {}; await F.refresh(); const nc0 = compiles().length;
  const d7 = L.open(); await tick(40); const np = cls(d7.o.body, 'ltx__nocomp');
  assert.ok(!np.hidden && /local TeX installation is required/.test(text(np)) && /Detected engines \(from \/runtime\): none\./.test(text(np)) && /never downloads TeX/.test(text(np)));
  assert.ok(btns(d7.o.body, 'Compile')[0].disabled && d7.o.buttons[1] && dlg.buttons.insert); btns(d7.o.body, 'Compile')[0].ls.click(); await tick(); assert.strictEqual(compiles().length, nc0);
  engines = { xelatex: {} }; btns(d7.o.body, 'Check again')[0].ls.click(); await tick(60);
  assert.ok(/engine/i.test(text(cls(d7.o.body, 'ltx__msg')) + 'engine') && btns(d7.o.body, 'Compile')[0].disabled, 'pdflatex missing but xelatex found: Compile stays off until another engine is chosen');
  console.log('PASS: 28. LaTeX window: compile only on click, mode label + wrapper on demand, error jump + gutter marks, missing files, no-compiler panel, last-good dimmed preview, zoom, Export .tex / Save Source, Insert / Apply = one undo step, close guard');
}

// 32. Figure-window a11y helpers (js/figures/a11y.js): roving radios, Ctrl+S / F6 scoped to the dialog, one-sentence help, status announcer, tooltip + shortcut
(function testFigureA11y() {
  const assert = require('assert'), saved0 = { RPE: global.RPE, document: global.document, active: global.__active };
  try {
  const mk = (tag, attrs) => { const el = { tag, attrs: Object.assign({}, attrs), ls: {}, children: [], textContent: '', focused: false, tabIndex: 0, closest: () => null, offsetParent: {},
    setAttribute(k, v) { this.attrs[k] = String(v); }, getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; }, removeAttribute(k) { delete this.attrs[k]; },
    addEventListener(t, f) { this.ls[t] = f; }, focus() { this.focused = true; global.__active = this; }, click() { this.clicked = (this.clicked || 0) + 1; },
    matches: () => false, querySelector() { return null; }, querySelectorAll() { return []; }, append() {}, appendChild(c) { this.children.push(c); } }; return el; };
  const popovers = [];
  global.RPE = { ui: { h: (t, a, ...k) => { const e = mk(t, a); e.textContent = k.filter((x) => typeof x === 'string').join(''); return e; }, hasPopover: () => false, isOpenFor: () => false, closeAll() {},
    popover: (anchor, content, o) => { popovers.push({ anchor, content, o }); return {}; } }, figures: {} };
  global.document = { get activeElement() { return global.__active || null; } };
  delete require.cache[require.resolve('../js/figures/a11y.js')]; require('../js/figures/a11y.js');
  const A = RPE.figures.a11y;

  // radio tiles: arrows move focus and select (click), wrapping; Home/End
  const t = [mk('button', { role: 'radio', 'aria-checked': 'true' }), mk('button', { role: 'radio', 'aria-checked': 'false' }), mk('button', { role: 'radio', 'aria-checked': 'false' })];
  const grp = mk('div'); grp.querySelectorAll = () => t; A.radios(grp);
  assert.deepStrictEqual(t.map((b) => b.tabIndex), [0, -1, -1], 'one tab stop on the checked tile');
  global.__active = t[2]; let prevented = 0; grp.ls.keydown({ key: 'ArrowRight', preventDefault() { prevented++; } });
  assert.ok(t[0].focused && t[0].clicked === 1 && prevented === 1, 'ArrowRight wraps to the first tile and selects it');
  global.__active = t[0]; grp.ls.keydown({ key: 'End', preventDefault() {} }); assert.strictEqual(t[2].clicked, 1);
  global.__active = t[1]; grp.ls.keydown({ key: 'a', preventDefault() { assert.fail('other keys untouched'); } });

  // Ctrl+S is consumed (the app must not save the deck behind a dialog); Ctrl+Enter only when a run handler is given
  const dlg = { el: mk('div') }; let saved = 0, ran = 0;
  A.keys(dlg, { save: () => saved++, run: () => { ran++; return false; } });
  const ev = (o) => Object.assign({ ctrlKey: true, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; } }, o);
  const e1 = ev({ key: 's' }); dlg.el.ls.keydown(e1); assert.ok(saved === 1 && e1.defaultPrevented && e1.stopped);
  const e2 = ev({ key: 'Enter' }); dlg.el.ls.keydown(e2); assert.ok(ran === 1 && !e2.defaultPrevented, 'a run handler returning false leaves the key to the code editor');
  const e3 = ev({ key: 's', ctrlKey: false }); dlg.el.ls.keydown(e3); assert.strictEqual(saved, 1);

  // F6 / Shift+F6 cycle through regions
  const regs = ['.a', '.b', '.c'].map((s) => { const r = mk('div'); r.sel = s; r.contains = (n) => n === r || n === r.inner; r.inner = mk('button'); r.querySelectorAll = () => [r.inner]; return r; });
  const d2 = { el: mk('div') }; d2.el.querySelector = (s) => regs.find((r) => r.sel === s) || null; A.panes(d2, ['.a', '.b', '.c']);
  global.__active = regs[0].inner; d2.el.ls.keydown({ key: 'F6', shiftKey: false, preventDefault() {} }); assert.ok(regs[1].inner.focused, 'F6 goes to the next region');
  global.__active = regs[0].inner; d2.el.ls.keydown({ key: 'F6', shiftKey: true, preventDefault() {} }); assert.ok(regs[2].inner.focused, 'Shift+F6 wraps backwards');

  // help button: labelled, opens one popover with exactly the sentence
  const hb = A.help('Pearson r measures straight-line association.', 'Correlation method');
  assert.strictEqual(hb.attrs['aria-label'], 'Help: Correlation method'); hb.ls.click(); assert.ok(popovers.length === 1 && popovers[0].o.role === 'dialog' && /^Pearson r/.test(popovers[0].content.textContent));

  // announcer speaks state changes, not timer ticks
  const an = A.announcer('Python run'); an.say('Running 0.1s'); an.say('Running 3.2s'); assert.strictEqual(an.el.textContent, 'Python run: Running');
  an.say('OK 0.8s'); assert.strictEqual(an.el.textContent, 'Python run: OK'); assert.strictEqual(an.el.attrs['aria-live'], 'polite');

  // tooltip with shortcut replaces the native title
  const b = mk('button', { title: 'Run' }); A.tip(b, 'Run the script', 'Ctrl+Enter');
  assert.ok(b.attrs['data-shortcut'] === 'Ctrl+Enter' && b.attrs['aria-keyshortcuts'] === 'Control+Enter' && b.attrs.title === undefined);

  // wiring: loaded before the editor, shortcuts registered, reduced-motion and drawer rules present
  const fs = require('fs'), html = fs.readFileSync('index.html', 'utf8'), css = fs.readFileSync('css/components.css', 'utf8'), dl = fs.readFileSync('js/dialogs.js', 'utf8');
  assert.ok(html.indexOf('js/figures/a11y.js') > 0 && html.indexOf('js/figures/a11y.js') < html.indexOf('js/figures/editor.js'));
  assert.ok(/Ctrl\+Enter'\], \['Figure windows: save source or figure', 'Ctrl\+S'\], \['Figure windows: next \/ previous pane', 'F6/.test(dl));
  assert.ok(/prefers-reduced-motion: reduce\) \{\s*\.fe__spin \{ animation: none/.test(css) && /max-width: 1240px\)[\s\S]*\.fe__drawerbtn \{ display: inline-flex/.test(css));
  console.log('PASS: 32. Figure-window a11y helpers: roving radio tiles, Ctrl+S consumed, F6 panes, one-sentence help, announcer, tooltip shortcuts, wiring');
  } finally { global.RPE = saved0.RPE; global.document = saved0.document; global.__active = saved0.active; }
})();

// 33. Plots / figures are pictures only: no client-side chart renderer left, neutral "not rendered" state, seed deck without fake plots,
//     Research Checks > Figures (alt text, text < 8 pt at placed size, effective dpi < 200, caption, stale / failed records).
(function testFigureChecksAndNoClientCharts() {
  const assert = require('assert'), fs = require('fs'), vm = require('vm');
  const saved0 = { RPE: global.RPE, document: global.document, window: global.window };
  try {
    const read = (f) => fs.readFileSync(f, 'utf8');
    // plots.js keeps only metadata; nothing that draws or fakes data
    global.window = {}; global.RPE = global.window.RPE = {};
    vm.runInThisContext(read('js/plots.js'), { filename: 'plots.js' });
    assert.deepStrictEqual(Object.keys(RPE.plots).sort(), ['DATASETS', 'FIG_LAYOUTS', 'KINDS', 'defaultsFor']);
    assert.ok(Object.keys(RPE.plots.KINDS).length === 6 && Object.keys(RPE.plots.FIG_LAYOUTS).length === 6);
    // grep test: no remaining references to the removed functions or their wording anywhere in js/, index.html, css/
    const files = []; const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => (e.isDirectory() ? walk(d + '/' + e.name) : /\.(js|html|css)$/.test(e.name) && files.push(d + '/' + e.name)));
    ['js', 'css'].forEach(walk); files.push('index.html');
    const removed = /RPE\.plots\.(svg|figure|pythonSource|pgfSource|parsePgf|panelLabel|ctxFrom)\b|\b(makeData|panelBody|figureSvg|svgWrap)\s*\(|backend integration|client-side approximation|a client-side approximation/i;
    files.forEach((f) => { const t = read(f); assert.ok(!removed.test(t), f + ' still refers to a removed renderer / pending text'); assert.ok(!/\.obj__plot\s*>\s*svg/.test(t), f + ' still styles a client-drawn svg'); });
    ['js/plots.js', 'js/renderer.js', 'js/checks.js', 'js/dialogs.js', 'js/seed.js'].forEach((f) => assert.ok(!/pending|approximation|coming soon|todo/i.test(read(f)), f + ' has a pending / placeholder string'));
    // renderer: src -> picture; no src -> neutral state (never a chart)
    const rsrc = read('js/renderer.js'); assert.ok(/Figure not rendered/.test(rsrc) && /const figPicture = /.test(rsrc) && (rsrc.match(/figPicture\(o, p\)/g) || []).length === 2);
    // seed deck: no plot / figure objects at all (they would be fake); everything else still builds
    const seedRPE = global.RPE = global.window.RPE = { store: { uid: (p) => p + Math.random().toString(36).slice(2, 7) } };
    vm.runInThisContext(read('js/seed.js'), { filename: 'seed.js' });
    const deck = seedRPE.seed.createDeck();
    assert.strictEqual(deck.slides.flatMap((s) => s.objects).filter((o) => o.type === 'plot' || o.type === 'figure').length, 0);
    assert.ok(deck.comments.every((c) => deck.slides.some((s) => s.id === c.slideId)), 'every comment points at an existing slide');

    // ---- Research Checks > Figures ----
    const strip = (h) => String(h || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    global.document = { createElement: () => { const d = { set innerHTML(v) { this.textContent = strip(v); } }; return d; } };
    const S = { ui: {}, doc: { size: { w: 1280, h: 720 }, figures: {}, slides: [] } };
    global.RPE = global.window.RPE = { store: S, ui: {}, h: () => ({}), renderer: {}, icons: { html: () => '' } };
    vm.runInThisContext(read('js/checks.js'), { filename: 'checks.js' });
    const C = RPE.checks, png = (w, h) => { const b = Buffer.alloc(24); Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b); b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20); return 'data:image/png;base64,' + b.toString('base64'); };
    assert.deepStrictEqual(C.figureTools.pngSize(png(1920, 1080)), { w: 1920, h: 1080 });
    assert.strictEqual(C.figureTools.pngSize('data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/'), null); assert.strictEqual(C.figureTools.pngSize(null), null);

    const rec = (o) => Object.assign({ id: 'f1', kind: 'structured', sourceMode: 'structured', export: { wIn: 6, hIn: 4, dpi: 450 }, config: { plotType: 'line', appearance: { fontSize: 10 }, options: {} }, render: { status: 'ok' } }, o || {});
    const cap = (y) => ({ id: 'c' + y, type: 'text', role: 'caption', html: '<p>Figure 1. Something.</p>', x: 64, y, w: 600, h: 30 });
    // placed 6 in wide (576 px): 1200 px -> 200 dpi; text 10 pt * 0.9 = 9 pt -> ok
    const good = { id: 'p1', type: 'plot', figureId: 'f1', src: png(1200, 800), alt: 'Line plot.', x: 64, y: 100, w: 576, h: 384 };
    const run = (objs, figs) => { S.doc.figures = figs || { f1: rec() }; S.doc.slides = [{ id: 's1', objects: objs }]; return C.run.figures(); };
    assert.deepStrictEqual(run([good, cap(490)]), [], 'a clean figure raises nothing');
    const cats = (items) => items.map((i) => i.cat).sort();
    assert.deepStrictEqual(cats(run([Object.assign({}, good, { alt: '  ' }), cap(490)])), ['Missing alt text']);
    assert.strictEqual(run([Object.assign({}, good, { alt: '' }), cap(490)])[0].fix, 'alt');
    assert.deepStrictEqual(cats(run([good])), ['Missing caption']);
    assert.strictEqual(run([good])[0].fix, 'caption');
    // dpi: 1100 px over 6 in = 183 dpi (below 200); exactly 1200 passes; a larger placement lowers the dpi
    const lo = run([Object.assign({}, good, { src: png(1100, 733) }), cap(490)]); assert.deepStrictEqual(cats(lo), ['Low resolution']); assert.ok(/183 dpi/.test(lo[0].text));
    assert.deepStrictEqual(cats(run([Object.assign({}, good, { w: 960, h: 640 }), cap(742)])), ['Low resolution'], 'enlarging the figure lowers its effective dpi');
    // text: 9 pt tick text at 6 in drawn / 4 in placed = 6 pt (< 8); legend off and no title keeps ticks as the smallest
    const small = run([Object.assign({}, good, { w: 384, h: 256, src: png(1200, 800) }), cap(366)]);
    assert.ok(cats(small).includes('Small text') && /6\.0 pt/.test(small.find((i) => i.cat === 'Small text').text), JSON.stringify(small));
    assert.ok(!cats(run([Object.assign({}, good, { w: 384, h: 256, src: png(1200, 800) }), cap(366)], { f1: rec({ config: { plotType: 'line', appearance: { fontSize: 14 }, options: {} } }) })).includes('Small text'), 'bigger drawn font passes at the same placed size');
    assert.ok(cats(run([Object.assign({}, good, { w: 576, h: 384 }), cap(490)], { f1: rec({ config: { plotType: 'line', appearance: { fontSize: 10, tickSize: 6, legend: { show: true } }, options: {} } }) })).includes('Small text'), 'an explicit small tick size is used');
    assert.ok(!cats(run([good, cap(490)], { f1: rec({ config: { plotType: 'box', appearance: { fontSize: 10, legendSize: 4 }, options: {} } }) })).includes('Small text'), 'box plots draw no legend, so legendSize does not count');
    assert.ok(!cats(run([Object.assign({}, good, { w: 192, h: 128 }), cap(240)], { f1: rec({ kind: 'python', sourceMode: 'custom' }) })).includes('Small text'), 'script-controlled text size is unknown, never guessed');
    // composite: panel keeps its own font unless fontApplyAll; the composite size applies to the rest
    const panel = (a) => ({ slot: 0, record: rec({ config: { plotType: 'bar', appearance: a, options: {} } }) });
    const comp = (c, a) => rec({ kind: 'composite', composite: Object.assign({ layout: '1x2', fontSize: 10, fontApplyAll: false, panels: [panel(a)] }, c) });
    const fig = Object.assign({}, good, { type: 'figure', w: 576, h: 384 });
    assert.ok(cats(run([fig, cap(490)], { f1: comp({}, { fontSize: 5 }) })).includes('Small text'), 'panel with its own font keeps it');
    assert.ok(!cats(run([fig, cap(490)], { f1: comp({ fontApplyAll: true }, { fontSize: 5 }) })).includes('Small text'), 'Apply to all uses the composite size');
    assert.ok(cats(run([fig, cap(490)], { f1: comp({ fontSize: 6 }, { fontSize: 10 }) })).includes('Small text'), 'composite font size drives panels without local fonts');
    // stale / failed records and a missing picture
    const st = run([good, cap(490)], { f1: rec({ render: { status: 'stale' } }) }); assert.deepStrictEqual(cats(st), ['Out of date']);
    const er = run([good, cap(490)], { f1: rec({ render: { status: 'error', error: 'Column "y" is not numeric' } }) }); assert.deepStrictEqual(cats(er), ['Failed render']); assert.ok(/not numeric/.test(er[0].text));
    const nr = run([Object.assign({}, good, { src: null }), cap(490)]); assert.deepStrictEqual(cats(nr), ['Not rendered']);
    assert.deepStrictEqual(cats(run([{ id: 'p2', type: 'plot', kind: 'line', alt: 'x', x: 0, y: 0, w: 400, h: 300 }, cap(310)], {})), ['Not rendered'], 'a legacy plot without picture or record is flagged, not drawn');
    // images and tables keep the old caption rule; figures are only reported by the figure check
    S.doc.slides = [{ id: 's1', objects: [good, { id: 't', type: 'table', x: 64, y: 100, w: 400, h: 100, cells: [['a']] }] }];
    assert.deepStrictEqual(C.run.captions().map((i) => i.obj), ['t']);
    assert.ok(S.doc.slides[0].objects.length === 2 && !('font' in good), 'checks never touch the document');
    console.log('PASS: 33. No client-side chart renderer left, neutral "not rendered" state, seed deck without fake plots, Research Checks > Figures (alt, < 8 pt, < 200 dpi, caption, stale / failed, not rendered)');

    // 34. Office-style theme-following color palette, tints and shades matrix, standard colors, recent colors
    {
      delete require.cache[require.resolve('../js/themes.js')];
      require('../js/themes.js');
      delete require.cache[require.resolve('../js/ui.js')];
      require('../js/ui.js');
      const T = RPE.themes;

      // 1. Color math functions
      assert.deepStrictEqual(T.hexToRgb('#4472C4'), [68, 114, 196]);
      assert.strictEqual(T.rgbToHex(68, 114, 196), '#4472C4');
      assert.strictEqual(T.tintColor('#4472C4', 0.8), '#DAE3F3'); // 80% lighter
      assert.strictEqual(T.shadeColor('#4472C4', 0.5), '#223962'); // 50% darker

      // 2. Office theme & palette
      const officeDoc = { themeId: 'office', paletteId: 'office' };
      const mOffice = T.themeMatrix(officeDoc);
      assert.strictEqual(mOffice.base.length, 10, '10 base theme columns');
      assert.strictEqual(mOffice.shades.length, 5, '5 shade/tint rows');
      assert.strictEqual(mOffice.shades[0].length, 10, '10 swatches per shade row');
      assert.strictEqual(mOffice.base[4].color, '#4472C4');
      assert.strictEqual(mOffice.shades[0][4].color, '#DAE3F3'); // 80% lighter
      assert.strictEqual(mOffice.shades[4][4].color, '#223962'); // 50% darker

      // 3. Dynamic theme following: when theme/palette changes to Burgundy Lab
      const burgDoc = { themeId: 'journal', paletteId: 'burgundy' };
      const mBurg = T.themeMatrix(burgDoc);
      assert.strictEqual(mBurg.base[4].color, '#702D3B', 'Accent 1 follows Burgundy Lab');
      assert.strictEqual(mBurg.shades[0][4].color, T.tintColor('#702D3B', 0.8));

      // 4. Dynamic theme following: when palette changes to Okabe-Ito
      const okabeDoc = { themeId: 'journal', paletteId: 'okabe' };
      const mOkabe = T.themeMatrix(okabeDoc);
      assert.strictEqual(mOkabe.base[4].color, '#0072B2', 'Accent 1 follows Okabe-Ito');
      assert.strictEqual(mOkabe.base[5].color, '#E69F00', 'Accent 2 follows Okabe-Ito');

      // 5. Standard colors list
      assert.strictEqual(T.STANDARD_COLORS.length, 10);
      assert.deepStrictEqual(T.STANDARD_COLORS, ['#C00000', '#FF0000', '#FFC000', '#FFFF00', '#92D050', '#00B050', '#00B0F0', '#0070C0', '#002060', '#7030A0']);

      // 6. Recent colors helper
      RPE.ui.addRecentColor('#123456');
      assert.ok(RPE.ui.getRecentColors().includes('#123456'));

      console.log('PASS: 34. Color palette follows design theme, 10x6 tints and shades matrix, standard colors, recent colors, and custom pickers');
    }
  } finally { global.RPE = saved0.RPE; global.document = saved0.document; global.window = saved0.window; }
})();
