/**
 * js/templates/index.js
 * Template catalog registry, gallery popover builder, and safe loading workflow.
 */
(function (global) {
  'use strict';

  const RPE = global.RPE = global.RPE || {};
  RPE.templates = RPE.templates || {};

  const ORDER = [
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

  function esc(s) {
    if (RPE.ui && RPE.ui.esc) return RPE.ui.esc(s);
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Return array of all 10 registered template definitions in intentional order.
   */
  function list() {
    return ORDER.map((id) => RPE.templates[id]).filter(Boolean);
  }

  /**
   * Return a template definition by ID.
   */
  function get(id) {
    return RPE.templates[id] || null;
  }

  /**
   * Generate a fresh PresentationDoc instance for a template.
   */
  function generateDeck(id) {
    const tpl = get(id);
    if (!tpl) throw new Error(`Unknown template "${id}".`);
    const uid = (RPE.store && RPE.store.uid) ? RPE.store.uid : ((p) => (p || 'id') + '-' + Math.random().toString(36).slice(2, 9));
    const slides = tpl.buildSlides();

    return {
      id: uid('d'),
      title: `${tpl.name} Presentation`,
      size: { w: 1280, h: 720 },
      themeId: tpl.id,
      typeId: tpl.id,
      paletteId: tpl.id,
      templateId: tpl.id,
      ...((RPE.palettes && RPE.palettes.get(tpl.id)) ? { palette: RPE.palettes.snapshot(RPE.palettes.get(tpl.id)) } : {}),
      slides: slides,
      figures: {},
      comments: []
    };
  }

  /**
   * Check if presentation is pristine/untouched:
   * 1 slide, layout title, default placeholder text or empty, no user edits, undo stack empty.
   */
  function isPristineBlankDoc(doc) {
    if (!doc || !Array.isArray(doc.slides) || doc.slides.length !== 1) return false;
    const S = RPE.store;
    if (S && S.nextUndoLabel && S.nextUndoLabel()) return false;
    if (S && S.ui && S.ui.saveState !== 'new') return false;

    const s0 = doc.slides[0];
    if (s0.layout !== 'title') return false;
    const objs = s0.objects || [];
    if (objs.length > 2) return false;

    // Check if objects are only the standard title and subtitle
    const pristineTexts = [
      '<p>Presentation title</p>',
      '<p>Author · Affiliation · Date</p>',
      '<p></p>',
      ''
    ];

    for (let i = 0; i < objs.length; i++) {
      const o = objs[i];
      if (o.type !== 'text') return false;
      const cleanHtml = (o.html || '').trim();
      const rawText = cleanHtml.replace(/<[^>]+>/g, '').trim();
      if (rawText !== '' && rawText !== 'Presentation title' && rawText !== 'Author · Affiliation · Date') {
        return false;
      }
    }
    return true;
  }

  /**
   * Execute the actual document replacement.
   */
  function executeLoad(tpl) {
    const S = RPE.store;
    const deck = generateDeck(tpl.id);
    S.replaceDoc(deck, 'new');
    S.clearHistory();
    if (RPE.ui && RPE.ui.closeAll) RPE.ui.closeAll();
    if (RPE.ui && RPE.ui.toast) {
      RPE.ui.toast(`Loaded ${tpl.name} template (${deck.slides.length} slides)`, { kind: 'success' });
    }
    return true;
  }



  /**
   * Load template with safe unsaved-presentation protection.
   * Handles Case A (pristine/saved), Case B (unsaved new), Case C (unsaved modifications).
   */
  async function loadTemplateSafe(templateId) {
    const tpl = get(templateId);
    if (!tpl) return false;

    const S = RPE.store;
    const U = RPE.ui;
    const doc = S.doc;
    const saveState = S.ui ? S.ui.saveState : 'new';

    // Case A: Pristine blank document -> instant load without prompt
    if (isPristineBlankDoc(doc)) {
      return executeLoad(tpl);
    }

    // Case A2: Already cleanly saved with no dirty modifications
    if (saveState === 'saved') {
      return executeLoad(tpl);
    }

    // Determine Case B vs Case C
    const isDirty = (saveState === 'dirty');
    const title = isDirty ? 'Unsaved Changes' : 'Unsaved Presentation';
    const message = isDirty
      ? 'Your current presentation has unsaved changes.\nLoading this template will replace your current slides.'
      : 'Your current presentation has not been saved.\nLoading this template will replace your current slides.';

    // Prompt dialog with 3 buttons
    const dlgPromise = new Promise((resolve) => {
      U.dialog({
        title,
        icon: 'triangle-alert',
        width: 480,
        dismiss: 'backdrop',
        body: U.h('div', { class: 'stack' },
          U.h('p', { class: 'dlg__text' }, message),
          U.h('p', { class: 'dlg__text dlg__text--muted', style: { fontSize: '13px' } },
            `Template to load: <b>${esc(tpl.name)}</b> (26 slides).`
          )
        ),
        focus: '.btn--primary',
        buttons: [
          {
            label: 'Save & Continue',
            kind: 'primary',
            onClick: () => resolve('save')
          },
          {
            label: 'Continue Without Saving',
            kind: 'danger',
            onClick: () => resolve('discard')
          },
          {
            label: 'Cancel',
            kind: 'ghost',
            onClick: () => resolve('cancel')
          }
        ],
        onClose: (v) => {
          if (v === undefined) resolve('cancel');
        }
      });
    });

    const choice = await dlgPromise;

    if (choice === 'save') {
      const saved = await S.saveLocal();
      if (!saved) {
        if (U && U.toast) {
          U.toast('Save cancelled or failed. Template loading aborted.', { kind: 'warn' });
        }
        return false;
      }
      return executeLoad(tpl);
    }

    if (choice === 'discard') {
      return executeLoad(tpl);
    }

    // Cancel or dismissed
    return false;
  }

  /**
   * Render an accurate miniature SVG vector preview of the template's cover slide.
   */
  function renderThumbnailSvg(tpl, w, h) {
    const width = w || 160;
    const height = h || 90;
    const c = tpl.colors;
    const f = tpl.fonts;

    // Build vector preview matching slide 0 layout
    const isDark = !!tpl.dark;
    const bgFill = c.bg;
    const kickerFill = c.accent;
    const titleFill = c.text;
    const ruleFill = c.accent;
    const borderFill = c.border;
    const subtitleFill = c.muted || c.text;

    // SVG representation of cover slide elements
    return `<svg class="tpl-thumb-svg" viewBox="0 0 1280 720" width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="background:${bgFill};border:1px solid ${borderFill};border-radius:3px;display:block;">
      ${isDark ? `<rect width="1280" height="720" fill="${bgFill}"/>` : ''}
      <rect x="72" y="140" width="72" height="4" fill="${ruleFill}"/>
      <text x="72" y="180" font-family="${f.title}, system-ui, sans-serif" font-size="20" font-weight="bold" fill="${kickerFill}" letter-spacing="1">SCIENTIFIC RESEARCH</text>
      <text x="72" y="270" font-family="${f.title}, system-ui, sans-serif" font-size="52" font-weight="bold" fill="${titleFill}">${esc(tpl.name)}</text>
      <text x="72" y="340" font-family="${f.title}, system-ui, sans-serif" font-size="52" font-weight="bold" fill="${titleFill}">Investigation</text>
      <text x="72" y="410" font-family="${f.body}, system-ui, sans-serif" font-size="26" fill="${subtitleFill}">A Multi-Center Structured Study Protocol</text>
      <line x1="72" y1="480" x2="1208" y2="480" stroke="${borderFill}" stroke-width="2"/>
      <rect x="72" y="520" width="240" height="14" rx="3" fill="${subtitleFill}" opacity="0.6"/>
      <rect x="72" y="550" width="180" height="12" rx="3" fill="${subtitleFill}" opacity="0.4"/>
      <rect x="640" y="520" width="220" height="14" rx="3" fill="${subtitleFill}" opacity="0.6"/>
      <rect x="640" y="550" width="160" height="12" rx="3" fill="${subtitleFill}" opacity="0.4"/>
      <circle cx="1180" cy="180" r="16" fill="${c.accent}"/>
      <circle cx="1140" cy="180" r="16" fill="${c.accent2}"/>
    </svg>`;
  }

  /**
   * Render palette dots HTML for a template.
   */
  function renderPaletteDots(tpl) {
    const colors = [tpl.colors.bg, tpl.colors.text, tpl.colors.accent, tpl.colors.accent2, tpl.colors.surface];
    return `<span class="tpl-dots">${colors.map(col => `<span class="tpl-dot" style="background:${col};border:1px solid ${tpl.colors.border}"></span>`).join('')}</span>`;
  }

  /**
   * Open the Academic Templates gallery popover.
   */
  function openGallery(anchor) {
    const U = RPE.ui;
    const S = RPE.store;
    const activeTplId = (S.doc && S.doc.templateId) || (S.doc && S.doc.themeId) || '';

    const wrap = U.h('div', { class: 'tpl-gallery', role: 'dialog', 'aria-label': 'Academic Templates' });

    // Header
    const head = U.h('div', { class: 'tpl-gallery__head' },
      U.h('div', { class: 'tpl-gallery__head-text' },
        U.h('h2', { class: 'tpl-gallery__title' }, 'Academic Templates'),
        U.h('p', { class: 'tpl-gallery__sub' }, 'Select an art-directed presentation deck. Loading a template starts a new presentation with 26 complete, editable slides.'),
        U.h('div', { class: 'tpl-gallery__disclaimer' },
          U.h('span', { class: 'tpl-gallery__disclaimer-badge' }, 'Disclaimer'),
          U.h('span', { class: 'tpl-gallery__disclaimer-text' },
            'All patient case studies, clinical trial metrics, investigator profiles, and hospital/institutional affiliations depicted in these templates are entirely fictional sample placeholders for layout demonstration. Any resemblance to real persons, living or deceased, or actual institutions is purely coincidental. Methodological citations and literature references are illustrative.'
          )
        )
      )
    );
    wrap.appendChild(head);


    // Cards Grid
    const grid = U.h('div', { class: 'tpl-gallery__grid' });

    list().forEach((tpl) => {
      const isSelected = (tpl.id === activeTplId);
      const card = U.h('div', {
        class: 'tpl-card' + (isSelected ? ' is-selected' : ''),
        tabindex: '0',
        role: 'button',
        'aria-label': `Select ${tpl.name} template`,
        onclick: () => {
          loadTemplateSafe(tpl.id);
        },
        onkeydown: (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            loadTemplateSafe(tpl.id);
          }
        }
      });

      // Thumbnail container
      const thumb = U.h('div', { class: 'tpl-card__thumb', html: renderThumbnailSvg(tpl, 240, 135) });
      card.appendChild(thumb);

      // Meta container
      const meta = U.h('div', { class: 'tpl-card__meta' });
      const topRow = U.h('div', { class: 'tpl-card__top' },
        U.h('span', { class: 'tpl-card__name' }, tpl.name),
        U.h('span', { html: renderPaletteDots(tpl) })
      );
      const desc = U.h('p', { class: 'tpl-card__desc' }, tpl.description);
      const aud = U.h('p', { class: 'tpl-card__aud' }, tpl.intendedAudience);

      const foot = U.h('div', { class: 'tpl-card__foot' },
        U.h('button', {
          type: 'button',
          class: 'btn btn--' + (isSelected ? 'primary' : 'ghost') + ' btn--sm tpl-card__btn',
          onclick: (e) => {
            e.stopPropagation();
            loadTemplateSafe(tpl.id);
          }
        }, isSelected ? 'Active Template' : 'Use Template')
      );

      meta.append(topRow, desc, aud, foot);
      card.appendChild(meta);
      grid.appendChild(card);
    });

    wrap.appendChild(grid);

    // If anchor is provided, place as popover; otherwise open in dialog or popover
    if (anchor) {
      U.popover(anchor, wrap, { class: 'popover--templates-gallery', placement: 'bottom-start' });
    } else {
      const defAnchor = document.querySelector('.rtemplate-more') || document.querySelector('.rtemplates') || document.querySelector('.ribbon');
      if (defAnchor) {
        U.popover(defAnchor, wrap, { class: 'popover--templates-gallery', placement: 'bottom-start' });
      }
    }
  }

  // Register the 10 template themes in RPE.themes.THEMES for frontend palette support
  function registerThemePresets() {
    if (!RPE.themes || !Array.isArray(RPE.themes.THEMES)) return;
    const T = RPE.themes;
    list().forEach((tpl) => {
      const exists = T.THEMES.some((x) => x.id === tpl.id);
      if (!exists) {
        T.THEMES.push({
          id: tpl.id,
          name: tpl.name,
          bg: tpl.colors.bg,
          title: tpl.colors.text,
          text: tpl.colors.text,
          muted: tpl.colors.muted,
          accent: tpl.colors.accent,
          accent2: tpl.colors.accent2,
          type: 'outfit',
          palette: 'burgundy',
          decor: 'rule',
          dark: !!tpl.dark,
          neutrals: [tpl.colors.bg, tpl.colors.text, tpl.colors.surface, tpl.colors.border]
        });
      }
    });
  }

  registerThemePresets();

  RPE.templates.list = list;
  RPE.templates.get = get;
  RPE.templates.generateDeck = generateDeck;
  RPE.templates.isPristineBlankDoc = isPristineBlankDoc;
  RPE.templates.loadTemplateSafe = loadTemplateSafe;
  RPE.templates.renderThumbnailSvg = renderThumbnailSvg;
  RPE.templates.renderPaletteDots = renderPaletteDots;
  RPE.templates.openGallery = openGallery;

})(typeof window !== 'undefined' ? window : this);


