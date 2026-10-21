/* Typography presets (tasks 14-15): registry, apply-by-role, persistence. Run: node tests/test_typography.js */
const assert = require('assert');
global.window = global; global.RPE = { store: { uid: (p) => p + Math.random().toString(36).slice(2, 8) } };
const d = __dirname + '/../js/';
require(d + 'themes.js'); require(d + 'templates/builder.js');
['clinical-blue', 'editorial-review', 'field-biology', 'molecular-translational', 'hematology-oncology', 'data-methods', 'population-health', 'computational-biology', 'dark-auditorium', 'swiss-minimal'].forEach((i) => require(d + 'templates/' + i + '.js'));
require(d + 'templates/index.js'); require(d + 'typography.js');
const R = RPE.typography, T = RPE.themes;
const strip = (doc) => JSON.stringify(doc.slides.map((s) => s.objects.map((o) => { const c = Object.assign({}, o); delete c.font; delete c.bold; delete c.italic; return c; })));

// registry: 4 legacy + 10 template-linked, every role resolves to a bundled font (legacy Georgia/Courier New are the known exceptions)
assert.strictEqual(R.listLegacy().length, 4);
assert.strictEqual(R.listTemplates().length, 10);
R.listTemplates().forEach((p) => {
  assert.ok(RPE.templates.get(p.templateId), p.id);
  R.ROLES.forEach((r) => assert.ok(p.roles[r].font, p.id + ':' + r));
  assert.deepStrictEqual(R.missingFonts(p), [], p.id);
});
assert.deepStrictEqual(R.listLegacy().map((p) => p.id), T.TYPES.map((t) => t.id));

// apply: typography only, by role; runs untouched; undo-able (pure data change)
const doc = RPE.templates.generateDeck('population-health');
doc.slides[1].objects.push({ id: 'x1', type: 'text', role: 'body', x: 1, y: 2, w: 3, h: 4, fontSize: 17, font: 'Georgia', bold: true, html: '<p>a <b>b</b> <span style="font-family:Inter">c</span> <i>d</i></p>' });
doc.slides[1].objects.push({ id: 'x2', type: 'text', role: 'text', x: 1, y: 2, w: 3, h: 4, font: 'Papyrus', html: '<p>keep</p>' });
const before = strip(doc);
assert.strictEqual(R.forDoc(doc).id, 'population-health');
assert.ok(R.apply(doc, 'editorial-review'));
assert.strictEqual(strip(doc), before);                       // nothing but font/bold/italic may change
const find = (id) => doc.slides[1].objects.find((o) => o.id === id);
assert.strictEqual(find('x1').font, null);                    // known role follows the preset
assert.ok(find('x1').html.includes('font-family:Inter'));     // character-level run kept
assert.strictEqual(find('x2').font, 'Papyrus');               // foreign explicit font = intentional
assert.strictEqual(R.roleStyle(R.forDoc(doc), { role: 'kicker' }).font, 'Source Sans 3');
assert.strictEqual(R.roleStyle(R.forDoc(doc), { role: 'subtitle' }).italic, true);

// empty deck + persistence/fallback
const empty = { slides: [{ id: 's', objects: [] }], typeId: 'outfit' };
assert.ok(R.apply(empty, 'swiss-minimal'));
const round = JSON.parse(JSON.stringify(empty));
assert.strictEqual(R.forDoc(round).roles.title.font, 'Spline Sans');
assert.strictEqual(R.forDoc({ typeId: 'journal' }).id, 'journal');   // old doc, no field
assert.strictEqual(R.forDoc({}).id, 'outfit');
assert.strictEqual(R.normalize({ typography: { roles: {} } }).typography, undefined);   // invalid is dropped, never created
assert.strictEqual(R.normalize({}).typography, undefined);
console.log('typography OK');
