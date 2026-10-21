/** tests/test_checks_core.js — accessibility contrast/findings + overflow geometry (DOM-free). Run: node tests/test_checks_core.js */
const assert = require('assert'), fs = require('fs');
global.window = global; const C = require('../js/checks_core.js');
const size = { w: 1280, h: 720 }, th = { bg: '#FFFFFF', text: '#111111', title: '#000000', muted: '#666666' };
const ctx = { col: (c) => (c || null), th, nameOf: (o) => o.id };
let n = 0; const test = (name, fn) => { fn(); n++; console.log('ok -', name); };
const T = (id, o) => Object.assign({ id, type: 'text', x: 100, y: 100, w: 400, h: 80, html: '<p>Hello</p>', fontSize: 18 }, o);

test('WCAG ratio + large-text thresholds', () => {
  assert.ok(Math.abs(C.ratio([0, 0, 0], [255, 255, 255]) - 21) < 1e-9);
  assert.ok(Math.abs(C.ratio([119, 119, 119], [255, 255, 255]) - 4.48) < 0.02);
  assert.strictEqual(C.needed(18, false), 3); assert.strictEqual(C.needed(14, true), 3); assert.strictEqual(C.needed(14, false), 4.5); assert.strictEqual(C.needed(12, true), 4.5);
  assert.deepStrictEqual(C.parseColor('#fff'), [255, 255, 255, 1]); assert.strictEqual(C.parseColor('rgba(0,0,0,0.5)')[3], 0.5);
});
test('contrast uses the real backdrop: shape fill, stacking, transparency, slide bg', () => {
  const f = (objs, bg) => C.accessibilityFindings({ size, slides: [{ id: 's', bg, objects: [T('title', { role: 'title', color: bg === '#000000' ? '#FFFFFF' : '#111111' })].concat(objs) }] }, ctx).filter((x) => x.cat === 'Low contrast' && x.obj !== 'title');
  assert.strictEqual(f([T('ok', { color: '#111111' })]).length, 0);
  assert.strictEqual(f([T('bad', { color: '#FFFFFF' })]).length, 1);                                               // white on white slide bg
  assert.strictEqual(f([{ id: 'card', type: 'shape', shape: 'rect', x: 50, y: 50, w: 600, h: 300, fill: '#003366' }, T('onCard', { color: '#FFFFFF' })]).length, 0);   // white on dark card = ok
  assert.strictEqual(f([{ id: 'card', type: 'shape', shape: 'rect', x: 50, y: 50, w: 600, h: 300, fill: '#003366' }, T('dark', { color: '#222222' })]).length, 1);   // dark on dark card
  assert.strictEqual(f([T('own', { fill: '#FFFF00', color: '#FFFFFF' })]).length, 1);                              // own fill wins over slide bg
  assert.strictEqual(f([T('clear', { fill: 'transparent', color: '#FFFFFF' })], '#000000').length, 0);            // transparent fill -> dark slide bg
  assert.strictEqual(f([T('big', { color: '#888888', fontSize: 24 })]).length, 0);                                // 3.5:1 passes as large text
  assert.strictEqual(f([T('small', { color: '#888888', fontSize: 12 })]).length, 1);
  assert.strictEqual(f([T('run', { html: '<p>a <span style="color:#FFFFFF">b</span></p>', color: '#111111' })]).length, 1);   // inline run colour
});
test('findings on crafted deck: names slide/object, missing title/alt, reading order, never "fully accessible"', () => {
  const doc = { size, slides: [
    { id: 'good', objects: [T('title', { role: 'title' }), { id: 'img', type: 'image', src: 'x', alt: 'A cell', x: 0, y: 200, w: 100, h: 100 }] },
    { id: 'bad', objects: [{ id: 'img2', type: 'image', src: 'x', x: 0, y: 0, w: 100, h: 100 }, T('title', { role: 'title' }), T('empty', { role: 'title', html: '' })] },
    { id: 'notitle', objects: [T('body', { role: 'body' })] }] };
  const r = C.accessibilityFindings(doc, ctx), by = (c) => r.filter((x) => x.cat === c);
  assert.strictEqual(r.filter((x) => x.slide === 0).length, 0);
  assert.ok(by('Missing alt text').some((x) => x.slide === 1 && x.obj === 'img2')); assert.ok(by('Reading order').some((x) => x.slide === 1));
  assert.ok(by('Missing title').some((x) => x.slide === 2));
  const src = fs.readFileSync(__dirname + '/../js/checks.js', 'utf8');
  assert.ok(/Checks performed/.test(src) && /Not checked/.test(src)); assert.ok(!/fully accessible|Good to go/i.test(src.replace(/not make a deck accessible/g, '')));
});
test('overflow: rotated shape, partly off-slide image, bleed, tolerance, clean deck', () => {
  const run = (objs, measure) => C.overflowFindings({ size, slides: [{ id: 's', objects: objs }] }, measure, ctx);
  assert.strictEqual(run([{ id: 'r', type: 'shape', shape: 'rect', x: 1100, y: 300, w: 300, h: 40, rotation: 0 }]).length, 1);   // plain off right
  assert.strictEqual(run([{ id: 'r', type: 'shape', shape: 'rect', x: 500, y: 350, w: 700, h: 20, rotation: 90 }]).length, 0);  // rotated 90: stays inside (cy +-350)
  assert.strictEqual(run([{ id: 'r', type: 'shape', shape: 'rect', x: 400, y: 340, w: 800, h: 40, rotation: 90, html: '<p>x</p>' }]).length, 1);  // rotated 90: 800 tall -> off top & bottom
  assert.strictEqual(run([{ id: 'p', type: 'image', x: 1200, y: 100, w: 200, h: 200 }]).length, 1);
  assert.strictEqual(run([{ id: 'bg', type: 'shape', shape: 'rect', x: -10, y: -10, w: 1300, h: 740, fill: '#000' }]).length, 0);   // bleed background
  assert.strictEqual(run([{ id: 'edge', type: 'shape', shape: 'rect', x: 0, y: 0, w: 1281, h: 100 }]).length, 0);              // sub-pixel / full-width
  assert.strictEqual(run([T('a', { x: 0, y: 0, w: 1280.5, h: 100 })]).length, 0);
  const t = run([T('tx')], () => [{ id: 'tx', over: 40 }, { id: 'tx', over: 2 }]); assert.strictEqual(t.length, 1); assert.strictEqual(t[0].cat, 'Text overflow');
  assert.strictEqual(run([T('c1'), { id: 'c2', type: 'shape', shape: 'rect', x: 600, y: 200, w: 300, h: 200, stroke: '#000', strokeWidth: 4 }], () => []).length, 0);
});
console.log(n + ' passed');
