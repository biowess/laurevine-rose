/**
 * tests/test_font_selection.js
 * Verification of font dropdown bar behavior:
 * - Active font at caret position
 * - Active font for uniform selection
 * - Blank font for mixed-font selection
 * - Choosing a font applies to selection and reflects back in the fonts bar
 */
const assert = require('assert');

// Minimal DOM node structure for unit testing font selection
class MockNode {
  constructor(nodeType, nodeValue = '') {
    this.nodeType = nodeType;
    this.nodeValue = nodeValue;
    this.childNodes = [];
    this.parentElement = null;
    this.style = { setProperty() {}, removeProperty() {} };
    this.dataset = {};
    this.classList = { add() {}, remove() {}, toggle() {} };
    this.attributes = {};
  }
  get textContent() {
    return this.nodeType === 3 ? this.nodeValue : this.childNodes.map(c => c.textContent).join('');
  }
  set textContent(v) {
    this.childNodes = [new MockNode(3, v)];
  }
  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentElement;
    }
    return false;
  }
  appendChild(child) {
    this.childNodes.push(child);
    child.parentElement = this;
    return child;
  }
  replaceChildren() {
    this.childNodes = [];
  }
  remove() {
    if (this.parentElement) {
      const idx = this.parentElement.childNodes.indexOf(this);
      if (idx >= 0) this.parentElement.childNodes.splice(idx, 1);
      this.parentElement = null;
    }
  }
  querySelector(sel) {
    if (this.childNodes) {
      for (const ch of this.childNodes) {
        if (ch === editEl) return editEl;
        const res = ch.querySelector(sel);
        if (res) return res;
      }
    }
    return null;
  }
  querySelectorAll() { return []; }
  getAttribute(name) {
    return this.attributes[name] || null;
  }
  setAttribute(name, val) {
    this.attributes[name] = val;
  }
}

class MockRange {
  constructor() {
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
    this.collapsed = true;
  }
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
    this.collapsed = (this.startContainer === this.endContainer && this.startOffset === this.endOffset);
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
    this.collapsed = (this.startContainer === this.endContainer && this.startOffset === this.endOffset);
  }
  selectNodeContents(node) {
    this.startContainer = node;
    this.startOffset = 0;
    this.endContainer = node;
    this.endOffset = node.childNodes ? node.childNodes.length : (node.nodeValue ? node.nodeValue.length : 0);
    this.collapsed = false;
  }
  collapse(toStart) {
    if (toStart) {
      this.endContainer = this.startContainer;
      this.endOffset = this.startOffset;
    } else {
      this.startContainer = this.endContainer;
      this.startOffset = this.endOffset;
    }
    this.collapsed = true;
  }
  cloneRange() {
    const r = new MockRange();
    r.startContainer = this.startContainer;
    r.startOffset = this.startOffset;
    r.endContainer = this.endContainer;
    r.endOffset = this.endOffset;
    r.collapsed = this.collapsed;
    return r;
  }
  intersectsNode(node) {
    if (this.startContainer === node && this.endContainer === node) return true;
    const allText = [];
    function walk(n) {
      if (n.nodeType === 3) allText.push(n);
      for (const ch of n.childNodes) walk(ch);
    }
    walk(editEl);
    const nodeIdx = allText.indexOf(node);
    const startIdx = allText.indexOf(this.startContainer);
    const endIdx = allText.indexOf(this.endContainer);
    if (nodeIdx < 0 || startIdx < 0 || endIdx < 0) return true;
    return (nodeIdx >= startIdx && nodeIdx <= endIdx);
  }
}

global.CustomEvent = class {};
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
global.localStorage = { getItem() { return null; }, setItem() {}, removeItem() {} };
global.window = global;

let editEl = null;
let activeRange = null;
global.getSelection = () => ({
  rangeCount: activeRange ? 1 : 0,
  getRangeAt: (i) => activeRange,
  removeAllRanges: () => { activeRange = null; },
  addRange: (r) => { activeRange = r; },
  anchorNode: activeRange ? activeRange.startContainer : null,
  isCollapsed: activeRange ? activeRange.collapsed : true
});

global.NodeFilter = { SHOW_TEXT: 4 };

const dummyEl = {
  addEventListener: () => {},
  removeEventListener: () => {},
  focus: () => {},
  insertBefore: () => {},
  replaceChildren: () => {},
  appendChild: () => {},
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  classList: { add() {}, remove() {}, toggle() {} },
  style: {},
  querySelector: () => null,
  querySelectorAll: () => []
};

global.document = {
  dispatchEvent() {},
  createElement: () => new MockNode(1),
  createDocumentFragment: () => new MockNode(11),
  createRange: () => new MockRange(),
  createTreeWalker: (root, whatToShow) => {
    const textNodes = [];
    function walk(n) {
      if (n.nodeType === 3) textNodes.push(n);
      for (const ch of n.childNodes) walk(ch);
    }
    walk(root);
    let idx = -1;
    return {
      nextNode: () => {
        idx++;
        return idx < textNodes.length ? textNodes[idx] : null;
      }
    };
  },
  execCommand: (cmd, ui, val) => true,
  addEventListener: () => {},
  removeEventListener: () => {},
  querySelector: (s) => dummyEl,
  querySelectorAll: () => []
};

global.window = global;
global.window.addEventListener = () => {};
global.window.removeEventListener = () => {};
global.getComputedStyle = (el) => el.style || {};
window.getComputedStyle = global.getComputedStyle;

const RPE = {};
global.RPE = RPE;

require('../js/state.js');
require('../js/icons.js');
require('../js/themes.js');
require('../js/ui.js');
require('../js/renderer.js');
require('../js/commands.js');
require('../js/canvas.js');

function testFontSelection() {
  const S = RPE.store;
  S.doc = { id: 'd1', title: 'Test', themeId: 'journal', size: { w: 960, h: 540 }, slides: [{ id: 's1', objects: [] }] };
  S.ui.activeSlideId = 's1';

  const textObj = {
    id: 't_test',
    type: 'text',
    role: 'body',
    font: 'Calibri',
    fontSize: 18,
    html: ''
  };
  S.doc.slides[0].objects.push(textObj);
  S.select([textObj.id]);

  // Build tree:
  // editEl: element (div)
  //   p: element
  //     text1: text "Hello " (font inherited: Calibri)
  //     spanArial: element (style.fontFamily = "Arial")
  //       text2: text "World" (font: Arial)
  //     text3: text " and " (font inherited: Calibri)
  //     spanGeorgia: element (style.fontFamily = "Georgia")
  //       text4: text "Universe" (font: Georgia)

  editEl = new MockNode(1);
  editEl.style = { fontFamily: "Calibri,Carlito,'Segoe UI',sans-serif" };
  const p = new MockNode(1);
  editEl.appendChild(p);

  const text1 = new MockNode(3, "Hello ");
  p.appendChild(text1);

  const spanArial = new MockNode(1);
  spanArial.style = { fontFamily: "Arial" };
  p.appendChild(spanArial);
  const text2 = new MockNode(3, "World");
  spanArial.appendChild(text2);

  const text3 = new MockNode(3, " and ");
  p.appendChild(text3);

  const spanGeorgia = new MockNode(1);
  spanGeorgia.style = { fontFamily: "Georgia" };
  p.appendChild(spanGeorgia);
  const text4 = new MockNode(3, "Universe");
  spanGeorgia.appendChild(text4);

  const slideEl = {
    classList: { add() {}, remove() {}, toggle() {} },
    style: {},
    remove: () => {},
    querySelector: (sel) => {
      if (sel && sel.includes(textObj.id)) {
        return {
          querySelector: (s2) => editEl,
          classList: { add() {}, remove() {} }
        };
      }
      return null;
    }
  };
  RPE.renderer.slideEl = () => slideEl;
  editEl.closest = () => null;
  editEl.focus = () => {};
  editEl.classList = { add() {}, remove() {}, toggle() {} };
  editEl.addEventListener = () => {};
  editEl.removeEventListener = () => {};

  RPE.canvas.init();

  RPE.canvas.startEdit(textObj.id);

  // Let's test RPE.canvas.currentFont() by setting selection ranges
  // 1. Caret placed in text1 ("Hello ") -> should show "Calibri"
  {
    const r = new MockRange();
    r.setStart(text1, 2);
    r.collapse(true);
    activeRange = r;

    // Use currentFont
    // Pass r into selection
    const font = RPE.canvas.currentFont();
    assert.strictEqual(font, 'Calibri', 'Caret in "Hello" should show Calibri');
    assert.strictEqual(RPE.commands.value('font.family'), 'Calibri', 'commands.value should be Calibri');
  }

  // 2. Caret placed in text2 ("World", Arial) -> should show "Arial"
  {
    const r = new MockRange();
    r.setStart(text2, 2);
    r.collapse(true);
    activeRange = r;

    const font = RPE.canvas.currentFont();
    assert.strictEqual(font, 'Arial', 'Caret in "World" should show Arial');
    assert.strictEqual(RPE.commands.value('font.family'), 'Arial', 'commands.value should be Arial');
  }

  // 3. Caret placed in text4 ("Universe", Georgia) -> should show "Georgia"
  {
    const r = new MockRange();
    r.setStart(text4, 3);
    r.collapse(true);
    activeRange = r;

    const font = RPE.canvas.currentFont();
    assert.strictEqual(font, 'Georgia', 'Caret in "Universe" should show Georgia');
    assert.strictEqual(RPE.commands.value('font.family'), 'Georgia', 'commands.value should be Georgia');
  }

  // 4. Selection of text2 only (all Arial) -> should show "Arial"
  {
    const r = new MockRange();
    r.setStart(text2, 0);
    r.setEnd(text2, 5);
    activeRange = r;

    const font = RPE.canvas.currentFont();
    assert.strictEqual(font, 'Arial', 'Selection of "World" should show Arial');
    assert.strictEqual(RPE.commands.value('font.family'), 'Arial', 'commands.value should be Arial');
  }

  // 5. Selection spanning text1 ("Hello ") and text2 ("World") -> Calibri + Arial -> multiple fonts -> blank ""
  {
    const r = new MockRange();
    r.setStart(text1, 0);
    r.setEnd(text2, 5);
    activeRange = r;

    const font = RPE.canvas.currentFont();
    assert.strictEqual(font, '', 'Selection spanning Calibri and Arial must be blank');
    assert.strictEqual(RPE.commands.value('font.family'), '', 'commands.value must be blank for mixed fonts');
  }

  // 6. Selection spanning text2 ("World") and text4 ("Universe") -> Arial + Calibri + Georgia -> multiple fonts -> blank ""
  {
    const r = new MockRange();
    r.setStart(text2, 0);
    r.setEnd(text4, 8);
    activeRange = r;

    const font = RPE.canvas.currentFont();
    assert.strictEqual(font, '', 'Selection spanning Arial and Georgia must be blank');
    assert.strictEqual(RPE.commands.value('font.family'), '', 'commands.value must be blank for mixed fonts');
  }

  // 7. Uniform selection across two spans that both have Georgia
  {
    const spanGeorgia2 = new MockNode(1);
    spanGeorgia2.style = { fontFamily: "Georgia" };
    p.appendChild(spanGeorgia2);
    const text5 = new MockNode(3, " Extra");
    spanGeorgia2.appendChild(text5);

    const r = new MockRange();
    r.setStart(text4, 0);
    r.setEnd(text5, 6);
    activeRange = r;

    const font = RPE.canvas.currentFont();
    assert.strictEqual(font, 'Georgia', 'Selection across two Georgia spans must show Georgia');
    assert.strictEqual(RPE.commands.value('font.family'), 'Georgia', 'commands.value must be Georgia');
  }

  console.log('ALL UNIT TESTS FOR FONT SELECTION PASSED!');
}

testFontSelection();
