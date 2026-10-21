"""Heatmap script generation (docs/FIGURES_CONTRACT.md s4h).

Two modes share one drawing path (``pcolormesh`` on a masked matrix):
  matrix       the numeric cells ARE the picture; row labels = ``mapping.x`` column, column labels = ``mapping.y`` names.
  correlation  pairwise Pearson / Spearman coefficients between the chosen numeric columns, computed INSIDE the script.
Missing / undefined cells are masked, drawn as light gray with a hatch and explained in a legend note; they are never
filled in. Cells of a hidden triangle are simply blank.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List

import numpy as np

from backend.figures.codegen.common import (
    CodegenError, GeneratedScript, Issue, assemble, emit_axes, emit_data, emit_figure, emit_header, emit_rcparams,
    issue, lit, section, Fragment, extra_imports, rc_items,
)
from backend.figures.dataset import to_matrix

MAX_CELLS = 250_000          # matrix mode: rows x columns
MAX_ANNOTATED = 2_500        # more annotated cells than this are unreadable: annotations are skipped (warning)
CROWDED = 60                 # tick labels per axis above which the labels will collide (warning)
MIN_PAIRS = 3                # a correlation needs at least this many rows where both columns have a value
MISSING_COLOR = "#E6E6E6"
MISSING_EDGE = "#9A9A9A"
DIVERGING = {"RdBu_r", "coolwarm"}
METHOD_LABEL = {"pearson": "Pearson r", "spearman": "Spearman ρ"}


def _label(value: Any) -> str:
    if value is None:
        return "(no label)"
    return value if isinstance(value, str) else format(value, "g")


def _corr_matrix(columns: np.ndarray, method: str) -> np.ndarray:
    """Pairwise-complete correlation, NaN where undefined (same rule as the generated script)."""
    from scipy import stats
    k = columns.shape[1]
    out = np.full((k, k), np.nan)
    for i in range(k):
        for j in range(i, k):
            a, b = columns[:, i], columns[:, j]
            ok = ~(np.isnan(a) | np.isnan(b))
            a, b = a[ok], b[ok]
            if a.size < MIN_PAIRS or np.ptp(a) == 0 or np.ptp(b) == 0:
                continue
            r = np.corrcoef(a, b)[0, 1] if method == "pearson" else stats.spearmanr(a, b)[0]
            out[i, j] = out[j, i] = float(np.clip(r, -1.0, 1.0))
    return out


def _hidden_mask(k: int, triangle: str) -> np.ndarray:
    if triangle == "lower":
        return np.triu(np.ones((k, k), dtype=bool), 1)
    if triangle == "upper":
        return np.tril(np.ones((k, k), dtype=bool), -1)
    return np.zeros((k, k), dtype=bool)


def _plan_limits(visible: np.ndarray, options: Dict[str, Any], correlation: bool, cmap: str, notes: List[Issue]):
    """(vmin, vmax, centered): fixed limits win, auto = [-1, 1] for correlation, else the data range."""
    if correlation:
        auto_low, auto_high = -1.0, 1.0
    else:
        auto_low, auto_high = float(visible.min()), float(visible.max())
        if auto_low == auto_high:
            notes.append(issue("info", "constant_matrix",
                               f"All values are equal ({auto_low:g}), so the colour scale was widened by 0.5 each side."))
            auto_low, auto_high = auto_low - 0.5, auto_high + 0.5
    vmin = options["vmin"] if options["vmin"] is not None else auto_low
    vmax = options["vmax"] if options["vmax"] is not None else auto_high
    if not vmin < vmax:
        raise CodegenError([issue("error", "vlimits_invalid",
                                  f"The colour scale minimum ({vmin:g}) must be below the maximum ({vmax:g}).")])
    below, above = int((visible < vmin).sum()), int((visible > vmax).sum())
    if below or above:
        notes.append(issue("info", "values_clipped",
                           f"{below + above} cell{'s' if below + above > 1 else ''} lie outside the colour scale "
                           f"{vmin:g} to {vmax:g} and are drawn in the end colour (marked by an arrow on the colourbar)."))
    centered = correlation and cmap in DIVERGING and vmin < 0 < vmax and (vmin, vmax) != (-vmax, vmax)
    if centered:
        notes.append(issue("info", "centered_at_zero", "The colour scale is asymmetric; zero is kept at the centre colour."))
    return vmin, vmax, centered, below, above


def generate(record: Dict[str, Any]) -> GeneratedScript:
    config, dataset = record["config"], record["dataset"]
    mapping, appearance, options = config["mapping"], config["appearance"], config["options"]
    correlation = options["heatmapMode"] == "correlation"
    notes: List[Issue] = []

    default_columns = [c["name"] for c in dataset["columns"] if c["type"] == "number"]
    columns: List[str] = list(mapping["y"]) or default_columns
    duplicated = sorted({c for c in columns if columns.count(c) > 1})
    if duplicated:
        raise CodegenError([issue("error", "duplicate_column",
                                  f"Column '{duplicated[0]}' is chosen more than once; list each column only once.",
                                  column=duplicated[0])])
    data = to_matrix(dataset, columns)                       # rows x columns, NaN = missing
    n_rows, n_cols = data.shape

    # ---- labels
    if correlation:
        if mapping["x"]:
            notes.append(issue("warning", "x_ignored",
                               f"A correlation heatmap is labelled by its columns; '{mapping['x']}' is not used.",
                               column=mapping["x"]))
        row_labels = col_labels = list(columns)
        row_axis_label = ""
    else:
        if mapping["x"]:
            position = [c["name"] for c in dataset["columns"]].index(mapping["x"])
            row_labels = [_label(r[position]) for r in dataset["rows"]]
            row_axis_label = mapping["x"]
        else:
            row_labels, row_axis_label = [str(i + 1) for i in range(n_rows)], "Row"
        col_labels = list(columns)
        if len(set(row_labels)) < len(row_labels):
            notes.append(issue("info", "duplicate_row_labels", "Some row labels repeat; rows are still drawn separately."))
        if n_rows * n_cols > MAX_CELLS:
            raise CodegenError([issue("error", "too_many_cells",
                                      f"A heatmap of {n_rows} rows x {n_cols} columns has {n_rows * n_cols:,} cells; "
                                      f"the limit is {MAX_CELLS:,}. Choose fewer rows or columns.")])

    # ---- the drawn matrix (computed here only to validate and report; the script recomputes it itself)
    if correlation:
        matrix = _corr_matrix(data, options["corrMethod"])
        hidden = _hidden_mask(len(columns), options["corrTriangle"])
        undefined = np.isnan(matrix) & ~hidden
        defined_off_diagonal = ~np.isnan(matrix) & ~np.eye(len(columns), dtype=bool)
        if not defined_off_diagonal.any():
            raise CodegenError([issue("error", "no_defined_correlations",
                                      "No correlation can be computed: every pair of columns has fewer than "
                                      f"{MIN_PAIRS} rows with both values, or a column that never changes.")])
        if undefined.any():
            pairs = [f"{columns[i]} / {columns[j]}" for i, j in np.argwhere(np.triu(undefined))[:5]]
            notes.append(issue("warning", "undefined_correlations",
                               f"{int(np.triu(undefined).sum())} correlation{'s are' if np.triu(undefined).sum() > 1 else ' is'} "
                               f"undefined (fewer than {MIN_PAIRS} shared values or no variation) and left masked: "
                               + "; ".join(pairs) + ("; ..." if np.triu(undefined).sum() > 5 else "") + "."))
        notes.append(issue("info", "corr_method",
                           f"{options['corrMethod'].capitalize()} coefficients use pairwise complete observations: each pair "
                           f"uses only the rows where both columns have a value (at least {MIN_PAIRS})."))
    else:
        matrix, hidden = data, np.zeros(data.shape, dtype=bool)
        undefined = np.isnan(matrix)
        if undefined.all():
            raise CodegenError([issue("error", "no_numeric_values",
                                      "The selected columns contain no numbers, so there is nothing to draw.")])
        if undefined.any():
            notes.append(issue("warning", "missing_cells",
                               f"{int(undefined.sum())} empty cell{'s' if undefined.sum() > 1 else ''} are masked "
                               "(gray, hatched, explained in the legend); nothing is filled in."))

    cmap = appearance["cmap"] or ("RdBu_r" if correlation else "viridis")
    visible = matrix[~np.isnan(matrix) & ~hidden]
    vmin, vmax, centered, below, above = _plan_limits(visible, options, correlation, cmap, notes)
    extend = "both" if below and above else "min" if below else "max" if above else "neither"

    shown_cells = int((~hidden & ~np.isnan(matrix)).sum())
    annotate = options["annotate"]
    if annotate and shown_cells > MAX_ANNOTATED:
        annotate = False
        notes.append(issue("warning", "annotations_skipped",
                           f"{shown_cells:,} cells are too many to annotate legibly (limit {MAX_ANNOTATED:,}); "
                           "the numbers were left out."))
    if max(len(row_labels), len(col_labels)) > CROWDED:
        notes.append(issue("warning", "labels_crowded",
                           f"With more than {CROWDED} labels on an axis the tick labels will overlap; "
                           "use fewer rows or columns or a larger figure."))
    has_missing = bool(undefined.any())

    # ---- script
    uses = [(c, "y") for c in columns]
    data_lines, files, var = emit_data(dataset, uses)
    spearman = correlation and options["corrMethod"] == "spearman"
    header = emit_header(record, "correlation heatmap" if correlation else "heatmap", uses_pandas=bool(files),
                         data_file=bool(files))
    header += ["from matplotlib.colors import Normalize" + (", TwoSlopeNorm" if centered else "")]
    header += ["from matplotlib.collections import PatchCollection", "from matplotlib.patches import Patch, Rectangle"] \
        if has_missing else []
    if spearman:
        header.insert(2, "# Spearman correlation also needs scipy (scipy.stats.spearmanr).")
        header.append("from scipy import stats")
    stacked = "np.column_stack([" + ", ".join(var[c] for c in columns) + "])"

    if correlation:
        coefficient = ("float(stats.spearmanr(a, b)[0])" if spearman else "float(np.corrcoef(a, b)[0, 1])")
        build = [
            f"MIN_PAIRS = {MIN_PAIRS}  # rows where both columns have a value",
            f"data = {stacked}",
            "",
            "def pair_corr(a, b):",
            "    ok = ~(np.isnan(a) | np.isnan(b))  # pairwise complete observations",
            "    a, b = a[ok], b[ok]",
            "    if a.size < MIN_PAIRS or np.ptp(a) == 0 or np.ptp(b) == 0:",
            "        return np.nan  # undefined: too few shared values or no variation",
            f"    return float(np.clip({coefficient}, -1.0, 1.0))",
            "",
            "k = data.shape[1]",
            "matrix = np.full((k, k), np.nan)",
            "for i in range(k):",
            "    for j in range(i, k):",
            "        matrix[i, j] = matrix[j, i] = pair_corr(data[:, i], data[:, j])",
            f"hidden = {'np.zeros((k, k), dtype=bool)' if options['corrTriangle'] == 'full' else 'np.triu(np.ones((k, k), dtype=bool), 1)' if options['corrTriangle'] == 'lower' else 'np.tril(np.ones((k, k), dtype=bool), -1)'}  # cells of the hidden triangle stay blank",
        ]
    else:
        build = [f"matrix = {stacked}", "hidden = np.zeros(matrix.shape, dtype=bool)"]
    build += ["missing = np.isnan(matrix) & ~hidden  # masked, never filled in",
              "plotted = np.ma.masked_array(matrix, mask=np.isnan(matrix) | hidden)",
              f"row_labels = {lit(row_labels)}",
              f"col_labels = {lit(col_labels)}"]

    border = (f"edgecolors={lit(options['cellBorderColor'])}, linewidth={lit(options['cellBorderWidth'])}"
              if options["cellBorders"] and options["cellBorderWidth"] > 0 else "edgecolors='none', linewidth=0")
    norm = (f"TwoSlopeNorm(vmin={lit(vmin)}, vcenter=0.0, vmax={lit(vmax)})" if centered
            else f"Normalize(vmin={lit(vmin)}, vmax={lit(vmax)})")
    draw = [f"vmin, vmax = {lit(vmin)}, {lit(vmax)}",
            f"cmap = plt.get_cmap({lit(cmap)}).copy()",
            f"norm = {norm}",
            f"mesh = ax.pcolormesh(plotted, cmap=cmap, norm=norm, {border})"]
    if has_missing:
        draw += ["gap = [Rectangle((j, i), 1, 1) for i, j in np.argwhere(missing)]",
                 f"ax.add_collection(PatchCollection(gap, facecolor={lit(MISSING_COLOR)}, edgecolor={lit(MISSING_EDGE)}, "
                 "linewidth=0, hatch='////'))"]
    draw += ["ax.set_xlim(0, matrix.shape[1])",
             "ax.set_ylim(matrix.shape[0], 0)  # first row on top",
             f"ax.set_aspect({lit('equal' if correlation else 'auto')})",
             "ax.set_xticks(np.arange(matrix.shape[1]) + 0.5, labels=col_labels)",
             "ax.set_yticks(np.arange(matrix.shape[0]) + 0.5, labels=row_labels)",
             "ax.tick_params(length=0)"]
    if options["colorbar"]:
        label = options["colorbarLabel"] or (METHOD_LABEL[options["corrMethod"]] if correlation else "")
        draw += [f"cbar = fig.colorbar(mesh, ax=ax, extend={lit(extend)})"]
        if label:
            draw.append(f"cbar.set_label({lit(label)})")
        draw.append("cbar.outline.set_linewidth(0.5)")

    notes_lines: List[str] = []
    if annotate:
        size = options["annotateSize"] or round(appearance["fontSize"] * 0.8, 1)
        notes_lines = [
            "for i in range(matrix.shape[0]):",
            "    for j in range(matrix.shape[1]):",
            "        if missing[i, j] or hidden[i, j]:",
            "            continue",
            "        r, g, b, _ = cmap(norm(matrix[i, j]))",
            "        ink = 'black' if 0.299 * r + 0.587 * g + 0.114 * b > 0.5 else 'white'  # readable on the cell colour",
            f"        ax.text(j + 0.5, i + 0.5, f'{{round(float(matrix[i, j]), {options['annotatePrecision']}) + 0.0:.{options['annotatePrecision']}f}}', ha='center', va='center', "
            f"fontsize={lit(size)}, color=ink)"]
    figure = emit_figure(record)
    legend: List[str] = []
    if has_missing:
        engine = ("rect=(0, 0.08, 1, 0.92)" if appearance["layout"] == "constrained" else "rect=(0, 0.08, 1, 1)")
        figure.append(f"fig.get_layout_engine().set({engine})  # room for the legend note under the plot")
        text = "Undefined correlation" if correlation else "Missing value"
        legend = [f"fig.legend(handles=[Patch(facecolor={lit(MISSING_COLOR)}, edgecolor={lit(MISSING_EDGE)}, hatch='////', "
                  f"label={lit(text)})], loc='lower center', frameon=False)"]

    axes_options = {**options, "xScale": "linear", "yScale": "linear", "xLim": None, "yLim": None}
    axes_lines = emit_axes(appearance, axes_options, "", row_axis_label)
    rc_lines, rc_notes = emit_rcparams(appearance)
    notes += rc_notes

    source = assemble(
        header,
        [section("Data"), *data_lines],
        [section("Matrix"), *build],
        [section("Style"), *rc_lines],
        [section("Figure"), *figure],
        [section("Heatmap"), *draw, *notes_lines],
        [section("Axes and legend"), *axes_lines, *legend, "", "plt.show()"],
    )
    imports = extra_imports(header)
    key: List[str] = []                       # as a fragment the missing-value key sits under the tick labels of the axes
    if has_missing:
        tick = appearance["tickSize"] or round(appearance["fontSize"] * 0.9, 1)
        angle = abs(math.sin(math.radians(appearance["xTickRotation"] or 0)))
        longest = max((len(str(c)) for c in col_labels), default=0)
        offset = round(tick * 1.3 + 8 + longest * tick * 0.55 * angle
                       + (1.5 * (appearance["labelSize"] or appearance["fontSize"]) if appearance["xLabel"] else 0), 1)
        imports.append("from matplotlib.transforms import offset_copy")
        key = [legend[0].replace("fig.legend(", "ax.legend(", 1).replace(
            "loc='lower center', frameon=False)",
            f"loc='upper center', bbox_to_anchor=(0.5, 0),\n    bbox_transform=offset_copy(ax.transAxes, fig=fig, y=-{offset}, units='points'), frameon=False)")]
    fragment = Fragment(setup=[*data_lines, *build], draw=[*draw, *notes_lines, *axes_lines, *key],
                        style=rc_items(appearance)[0], imports=imports)
    return GeneratedScript(source=source, files=files, warnings=notes, fragment=fragment)
