/* storage.js — document persistence in IndexedDB (preferences stay in localStorage).
   DB "rpe", version 1: store "docs" {key, format, savedAt, title, doc (no images), assetIds} and store "assets" (id -> image data URL).
   One readwrite transaction per save: puts the document, adds only the assets that are not stored yet and deletes the ones the
   document no longer uses. Any failure (quota included) aborts the whole transaction, so the previous save stays intact.
   Every call resolves/rejects with an Error that carries `code`: quota | unavailable | blocked | newer | error. */
(function (RPE) {
  'use strict';
  const DB_NAME = 'rpe', DB_VERSION = 1, FORMAT = 1;
  const MSG = {
    quota: 'Browser storage is full.',
    unavailable: 'This browser does not allow projects to be stored (private mode or storage disabled).',
    blocked: 'Another tab of this editor uses an older version of the project database. Close it and try again.',
    newer: 'The saved copy was written by a newer version of the editor.',
    error: 'The browser could not read or write the saved project.'
  };
  let dbp = null;

  function fail(code, cause) {
    const name = cause && cause.name, text = String((cause && cause.message) || '');
    if (code === 'error' && (name === 'QuotaExceededError' || /quota/i.test(text))) code = 'quota';
    const e = new Error(MSG[code] + (code === 'error' && text ? ' (' + text + ')' : ''));
    e.code = code; return e;
  }
  const factory = () => (typeof indexedDB !== 'undefined' ? indexedDB : null);

  function open() {
    if (dbp) return dbp;
    const f = factory();
    if (!f) return Promise.reject(fail('unavailable'));
    dbp = new Promise((res, rej) => {
      let req; try { req = f.open(DB_NAME, DB_VERSION); } catch (e) { rej(fail('unavailable', e)); return; }
      req.onupgradeneeded = (ev) => {
        const db = req.result;   // later versions: add `if (ev.oldVersion < 2) { ... }` blocks, never edit the ones above
        if (ev.oldVersion < 1) { db.createObjectStore('docs', { keyPath: 'key' }); db.createObjectStore('assets'); }
      };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); dbp = null; }; res(db); };
      req.onerror = () => rej(fail('unavailable', req.error));
      req.onblocked = () => rej(fail('blocked'));
    });
    dbp.catch(() => { dbp = null; });
    return dbp;
  }

  /* payload = serialized document ({...doc, assets:{id: dataURL}}), see RPE.store.serialize */
  function saveDoc(key, payload, opts) {
    return open().then((db) => new Promise((res, rej) => {
      const assets = payload.assets || {}, doc = Object.assign({}, payload); delete doc.assets;
      const rec = { key, format: FORMAT, savedAt: (opts && opts.savedAt) || Date.now(), title: String(doc.title || ''), doc, assetIds: Object.keys(assets) };
      let tx, added = 0;
      try { tx = db.transaction(['docs', 'assets'], 'readwrite'); } catch (e) { rej(fail('error', e)); return; }
      tx.oncomplete = () => res({ savedAt: rec.savedAt, added });
      tx.onabort = () => rej(fail('error', tx.error));
      try {
        const as = tx.objectStore('assets'), keys = as.getAllKeys();
        keys.onsuccess = () => {
          const have = new Set(keys.result);
          rec.assetIds.forEach((id) => { if (!have.has(id)) { as.put(assets[id], id); added++; } });
          have.forEach((id) => { if (!Object.prototype.hasOwnProperty.call(assets, id)) as.delete(id); });
          tx.objectStore('docs').put(rec);
        };
      } catch (e) { try { tx.abort(); } catch (_) { /* already finished */ } rej(fail('error', e)); }
    }));
  }

  /* -> {doc (with .assets re-attached), savedAt} | null when nothing is stored */
  function loadDoc(key) {
    return open().then((db) => new Promise((res, rej) => {
      let tx, rec = null, assets = {}, newer = false;
      try { tx = db.transaction(['docs', 'assets'], 'readonly'); } catch (e) { rej(fail('error', e)); return; }
      const r = tx.objectStore('docs').get(key);
      r.onsuccess = () => {
        rec = r.result || null; if (!rec) return;
        if (rec.format > FORMAT) { newer = true; return; }
        const as = tx.objectStore('assets');
        (rec.assetIds || []).forEach((id) => { const g = as.get(id); g.onsuccess = () => { if (typeof g.result === 'string') assets[id] = g.result; }; });
      };
      tx.oncomplete = () => (newer ? rej(fail('newer')) : res(rec ? { doc: Object.assign({}, rec.doc, { assets }), savedAt: rec.savedAt } : null));
      tx.onabort = () => rej(fail('error', tx.error));
    }));
  }

  /* -> {savedAt, title} | null, without reading the images */
  function peekDoc(key) {
    return open().then((db) => new Promise((res, rej) => {
      let tx; try { tx = db.transaction(['docs'], 'readonly'); } catch (e) { rej(fail('error', e)); return; }
      const r = tx.objectStore('docs').get(key);
      tx.oncomplete = () => res(r.result && r.result.format <= FORMAT ? { savedAt: r.result.savedAt, title: r.result.title } : null);
      tx.onabort = () => rej(fail('error', tx.error));
    }));
  }

  function removeDoc(key) {
    return open().then((db) => new Promise((res, rej) => {
      let tx; try { tx = db.transaction(['docs', 'assets'], 'readwrite'); } catch (e) { rej(fail('error', e)); return; }
      tx.objectStore('docs').delete(key); tx.objectStore('assets').clear();
      tx.oncomplete = () => res(true); tx.onabort = () => rej(fail('error', tx.error));
    }));
  }

  /* drops the cached connection (tests simulate a page reload with it) */
  function reset() { if (dbp) dbp.then((db) => db.close(), () => {}); dbp = null; }

  RPE.storage = { DB_NAME, DB_VERSION, FORMAT, available: () => !!factory(), saveDoc, loadDoc, peekDoc, removeDoc, reset };
})(window.RPE = window.RPE || {});
