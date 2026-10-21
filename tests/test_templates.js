/**
 * tests/test_templates.js
 * Verification of all 10 academic template packs (260 slides).
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Mock browser globals
global.window = global;
global.RPE = {};

// Load dependencies
require('../js/themes.js');
require('../js/templates/builder.js');
require('../js/templates/clinical-blue.js');
require('../js/templates/editorial-review.js');
require('../js/templates/field-biology.js');
require('../js/templates/molecular-translational.js');
require('../js/templates/hematology-oncology.js');
require('../js/templates/data-methods.js');
require('../js/templates/population-health.js');
require('../js/templates/computational-biology.js');
require('../js/templates/dark-auditorium.js');
require('../js/templates/swiss-minimal.js');
require('../js/templates/index.js');

const T = RPE.templates;

console.log('Testing Academic Templates catalog...');

const EXPECTED_IDS = [
  'clinical-blue',
  'editorial-review',
  'field-biology',
  'molecular-translational',
  'hematology-oncology',
  'data-methods',
  'population-health',
  'computational-biology',
  'dark-auditorium',
  'swiss-minimal'
];

// 1. Verify all 10 templates exist
const tpls = T.list();
assert.strictEqual(tpls.length, 10, 'Must have exactly 10 templates');

EXPECTED_IDS.forEach((id, idx) => {
  const tpl = tpls[idx];
  assert(tpl, `Template at index ${idx} should exist`);
  assert.strictEqual(tpl.id, id, `Template ${idx} id mismatch`);
  assert(tpl.name && typeof tpl.name === 'string', `${id} must have a name`);
  assert(tpl.description && typeof tpl.description === 'string', `${id} must have a description`);
  assert(tpl.intendedAudience && typeof tpl.intendedAudience === 'string', `${id} must have intendedAudience`);
  assert(tpl.colors && tpl.colors.bg && tpl.colors.text && tpl.colors.accent, `${id} must have colors`);
  assert(tpl.fonts && tpl.fonts.title && tpl.fonts.body, `${id} must have fonts`);
});
console.log('✔ All 10 templates registered in intentional order');

// 2. Verify all 10 templates generate exactly 26 slides (260 slide instances total)
let totalSlides = 0;
const decks = {};

EXPECTED_IDS.forEach((id) => {
  const deck = T.generateDeck(id);
  decks[id] = deck;
  assert.strictEqual(deck.slides.length, 26, `Template ${id} must contain exactly 26 slides, got ${deck.slides.length}`);
  totalSlides += deck.slides.length;

  // Check each slide has valid layout and objects
  deck.slides.forEach((s, sIdx) => {
    assert(s.layout, `Slide ${sIdx} in ${id} must have a layout`);
    assert(Array.isArray(s.objects) && s.objects.length > 0, `Slide ${sIdx} in ${id} must contain objects`);

    // Verify objects have coordinates and types
    s.objects.forEach((o, oIdx) => {
      assert(typeof o.x === 'number' && typeof o.y === 'number', `Obj ${oIdx} on slide ${sIdx} in ${id} missing x/y`);
      assert(typeof o.w === 'number' && typeof o.h === 'number', `Obj ${oIdx} on slide ${sIdx} in ${id} missing w/h`);
      assert(['text', 'shape', 'table', 'image'].includes(o.type), `Obj ${oIdx} invalid type ${o.type}`);

      // If table, verify cell structure
      if (o.type === 'table') {
        assert(Array.isArray(o.cells) && o.cells.length > 0, `Table on slide ${sIdx} in ${id} has no cells`);
        o.cells.forEach(row => {
          assert(Array.isArray(row) && row.length > 0, `Table row must be non-empty`);
        });
      }
    });
  });
});

assert.strictEqual(totalSlides, 260, 'Total slides across catalog must be exactly 260');
console.log(`✔ All 10 decks contain 26 slides each (${totalSlides} total slide instances across catalog)`);

// 3. Verify pristine check
const pristineDoc = {
  slides: [
    {
      layout: 'title',
      objects: [
        { type: 'text', role: 'title', html: '<p>Presentation title</p>' },
        { type: 'text', role: 'subtitle', html: '<p>Author · Affiliation · Date</p>' }
      ]
    }
  ]
};
assert(T.isPristineBlankDoc(pristineDoc), 'Pristine doc should be detected as pristine');

const editedDoc = {
  slides: [
    {
      layout: 'title',
      objects: [
        { type: 'text', role: 'title', html: '<p>My Novel Drug Discovery</p>' },
        { type: 'text', role: 'subtitle', html: '<p>Author · Affiliation · Date</p>' }
      ]
    }
  ]
};
assert(!T.isPristineBlankDoc(editedDoc), 'Edited title should not be pristine');

const multiSlideDoc = {
  slides: [
    { layout: 'title', objects: [] },
    { layout: 'content', objects: [] }
  ]
};
assert(!T.isPristineBlankDoc(multiSlideDoc), 'Multi-slide doc should not be pristine');
console.log('✔ Unsaved presentation pristine detector verified');

// 4. Save decks to disk for python exporter test
fs.writeFileSync('/tmp/academic_templates_decks.json', JSON.stringify(decks));
console.log('✔ Serialized all 10 decks for PPTX export testing');
console.log('All template node tests passed successfully!');
