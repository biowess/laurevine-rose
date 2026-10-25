/* backstage_meta.js — titles/descriptions of the File backstage pages (DOM-free; unit-testable).
   `clean()` is the single guard that keeps null/undefined/"null" from ever being rendered as text in Backstage. */
(function (g) {
  'use strict';
  const VERSION = '1.0.0';   // keep in sync with pyproject.toml
  const clean = (v) => { if (v == null) return ''; const s = String(v).trim(); return /^(null|undefined|nan)$/i.test(s) ? '' : s; };
  const PAGES = {
    new: { title: 'New', desc: 'Start a presentation.' },
    open: { title: 'Open', desc: 'Open a project saved from this editor.' },
    save: { title: 'Save', desc: 'Where this presentation is stored.' },
    export: { title: 'Export', desc: 'Export presentation to standard formats.' },
    setup: { title: 'Setup & Components', desc: 'Re-detect, install or reinstall the PDF converter, remove the managed copy, and view the license.' },
    prefs: { title: 'Preferences', desc: 'Application preferences for this editor: choose how the interface behaves, when your work is saved, how slide shows start and which local service the editor connects to. Changes take effect as soon as you make them.' },
    about: { title: 'About', desc: `Laurevine Rose, version ${VERSION} — a browser-based editor for research slides, with figures and plots that export to PowerPoint and PDF through a local Python service. Projects are saved as .rpe.json files.` },
  };
  const page = (id) => { const p = PAGES[id] || PAGES.new; return { title: clean(p.title), desc: clean(p.desc) }; };
  const api = { VERSION, clean, PAGES, page };
  g.RPE = g.RPE || {}; g.RPE.backstageMeta = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : global);
