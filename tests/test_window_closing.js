/**
 * tests/test_window_closing.js
 * Verification of window-closing behavior, unsaved changes dialog,
 * dialog actions, save failures, duplicate dialog prevention,
 * and reopening saved projects.
 */
const assert = require('assert');
const createFakeIDB = require('./fake_idb.js');

// Setup DOM and browser globals
const fakeIDB = createFakeIDB();
global.indexedDB = fakeIDB;
global.window = global;
global.localStorage = {
  _data: {},
  getItem(k) { return this._data[k] || null; },
  setItem(k, v) { this._data[k] = String(v); },
  removeItem(k) { delete this._data[k]; }
};

// Minimal DOM implementation for Node
class FakeClassList {
  constructor(el) { this.el = el; this._classes = new Set(); }
  add(c) { this._classes.add(c); }
  remove(c) { this._classes.delete(c); }
  toggle(c, force) { if (force !== undefined) { if (force) this.add(c); else this.remove(c); return force; } if (this.contains(c)) { this.remove(c); return false; } this.add(c); return true; }
  contains(c) { return this._classes.has(c); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.classList = new FakeClassList(this);
    this.style = {
      _props: {},
      setProperty(k, v) { this._props[k] = v; },
      getProperty(k) { return this._props[k]; }
    };
    this.dataset = {};
    this._listeners = {};
    this.attributes = {};
    this.textContent = '';
    this.hidden = false;
  }
  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    nodes.forEach(n => {
      if (typeof n === 'string') {
        const textNode = new FakeElement('#text');
        textNode.textContent = n;
        this.appendChild(textNode);
      } else if (n) {
        this.appendChild(n);
      }
    });
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) {
      this.children.splice(idx, 1);
      child.parentNode = null;
    }
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = [];
    this._listeners[evt].push(fn);
  }
  removeEventListener(evt, fn) {
    if (!this._listeners[evt]) return;
    this._listeners[evt] = this._listeners[evt].filter(f => f !== fn);
  }
  dispatchEvent(evt) {
    const fns = this._listeners[evt.type] || [];
    fns.forEach(fn => fn(evt));
  }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k]; }
  querySelector(sel) {
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      if (this.classList.contains(cls)) return this;
      for (const c of this.children) {
        if (c.querySelector) {
          const found = c.querySelector(sel);
          if (found) return found;
        }
      }
    }
    return null;
  }
  querySelectorAll(sel) {
    const results = [];
    if (sel.startsWith('.')) {
      const cls = sel.slice(1);
      if (this.classList.contains(cls)) results.push(this);
    }
    for (const c of this.children) {
      if (c.querySelectorAll) results.push(...c.querySelectorAll(sel));
    }
    return results;
  }
  focus() { this._focused = true; }
  contains(node) {
    if (node === this) return true;
    for (const c of this.children) {
      if (c.contains && c.contains(node)) return true;
    }
    return false;
  }
}

global.CustomEvent = class CustomEvent {
  constructor(type, init) {
    this.type = type;
    this.detail = init && init.detail;
  }
};

global.document = {
  body: new FakeElement('body'),
  createElement(tag) { return new FakeElement(tag); },
  createTextNode(txt) {
    const el = new FakeElement('#text');
    el.textContent = txt;
    return el;
  },
  getElementById(id) {
    if (id === 'toasts') return this._toasts || (this._toasts = new FakeElement('div'));
    if (id === 'winControls') return this._winControls || (this._winControls = new FakeElement('div'));
    if (id === 'winClose') return this._winClose || (this._winClose = new FakeElement('button'));
    return null;
  },
  contains(node) { return global.document.body.contains(node); },
  activeElement: null,
  addEventListener() {},
  dispatchEvent() {}
};

global.requestAnimationFrame = (fn) => setTimeout(fn, 0);

// Load app components
global.RPE = {};
global.RPE.icons = {
  html: (name) => `<svg class="ic-${name}"></svg>`,
  render: () => {}
};

require('../js/themes.js');
require('../js/storage.js');
require('../js/state.js');
require('../js/seed.js');
require('../js/ui.js');
require('../js/templates/builder.js');
require('../js/templates/index.js');

// Mock desktopAPI
let forceCloseCalled = false;
let closeCalled = false;
let requestCloseHandler = null;

global.desktopAPI = {
  close: (force) => { if (force) forceCloseCalled = true; else closeCalled = true; },
  forceClose: () => { forceCloseCalled = true; },
  onRequestClose: (cb) => { requestCloseHandler = cb; },
  minimize: () => {},
  maximize: () => {},
  isMaximized: () => Promise.resolve(false),
  onMaximizeChange: () => {}
};

require('../js/desktop.js');

const S = RPE.store;
const U = RPE.ui;
const desktopClose = RPE.desktopClose;

assert(desktopClose, 'desktopClose module must be exported');

async function runTests() {
  console.log('Starting window-closing test suite...\n');

  // Helper to reset state
  function resetAll() {
    forceCloseCalled = false;
    closeCalled = false;
    window.__isClosing = false;
    // Clear open dialogs in DOM
    global.document.body.children = [];
    if (desktopClose.getActiveCloseDialog()) {
      desktopClose.getActiveCloseDialog().close();
    }
    S.doc = RPE.seed.createDeck({ blank: true });
  }

  // 1. Test clean closing with pristine blank doc
  console.log('1. Testing clean closing with pristine blank document...');
  resetAll();
  S.ui.saveState = 'new';
  assert.strictEqual(desktopClose.hasUnsavedChanges(), false, 'Pristine doc should not have unsaved changes');
  desktopClose.handleCloseRequest();
  assert.strictEqual(forceCloseCalled, true, 'Clean closing should trigger forceClose immediately');
  assert.strictEqual(desktopClose.isCloseDialogOpen(), false, 'Clean closing should not open unsaved dialog');
  console.log('✔ Clean closing for pristine blank document verified.');

  // 2. Test clean closing for saved document
  console.log('\n2. Testing clean closing with saved document...');
  resetAll();
  S.ui.saveState = 'saved';
  assert.strictEqual(desktopClose.hasUnsavedChanges(), false, 'Saved doc should not have unsaved changes');
  desktopClose.handleCloseRequest();
  assert.strictEqual(forceCloseCalled, true, 'Clean closing should trigger forceClose immediately');
  assert.strictEqual(desktopClose.isCloseDialogOpen(), false, 'Clean closing should not open unsaved dialog');
  console.log('✔ Clean closing for saved document verified.');

  // 3. Test clean closing for opened file without edits
  console.log('\n3. Testing clean closing for opened document without edits...');
  resetAll();
  S.ui.saveState = 'opened';
  assert.strictEqual(desktopClose.hasUnsavedChanges(), false, 'Opened doc without edits should not have unsaved changes');
  desktopClose.handleCloseRequest();
  assert.strictEqual(forceCloseCalled, true, 'Clean closing should trigger forceClose immediately');
  assert.strictEqual(desktopClose.isCloseDialogOpen(), false, 'Clean closing should not open unsaved dialog');
  console.log('✔ Clean closing for opened document verified.');

  // 4. Test dirty document detection
  console.log('\n4. Testing dirty document detection...');
  resetAll();
  S.ui.saveState = 'dirty';
  assert.strictEqual(desktopClose.hasUnsavedChanges(), true, 'saveState: dirty must be detected as unsaved changes');

  S.ui.saveState = 'failed';
  assert.strictEqual(desktopClose.hasUnsavedChanges(), true, 'saveState: failed must be detected as unsaved changes');

  // Modified new doc (e.g. edited text)
  S.ui.saveState = 'new';
  S.doc.slides[0].objects[0].html = '<p>Modified Title</p>';
  assert.strictEqual(desktopClose.hasUnsavedChanges(), true, 'Non-pristine new document must be detected as unsaved');
  console.log('✔ Dirty document detection verified for all unsaved cases.');

  // 5. Test dialog action: Cancel
  console.log('\n5. Testing dialog action: Cancel closing...');
  resetAll();
  S.ui.saveState = 'dirty';
  desktopClose.handleCloseRequest();
  assert.strictEqual(desktopClose.isCloseDialogOpen(), true, 'Unsaved dialog should be open');
  assert.strictEqual(forceCloseCalled, false, 'Window must NOT close when dialog is shown');

  const dlg = desktopClose.getActiveCloseDialog();
  assert(dlg, 'Active close dialog must exist');
  assert(dlg.buttons.cancel, 'Cancel button must exist');
  assert(dlg.buttons.discard, 'Discard changes button must exist');
  assert(dlg.buttons.save, 'Save button must exist');

  // Click Cancel
  dlg.close('cancel');
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(desktopClose.isCloseDialogOpen(), false, 'Dialog must be closed');
  assert.strictEqual(forceCloseCalled, false, 'Window must NOT close after Cancel');
  assert.strictEqual(S.ui.saveState, 'dirty', 'Document must remain dirty');
  assert.strictEqual(window.__isClosing, false, 'window.__isClosing must remain false');
  console.log('✔ Dialog action: Cancel verified (window remains open, data intact).');

  // 6. Test dialog action: Discard changes
  console.log('\n6. Testing dialog action: Discard changes...');
  resetAll();
  S.ui.saveState = 'dirty';
  desktopClose.handleCloseRequest();
  assert.strictEqual(desktopClose.isCloseDialogOpen(), true, 'Unsaved dialog should be open');

  const dlgDiscard = desktopClose.getActiveCloseDialog();
  dlgDiscard.close('discard');
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(desktopClose.isCloseDialogOpen(), false, 'Dialog must be closed');
  assert.strictEqual(forceCloseCalled, true, 'Window must close after Discard changes');
  assert.strictEqual(window.__isClosing, true, 'window.__isClosing must be true to allow unload');
  console.log('✔ Dialog action: Discard changes verified (window closes immediately without saving).');

  // 7. Test dialog action: Save (Success)
  console.log('\n7. Testing dialog action: Save & Close (Success)...');
  resetAll();
  S.ui.saveState = 'dirty';
  desktopClose.handleCloseRequest();
  assert.strictEqual(desktopClose.isCloseDialogOpen(), true, 'Unsaved dialog should be open');

  const dlgSave = desktopClose.getActiveCloseDialog();
  let backendSaveCalled = false;
  RPE.backend = {
    request: (endpoint, payload) => {
      if (endpoint === 'presentation.save') backendSaveCalled = true;
      return Promise.resolve({ ok: true });
    }
  };

  const savePromise = desktopClose.performSaveAndClose(dlgSave);
  await savePromise;
  await new Promise(r => setTimeout(r, 20));

  assert.strictEqual(S.ui.saveState, 'saved', 'Document state must be saved');
  assert.strictEqual(backendSaveCalled, true, 'Backend presentation.save must be notified');
  assert.strictEqual(forceCloseCalled, true, 'Window must close after successful save');
  assert.strictEqual(window.__isClosing, true, 'window.__isClosing must be true');
  assert.strictEqual(desktopClose.isCloseDialogOpen(), false, 'Dialog must be closed');
  console.log('✔ Dialog action: Save & Close verified (saved to storage, backend notified, window closed).');

  // 8. Test dialog action: Save failure handling
  console.log('\n8. Testing save failure handling (Quota/IO Error)...');
  resetAll();
  S.ui.saveState = 'dirty';
  desktopClose.handleCloseRequest();
  assert.strictEqual(desktopClose.isCloseDialogOpen(), true, 'Unsaved dialog should be open');

  const dlgSaveFail = desktopClose.getActiveCloseDialog();
  // Mock saveLocal to fail
  const origSaveLocal = S.saveLocal;
  S.saveLocal = () => Promise.resolve(false);

  let toastMessage = '';
  U.toast = (msg) => { toastMessage = msg; };

  const failPromise = desktopClose.performSaveAndClose(dlgSaveFail);
  await failPromise;
  await new Promise(r => setTimeout(r, 20));

  assert.strictEqual(forceCloseCalled, false, 'Window must NOT close when save fails (prevents data loss)');
  assert.strictEqual(window.__isClosing, false, 'window.__isClosing must not be true on save failure');
  assert(toastMessage.includes('Save failed'), 'Warning toast must be presented to user');
  S.saveLocal = origSaveLocal;
  console.log('✔ Save failure handling verified (data loss prevented, window remains open, user warned).');

  // 9. Test repeated close attempts / duplicate dialog prevention
  console.log('\n9. Testing repeated close attempts (duplicate dialog prevention)...');
  resetAll();
  S.ui.saveState = 'dirty';
  desktopClose.handleCloseRequest();
  assert.strictEqual(desktopClose.isCloseDialogOpen(), true, 'First close request opened dialog');
  const firstDlg = desktopClose.getActiveCloseDialog();

  // Attempt second close while dialog is open
  desktopClose.handleCloseRequest();
  assert.strictEqual(desktopClose.getActiveCloseDialog(), firstDlg, 'Must not create a new dialog');
  assert.strictEqual(global.document.body.children.length, 1, 'Only one dialog backdrop in DOM');

  // Third attempt via IPC event
  if (requestCloseHandler) {
    requestCloseHandler();
  }
  assert.strictEqual(desktopClose.getActiveCloseDialog(), firstDlg, 'Must still be the same dialog');
  assert.strictEqual(global.document.body.children.length, 1, 'Still only one dialog in DOM');

  // Cancel dialog
  firstDlg.close('cancel');
  await new Promise(r => setTimeout(r, 10));
  assert.strictEqual(desktopClose.isCloseDialogOpen(), false, 'Dialog closed after cancel');

  // Now a subsequent close attempt SHOULD open a new dialog
  desktopClose.handleCloseRequest();
  assert.strictEqual(desktopClose.isCloseDialogOpen(), true, 'New dialog opened after previous was cancelled');
  desktopClose.getActiveCloseDialog().close('cancel');
  console.log('✔ Repeated close attempts verified (duplicate dialogs prevented, future attempts work).');

  // 10. Test reopening saved projects
  console.log('\n10. Testing reopening saved projects from IndexedDB...');
  resetAll();
  S.doc = {
    id: 'deck-101',
    title: 'Research Oncology Presentation',
    slides: [
      {
        id: 's1',
        layout: 'title',
        objects: [
          { type: 'text', role: 'title', html: '<p>Breakthrough in Immunotherapy</p>' }
        ]
      }
    ],
    assets: {}
  };
  S.ui.saveState = 'dirty';

  // Perform save
  const savedOk = await S.saveLocal();
  assert.strictEqual(savedOk, true, 'saveLocal must succeed');
  assert.strictEqual(S.ui.saveState, 'saved', 'State must be saved');

  // Simulate closing and reloading in a new session
  S.doc = null;
  const loaded = await S.loadLocal();
  assert(loaded && loaded.doc, 'Saved project must be loaded from storage');
  assert.strictEqual(loaded.doc.title, 'Research Oncology Presentation', 'Title must match saved');
  assert.strictEqual(loaded.doc.slides[0].objects[0].html, '<p>Breakthrough in Immunotherapy</p>', 'Slide content must match');
  console.log('✔ Reopening saved projects verified (round-trip persistence intact).');

  console.log('\n======================================================');
  console.log('All 10 window-closing test cases passed successfully!');
  console.log('======================================================');
}

runTests().catch(err => {
  console.error('Test suite failed:', err);
  process.exit(1);
});
