"""Scatter plot generator (docs/FIGURES_CONTRACT.md s4c, s4d).

One cloud of points per Y column or, with a group column, one per group of the first Y column. A fit is drawn only when
``options.fit`` asks for it; it is computed inside the generated script with numpy.polyfit from the points that have both
an x and a y value, so the script stays the single source of the numbers. Missing values are never filled in.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import numpy as np

from backend.figures.codegen.common import (
    MARKERS, PALETTES, CodegenError, GeneratedScript, Issue, assemble, call, check_log_axes, emit_axes, emit_data,
    emit_figure, emit_header, emit_legend, emit_rcparams, issue, legend_visible, lit, section, series_colors,
    Fragment, extra_imports, rc_items,
)
from backend.figures.dataset import to_matrix

MAX_GROUPS = 50                      # one series per group: more would be unreadable and slow to draw
UNFILLED_MARKERS = ("plus", "cross")  # drawn as strokes, they have no separate outline
NO_GROUP = "(no group)"              # legend label of the rows whose group cell is empty

_EQUATION_HELPER = '''def equation_text(coefficients):
    """The fitted equation as text, highest power first, coefficients rounded to 4 digits, e.g. 'y = 2x² − 3x + 1'."""
    powers = ["", "x", "x²", "x³", "x⁴", "x⁵"]
    degree = len(coefficients) - 1
    text = ""
    for position, coefficient in enumerate(coefficients):
        term = f"{abs(coefficient):.4g}{powers[degree - position]}"
        if position == 0:
            text = ("−" if coefficient < 0 else "") + term
        else:
            text += (" − " if coefficient < 0 else " + ") + term
    return "y = " + text'''


# ------------------------------------------------------------------- helpers
def _label(value: Any) -> Optional[str]:
    """Legend label of one group cell; None = the row has no group value."""
    if value is None or value == "":
        return None
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _percent(level: float) -> str:
    return f"{round(level * 100, 1):g}%"


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def _check_fit(label: str, px: np.ndarray, py: np.ndarray, degree: int, fit_name: str) -> List[Issue]:
    """Errors when the points of one series cannot carry the fit (NaN marks a missing value)."""
    ok = np.isfinite(px) & np.isfinite(py)
    count = int(ok.sum())
    if count <= degree + 1:
        return [issue("error", "fit_too_few_points",
                      f"A {fit_name} needs at least {degree + 2} points with both x and y values, but series '{label}' "
                      f"has {count}. Lower the degree, add data or set Fit to none.")]
    distinct = int(np.unique(px[ok]).size)
    if distinct < degree + 1:
        return [issue("error", "fit_degenerate_x",
                      f"Series '{label}' has only {_plural(distinct, 'distinct x value')}, which is too few for a "
                      f"{fit_name}. Lower the degree or set Fit to none.")]
    if np.ptp(py[ok]) == 0:
        return [issue("error", "fit_constant_y",
                      f"All y values of series '{label}' are equal, so R² is undefined. Set Fit to none or use other data.")]
    return []


def _fit_helpers(degree: int, level: Optional[float], log_x: bool, fit_name: str) -> List[str]:
    """Fit section of the script: constants, ``equation_text`` and ``polynomial_fit`` (scipy only for a band)."""
    grid = "np.geomspace" if log_x else "np.linspace"
    lines = [
        section("Fit"),
        "# Least-squares fit of y on x (numpy.polyfit) to the points that have both values; nothing is filled in.",
        "# R² = 1 - (residual sum of squares) / (total sum of squares).",
    ]
    if level is not None:
        lines.append("# The band is the pointwise confidence interval of the fitted line (not a prediction interval),")
        lines.append("# computed with the t-distribution (scipy.stats.t) and n - (degree + 1) degrees of freedom.")
    lines += [f"FIT_NAME = {lit(fit_name)}", f"FIT_DEGREE = {degree}"]
    if level is not None:
        lines.append(f"BAND_LEVEL = {lit(level)}  # confidence level of the band")
    lines += ["fit_results = []  # per fitted series: coefficients (highest power first), R² and the number of points",
              "", "", *_EQUATION_HELPER.splitlines(), "", ""]
    lines += [
        f"def polynomial_fit(x_values, y_values, degree{', level' if level is not None else ''}):",
        '    """Least-squares polynomial of the given degree on the points that have both an x and a y value."""',
        "    ok = np.isfinite(x_values) & np.isfinite(y_values)",
        "    px, py = x_values[ok], y_values[ok]",
        "    coefficients, covariance = np.polyfit(px, py, degree, cov=True)" if level is not None
        else "    coefficients = np.polyfit(px, py, degree)",
        "    residuals = py - np.polyval(coefficients, px)",
        "    r2 = 1 - np.sum(residuals ** 2) / np.sum((py - py.mean()) ** 2)",
        f"    grid = {grid}(px.min(), px.max(), 200)",
        "    curve = np.polyval(coefficients, grid)",
        '    result = {"coefficients": coefficients, "r2": r2, "points": len(px), "grid": grid, "curve": curve}',
    ]
    if level is not None:
        lines += [
            "    degrees_of_freedom = len(px) - (degree + 1)",
            "    design = np.vander(grid, degree + 1)  # columns in the order of the coefficients",
            '    standard_error = np.sqrt(np.einsum("ij,jk,ik->i", design, covariance, design))',
            "    half_width = stats.t.ppf(0.5 + level / 2, degrees_of_freedom) * standard_error",
            '    result["band"] = (curve - half_width, curve + half_width)',
        ]
    lines += ["    return result", ""]               # the blank line keeps two empty lines before the next section
    return lines


def _point_keywords(appearance: Dict[str, Any], options: Dict[str, Any]) -> List[Any]:
    """Keywords of ``ax.scatter`` (``color`` and ``label`` are the loop variables of the generated script)."""
    marker, edge = options["marker"], options["markerEdgeColor"]
    keywords = [("s", f"{lit(appearance['markerSize'])} ** 2"), ("marker", lit(MARKERS[marker]))]
    if marker in UNFILLED_MARKERS:
        keywords += [("color", "color"), ("linewidths", lit(appearance["lineWidth"]))]
    else:
        keywords += [("facecolors", "color"), ("edgecolors", lit(edge) if edge else "color"),
                     ("linewidths", lit(options["markerEdgeWidth"]))]
    if appearance["alpha"] < 1:
        keywords.append(("alpha", lit(appearance["alpha"])))
    return keywords + [("label", "label"), ("zorder", "2")]


def _indent(lines: List[str]) -> List[str]:
    return [f"    {line}" if line else line for line in lines]


# ------------------------------------------------------------------ generator
def generate(record: Dict[str, Any]) -> GeneratedScript:
    config, dataset = record["config"], record["dataset"]
    mapping, appearance, options = config["mapping"], config["appearance"], config["options"]
    x_column, group_column = mapping["x"], mapping["group"]
    names = [c["name"] for c in dataset["columns"]]
    notes: List[Issue] = []
    errors: List[Issue] = []

    # ---- series: one per Y column, or one per group of the first Y column
    y_columns = list(mapping["y"])
    row_labels: List[Optional[str]] = []
    series: List[Dict[str, Any]] = []                 # {label, y, key (group value, '' = none), rows}
    if group_column:
        if len(y_columns) > 1:
            notes.append(issue("warning", "y_columns_ignored",
                               f"With a group column the plot draws one Y column; '{y_columns[0]}' is used and "
                               f"{_plural(len(y_columns) - 1, 'other Y column')} not drawn."))
        position = names.index(group_column)
        row_labels = [_label(row[position]) for row in dataset["rows"]]
        members: Dict[Optional[str], List[int]] = {}
        for index, label in enumerate(row_labels):
            members.setdefault(label, []).append(index)
        keys = [k for k in members if k is not None] + ([None] if None in members else [])
        if len(keys) > MAX_GROUPS:
            raise CodegenError([issue("error", "too_many_groups",
                                      f"Column '{group_column}' has {len(keys)} distinct values; a scatter plot draws at most "
                                      f"{MAX_GROUPS} groups. Pick a column with fewer groups.", column=group_column)])
        series = [{"label": NO_GROUP if k is None else k, "y": y_columns[0], "key": "" if k is None else k,
                   "rows": np.array(members[k])} for k in keys]
    else:
        all_rows = np.arange(len(dataset["rows"]))
        series = [{"label": y, "y": y, "key": None, "rows": all_rows} for y in y_columns]
    drawn_y = list(dict.fromkeys(s["y"] for s in series))

    colors = series_colors(appearance, len(series))
    palette_size = len(appearance["colors"] or PALETTES[appearance["palette"]])
    if len(series) > palette_size:
        notes.append(issue("warning", "palette_cycled",
                           f"There are more series than palette colours ({palette_size}), so colours repeat. "
                           "Add colours to the palette to tell every series apart."))
    if options["errorBars"] and mapping["yErr"]:
        notes.append(issue("warning", "error_bars_ignored",
                           f"Scatter plots do not draw error bars; column '{mapping['yErr']}' is not used.",
                           column=mapping["yErr"]))
    if options["marker"] in UNFILLED_MARKERS and options["markerEdgeColor"]:
        notes.append(issue("warning", "outline_ignored",
                           f"The '{options['marker']}' marker is drawn as a stroke and has no separate outline."))

    # ---- fit: opt-in only; refused (not guessed) when the points cannot carry it
    fit = options["fit"]
    degree = {"none": 0, "linear": 1, "polynomial": options["fitDegree"]}[fit]
    band = degree > 0 and options["fitBand"]
    level = options["fitLevel"] if band else None
    fit_name = {"none": "", "linear": "Fit (linear)", "polynomial": f"Fit (polynomial, degree {degree})"}[fit]
    if degree:
        long_name = "linear fit" if fit == "linear" else f"degree-{degree} polynomial fit"
        x_values = to_matrix(dataset, [x_column])[:, 0]
        y_values = {y: to_matrix(dataset, [y])[:, 0] for y in drawn_y}
        for s in series:
            errors += _check_fit(s["label"], x_values[s["rows"]], y_values[s["y"]][s["rows"]], degree, long_name)
    errors += check_log_axes(dataset, options, x_column, drawn_y)
    if errors:
        raise CodegenError(errors)

    # ---- data: X, every drawn Y column and, for groups, the group labels as text (also for numeric group columns)
    source = dataset
    uses = [(x_column, "x")] + [(y, "y") for y in drawn_y]
    if group_column:
        label_column = f"{group_column} (group)"
        while label_column in names:
            label_column += "'"
        source = {**dataset, "columns": dataset["columns"] + [{"name": label_column, "type": "text"}],
                  "rows": [row + [label] for row, label in zip(dataset["rows"], row_labels)]}
        uses.append((label_column, "group"))
    data_lines, files, var = emit_data(source, uses)

    # ---- series table of the script: (legend label, x values, y values, colour)
    if group_column:
        data_lines.append(f"group = np.array({var[label_column]})  # '' = the row has no group value")
        entries = [f"    ({lit(s['label'])}, x[group == {lit(s['key'])}], {var[s['y']]}[group == {lit(s['key'])}], {lit(color)}),"
                   for s, color in zip(series, colors)]
    else:
        entries = [f"    ({lit(s['label'])}, x, {var[s['y']]}, {lit(color)})," for s, color in zip(series, colors)]
    series_lines = ["# One entry per series: (legend label, x values, y values, colour).", "series = [", *entries, "]"]

    # ---- drawing loop: points, then the fit line and its band for the same series
    draw = ["handles = []  # legend entries in drawing order: points, fit line, band, next series",
            "for label, sx, sy, color in series:",
            *_indent(call("points = ax.scatter", "sx, sy", _point_keywords(appearance, options))),
            "    handles.append(points)"]
    if degree:
        show_eq, show_r2 = options.get("fitEquation", True), options.get("fitR2", True)   # which parts the legend's second line holds
        fit_text = {(True, True): "f\"{equation_text(result['coefficients'])}, R² = {result['r2']:.3f}\"",
                    (True, False): "equation_text(result['coefficients'])",
                    (False, True): "f\"R² = {result['r2']:.3f}\"", (False, False): ""}[(bool(show_eq), bool(show_r2))]
        result_call = f"polynomial_fit(sx, sy, FIT_DEGREE{', BAND_LEVEL' if band else ''})"
        line_keywords = [("color", "color"), ("linestyle", lit("--")), ("linewidth", lit(appearance["lineWidth"])),
                         ("zorder", "3"), ("label", 'f"{FIT_NAME}{suffix}\\n{equation}"' if fit_text else 'f"{FIT_NAME}{suffix}"')]
        draw += [
            f"    result = {result_call}",
            '    fit_results.append({"series": label, "coefficients": result["coefficients"], '
            '"r2": result["r2"], "points": result["points"]})',
            '    suffix = f": {label}" if len(series) > 1 else ""',
            *(["    equation = " + fit_text] if fit_text else []),
            *_indent(call("fit_line, = ax.plot", 'result["grid"], result["curve"]', line_keywords)),
            "    handles.append(fit_line)",
        ]
        if band:
            band_label = 'f"{round(BAND_LEVEL * 100, 1):g}% confidence band{suffix}, t-distribution"'
            band_keywords = [("color", "color"), ("alpha", "0.2"), ("linewidth", "0"), ("zorder", "1"), ("label", band_label)]
            draw += [*_indent(call("band = ax.fill_between", 'result["grid"], *result["band"]', band_keywords)),
                     "    handles.append(band)"]

    # ---- axes and legend: automatic labels are the X column and, when every series shares one, the Y column
    entry_count = len(series) * (1 + (1 if degree else 0) + (1 if band else 0))
    axes_lines = emit_axes(appearance, options, x_column, drawn_y[0] if len(drawn_y) == 1 else "")
    show_legend = legend_visible(appearance["legend"], entry_count)
    if show_legend:
        axes_lines += emit_legend(appearance["legend"], "handles=handles")

    # ---- notes for the user (method named here as well as in the legend)
    if degree:
        method = (f"Fit: {'linear' if fit == 'linear' else f'degree-{degree} polynomial'} least squares (numpy.polyfit) on the "
                  "points that have both x and y values; R² = 1 − residual sum of squares / total sum of squares.")
        if band:
            method += (f" Band: pointwise {_percent(level)} confidence interval of the fitted line (not a prediction "
                       f"interval), from the t-distribution (scipy.stats.t) with n − {degree + 1} degrees of freedom.")
        notes.append(issue("info", "fit_method", method))
        if "log" in (options["xScale"], options["yScale"]):
            notes.append(issue("info", "fit_on_log_axis",
                               "Fits use the plotted values, not their logarithms, so the fitted line bends on a log axis."))
        if not show_legend:
            notes.append(issue("info", "fit_legend_hidden",
                               "The legend is hidden, so the fit equation, R² and method are not shown on the figure."))

    header = emit_header(record, "scatter plot", uses_pandas=bool(files), data_file=bool(files))
    if band:
        header.insert(2, "# The confidence band also needs scipy (scipy.stats.t).")
        header.append("from scipy import stats")
    rc_lines, font_notes = emit_rcparams(appearance)
    helpers = _fit_helpers(degree, level, options["xScale"] == "log", fit_name) if degree else []
    script = assemble(
        header,
        [section("Data"), "# Missing values are NaN: such points are not drawn and nothing is filled in.", *data_lines],
        [section("Style"), *rc_lines],
        helpers,
        [section("Figure"), *emit_figure(record)],
        [section("Series"), *series_lines],
        [section("Points and fits" if degree else "Points"), *draw],
        [section("Axes and legend"), *axes_lines],
        ["plt.show()"],
    )
    fragment = Fragment(setup=[*data_lines, *helpers], draw=[*series_lines, *draw, *axes_lines],
                        style=rc_items(appearance)[0], imports=extra_imports(header))
    return GeneratedScript(source=script, files=files, warnings=notes + font_notes, fragment=fragment)
