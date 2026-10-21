/* state.js — single source of truth.
   RPE.bus    : tiny event emitter (also re-dispatched as DOM CustomEvents "rpe:<name>")
   RPE.store  : { doc, ui, prefs } plus selectors, mutate() with undo/redo, persistence.
   Everything the user can change in the document goes through store.mutate(). */
(function (RPE) {
  'use strict';

  /* ---------- event bus ---------- */
  const handlers = {};
  const bus = {
    on(name, fn) { (handlers[name] = handlers[name] || []).push(fn); return () => bus.off(name, fn); },
    off(name, fn) { handlers[name] = (handlers[name] || []).filter((f) => f !== fn); },
    emit(name, detail) {
      (handlers[name] || []).slice().forEach((fn) => { try { fn(detail); } catch (err) { console.error('[rpe:' + name + ']', err); } });
      document.dispatchEvent(new CustomEvent('rpe:' + name, { detail }));
    }
  };

  /* ---------- helpers ---------- */
  let counter = 0;
  const uid = (p) => `${p || 'o'}_${(++counter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const clone = (v) => JSON.parse(JSON.stringify(v));

  const PREF_KEY = 'rpe.prefs.v1';
  const DOC_KEY = 'deck';               // key of the autosave record in IndexedDB (js/storage.js)
  const LEGACY_DOC_KEY = 'rpe.deck.v1'; // v1 kept the document in localStorage; read once to migrate, then removed
  const defaultPrefs = { autosave: false, reduceMotion: false, backendUrl: 'http://localhost:8000', fullscreenPresent: true };

  function loadPrefs() {
    try { return Object.assign({}, defaultPrefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')); } catch (e) { return Object.assign({}, defaultPrefs); }
  }

  let pendingSel = null;   // {slideId, ids}: selection cleared by an empty-canvas click, restorable by the next Undo
  const S = {
    doc: null,
    prefs: loadPrefs(),
    ui: {
      activeSlideId: null, selectedIds: [], editingId: null,
      activeTab: 'home', view: 'normal',
      zoomMode: 'fit', zoom: 100, sorterZoom: 20,
      notesOpen: false, notesHeight: 112, paneWidth: 212,
      ribbonCollapsed: false, ribbonPeek: false,
      showRuler: false, showGrid: false, showGuides: false,
      snapEnabled: true, snapToGrid: false,
      backstage: null, saveState: 'new', localInfo: null, painter: null, clipboard: null,
      lastColors: { font: '#C00000', highlight: '#FFFF00', fill: 'accent', outline: 'accent' },
      presenting: false,
      cellSel: null
    },
    uid, clone, bus
  };

  /* ---------- selectors ---------- */
  S.slide = (id) => S.doc.slides.find((s) => s.id === id) || null;
  S.activeSlide = () => S.slide(S.ui.activeSlideId);
  S.activeIndex = () => S.doc.slides.findIndex((s) => s.id === S.ui.activeSlideId);
  /* Header/footer regions ("hf:header", "hf:footer") resolve to a live text-object proxy (js/headerfooter.js), so the text editor and the
     formatting commands treat them like any text box. They are never part of slide.objects. */
  const isHF = (id) => !!(RPE.hf && RPE.hf.isId(id));
  S.findObject = (id) => {
    const s = S.activeSlide(); if (!s) return null;
    return isHF(id) ? RPE.hf.resolveId(S.doc, s, id) : s.objects.find((o) => o.id === id) || null;
  };
  S.selectedObjects = () => { const s = S.activeSlide(); return s ? S.ui.selectedIds.map((id) => (isHF(id) ? RPE.hf.resolveId(S.doc, s, id) : s.objects.find((o) => o.id === id))).filter(Boolean) : []; };

  /* ---------- ui state ---------- */
  S.setUI = function (patch, reason) {
    const changed = [];
    Object.keys(patch).forEach((k) => { if (S.ui[k] !== patch[k]) { S.ui[k] = patch[k]; changed.push(k); } });
    if (changed.some((k) => k === 'selectedIds' || k === 'activeSlideId' || (k === 'editingId' && S.ui.editingId))) pendingSel = null;
    if (changed.length) bus.emit('ui', { changed, reason: reason || null });
    return changed;
  };
  /* Empty-canvas click: clears the selection and remembers the previous non-empty one for the very next Undo (never in document history).
     Discarded by any document change, other selection, slide switch, text edit, new gesture, or a second blank click. */
  S.clearSelectionByCanvasClick = function () {
    const prev = S.ui.selectedIds.slice(), slideId = S.ui.activeSlideId;
    pendingSel = null;
    if (!prev.length) return;
    S.select([]);
    if (!S.ui.selectedIds.length) pendingSel = { slideId, ids: prev };
  };
  S.discardSelectionRestore = () => { pendingSel = null; };
  S.setPrefs = function (patch) {
    Object.assign(S.prefs, patch);
    try { localStorage.setItem(PREF_KEY, JSON.stringify(S.prefs)); } catch (e) { /* storage unavailable */ }
    bus.emit('prefs', patch);
  };
  S.setActiveSlide = (id) => S.setUI({ activeSlideId: id, selectedIds: [], editingId: null, cellSel: null }, 'slide');
  S.select = function (ids) {
    const s = S.activeSlide(); let out = ids.slice();
    if (s) { // selecting one member of a group selects the whole group
      s.objects.forEach((o) => { if (o.groupId && ids.some((id) => (s.objects.find((x) => x.id === id) || {}).groupId === o.groupId) && !out.includes(o.id)) out.push(o.id); });
    }
    const cur = S.ui.selectedIds;
    if (S.ui.cellSel && (out.length !== 1 || out[0] !== S.ui.cellSel.id)) {
      S.ui.cellSel = null;
    }
    if (cur.length === out.length && cur.every((v, i) => v === out[i])) return;
    S.setUI({ selectedIds: out }, 'select');
  };

  /* ---------- history ---------- */
  const hist = { undo: [], redo: [], key: null, t: 0, group: null };
  S.canUndo = () => hist.undo.length > 0 || !!pendingSel;
  S.canRedo = () => hist.redo.length > 0;
  S.endCoalesce = () => { hist.key = null; };
  /* Undo group: every mutate between beginGroup and endGroup shares ONE undo step (text + formatting of one edit session). */
  S.beginGroup = (label) => { hist.key = null; hist.group = { label, pushed: false }; };
  S.endGroup = () => { hist.group = null; hist.key = null; };
  S.clearHistory = () => { pendingSel = null; hist.undo.length = 0; hist.redo.length = 0; hist.key = null; };
  S.nextUndoLabel = () => (hist.undo.length ? hist.undo[hist.undo.length - 1].label : null);
  S.nextRedoLabel = () => (hist.redo.length ? hist.redo[hist.redo.length - 1].label : null);

  let rev = 0;   // bumped by every change; an async save only marks the document saved when it has not moved on
  function markDirty() {
    rev++;
    if (S.ui.saveState !== 'dirty') S.setUI({ saveState: 'dirty' });
    if (S.prefs.autosave) { clearTimeout(markDirty.t); markDirty.t = setTimeout(() => S.saveLocal(true), 1500); }
  }


  /* mutate(label, fn, {coalesce, window, hint, history})
     - snapshots the document once per coalesce group (drags, typing); history:false skips the snapshot
       (machine-made changes such as a finished figure render: no undo step, still marks the document dirty),
     - runs fn(doc) to edit the document in place,
     - emits "doc" with a render hint: {objects:[ids], geom:bool} | {full:true} | {skipCanvas:true}. */
  S.mutate = function (label, fn, opts) {
    opts = opts || {};
    const now = performance.now();
    const record = opts.history !== false;
    const grp = hist.group;
    const joined = record && ((grp && grp.pushed) || (opts.coalesce && hist.key === opts.coalesce && now - hist.t < (opts.window || 1200)));
    if (record) pendingSel = null;
    if (record && !joined) {
      hist.undo.push({ label: grp ? grp.label : label, snap: JSON.stringify(S.doc) });
      if (grp) grp.pushed = true;
      if (hist.undo.length > 100) hist.undo.shift();
      hist.redo.length = 0;
    }
    if (record) { hist.key = opts.coalesce || null; hist.t = now; }
    const result = fn(S.doc);
    markDirty();
    bus.emit('doc', { label, hint: opts.hint || { full: true } });
    return result;
  };

  function restore(snap, label) {
    const idx = Math.max(0, S.activeIndex());
    S.doc = JSON.parse(snap);
    const slides = S.doc.slides;
    if (!slides.some((s) => s.id === S.ui.activeSlideId)) S.ui.activeSlideId = slides[Math.min(idx, slides.length - 1)].id;
    const s = S.activeSlide();
    S.ui.selectedIds = S.ui.selectedIds.filter((id) => s.objects.some((o) => o.id === id));
    S.ui.editingId = null;
    S.ui.cellSel = null;
    markDirty();
    bus.emit('doc', { label, hint: { full: true, history: true } });
    bus.emit('ui', { changed: ['activeSlideId', 'selectedIds', 'editingId', 'cellSel'], reason: 'history' });
  }
  S.undo = function () {
    S.endCoalesce(); hist.group = null;
    const sel = pendingSel; pendingSel = null;
    if (sel) {   // Case A: restore the cleared selection only; document and history stay untouched
      const s = S.activeSlide();
      const ids = s && s.id === sel.slideId ? sel.ids.filter((id) => s.objects.some((o) => o.id === id)) : [];
      if (ids.length) { S.select(ids); return 'selection'; }
    }
    const e = hist.undo.pop(); if (!e) return null;
    hist.redo.push({ label: e.label, snap: JSON.stringify(S.doc) });
    restore(e.snap, 'Undo ' + e.label); return e.label;
  };
  S.redo = function () {
    S.endCoalesce(); hist.group = null; pendingSel = null;
    const e = hist.redo.pop(); if (!e) return null;
    hist.undo.push({ label: e.label, snap: JSON.stringify(S.doc) });
    restore(e.snap, 'Redo ' + e.label); return e.label;
  };

  /* ---------- schema migration (v1 -> v2: adds doc.figures; slide objects are never touched) ---------- */
  const SCHEMA_VERSION = 2;
  S.SCHEMA_VERSION = SCHEMA_VERSION;
  /* In place and idempotent; returns doc. Throws on malformed or newer-than-supported documents.
     Plot/figure objects without a figureId stay as they are (plain legacy objects). */
  S.migrateDoc = function (doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Project data is not a valid document.');
    const v = doc.schemaVersion === undefined || doc.schemaVersion === null ? 1 : doc.schemaVersion;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw new Error('Invalid project schema version (' + v + ').');
    if (v > SCHEMA_VERSION) throw new Error('Unsupported project schema version (' + v + ').');
    if (RPE.typography) RPE.typography.normalize(doc);   // optional persisted typography preset: repaired/dropped when invalid, never created
    if (RPE.palettes) RPE.palettes.normalize(doc);   // optional persisted colour palette: repaired/dropped when invalid, never created
    if (RPE.hf) RPE.hf.normalize(doc);   // optional header/footer data (doc.hf, slide.hf): repaired, empties removed, never created
    if (doc.figures === undefined || doc.figures === null) doc.figures = {};
    else if (typeof doc.figures !== 'object' || Array.isArray(doc.figures)) throw new Error('Project figures are malformed.');
    doc.schemaVersion = SCHEMA_VERSION;
    return doc;
  };

  /* ---------- images: assets ----------
     In memory the document is exactly as in v1 (slide object `src` and figure `render.preview` hold image data URLs).
     Persisted and exported documents move every image into doc.assets {assetId: dataURL} and refer to it as "asset:<id>"
     (contract 3e); ids come from the content, so identical pictures are stored once. */
  const ASSET_RE = /^asset:([A-Za-z0-9_-]{1,80})$/;
  const isImg = (v) => typeof v === 'string' && v.indexOf('data:image/') === 0;
  const idCache = new Map();   // dataURL -> id, so a save hashes each picture once per session
  function hashStr(str) {      // two 32-bit hashes over the whole string + length
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return 'a' + (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36) + str.length.toString(36);
  }

  /* Persisted form of `doc` (default: the open document): a copy that shares everything except the changed objects/records,
     with `assets` holding the pictures that are still referenced. Does not touch `doc`. */
  S.serialize = function (doc) {
    doc = S.migrateDoc(doc || S.doc);
    const assets = {};
    const ref = (v) => {
      let id = idCache.get(v);
      if (!id) { id = hashStr(v); idCache.set(v, id); if (idCache.size > 200) idCache.delete(idCache.keys().next().value); }
      assets[id] = v; return 'asset:' + id;
    };
    const out = Object.assign({}, doc);
    out.slides = doc.slides.map((s) => Object.assign({}, s, { objects: (s.objects || []).map((o) => (o && isImg(o.src) ? Object.assign({}, o, { src: ref(o.src) }) : o)) }));
    out.figures = {};
    Object.keys(doc.figures).forEach((id) => {
      const r = doc.figures[id], p = r && r.render && r.render.preview;
      out.figures[id] = isImg(p) ? Object.assign({}, r, { render: Object.assign({}, r.render, { preview: ref(p) }) }) : r;
    });
    if (RPE.typography) out.typography = RPE.typography.snapshot(doc);   // resolved roles, so the exporter needs no template knowledge (old docs: derived from typeId)
    out.assets = assets;
    return out;
  };

  /* Opens a loaded document in place: resolves asset references, validates and repairs. Returns notices (strings).
     The file is only data: nothing in it is evaluated, no script or render runs, and only embedded images are kept
     (an external or unknown `src` is dropped). A plot/figure object whose record is missing becomes a plain image. */
  S.hydrate = function (doc) {
    if (!Array.isArray(doc.slides) || !doc.slides.length) throw new Error('Presentation must contain at least one slide.');
    const raw = doc.assets, assets = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    delete doc.assets;
    const n = { lost: 0, dropped: 0, unlinked: 0, restored: 0, records: 0 };
    const pick = (v) => {   // -> data URL | null
      if (typeof v !== 'string' || !v) return null;
      const m = ASSET_RE.exec(v);
      if (m) { const a = assets[m[1]]; if (isImg(a)) return a; n.lost++; return null; }
      if (isImg(v)) return v;
      n.dropped++; return null;
    };
    const figs = doc.figures;
    Object.keys(figs).forEach((id) => {
      const r = figs[id];
      if (!r || typeof r !== 'object' || Array.isArray(r) || r.id !== id) { delete figs[id]; n.records++; return; }
      const rd = r.render;
      if (rd && typeof rd === 'object' && typeof rd.preview === 'string') {
        rd.preview = pick(rd.preview);
        if (!rd.preview && (rd.status === 'ok' || rd.status === 'stale')) rd.status = 'none';
      }
    });
    doc.slides.forEach((s) => {
      s.objects = (Array.isArray(s.objects) ? s.objects : []).filter((o) => o && typeof o === 'object' && !Array.isArray(o));
      s.objects.forEach((o) => {
        if (typeof o.src === 'string') o.src = pick(o.src);
        if (!o.figureId) return;
        const rec = figs[o.figureId];
        if (!rec) { o.type = 'image'; delete o.figureId; n.unlinked++; return; }
        if (!o.src && rec.render && rec.render.preview) { o.src = rec.render.preview; n.restored++; }
      });
    });
    const out = [], pl = (k, w) => k + ' ' + w + (k === 1 ? '' : 's');
    if (n.unlinked) out.push(pl(n.unlinked, 'figure object') + ' lost its figure data and is now a plain image.');
    if (n.restored) out.push(pl(n.restored, 'picture') + ' was missing and is shown from the figure preview (lower resolution); apply the figure again to refresh it.');
    if (n.lost) out.push(pl(n.lost, 'image') + ' missing from the file.');
    if (n.dropped) out.push(pl(n.dropped, 'external image reference') + ' removed (only embedded images are kept).');
    if (n.records) out.push(pl(n.records, 'invalid figure record') + ' skipped.');
    return out;
  };

  /* ---------- document lifecycle & persistence ---------- */
  S.replaceDoc = function (doc, saveState) {
    S.migrateDoc(doc);
    const notes = S.hydrate(doc);
    S.doc = doc; S.clearHistory(); idCache.clear(); rev++;
    S.ui.activeSlideId = doc.slides[0].id; S.ui.selectedIds = []; S.ui.editingId = null; S.ui.cellSel = null;
    S.ui.saveState = saveState || 'new';
    bus.emit('doc', { label: 'Open', hint: { full: true, replaced: true } });
    bus.emit('ui', { changed: ['activeSlideId', 'selectedIds', 'editingId', 'saveState', 'cellSel'], reason: 'replace' });
    return notes;
  };
  /* Orphan figure records (no slide object points at them, not on the editor clipboard) are dropped on explicit saves only
     (Save, Download project, Save to server), never while editing or on autosave, so Undo and a dialog's draft never lose a record. */
  function gcFigures() {
    const F = RPE.figures;
    if (!F || !F.gc) return;
    const clip = (S.ui.clipboard && S.ui.clipboard.objs) || [];
    F.gc(S.doc, clip.map((o) => o && o.figureId).filter(Boolean));
  }
  /* The document as it is persisted (see serialize). opts.auto = autosave: no orphan collection. */
  S.prepareSave = function (opts) {
    S.migrateDoc(S.doc);
    if (!(opts && opts.auto)) gcFigures();
    return S.serialize();
  };

  let warned = false;   // one warning per failure streak for autosave; explicit saves always say so
  function saveFailed(e, auto) {
    S.setUI({ saveState: 'failed' });
    if (auto && warned) return;
    warned = true;
    const U = RPE.ui;
    if (!U || !U.toast) return;
    U.toast((e.code === 'quota' ? 'Browser storage is full, so this presentation was not saved in the browser.' : 'Not saved in the browser: ' + e.message) + ' Download a project file to keep your work.',
      { kind: 'warn', duration: 14000, action: { label: 'Download project', onClick: () => RPE.commands.run('file.exportJson', {}, 'save') } });
  }
  /* Saves to IndexedDB. Resolves true/false; a failure shows a non-blocking warning with a "Download project" action. */
  S.saveLocal = function (auto) {
    const rev0 = rev; let payload;


    try { payload = S.prepareSave({ auto: !!auto }); } catch (e) { saveFailed(e, auto); return Promise.resolve(false); }
    if (!RPE.storage) { saveFailed(Object.assign(new Error('Storage module missing.'), { code: 'unavailable' }), auto); return Promise.resolve(false); }
    return RPE.storage.saveDoc(DOC_KEY, payload).then((r) => {
      warned = false;
      S.setUI({ saveState: rev === rev0 ? 'saved' : 'dirty', localInfo: { savedAt: r.savedAt, title: payload.title } });
      return true;
    }, (e) => { saveFailed(e, auto); return false; });
  };
  function legacyRead() {
    try {
      const raw = localStorage.getItem(LEGACY_DOC_KEY), j = raw ? JSON.parse(raw) : null;
      return j && j.doc && typeof j.doc === 'object' ? { doc: j.doc, savedAt: j.savedAt || Date.now() } : null;
    } catch (e) { return null; }
  }
  /* -> {doc, savedAt} | null (IndexedDB first, then an un-migrated v1 copy). Rejects with an Error that has `code`. */
  S.loadLocal = function () {
    const st = RPE.storage;
    return (st ? st.loadDoc(DOC_KEY) : Promise.resolve(null)).then((r) => r || legacyRead(), (e) => legacyRead() || Promise.reject(e));
  };
  S.refreshLocalInfo = function () {
    const st = RPE.storage, leg = legacyRead();
    return (st ? st.peekDoc(DOC_KEY) : Promise.resolve(null)).catch(() => null)
      .then((r) => { r = r || (leg ? { savedAt: leg.savedAt, title: leg.doc.title || '' } : null); S.setUI({ localInfo: r }); return r; });
  };
  /* v1 -> v2 storage: the localStorage copy moves to IndexedDB once; it is removed only after the write succeeded. */
  S.migrateLegacyLocal = function () {
    const leg = legacyRead(), st = RPE.storage;
    if (!leg || !st) return Promise.resolve(false);
    const drop = () => { try { localStorage.removeItem(LEGACY_DOC_KEY); } catch (e) { /* storage unavailable */ } return true; };
    return st.peekDoc(DOC_KEY).then((cur) => {
      if (cur) return drop();   // a newer copy already lives in IndexedDB
      return st.saveDoc(DOC_KEY, S.serialize(S.migrateDoc(leg.doc)), { savedAt: leg.savedAt }).then(drop);
    }).catch(() => false);
  };
  S.exportJSON = () => JSON.stringify({ format: 'rpe-deck', version: 1, doc: S.prepareSave() }, null, 2);

  RPE.bus = bus;
  RPE.store = S;
})(window.RPE = window.RPE || {});
