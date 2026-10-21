/* typography.js — ONE typography-preset registry + the "apply typography by text role" operation.
   Presets = the 4 legacy RPE.themes.TYPES + 10 template-linked presets (id = template id) whose fonts/weights are DERIVED from
   the template definitions (tpl.fonts + the roles used by tpl.buildSlides()); nothing is duplicated as constants here.
   Persisted doc field: doc.typography = { id, roles:{title,subtitle,body,label,caption}: {font, bold?, italic?} } (a resolved
   snapshot; the backend reads it so it needs no template knowledge). Old docs without it fall back to doc.typeId, then 'outfit'.
   Spec semantics per role entry: key absent = leave the property alone, null = reset to the default, true/false = explicit.
   Sizes are NOT part of a preset: they belong to layout/geometry fit and are never changed. */
(function (RPE) {
  'use strict';
  const T = RPE.themes;

  const ROLES = ['title', 'subtitle', 'body', 'label', 'caption'];
  /* app role string -> typography role. Anything else ('text', no role, template-specific ids like 'aim-t') is "generic". */
  const ROLE_OF = { title: 'title', subtitle: 'subtitle', body: 'body', kicker: 'label', meta: 'label', label: 'label', caption: 'caption', footnote: 'caption' };
  const roleOf = (o) => (o && o.role && Object.prototype.hasOwnProperty.call(ROLE_OF, o.role)) ? ROLE_OF[o.role] : null;
  const lc = (s) => String(s || '').toLowerCase();
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const bundledSet = () => new Set(T.FONTS.map((f) => lc(f.name)));

  function finalize(p) { p.head = p.roles.title.font; p.body = p.roles.body.font; return p; }

  function legacyPreset(t) {
    return finalize({
      id: t.id, name: t.name, kind: 'legacy', templateId: null,
      roles: { title: { font: t.head, bold: null }, subtitle: { font: t.body, italic: null }, body: { font: t.body }, label: { font: t.body, bold: null }, caption: { font: t.body } }
    });
  }

  /* modal value of a tally {key: count}; ties resolved by `prefer` order */
  function modal(tally, prefer) {
    let best = null, n = -1;
    Object.keys(tally).forEach((k) => {
      const c = tally[k] + (prefer && prefer.indexOf(k) >= 0 ? (prefer.length - prefer.indexOf(k)) / 100 : 0);
      if (c > n) { n = c; best = k; }
    });
    return best;
  }

  function templatePreset(tpl) {
    const slots = tpl.fonts || {};
    const fallbackTitle = slots.title || 'Outfit', fallbackBody = slots.body || slots.title || 'Outfit';
    const prefer = [fallbackBody, fallbackTitle, slots.tech].filter(Boolean);
    const tally = {};
    ROLES.forEach((r) => { tally[r] = { font: {}, bold: {}, italic: {} }; });
    const inc = (m, k) => { m[k] = (m[k] || 0) + 1; };
    let slides = [];
    try { slides = tpl.buildSlides(); } catch (e) { slides = []; }
    slides.forEach((s) => (s.objects || []).forEach((o) => {
      const r = o && o.type === 'text' ? roleOf(o) : null;
      if (!r || !o.font) return;
      inc(tally[r].font, o.font); inc(tally[r].bold, String(o.bold)); inc(tally[r].italic, String(o.italic));
    }));
    const ok = bundledSet();
    const pick = (r, dflt) => { const f = modal(tally[r].font, prefer); return (f && ok.has(lc(f))) ? f : dflt; };
    const isTrue = (r, k) => modal(tally[r][k], ['true']) === 'true';
    return finalize({
      id: tpl.id, name: tpl.name, kind: 'template', templateId: tpl.id,
      roles: {
        title: { font: pick('title', fallbackTitle), bold: isTrue('title', 'bold') },
        subtitle: { font: pick('subtitle', fallbackBody), italic: isTrue('subtitle', 'italic') },
        body: { font: pick('body', fallbackBody) },
        label: { font: pick('label', fallbackBody), bold: isTrue('label', 'bold') },
        caption: { font: pick('caption', fallbackBody) }
      }
    });
  }

  let cache = null;
  function all() {
    if (cache) return cache;
    const legacy = T.TYPES.map(legacyPreset);
    const tpls = (RPE.templates && RPE.templates.list) ? RPE.templates.list().map(templatePreset) : [];
    cache = legacy.concat(tpls);
    return cache;
  }
  const list = () => all().slice();
  const listLegacy = () => all().filter((p) => p.kind === 'legacy');
  const listTemplates = () => all().filter((p) => p.kind === 'template');
  const get = (id) => all().find((p) => p.id === id) || null;

  /* Persisted snapshot -> clean object, or null when unusable (title/body fonts are mandatory; other roles fall back to body). */
  function sanitize(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !raw.roles || typeof raw.roles !== 'object') return null;
    const font = (r) => { const f = raw.roles[r] && raw.roles[r].font; return (typeof f === 'string' && f.trim() && f.length <= 80) ? f.trim() : null; };
    const flag = (r, k) => { const v = raw.roles[r] ? raw.roles[r][k] : undefined; return (v === true || v === false || v === null) ? v : undefined; };
    const tf = font('title'), bf = font('body');
    if (!tf || !bf) return null;
    const roles = {};
    ROLES.forEach((r) => {
      const e = { font: font(r) || bf };
      ['bold', 'italic'].forEach((k) => { const v = flag(r, k); if (v !== undefined) e[k] = v; });
      roles[r] = e;
    });
    return { id: typeof raw.id === 'string' ? raw.id.slice(0, 80) : 'custom', roles };
  }

  function forDoc(doc) {
    const snap = doc && sanitize(doc.typography);
    if (snap) {
      const base = get(snap.id);
      return finalize({ id: snap.id, name: base ? base.name : 'Custom', kind: base ? base.kind : 'custom', templateId: base ? base.templateId : null, roles: snap.roles });
    }
    return get(doc && doc.typeId) || get('outfit');
  }
  const snapshot = (doc) => { const p = forDoc(doc); return { id: p.id, roles: clone(p.roles) }; };

  /* Style of the role an object plays under preset `ty` (object-level font/bold/italic still win in the renderer/exporter). */
  function roleStyle(ty, o) {
    const r = roleOf(o);
    if (ty && ty.roles) return ty.roles[r] || ty.roles.body;
    return { font: ty ? (r === 'title' ? ty.head : ty.body) : 'Outfit' };
  }

  /* One object, typography properties only (font / bold / italic). Never touches html, colour, size, geometry, anything else.
     Known roles follow the preset dynamically (object-level overrides are cleared); generic objects with an explicit font that
     matches one of the previous preset's role fonts keep an explicit font, remapped to the same role of the new preset; a foreign
     font (not a previous-preset font) is treated as intentional and left alone. Character-level runs inside html are never read. */
  function applyObject(o, prev, target) {
    const r = roleOf(o);
    if (r) {
      const spec = target.roles[r];
      if (o.font != null) o.font = null;
      if (spec.bold !== undefined && o.bold != null) o.bold = null;
      if (spec.italic !== undefined && o.italic != null) o.italic = null;
      return;
    }
    if (!o.font) return;
    const f = lc(o.font), P = prev.roles;
    const same = (k) => P[k] && lc(P[k].font) === f;
    let k = null;
    if (same('title') && same('body')) k = o.bold === true ? 'title' : 'body';
    else if (same('title')) k = 'title';
    else if (same('body')) k = 'body';
    else if (same('label')) k = 'label';
    if (k) o.font = target.roles[k].font;
  }

  /* Presentation-wide, typography only. Call inside ONE S.mutate (single undo step). Works on empty decks. */
  function apply(doc, id) {
    const target = get(id);
    if (!target) return false;
    const prev = forDoc(doc);
    doc.typeId = target.id;
    doc.typography = { id: target.id, roles: clone(target.roles) };
    (doc.slides || []).forEach((s) => (s.objects || []).forEach((o) => { if (o && o.type === 'text') applyObject(o, prev, target); }));
    return true;
  }

  /* Called from migrateDoc: repairs/drops an invalid persisted field, never creates one. */
  function normalize(doc) {
    if (!doc || typeof doc !== 'object' || doc.typography === undefined) return doc;
    const s = sanitize(doc.typography);
    if (s) doc.typography = s; else delete doc.typography;
    return doc;
  }

  const fontsOf = (p) => Array.from(new Set(ROLES.map((r) => p.roles[r].font)));
  /* fonts a preset needs that are not in the bundled catalogue (legacy Georgia / Courier New) */
  const missingFonts = (p) => { const ok = bundledSet(); return fontsOf(p).filter((f) => !ok.has(lc(f))); };

  RPE.typography = { ROLES, ROLE_OF, roleOf, list, listLegacy, listTemplates, get, forDoc, snapshot, sanitize, normalize, roleStyle, apply, applyObject, fontsOf, missingFonts };
  T.type = (doc) => forDoc(doc);   // renderer/canvas read the active preset through RPE.themes.type(doc)
})(window.RPE = window.RPE || {});
