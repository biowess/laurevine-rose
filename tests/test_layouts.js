/**
 * tests/test_layouts.js — shared layout library (catalog, picker model, apply-to-slide). Run: node tests/test_layouts.js
 * No DOM needed: the picker's view model / thumbnails / onSelect are DOM-free by design.
 */
const assert = require('assert');
global.window = global; global.RPE = {};
require('../js/themes.js');
RPE.store = { uid: (p) => p + '_' + Math.random().toString(36).slice(2, 9) };
require('../js/layouts.js');
require('../js/layoutpicker.js');
const L = RPE.layouts, P = RPE.layoutPicker;
const SIZES = [{ w: 1280, h: 720 }, { w: 1152, h: 720 }, { w: 960, h: 720 }, { w: 1018, h: 720 }];
const plain = (h) => String(h || '').replace(/<[^>]*>/g, '').trim();
const clone = (x) => JSON.parse(JSON.stringify(x));
let n = 0; const test = (name, fn) => { fn(); n++; console.log('ok -', name); };

test('exactly 26 unique layout ids, 12 flagged primary, ranks 1..26', () => {
  const all = L.list();
  assert.strictEqual(all.length, 26); assert.strictEqual(new Set(all.map((l) => l.id)).size, 26);
  assert.strictEqual(L.primary().length, 12); assert.strictEqual(L.more().length, 14);
  assert.deepStrictEqual(all.map((l) => l.rank), Array.from({ length: 26 }, (_, i) => i + 1));
  ['blank', 'title', 'section', 'titleContent', 'twoContent', 'titleFigure'].forEach((id) => assert.ok(L.primary().some((l) => l.id === id), id + ' must be primary'));
});

test('every generator yields editable, in-bounds, empty, font-free objects (all slide sizes, light + dark theme)', () => {
  SIZES.forEach((size) => ['journal', 'midnight'].forEach((themeId) => L.list().forEach((l) => {
    const doc = { size, themeId }, objs = L.build(l.id, doc);
    assert.ok(L.inBounds(objs, size), `${l.id} out of bounds at ${size.w}`);
    assert.strictEqual(new Set(objs.map((o) => o.id)).size, objs.length);
    objs.forEach((o) => {
      assert.ok(['text', 'shape', 'image', 'table'].includes(o.type));
      assert.ok(!o.font, `${l.id}: font must follow the deck typography`);
      if (o.type === 'text' && o.slot !== 'deco') assert.strictEqual(plain(o.html), '', `${l.id}: placeholder must be empty`);
      if (o.type === 'image') assert.strictEqual(o.src, null);
    });
    if (l.id === 'blank') assert.strictEqual(objs.length, 0);
  })));
});

test('colours are theme tokens (or hex derived from the current theme), never template-baked', () => {
  const tokens = new Set(['accent', 'accent2', 'text', 'title', 'muted', 'bg', 'surface', 'border', 'card', 'onAccent', 'transparent']);
  L.list().forEach((l) => L.build(l.id, { size: SIZES[0], themeId: 'slate' }).forEach((o) => ['fill', 'stroke', 'color'].forEach((k) => {
    if (o[k] && !tokens.has(o[k])) assert.ok(/^#[0-9A-F]{6}$/i.test(o[k]), `${l.id}.${k}=${o[k]}`);
  })));
});

test('building / applying never mutates the deck theme, typography or palette', () => {
  const doc = { size: SIZES[0], themeId: 'slate', typeId: 'journal', paletteId: 'okabe', templateId: 'clinical-blue', slides: [] };
  const before = clone(doc);
  L.list().forEach((l) => { L.build(l.id, doc); L.newSlide(l.id, doc); L.apply({ id: 's', layout: 'titleContent', objects: [] }, l.id, doc); });
  assert.deepStrictEqual(doc, before);
});

test('title-figure is stored as layout "title" (numbering / footer rules); others store their own id', () => {
  assert.strictEqual(L.newSlide('coverFigure', {}).layout, 'title');
  L.list().filter((l) => l.id !== 'coverFigure').forEach((l) => assert.strictEqual(L.newSlide(l.id, {}).layout, l.id));
});

test('new slide per layout id: fresh id, empty notes, objects match build()', () => {
  L.list().forEach((l) => { const s = L.newSlide(l.id, { size: SIZES[0] }); assert.ok(s.id && s.notes === '' && Array.isArray(s.objects)); assert.strictEqual(s.objects.length, L.build(l.id, { size: SIZES[0] }).length); });
});

test('apply to an existing slide keeps ALL user content (moved into matching placeholders, rest kept in place)', () => {
  const doc = { size: SIZES[0], themeId: 'journal' };
  L.list().forEach((target) => {
    const s = { id: 's1', layout: 'titleContent', objects: L.build('titleContent', doc) };
    s.objects.find((o) => o.slot === 'title').html = '<p>Title text</p>';
    s.objects.find((o) => o.slot === 'body').html = '<p>First point</p><p>Second point</p>';
    s.objects.push({ id: 'img1', type: 'image', x: 10, y: 10, w: 400, h: 200, src: 'data:image/png;base64,AAAA', aspect: 2 });
    s.objects.push({ id: 'tb1', type: 'table', x: 10, y: 300, w: 300, h: 100, cells: [['a', 'b'], ['c', 'd']] });
    s.objects.push({ id: 'free', type: 'shape', shape: 'ellipse', x: 5, y: 5, w: 20, h: 20, fill: '#FF0000', stroke: 'transparent', html: '' });
    const res = L.apply(s, target.id, doc);
    ['img1', 'tb1', 'free'].forEach((id) => assert.ok(s.objects.some((o) => o.id === id), `${target.id}: lost ${id}`));
    const text = s.objects.map((o) => plain(o.html)).join('|');
    assert.ok(/Title text/.test(text) && /First point/.test(text) && /Second point/.test(text), `${target.id}: lost text`);
    assert.strictEqual(s.layout, target.layout); assert.ok(res.kept >= 1);
    assert.ok(L.inBounds(s.objects.filter((o) => o.id === 'img1'), doc.size));
  });
});

test('re-applying layouts leaves no stale placeholders or decoration; applying blank keeps content', () => {
  const doc = { size: SIZES[0] };
  const s = { id: 's', layout: 'blank', objects: [] };
  L.apply(s, 'threePart', doc); L.apply(s, 'agenda', doc); L.apply(s, 'blank', doc);
  assert.strictEqual(s.objects.length, 0);
  s.objects.push({ id: 'u', type: 'text', role: 'body', x: 1, y: 1, w: 50, h: 20, html: '<p>keep me</p>' });
  L.apply(s, 'blank', doc); assert.strictEqual(s.objects.length, 1);
});

test('picker model: 12 primary + 14 more, thumbnails for empty, populated and undefined decks, onSelect fires with the id', () => {
  const populated = { size: SIZES[0], themeId: 'midnight', slides: [{ id: 's', layout: 'title', objects: L.build('title', { size: SIZES[0] }) }] };
  [{ size: SIZES[0], slides: [] }, populated, undefined, {}].forEach((doc) => {
    const m = P.model(doc, 'twoContent');
    assert.strictEqual(m.primary.length, 12); assert.strictEqual(m.more.length, 14);
    m.primary.concat(m.more).forEach((x) => assert.ok(/^<svg/.test(x.svg) && x.name));
    assert.strictEqual(m.primary.concat(m.more).filter((x) => x.selected).map((x) => x.id)[0], 'twoContent');
  });
  const got = []; const picker = P.create({ doc: populated, onSelect: (id) => got.push(id) });
  picker.select('timeline'); picker.select('nope'); picker.select('blank');
  assert.deepStrictEqual(got, ['timeline', 'blank']);
});

console.log(`\n${n} layout tests passed`);
