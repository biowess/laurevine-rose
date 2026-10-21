/* Symbol catalog (task 21): integrity + search. Run: node tests/test_symbols.js */
const assert = require('assert');
global.window = global; global.RPE = {};
require(__dirname + '/../js/symbols.js');
const S = RPE.symbols;

// integrity: nothing reported by validate(), plus independent checks
assert.deepStrictEqual(S.validate(), []);
assert.deepStrictEqual(S.CATEGORIES.map((c) => c.id), ['greek', 'operators', 'relations', 'calculus', 'sets', 'arrows', 'scripts', 'units', 'typography']);
S.CATEGORIES.forEach((cat) => {
  const seen = new Set();
  assert.ok(cat.symbols.length >= 20, cat.id + ' too small');
  cat.symbols.forEach((s) => {
    assert.strictEqual(Array.from(s.c).length, 1, cat.id + ' one code point: ' + JSON.stringify(s.c));
    const cp = s.c.codePointAt(0); assert.ok(cp >= 0x20 && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) && !(cp >= 0xE000 && cp <= 0xF8FF), 'valid cp ' + cp.toString(16));
    assert.ok(s.n && s.n.trim(), 'name for ' + s.c);
    assert.ok(!seen.has(s.c), cat.id + ' duplicate ' + s.c); seen.add(s.c);
  });
});
// the validator really catches problems
const probe = { id: 'x', label: 'x', icon: 'x', symbols: [{ c: 'a', n: 'a', k: '' }, { c: 'a', n: 'again', k: '' }, { c: 'b', n: '', k: '' }, { c: '\uD800', n: 'lone', k: '' }] };
S.CATEGORIES.push(probe); const bad = S.validate().join('\n'); S.CATEGORIES.pop();
assert.ok(/duplicate/.test(bad) && /no name/.test(bad) && /code point/.test(bad), bad);

// search: substring on name / keywords / char, case-insensitive, ranked, scoped by category
const names = (q, c) => S.search(q, c).map((s) => s.n);
assert.ok(names('alpha').includes('alpha') && names('ALPHA').includes('alpha'));
assert.deepStrictEqual(S.search('∞').map((s) => s.n), ['infinity']);                      // by character, exact hit first
assert.ok(S.search('integral', 'calculus').every((s) => s.cat === 'calculus') && S.search('integral', 'calculus').length >= 5);
assert.ok(S.search('equilibrium').some((s) => s.c === '⇌'));                                // by keyword
assert.ok(S.search('u+03b1').some((s) => s.c === 'α'));                                     // by code point
assert.strictEqual(S.search('zzzzqq').length, 0);
assert.strictEqual(S.search('', 'greek').length, S.get('greek').symbols.length);            // empty query = whole category
assert.strictEqual(S.search('  ').length, S.all().length);                                  // blank = everything
assert.strictEqual(S.search('arrow', 'arrows')[0].n.includes('arrow'), true);
const hits = S.search('sum'); assert.strictEqual(new Set(hits.map((s) => s.c)).size, hits.length, 'cross-category duplicates collapse');
assert.ok(S.search('s', 'greek').length > 0 && S.search('no-break')[0].c === '\u00A0');
console.log('symbols: ok');
