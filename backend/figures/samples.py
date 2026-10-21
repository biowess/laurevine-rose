"""Deterministic sample datasets, one purposeful set per plot type (docs/FIGURES_CONTRACT.md s3d).

`sample_for(plotType)` -> {plotType, sampleId, label, description, dataset:{columns, rows, origin}, mapping, options}.
`mapping` / `options` are the config patch that draws the sample well; the client merges them into the record.
Values come from fixed seeds and are rounded, so every call returns the same data.
"""
from __future__ import annotations

import math
import random
from typing import Any, Callable, Dict, List, Optional

PLOT_TYPES = ("line", "scatter", "bar", "hist", "box", "heatmap")


def _num(name: str) -> Dict[str, str]:
    return {"name": name, "type": "number"}


def _txt(name: str) -> Dict[str, str]:
    return {"name": name, "type": "text"}


def _r(v: float, n: int = 3) -> float:
    return round(float(v), n)


def _line() -> Dict[str, Any]:
    rng = random.Random(1101)
    doses = [0.01, 0.03, 0.1, 0.3, 1, 3, 10, 30, 100]
    series = {"Compound A": (2.0, 0.9), "Compound B": (8.0, 1.3), "Compound C": (30.0, 0.8)}   # (EC50 in uM, Hill slope)
    cols = [_num("Dose (uM)")]
    for s in series:
        cols += [_num(s), _num(s + " SD")]
    rows: List[List[Any]] = []
    for d in doses:
        row: List[Any] = [d]
        for ec50, hill in series.values():
            resp = 100 * d ** hill / (ec50 ** hill + d ** hill)
            row += [_r(min(100, max(0, resp + rng.gauss(0, 1.2))), 1), _r(2.0 + 0.06 * resp + rng.random() * 1.5, 1)]
        rows.append(row)
    opts = {"series": {s: {"error": "symmetric", "errorCol": s + " SD"} for s in series}, "xScale": "log"}
    return dict(sampleId="dose-response", label="Dose-response", columns=cols, rows=rows,
                description="Response (% of maximum) of three compounds across nine doses; SD columns drive the error bars.",
                mapping={"x": "Dose (uM)", "y": list(series), "group": None, "yErr": None}, options=opts)


def _scatter() -> Dict[str, Any]:
    rng = random.Random(2202)
    rows: List[List[Any]] = []
    for grp, slope, icpt in (("Wild type", 0.55, 4.0), ("Knockout", 0.38, 6.5)):
        for _ in range(30):
            mass = rng.uniform(18, 42)
            rows.append([_r(mass, 1), _r(icpt + slope * mass + rng.gauss(0, 1.1), 2), grp])
    return dict(sampleId="two-group-trend", label="Two groups with trend",
                columns=[_num("Body mass (g)"), _num("Metabolic rate (mL O2/h)"), _txt("Genotype")], rows=rows,
                description="Metabolic rate against body mass for two genotypes (30 animals each), with a linear fit per group.",
                mapping={"x": "Body mass (g)", "y": ["Metabolic rate (mL O2/h)"], "group": "Genotype", "yErr": None},
                options={"fit": "linear", "fitBand": True})


def _bar() -> Dict[str, Any]:
    rng = random.Random(3303)
    treats = {"Vehicle": (10.0, 0.5), "Drug A": (14.0, 4.0), "Drug B": (11.0, 8.0)}      # (day-0 mean, gain per day)
    days = ["Day 1", "Day 3", "Day 7", "Day 14"]
    cols = [_txt("Time point")]
    for t in treats:
        cols += [_num(t), _num(t + " SEM")]
    rows: List[List[Any]] = []
    for i, day in enumerate(days):
        row: List[Any] = [day]
        for base, gain in treats.values():
            mean = base + gain * (0.5 + 1.6 * i) / 2 + rng.gauss(0, 0.4)
            row += [_r(mean, 2), _r(0.35 + 0.08 * mean + rng.random() * 0.25, 2)]
        rows.append(row)
    opts = {"barMode": "grouped", "errorBars": True,
            "series": {t: {"error": "symmetric", "errorCol": t + " SEM"} for t in treats}}
    return dict(sampleId="grouped-treatments", label="Grouped treatments",
                columns=cols, rows=rows,
                description="Tumour volume (mean, arbitrary units) of three treatments at four time points; SEM columns draw the error bars.",
                mapping={"x": "Time point", "y": list(treats), "group": None, "yErr": None}, options=opts)


def _hist() -> Dict[str, Any]:
    rng = random.Random(4404)
    vals = [rng.gauss(-1.1, 0.55) for _ in range(140)] + [rng.gauss(1.4, 0.75) for _ in range(110)]
    rng.shuffle(vals)
    return dict(sampleId="bimodal-residuals", label="Bimodal residuals",
                columns=[_num("Residual (mmol/L)")], rows=[[_r(v, 3)] for v in vals],
                description="250 model residuals drawn from two overlapping populations, so the histogram has two humps.",
                mapping={"x": None, "y": ["Residual (mmol/L)"], "group": None, "yErr": None},
                options={"binMode": "count", "bins": 24})


def _box() -> Dict[str, Any]:
    rng = random.Random(5505)
    spec = [("Control", 50, 8), ("Low dose", 56, 9), ("High dose", 66, 11), ("Combination", 72, 7)]
    rows: List[List[Any]] = []
    for name, mu, sd in spec:
        vals = [rng.gauss(mu, sd) for _ in range(25)]
        vals[3] = mu + 4.6 * sd                           # one high outlier per condition,
        if name in ("Control", "High dose"):
            vals[11] = mu - 4.2 * sd                      # and a low one for two of them
        rows += [[name, _r(v, 1)] for v in vals]
    return dict(sampleId="four-conditions", label="Four conditions",
                columns=[_txt("Condition"), _num("Response (a.u.)")], rows=rows,
                description="25 observations in each of four conditions, with a few deliberate outliers.",
                mapping={"x": None, "y": ["Response (a.u.)"], "group": "Condition", "yErr": None},
                options={"showPoints": True, "showOutliers": True})


def _heatmap() -> Dict[str, Any]:
    rng = random.Random(6606)
    genes = ["GENE1", "GENE2", "GENE3", "GENE4", "GENE5", "GENE6", "GENE7", "GENE8"]
    cols = [_num(c) for c in ("Control 1", "Control 2", "Treated 1", "Treated 2", "Treated 3", "Recovery")]
    rows: List[List[Any]] = []
    for g in genes:
        base, effect = rng.uniform(-0.5, 0.5), rng.uniform(-2.2, 2.2)
        shared = [rng.gauss(0, 0.25) for _ in range(len(cols))]
        rows.append([g] + [_r(base + effect * w + shared[i] + rng.gauss(0, 0.2), 2)
                           for i, w in enumerate((0, 0, 1, 1, 1, 0.4))])
    return dict(sampleId="expression-matrix", label="Expression matrix",
                columns=[_txt("Gene")] + cols, rows=rows,
                description="Log2 fold change of eight genes in six samples. Matrix mode shows the values; switch to correlation to compare the samples.",
                mapping={"x": "Gene", "y": [c["name"] for c in cols], "group": None, "yErr": None},
                options={"heatmapMode": "matrix", "annotate": True, "annotatePrecision": 1})


_BUILDERS: Dict[str, Callable[[], Dict[str, Any]]] = {
    "line": _line, "scatter": _scatter, "bar": _bar, "hist": _hist, "box": _box, "heatmap": _heatmap,
}


def sample_for(plot_type: str) -> Optional[Dict[str, Any]]:
    build = _BUILDERS.get(plot_type)
    if build is None:
        return None
    b = build()
    return {
        "plotType": plot_type, "sampleId": b["sampleId"], "label": b["label"], "description": b["description"],
        "dataset": {"columns": b["columns"], "rows": b["rows"],
                    "origin": {"type": "sample", "label": b["label"], "sampleId": b["sampleId"]}},
        "mapping": b["mapping"], "options": b["options"],
    }
