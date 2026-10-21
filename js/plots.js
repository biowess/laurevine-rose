/* plots.js — plot-type metadata shared by the UI: KINDS (tiles / labels / icons), DATASETS and LABELS (default labels per kind),
   FIG_LAYOUTS (multi-panel layout rects, kept equal to the backend layout table by tests/test_figures_composite.py) and defaultsFor.
   Nothing here draws a chart: every plot and figure is a backend-rendered PNG (docs/FIGURES_CONTRACT.md s1). */
(function (RPE) {
  'use strict';

  const KINDS = {
    line: { label: 'Line', icon: 'chart-line' },
    scatter: { label: 'Scatter', icon: 'chart-scatter' },
    bar: { label: 'Bar', icon: 'chart-column' },
    hist: { label: 'Histogram', icon: 'chart-no-axes-column' },
    box: { label: 'Box plot', icon: 'chart-candlestick' },
    heatmap: { label: 'Heatmap', icon: 'grid-3x3' }
  };
  const DATASETS = {
    line: [{ id: 'doseResponse', label: 'Dose–response, 3 cell lines' }, { id: 'timeSeries', label: 'Growth time series' }],
    scatter: [{ id: 'correlated', label: 'Two correlated groups' }],
    bar: [{ id: 'groups', label: 'Treatment groups' }],
    hist: [{ id: 'distribution', label: 'Residual distribution' }],
    box: [{ id: 'groups', label: 'Condition comparison' }],
    heatmap: [{ id: 'correlation', label: 'Correlation matrix' }]
  };
  const LABELS = {
    doseResponse: ['log10 [inhibitor] (µM)', 'Viability (%)'], timeSeries: ['Time (h)', 'OD600'],
    correlated: ['Marker expression (a.u.)', 'Response (a.u.)'], groups: ['Condition', 'Signal (a.u.)'],
    distribution: ['Residual (a.u.)', 'Count'], correlation: ['', '']
  };

  const FIG_LAYOUTS = {
    '2x2': { label: '2 × 2', rects: [[0, 0, .5, .5], [.5, 0, .5, .5], [0, .5, .5, .5], [.5, .5, .5, .5]] },
    '1x2': { label: '1 × 2', rects: [[0, 0, .5, 1], [.5, 0, .5, 1]] },
    '2x1': { label: '2 × 1', rects: [[0, 0, 1, .5], [0, .5, 1, .5]] },
    '1x3': { label: '1 × 3', rects: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]] },
    '1+2': { label: '1 + 2', rects: [[0, 0, .5, 1], [.5, 0, .5, .5], [.5, .5, .5, .5]] },
    '2x3': { label: '2 × 3', rects: [[0, 0, 1 / 3, .5], [1 / 3, 0, 1 / 3, .5], [2 / 3, 0, 1 / 3, .5], [0, .5, 1 / 3, .5], [1 / 3, .5, 1 / 3, .5], [2 / 3, .5, 1 / 3, .5]] }
  };

  function defaultsFor(kind, dataset) {
    const l = LABELS[dataset] || LABELS[(DATASETS[kind] || [{ id: '' }])[0].id] || ['', ''];
    return { xLabel: l[0], yLabel: l[1], dataset: dataset || (DATASETS[kind] || [{ id: '' }])[0].id };
  }

  RPE.plots = { KINDS, DATASETS, FIG_LAYOUTS, defaultsFor };
})(window.RPE = window.RPE || {});
