/* Colour palettes (tasks 16-17): registry, persistence, apply-by-role, contrast. Run: node tests/test_palettes.js */
const assert = require('assert');
global.window = global; global.RPE = { store: { uid: (p) => p + Math.random().toString(36).slice(2, 8) } };
const d = __dirname + '/../js/';
require(d + 'themes.js'); require(d + 'templates/builder.js');
['clinical-blue', 'editorial-review', 'field-biology', 'molecular-translational', 'hematology-oncology', 'data-methods', 'population-health', 'computational-biology', 'dark-auditorium', 'swiss-minimal'].forEach((i) => require(d + 'templates/' + i + '.js'));
require(d + 'templates/index.js'); require(d + 'typography.js'); require(d + 'palettes.js');
const P = RPE.palettes, T = RPE.themes, C = P.contrast;

// registry: 5 legacy kept + 10 template-linked, each fully populated per role, template colours reused verbatim
assert.deepStrictEqual(P.listLegacy().map((p) => p.id), T.PALETTES.map((p) => p.id));
assert.strictEqual(P.listTemplates().length, 10);
P.listTemplates().forEach((p) => {
  const tpl = RPE.templates.get(p.templateId);
  assert.ok(tpl && p.id === tpl.id && p.name === tpl.name, p.id);
  assert.deepStrictEqual(P.missingRoles(p), [], p.id);
  ['bg', 'text', 'accent', 'accent2', 'surface', 'border', 'muted'].forEach((k) => assert.strictEqual(p.roles[k], tpl.colors[k].toUpperCase(), p.id + ':' + k));
  assert.strictEqual(p.chart.length, 6); assert.strictEqual(p.table.headerFill, p.roles.accent);
});

// contrast floors on the role pairs (failures are REPORTED by message, template colours are never altered)
const fails = [];
P.listTemplates().forEach((p) => {
  const r = p.roles, chk = (n, a, b, min) => { const c = C(a, b); if (c < min) fails.push(`${p.id}: ${n} ${c.toFixed(2)} < ${min}`); };
  chk('text/bg', r.text, r.bg, 4.5); chk('title/bg', r.title, r.bg, 4.5); chk('text/card', r.text, r.card, 4.5); chk('text/surface', r.text, r.surface, 4.5);
  chk('muted/bg', r.muted, r.bg, 4.5); chk('onAccent/accent', r.onAccent, r.accent, 4.5);
  chk('accent/bg', r.accent, r.bg, 3); chk('accent2/bg', r.accent2, r.bg, 3);
});
assert.deepStrictEqual(fails, [], fails.join('\n'));

// persistence: round trip, fallback for old docs, invalid dropped (never created)
const doc = RPE.templates.generateDeck('editorial-review');
const round = JSON.parse(JSON.stringify(doc));
assert.deepStrictEqual(P.normalize(round).palette, doc.palette);
assert.strictEqual(P.forDoc({ paletteId: 'burgundy', themeId: 'journal' }).id, 'burgundy');   // old doc, no field
assert.strictEqual(P.forDoc({ paletteId: 'data-methods' }).id, 'data-methods');
assert.strictEqual(T.theme({ themeId: 'journal', paletteId: 'burgundy' }).accent, '#702D3B');   // old doc: theme colours untouched
assert.strictEqual(P.normalize({ palette: { roles: {} } }).palette, undefined);
assert.strictEqual(P.normalize({}).palette, undefined);

// apply: Editorial Review typography/layouts + Data Methods palette -> everything except colour properties is byte-identical
const strip = (x) => JSON.stringify(x.slides.map((s) => ({ id: s.id, layout: s.layout, notes: s.notes, objects: s.objects.map((o) => {
  const c = Object.assign({}, o); ['fill', 'stroke', 'color', 'tableBorder'].forEach((k) => delete c[k]);
  if (c.html) c.html = c.html.replace(/(color\s*[:=]\s*["']?)(#[0-9a-fA-F]{3,6}|rgb\([^)]*\))/gi, '$1X');
  if (c.cellFmt) c.cellFmt = Object.keys(c.cellFmt).map((k) => { const f = Object.assign({}, c.cellFmt[k]); delete f.fill; delete f.color; return [k, f]; });
  return c; }) })));
const before = strip(doc), typo = JSON.stringify(doc.typography), fontsBefore = JSON.stringify(doc.slides.map((s) => s.objects.map((o) => [o.font, o.fontSize, o.x, o.y, o.w, o.h])));
assert.ok(P.apply(doc, 'data-methods'));
assert.strictEqual(strip(doc), before);                                                   // fonts, sizes, geometry, content, order unchanged
assert.strictEqual(JSON.stringify(doc.slides.map((s) => s.objects.map((o) => [o.font, o.fontSize, o.x, o.y, o.w, o.h]))), fontsBefore);
assert.strictEqual(JSON.stringify(doc.typography), typo);
assert.strictEqual(doc.palette.id, 'data-methods'); assert.strictEqual(doc.paletteId, 'data-methods');
assert.strictEqual(T.theme(doc).accent, '#174C8C');
const ed = P.get('editorial-review').roles, dm = P.get('data-methods').roles;
const blob = JSON.stringify(doc.slides).toUpperCase();
[ed.accent, ed.accent2, ed.surface, ed.border, ed.text, ed.muted].forEach((c) => assert.ok(!blob.includes(c), 'old role colour left: ' + c));
assert.ok(blob.includes(dm.accent) && blob.includes(dm.surface));

// role-based, not RGB-blind: white text on an accent fill stays readable on a dark palette; a custom colour is left alone; a role is mapped by property
const t = { id: 'd', themeId: 'journal', paletteId: 'data-methods', templateId: 'data-methods', slides: [{ id: 's', objects: [
  { id: 'a', type: 'shape', shape: 'rect', x: 0, y: 0, w: 400, h: 100, fill: dm.accent, stroke: dm.border, color: '#FFFFFF', fontSize: 16, html: '<p>x</p>' },
  { id: 'b', type: 'text', role: 'body', x: 10, y: 120, w: 100, h: 20, fontSize: 16, color: '#FF00AA', html: '<p><span style="color:' + dm.text + '">y</span></p>' }] }] };
P.apply(t, 'dark-auditorium');
const da = P.get('dark-auditorium').roles, [a, b] = t.slides[0].objects;
assert.strictEqual(a.fill, da.accent); assert.strictEqual(a.stroke, da.border);
assert.ok(C(a.color, a.fill) >= 4.5);                                                      // on-accent role, not a copied white
assert.strictEqual(b.color, '#FF00AA');                                                    // user colour with no role: unchanged
assert.ok(b.html.includes(da.text));                                                       // inline run colour mapped by role

// empty deck: palette set for future content; legacy palette swaps accents only; one-step apply is pure data (undo = snapshot restore)
const empty = { slides: [{ id: 's', objects: [] }], themeId: 'journal', paletteId: 'burgundy' };
assert.ok(P.apply(empty, 'swiss-minimal')); assert.strictEqual(T.theme(empty).accent, '#B33D2E'); assert.strictEqual(T.theme(empty).bg, '#FFFFFF');
assert.ok(P.apply(empty, 'okabe')); assert.strictEqual(empty.palette.roles.accent, '#0072B2'); assert.strictEqual(empty.palette.roles.bg, '#FFFFFF');
assert.strictEqual(P.apply(empty, 'nope'), false);
console.log('palettes OK');
