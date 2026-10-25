/**
 * tests/test_pptx_import_frontend.js — unit and contract tests for the PowerPoint Import frontend workflow.
 * Run with: node tests/test_pptx_import_frontend.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// 1. Verify index.html contains fileImportPptx input with proper accept attribute
const indexHtml = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
assert.ok(
  indexHtml.includes('id="fileImportPptx"'),
  'index.html must include #fileImportPptx file input'
);
assert.ok(
  indexHtml.includes('.pptx'),
  '#fileImportPptx must accept .pptx'
);
console.log('✓ index.html file input markup verified');

// 2. Verify commands.js registers file.importPptx
const commandsJs = fs.readFileSync(path.join(__dirname, '../js/commands.js'), 'utf8');
assert.ok(
  commandsJs.includes("register('file.importPptx'"),
  'commands.js must register file.importPptx command'
);
assert.ok(
  commandsJs.includes('fileImportPptx'),
  'file.importPptx command must trigger #fileImportPptx input'
);
console.log('✓ commands.js file.importPptx registration verified');

// 3. Verify app.js wires up Backstage buttons and change listener
const appJs = fs.readFileSync(path.join(__dirname, '../js/app.js'), 'utf8');
assert.ok(
  appJs.includes("'file.importPptx'"),
  'app.js bsPanel must provide button for file.importPptx'
);
assert.ok(
  appJs.includes('#fileImportPptx'),
  'app.js initFiles must attach change listener to #fileImportPptx'
);
assert.ok(
  appJs.includes('Compatibility') || appJs.includes('compatibility') || appJs.includes('complex elements'),
  'app.js must provide a compatibility notice explaining limitations'
);
assert.ok(
  appJs.includes('never be overwritten') || appJs.includes('unchanged'),
  'app.js must confirm original file remains unchanged and is never overwritten'
);
console.log('✓ app.js Backstage button and compatibility warning verified');

// 4. Test backend.js presentation.import request behavior
const backendJs = fs.readFileSync(path.join(__dirname, '../js/backend.js'), 'utf8');
assert.ok(
  backendJs.includes("name === 'presentation.import'"),
  'backend.js must handle presentation.import requests'
);
assert.ok(
  backendJs.includes('/api/presentation/import'),
  'backend.js must target /api/presentation/import endpoint'
);
assert.ok(
  backendJs.includes('FormData') || backendJs.includes('fileBase64'),
  'backend.js must handle file transfer'
);
assert.ok(
  backendJs.includes('AbortError') || backendJs.includes('cancelled'),
  'backend.js must handle request cancellation cleanly'
);
console.log('✓ backend.js endpoint contract verified');

// 5. Test mock execution of backend.js presentation.import handler
async function testBackendJsMock() {
  const RPE = {
    bus: { emit: () => {} },
    store: { prefs: { backendUrl: 'http://127.0.0.1:8000' } }
  };
  
  // Set up mock window and fetch
  global.window = {
    location: { protocol: 'http:', origin: 'http://127.0.0.1:8000' },
    addEventListener: () => {},
    RPE
  };
  global.document = { querySelector: () => null };

  let fetchCalls = [];
  global.fetch = async (url, opts) => {
    fetchCalls.push({ url, opts });
    if (opts && opts.signal && opts.signal.aborted) {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    }
    if (url.includes('/api/presentation/import')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          status: 'ok',
          doc: { id: 'deck_1', title: 'imported_test', slides: [{ id: 's1', objects: [] }] },
          warnings: [{ slide: 1, type: 'chart', message: 'Chart skipped' }],
          fileName: 'imported_test.pptx'
        })
      };
    }
    return { ok: false, status: 404 };
  };

  // Evaluate backend.js in sandbox
  const fn = new Function('RPE', backendJs);
  fn(RPE);

  // Test successful import request
  const successRes = await RPE.backend.request('presentation.import', {
    fileBase64: 'fakeb64data',
    fileName: 'test.pptx'
  });
  assert.strictEqual(successRes.ok, true);
  assert.strictEqual(successRes.doc.title, 'imported_test');
  assert.strictEqual(successRes.warnings.length, 1);
  console.log('✓ backend.request presentation.import successful call verified');

  // Test cancellation (AbortController)
  const ctrl = new (require('events').EventEmitter)();
  ctrl.aborted = true;
  ctrl.signal = { aborted: true, addEventListener: () => {} };
  const cancelRes = await RPE.backend.request('presentation.import', {
    fileBase64: 'fakeb64data',
    fileName: 'test.pptx',
    signal: ctrl.signal
  });
  assert.strictEqual(cancelRes.ok, false);
  assert.strictEqual(cancelRes.status, 499);
  assert.ok(cancelRes.message.includes('cancelled'));
  console.log('✓ backend.request cancellation (status 499) verified');

  // Test network failure
  global.fetch = async () => {
    throw new Error('Failed to fetch');
  };
  const failRes = await RPE.backend.request('presentation.import', {
    fileBase64: 'fakeb64data',
    fileName: 'test.pptx'
  });
  assert.strictEqual(failRes.ok, false);
  assert.ok(failRes.message.includes('offline') || failRes.message.includes('fetch'));
  console.log('✓ backend.request network failure handling verified');
}

testBackendJsMock().then(() => {
  console.log('\nAll PowerPoint Import frontend integration tests PASSED.');
}).catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});
