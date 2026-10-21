/* seed.js — demonstration content: a small, plausible research talk.
   Coordinates are logical slide pixels on a 1280 × 720 widescreen slide. */
(function (RPE) {
  'use strict';
  const uid = (p) => RPE.store.uid(p);
  const P = (...lines) => lines.map((l) => `<p>${l}</p>`).join('');

  function text(role, x, y, w, h, html, o) {
    return Object.assign({ id: uid('o'), type: 'text', role, x, y, w, h, html, fontSize: 24, align: 'left', lineHeight: 1.2, vAlign: 'top' }, o || {});
  }
  const title = (t, o) => text('title', 64, 54, 1152, 100, P(t), Object.assign({ fontSize: 34, vAlign: 'middle' }, o));
  const slide = (layout, objects, notes) => ({ id: uid('s'), layout, notes: notes || '', objects });

  function createDeck(opts) {
    opts = opts || {};
    const doc = { id: uid('d'), title: 'Untitled Presentation', size: { w: 1280, h: 720 }, themeId: 'journal', typeId: 'outfit', paletteId: 'burgundy', slides: [], comments: [] };

    if (opts.blank) {
      const t = RPE.themes.layoutObjects('title', doc.size);
      t[0].html = P('Presentation title'); t[1].html = P('Author · Affiliation · Date');
      doc.slides.push({ id: uid('s'), layout: 'title', notes: '', objects: t });
      return doc;
    }

    /* 1 — title */
    const s1 = slide('title', [
      text('title', 116, 190, 1060, 190, P('Dose–Response Dynamics of a Kinase Inhibitor Panel'), { fontSize: 46, vAlign: 'bottom' }),
      text('subtitle', 116, 404, 1040, 90, P('Group meeting · A. Researcher, Department of Biochemistry', 'October 13, 2026'), { fontSize: 22 })
    ], 'Welcome. Frame the question: how do potency and efficacy vary across cell lines for the same compound set?');

    /* 2 — outline */
    const s2 = slide('titleContent', [
      title('Outline'),
      text('body', 64, 190, 1000, 400, P('Background and hypothesis', 'Assay workflow', 'Dose–response across cell lines', 'Statistical summary and next steps'), { list: 'number', fontSize: 26, lineHeight: 1.45 })
    ]);

    /* 3 — background (intentionally a little long and with a small footnote so Research Checks have something to find) */
    const s3 = slide('contentFigure', [
      title('Background and hypothesis'),
      text('body', 64, 190, 560, 300, P('Kinase X drives proliferation in several epithelial tumour models', 'Existing inhibitors show uneven potency between cell lines', 'Hypothesis: sensitivity tracks baseline pathway activation', 'Aim: quantify EC50 and maximal effect across a panel of three lines', 'Readouts are normalised to vehicle controls on each plate'), { list: 'bullet', fontSize: 22, lineHeight: 1.3 }),
      { id: uid('o'), type: 'image', role: 'figure', x: 690, y: 190, w: 526, h: 350, name: 'Pathway schematic', alt: '', src: null },
      text('footnote', 690, 556, 526, 30, P('Schematic adapted from Smith et al., 2024.'), { fontSize: 10, role: 'footnote' })
    ], 'Keep this short. The schematic still needs a final image and a figure caption.');

    /* 4 — methods workflow built from shapes */
    const steps = [['Seed cells', '384-well plates', 'Day 0'], ['Titrate compound', '10-point series', 'Day 1'], ['Viability readout', '72 h exposure', 'Day 4'], ['Fit curves', '4-parameter logistic', 'Day 4–5']];
    const wf = [title('Assay workflow')];
    steps.forEach((s, i) => {
      const x = 64 + i * 307;
      wf.push({ id: uid('o'), type: 'shape', shape: 'rounded', x, y: 230, w: 230, h: 130, fill: i === 3 ? 'accent' : 'transparent', stroke: 'accent', strokeWidth: 2, html: P(`<b>${s[0]}</b>`, s[1]), fontSize: 18, align: 'center', color: i === 3 ? '#FFFFFF' : null, vAlign: 'middle', lineHeight: 1.25 });
      wf.push(text('caption', x, 372, 230, 32, P(s[2]), { fontSize: 16, align: 'center', role: 'caption' }));
      if (i < 3) wf.push({ id: uid('o'), type: 'shape', shape: 'arrow', x: x + 246, y: 276, w: 46, h: 38, fill: 'accent2', stroke: 'transparent', strokeWidth: 0, html: '' });
    });
    wf.push(text('text', 64, 470, 1152, 120, P('All conditions in triplicate; vehicle (0.1% DMSO) and staurosporine controls on every plate.', 'Curves fitted per replicate, then summarised as mean ± SD.'), { fontSize: 22, lineHeight: 1.35 }));
    const s4 = slide('titleOnly', wf);

    /* 5 — dose-response potency (text only: figures are rendered by the backend, so the seed deck carries none) */
    const s5 = slide('titleOnly', [
      title('Dose–response potency across cell lines'),
      text('body', 64, 196, 1152, 330, P('<b>EC50 (µM)</b>', 'HCT116 · 0.42', 'A549 · 2.24', 'MCF7 · 10.0', 'Curves share a similar slope but separate by more than an order of magnitude in potency.'), { fontSize: 24, lineHeight: 1.4 })
    ], 'Point out the order-of-magnitude spread in EC50 between HCT116 and MCF7.');

    /* 6 — statistics table */
    const s6 = slide('titleOnly', [
      title('Statistical summary'),
      { id: uid('o'), type: 'table', x: 64, y: 190, w: 1152, h: 270, headerRow: true, banded: true, fontSize: 18, cells: [['Cell line', 'EC50 (µM)', '95% CI', 'n'], ['HCT116', '0.42', '0.35–0.51', '3'], ['A549', '2.24', '1.80–2.79', '3'], ['MCF7', '10.0', '8.1–12.3', '3'], ['HeLa', '1.30', '1.02–1.66', '3']], caption: '' },
      text('caption', 64, 470, 1152, 30, P('<b>Table 1.</b> Potency estimates from 4-parameter logistic fits.'), { fontSize: 14, role: 'caption' }),
      text('footnote', 64, 640, 1152, 28, P('Mann–Whitney U test, α = 0.05; replicates are independent plates.'), { fontSize: 12, role: 'footnote' })
    ]);

    /* 7 — summary */
    const s7 = slide('titleContent', [
      title('Summary and next steps'),
      text('body', 64, 190, 1152, 420, P('Potency differs by more than 20× across the three cell lines', 'Every condition was run in triplicate on each plate', 'Next: extend to the full 12-line panel', 'Next: link EC50 to baseline pathway activity'), { list: 'bullet', fontSize: 26, lineHeight: 1.4 })
    ], 'Close with the proposed 12-line panel and the pathway-activity analysis.');

    doc.slides = [s1, s2, s3, s4, s5, s6, s7];
    doc.comments = [
      { id: uid('c'), slideId: s5.id, author: 'Reviewer A', text: 'State how EC50 was estimated (fit model, software) on this slide.', ts: Date.now() - 86400000, resolved: false },
      { id: uid('c'), slideId: s6.id, author: 'Advisor', text: 'Add exact p-values next to the Mann–Whitney footnote.', ts: Date.now() - 3600000 * 5, resolved: false }
    ];
    return doc;
  }

  RPE.seed = { createDeck };
})(window.RPE = window.RPE || {});
