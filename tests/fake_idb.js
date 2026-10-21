/* tests/fake_idb.js — minimal in-memory IndexedDB for tests: open / upgrade, object stores (keyPath or out-of-line keys),
   get / put / delete / clear / getAllKeys, transactions that stage their writes and commit or abort as a whole,
   values are structured-cloned, and a byte quota that aborts the transaction with a QuotaExceededError like a full disk. */
module.exports = function createFakeIDB() {
  const dbs = {};
  const fake = { quota: Infinity, failOpen: false, stats: { puts: { docs: 0, assets: 0 }, aborts: 0 } };
  const size = (stores) => {
    let n = 0;
    Object.keys(stores).forEach((name) => stores[name].forEach((v) => { n += typeof v === 'string' ? v.length : JSON.stringify(v).length; }));
    return n;
  };
  fake.bytes = (db) => size(Object.fromEntries(Object.entries(dbs[db || 'rpe'].stores).map(([k, s]) => [k, s.data])));
  fake.keys = (store, db) => [...dbs[db || 'rpe'].stores[store].data.keys()];
  fake.get = (store, key, db) => dbs[db || 'rpe'].stores[store].data.get(key);

  function transaction(db, names, mode) {
    names = [].concat(names);
    const tx = { error: null, oncomplete: null, onabort: null, onerror: null };
    const staged = {}; names.forEach((n) => { staged[n] = new Map(db.stores[n].data); });
    let pending = 0, done = false;
    const settle = () => setTimeout(() => {
      if (done || pending) return;
      done = true;
      if (mode === 'readwrite') {
        const all = {}; Object.keys(db.stores).forEach((n) => { all[n] = staged[n] || db.stores[n].data; });
        if (size(all) > fake.quota) { tx.error = Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }); fake.stats.aborts++; if (tx.onabort) tx.onabort({ target: tx }); return; }
        names.forEach((n) => { db.stores[n].data = staged[n]; });
      }
      if (tx.oncomplete) tx.oncomplete({ target: tx });
    }, 0);
    const request = (fn) => {
      const req = { result: undefined, error: null, onsuccess: null, onerror: null };
      pending++;
      setTimeout(() => {
        if (done) return;
        try { req.result = fn(); if (req.onsuccess) req.onsuccess({ target: req }); } catch (e) { req.error = e; tx.error = e; done = true; fake.stats.aborts++; if (tx.onabort) tx.onabort({ target: tx }); return; }
        pending--; settle();
      }, 0);
      return req;
    };
    tx.abort = () => { if (!done) { done = true; fake.stats.aborts++; if (tx.onabort) setTimeout(() => tx.onabort({ target: tx }), 0); } };
    tx.objectStore = (name) => {
      const st = db.stores[name], data = staged[name];
      if (!data) throw Object.assign(new Error('NotFoundError'), { name: 'NotFoundError' });
      return {
        get: (k) => request(() => (data.has(k) ? structuredClone(data.get(k)) : undefined)),
        getAllKeys: () => request(() => [...data.keys()]),
        put: (v, k) => request(() => { if (mode !== 'readwrite') throw new Error('ReadOnlyError'); const key = st.keyPath ? v[st.keyPath] : k; data.set(key, structuredClone(v)); fake.stats.puts[name]++; return key; }),
        delete: (k) => request(() => { data.delete(k); }),
        clear: () => request(() => { data.clear(); })
      };
    };
    settle();
    return tx;
  }

  fake.open = (name, version) => {
    const req = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
    setTimeout(() => {
      if (fake.failOpen) { req.error = new Error('denied'); if (req.onerror) req.onerror({ target: req }); return; }
      const rec = dbs[name] || (dbs[name] = { version: 0, stores: {} });
      const handle = {
        onversionchange: null, close() {},
        createObjectStore(n, o) { rec.stores[n] = { keyPath: (o && o.keyPath) || null, data: new Map() }; },
        transaction: (names, mode) => transaction(rec, names, mode)
      };
      req.result = handle;
      if (rec.version < version) { const old = rec.version; rec.version = version; if (req.onupgradeneeded) req.onupgradeneeded({ oldVersion: old }); }
      if (req.onsuccess) req.onsuccess({ target: req });
    }, 0);
    return req;
  };
  return fake;
};
