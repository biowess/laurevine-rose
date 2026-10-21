/** tests/test_backstage_meta.js — no Backstage page renders a null/undefined description. Run: node tests/test_backstage_meta.js */
const assert = require('assert'), fs = require('fs'); global.window = global;
const M = require('../js/backstage_meta.js');
['new', 'open', 'save', 'export', 'prefs', 'about', 'bogus', undefined, null].forEach((id) => { const p = M.page(id); assert.ok(p.title && p.desc, 'page ' + id); assert.ok(!/\b(null|undefined)\b/i.test(p.title + ' ' + p.desc)); });
assert.ok(/preferences/i.test(M.page('prefs').desc)); assert.ok(M.page('about').desc.includes(M.VERSION));
assert.strictEqual(M.clean(null), ''); assert.strictEqual(M.clean('null'), ''); assert.strictEqual(M.clean(undefined), ''); assert.strictEqual(M.clean(' hi '), 'hi');
const py = fs.readFileSync(__dirname + '/../pyproject.toml', 'utf8'); assert.ok(py.includes(`version = "${M.VERSION}"`), 'version in sync with pyproject');
assert.ok(!/head\('Preferences'\)/.test(fs.readFileSync(__dirname + '/../js/app.js', 'utf8')), 'head() must take its text from RPE.backstageMeta');
console.log('backstage meta ok');
