/* equation.js — Compact LaTeX Equation Editor for Laurevine Rose
   Provides:
   - LaTeX input with syntax helper buttons (fractions, integrals, Greek, matrices, sub/super)
   - Live / debounced rendered preview on transparent background
   - Compilation error reporting with useful diagnostics
   - Automatic slide background contrast detection + manual foreground color selection
   - Insert and Edit actions producing high-resolution transparent PNG images
   - Seamless preservation on save/reopen, resize, and export (PDF/PPTX)
*/
(function (RPE) {
  'use strict';

  const EQ = (RPE.equation = {});

  // Common equation templates for quick insertion
  const SNIPPETS = [
    { label: 'Fraction', tex: '\\frac{a}{b}' },
    { label: 'Power', tex: 'x^{2}' },
    { label: 'Subscript', tex: 'x_{i}' },
    { label: 'Sqrt', tex: '\\sqrt{x}' },
    { label: 'Integral', tex: '\\int_{a}^{b} f(x) \\, dx' },
    { label: 'Sum', tex: '\\sum_{i=1}^{n} x_i' },
    { label: 'Greek', tex: '\\alpha + \\beta = \\gamma' },
    { label: 'Matrix', tex: '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}' },
    { label: 'Cases', tex: '\\begin{cases} x & x \\ge 0 \\\\ -x & x < 0 \\end{cases}' }
  ];

  EQ.SNIPPETS = SNIPPETS;

  /**
   * Calculates the perceived luminance of an RGB hex string (0 to 1).
   */
  function getLuminance(hex) {
    if (!hex || typeof hex !== 'string') return 1.0;
    let s = hex.trim().replace(/^#/, '');
    if (s.length === 3) s = s.split('').map((c) => c + c).join('');
    if (s.length !== 6) return 1.0;
    const r = parseInt(s.slice(0, 2), 16) / 255;
    const g = parseInt(s.slice(2, 4), 16) / 255;
    const b = parseInt(s.slice(4, 6), 16) / 255;
    const a = [r, g, b].map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return a[0] * 0.2126 + a[1] * 0.7152 + a[2] * 0.0722;
  }

  EQ.getLuminance = getLuminance;

  /**
   * Determines the optimal contrasting foreground color based on background luminance.
   * If background is dark (luminance < 0.4), returns white '#FFFFFF'; else dark '#1E2128'.
   */
  function defaultContrastColor(bgHex) {
    const lum = getLuminance(bgHex);
    return lum < 0.4 ? '#FFFFFF' : '#1E2128';
  }

  EQ.defaultContrastColor = defaultContrastColor;

  /**
   * Resolves the current slide's background color.
   */
  function currentSlideBg() {
    const S = RPE.store;
    if (!S) return '#FFFFFF';
    const slide = S.activeSlide && S.activeSlide();
    const doc = S.doc;
    const th = RPE.themes && RPE.themes.theme ? RPE.themes.theme(doc) : null;
    return (slide && slide.bg) || (th && th.bg) || '#FFFFFF';
  }

  EQ.currentSlideBg = currentSlideBg;

  /**
   * Normalizes equation text to ensure clean math rendering.
   */
  function normalizeInput(src) {
    let s = (src || '').trim();
    if (s.startsWith('\\[') && s.endsWith('\\]')) s = s.slice(2, -2).trim();
    else if (s.startsWith('$$') && s.endsWith('$$')) s = s.slice(2, -2).trim();
    else if (s.startsWith('$') && s.endsWith('$')) s = s.slice(1, -1).trim();
    return s;
  }

  EQ.normalizeInput = normalizeInput;

  /**
   * Opens the compact Equation Editor modal.
   * @param {Object} opts { obj: existingSlideObject (for edit mode) }
   */
  function open(opts) {
    opts = opts || {};
    const U = RPE.ui,
      S = RPE.store,
      h = U.h;
    const editingObj = opts.obj || null;
    const isEdit = !!(editingObj && editingObj.latex);

    const slideBg = currentSlideBg();
    const defaultColor = isEdit
      ? editingObj.equationColor || defaultContrastColor(slideBg)
      : defaultContrastColor(slideBg);

    const state = {
      source: isEdit ? editingObj.latex : '\\int_{-\\infty}^{\\infty} e^{-x^2} dx = \\sqrt{\\pi}',
      color: defaultColor,
      autoColor: !isEdit,
      status: 'idle',
      preview: isEdit ? editingObj.src : null,
      errorMsg: '',
      widthPx: isEdit ? editingObj.w : null,
      heightPx: isEdit ? editingObj.h : null,
      dpi: 300,
      running: false
    };

    // UI elements
    const textarea = h('textarea', {
      class: 'eq-editor__input',
      rows: '4',
      spellcheck: 'false',
      placeholder: 'Type LaTeX math here, e.g. \\frac{a}{b} or \\int_0^1 x^2 dx…'
    });
    textarea.value = state.source;

    const quickBar = h('div', { class: 'eq-editor__quickbar' });
    SNIPPETS.forEach((sn) => {
      const btn = h(
        'button',
        {
          type: 'button',
          class: 'btn btn--ghost btn--sm eq-snippet-btn',
          title: 'Insert ' + sn.label
        },
        sn.label
      );
      btn.addEventListener('click', () => {
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const val = textarea.value;
        textarea.value = val.slice(0, start) + sn.tex + val.slice(end);
        textarea.selectionStart = textarea.selectionEnd = start + sn.tex.length;
        textarea.focus();
        scheduleCompile();
      });
      quickBar.appendChild(btn);
    });

    // Color picker row
    const colorInput = h('input', {
      type: 'color',
      class: 'eq-editor__color-input',
      value: state.color.startsWith('#') && state.color.length === 7 ? state.color : '#000000',
      'aria-label': 'Foreground equation color'
    });
    const autoColorBtn = h(
      'button',
      {
        type: 'button',
        class: 'btn btn--ghost btn--sm',
        title: 'Reset to high-contrast foreground based on slide background'
      },
      'Auto Contrast'
    );
    const colorLabel = h(
      'span',
      { class: 'eq-editor__color-label' },
      state.color.toUpperCase()
    );

    autoColorBtn.addEventListener('click', () => {
      state.autoColor = true;
      const c = defaultContrastColor(slideBg);
      state.color = c;
      colorInput.value = c.startsWith('#') && c.length === 7 ? c : '#000000';
      colorLabel.textContent = c.toUpperCase();
      scheduleCompile(true);
    });

    colorInput.addEventListener('input', () => {
      state.autoColor = false;
      state.color = colorInput.value;
      colorLabel.textContent = state.color.toUpperCase();
      scheduleCompile();
    });

    const colorRow = h(
      'div',
      { class: 'eq-editor__color-row' },
      h('label', { class: 'eq-editor__field-label' }, 'Color:'),
      colorInput,
      colorLabel,
      autoColorBtn,
      h(
        'span',
        { class: 'eq-editor__bg-hint' },
        `Slide background: ${slideBg}`
      )
    );

    // Preview area with a transparent checkerboard / slide background contrast preview
    const previewStage = h('div', { class: 'eq-editor__stage' });
    previewStage.style.backgroundColor = slideBg;

    const previewImg = h('img', {
      class: 'eq-editor__preview-img',
      alt: 'Rendered LaTeX equation preview',
      hidden: !state.preview
    });
    if (state.preview) previewImg.src = state.preview;

    const previewPlaceholder = h(
      'div',
      {
        class: 'eq-editor__placeholder',
        hidden: !!state.preview
      },
      'Enter LaTeX above to render preview'
    );

    const spinner = h('div', {
      class: 'fe__spin eq-editor__spin',
      hidden: true
    });
    previewStage.append(previewPlaceholder, previewImg, spinner);

    // Diagnostics / Error notification
    const errorBanner = h('div', {
      class: 'eq-editor__error',
      role: 'alert',
      hidden: true
    });

    const body = h(
      'div',
      { class: 'eq-editor' },
      h('div', { class: 'eq-editor__section' }, h('label', { class: 'eq-editor__field-label' }, 'LaTeX Equation Input (Math Mode):'), quickBar, textarea),
      colorRow,
      h('div', { class: 'eq-editor__section' }, h('label', { class: 'eq-editor__field-label' }, 'Preview (Transparent PNG over Slide Background):'), previewStage, errorBanner)
    );

    let compileTimeout = null;
    let abortController = null;

    async function runCompile() {
      const src = textarea.value.trim();
      if (!src) {
        state.status = 'empty';
        state.preview = null;
        previewImg.hidden = true;
        previewPlaceholder.hidden = false;
        errorBanner.hidden = true;
        spinner.hidden = true;
        return;
      }

      if (abortController) {
        abortController.abort();
      }
      abortController = new AbortController();

      spinner.hidden = false;
      state.running = true;

      try {
        const res = await RPE.backend.request(
          'figures.latex.equation',
          {
            source: src,
            color: state.color,
            dpi: state.dpi,
            signal: abortController.signal
          }
        );

        spinner.hidden = true;
        state.running = false;

        if (res && res.ok && res.data && res.data.ok) {
          const d = res.data;
          state.status = 'ok';
          state.preview = d.preview;
          state.widthPx = d.widthPx;
          state.heightPx = d.heightPx;
          previewImg.src = d.preview;
          previewImg.hidden = false;
          previewPlaceholder.hidden = true;
          errorBanner.hidden = true;
        } else {
          state.status = 'error';
          const msg =
            (res && res.data && res.data.message) ||
            (res && res.message) ||
            'LaTeX compilation failed.';
          errorBanner.textContent = msg;
          errorBanner.hidden = false;
        }
      } catch (err) {
        spinner.hidden = true;
        state.running = false;
        errorBanner.textContent = 'Error: ' + err.message;
        errorBanner.hidden = false;
      }
    }

    function scheduleCompile(immediate) {
      if (compileTimeout) clearTimeout(compileTimeout);
      if (immediate) {
        runCompile();
      } else {
        compileTimeout = setTimeout(runCompile, 450);
      }
    }

    textarea.addEventListener('input', () => {
      state.source = textarea.value;
      scheduleCompile();
    });

    // Enter / Ctrl+Enter shortcuts
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        doInsert();
      }
    });

    async function doInsert() {
      const src = textarea.value.trim();
      if (!src) {
        U.toast('LaTeX equation source is empty.', { kind: 'warn' });
        return;
      }

      if (!state.preview || state.status !== 'ok') {
        await runCompile();
        if (state.status !== 'ok' || !state.preview) {
          U.toast('Please fix LaTeX compilation errors before inserting.', { kind: 'warn' });
          return;
        }
      }

      // Calculate placement & dimensions on slide
      const aspect = (state.widthPx || 300) / (state.heightPx || 100);
      // Native display width based on 96 DPI screen resolution vs 300 DPI render resolution
      const targetW = Math.max(60, Math.min(800, Math.round(((state.widthPx || 300) / state.dpi) * 96)));
      const targetH = Math.max(24, Math.round(targetW / aspect));

      if (isEdit) {
        // Update existing equation object
        S.mutate('Edit Equation', () => {
          Object.assign(editingObj, {
            src: state.preview,
            latex: src,
            equationColor: state.color,
            alt: `Equation: ${src}`,
            name: `Equation: ${src.slice(0, 30)}`,
            aspect: aspect,
            h: Math.round(editingObj.w / aspect)
          });
        });
        U.toast('Equation updated.');
      } else {
        // Insert new object
        const docSize = S.doc.size;
        const placeX = Math.round((docSize.w - targetW) / 2);
        const placeY = Math.round((docSize.h - targetH) / 2);

        const newObj = {
          id: S.uid('o'),
          type: 'image',
          role: 'equation',
          x: placeX,
          y: placeY,
          w: targetW,
          h: targetH,
          aspect: aspect,
          src: state.preview,
          latex: src,
          equationColor: state.color,
          name: `Equation: ${src.slice(0, 30)}`,
          alt: `Equation: ${src}`
        };

        RPE.commands.addObject(newObj, 'equation');
        U.toast('Equation inserted.');
      }

      if (dlg) dlg.close();
    }

    const dlg = U.dialog({
      title: isEdit ? 'Edit LaTeX Equation' : 'Insert LaTeX Equation',
      icon: 'sigma',
      width: 580,
      dismiss: 'backdrop',
      body,
      focus: '.eq-editor__input',
      buttons: [
        { label: 'Cancel', kind: 'ghost', value: 'cancel' },
        {
          label: isEdit ? 'Apply' : 'Insert',
          kind: 'primary',
          id: 'insertBtn',
          onClick: () => {
            doInsert();
            return false;
          }
        }
      ],
      onClose() {
        if (compileTimeout) clearTimeout(compileTimeout);
        if (abortController) abortController.abort();
      }
    });

    // Run initial compile if editing or default snippet
    scheduleCompile(true);

    return { dlg, state };
  }

  EQ.open = open;
})(window.RPE = window.RPE || {});
