"""Histogram script generation (docs/FIGURES_CONTRACT.md s4f).

One numeric column in, one ``ax.hist`` call out. This module shares only the generic helpers of ``common`` (header,
data, style, axes, legend) with the other generators; it does not use or import the bar-chart code.
Everything that decides what the picture means (bins, statistic, cumulative, normal fit) is decided here, checked
against the data, and written into the script in plain numpy / matplotlib / scipy calls.
"""
from __future__ import annotations

import math
from typing import Any, Dict, List

import numpy as np

from backend.figures.codegen.common import (
    CodegenError, Fragment, GeneratedScript, Issue, assemble, call, check_log_axes, emit_axes, emit_data, emit_figure,
    emit_header, emit_legend, emit_rcparams, extra_imports, rc_items, issue, legend_visible, lit, section, series_colors,
)
from backend.figures.dataset import to_matrix

MAX_BINS = 1000
EDGE_DEFAULT = "#333333"
NORMAL_LABEL = "Normal fit (μ, σ)"
Y_LABELS = {"count": "Count", "frequency": "Frequency (fraction)", "density": "Density"}
METHOD_NAMES = {"auto": "auto", "fd": "Freedman-Diaconis", "sturges": "Sturges", "scott": "Scott", "sqrt": "square root"}


def stat_of(options: Dict[str, Any]) -> str:
    """Bar height statistic: ``options.stat``, or (while it is unset) the legacy ``density`` flag."""
    return options["stat"] or ("density" if options["density"] else "count")


def y_label(stat: str, cumulative: bool) -> str:
    """Automatic y-axis label; it always names the statistic that is drawn (``appearance.yLabel`` overrides it)."""
    label = Y_LABELS[stat]
    return f"Cumulative {label[0].lower()}{label[1:]}" if cumulative else label


def _too_many(message: str) -> CodegenError:
    return CodegenError([issue("error", "too_many_bins", message)])


# ------------------------------------------------------------------- bins
def _method_bin_estimate(values: np.ndarray, method: str) -> int:
    """Bins numpy's rule will ask for, from the documented formulas. Used only to refuse absurd counts BEFORE numpy
    allocates the edges; the real edges (and the real limit check) come from ``np.histogram_bin_edges``."""
    n = values.size
    span = float(values.max() - values.min())
    if method == "sqrt":
        return max(1, math.ceil(math.sqrt(n)))
    sturges = span / (math.log2(n) + 1.0)
    q75, q25 = np.percentile(values, [75, 25])
    fd = 2.0 * float(q75 - q25) * n ** (-1.0 / 3.0)
    scott = (24.0 * math.sqrt(math.pi) / n) ** (1.0 / 3.0) * float(np.std(values))
    width = {"sturges": sturges, "fd": fd, "scott": scott, "auto": min(fd, sturges) if fd else sturges}[method]
    return max(1, math.ceil(span / width)) if width else 1


def _numpy_edges(values: np.ndarray, bins: Any, column: str) -> np.ndarray:
    """``np.histogram_bin_edges`` with its refusal ("too many bins for data range") turned into our own error."""
    try:
        return np.histogram_bin_edges(values, bins=bins)
    except ValueError as exc:
        raise CodegenError([issue("error", "bins_too_fine",
                                  f"The values in '{column}' are too close together to be split into these bins. "
                                  "Choose fewer bins or a wider bin width.")]) from exc


def _constant_half_width(value: float) -> float:
    """Half of the bin range drawn around identical values: 5 % of the value (0.5 for zero), so it scales with the data."""
    return abs(value) * 0.05 or 0.5


def _plan_bins(values: np.ndarray, options: Dict[str, Any], column: str):
    """Decide the bin edges. Returns (edges, script lines that rebuild them, notes). Raises CodegenError."""
    mode = options["binMode"]
    low, high = float(values.min()), float(values.max())
    notes: List[Issue] = []

    if mode == "count" and options["bins"] > MAX_BINS:
        raise _too_many(f"{options['bins']:,} bins were requested; a histogram can have at most {MAX_BINS:,}. "
                        "Choose fewer bins.")
    if mode == "width":
        width = options["binWidth"]
        if width is None:
            raise CodegenError([issue("error", "bin_width_missing", "Enter a bin width greater than 0.")])
        if low < high and (high - low) / width > MAX_BINS:
            raise _too_many(f"A bin width of {width:g} over the values {low:g} to {high:g} would need more than "
                            f"{MAX_BINS:,} bins (a histogram can have at most {MAX_BINS:,}). Use a wider bin width.")
    if mode == "method" and low < high and _method_bin_estimate(values, options["binMethod"]) > MAX_BINS:
        raise _too_many(f"The {METHOD_NAMES[options['binMethod']]} rule would need more than {MAX_BINS:,} bins for "
                        f"'{column}' (a histogram can have at most {MAX_BINS:,}). Choose a bin count instead.")

    if low == high:       # identical values: no spread to split, so draw a small range around the value
        if mode == "width":
            lo, hi, count = low - width / 2, low + width / 2, 1
        else:
            half = _constant_half_width(low)
            lo, hi, count = low - half, low + half, (options["bins"] if mode == "count" else 1)
        edges = np.linspace(lo, hi, count + 1)
        lines = [f"edges = np.linspace({lit(lo)}, {lit(hi)}, {count + 1})  # identical values: a range around the value"]
        notes.append(issue(
            "warning", "constant_data",
            f"All {values.size} values in '{column}' are equal ({low:g}). There is no spread to split into bins, so the "
            f"bin range was set to {lo:g} to {hi:g} and every value falls into one bar."))
    elif mode == "count":
        edges = _numpy_edges(values, options["bins"], column)
        lines = [f"edges = np.histogram_bin_edges(values, bins={options['bins']})  # equal-width bins from min to max"]
    elif mode == "method":
        edges = _numpy_edges(values, options["binMethod"], column)
        lines = [f"edges = np.histogram_bin_edges(values, bins={lit(options['binMethod'])})"
                 f"  # numpy rule: {METHOD_NAMES[options['binMethod']]}"]
    else:
        span = high - low
        count = max(1, int(np.ceil(span / width)))
        if low + count * width < high:      # rounding must never leave the largest value outside the last bin
            count += 1
        edges = low + width * np.arange(count + 1)
        lines = [f"bin_width = {lit(width)}",
                 "n_bins = max(1, int(np.ceil((values.max() - values.min()) / bin_width)))",
                 "if values.min() + n_bins * bin_width < values.max():  # rounding must never drop the largest value",
                 "    n_bins += 1",
                 "edges = values.min() + bin_width * np.arange(n_bins + 1)"]

    count = len(edges) - 1
    if count > MAX_BINS:
        raise _too_many(f"This setting gives {count:,} bins; a histogram can have at most {MAX_BINS:,}. "
                        "Choose a wider bin width or fewer bins.")
    if not np.all(np.diff(edges) > 0):
        raise CodegenError([issue("error", "bins_too_fine",
                                  f"The values in '{column}' are too close together to be split into {count:,} bins. "
                                  "Choose fewer bins or a wider bin width.")])
    if low != high:
        how = {"count": "the bin count you chose", "width": "the bin width you chose",
               "method": f"the {METHOD_NAMES[options['binMethod']]} rule"}[mode]
        notes.append(issue("info", "bins_used",
                           f"{count} bin{'s' if count != 1 else ''} of width {edges[1] - edges[0]:.6g} covering "
                           f"{edges[0]:.6g} to {edges[-1]:.6g} ({how})."))
    return edges, lines, notes


# ------------------------------------------------------------ script parts
def _curve_color(appearance: Dict[str, Any], bar_color: str) -> str:
    """First palette colour that differs from the bars; black if the user's own list has only the bar colour."""
    for color in series_colors(appearance, 8):
        if color.lower() != bar_color.lower():
            return color
    return "#000000"


def _hist_call(stat: str, cumulative: bool, appearance: Dict[str, Any], options: Dict[str, Any],
               bar_color: str, label: str) -> List[str]:
    keywords = [("bins", "edges")]
    if stat == "frequency":
        keywords.append(("weights", "np.full(n, 1.0 / n)"))        # each value counts 1/n: the bars add up to 1
    if stat == "density":
        keywords.append(("density", "True"))                       # area of the bars adds up to 1
    if cumulative:
        keywords.append(("cumulative", "True"))
    keywords += [("color", lit(bar_color)), ("edgecolor", lit(options["barEdgeColor"] or EDGE_DEFAULT)),
                 ("linewidth", lit(options["barEdgeWidth"])), ("alpha", lit(appearance["alpha"])), ("label", lit(label))]
    return call("heights, _, bars = ax.hist", "values", keywords)


def _overlay_lines(stat: str, cumulative: bool, color: str, line_width: float) -> List[str]:
    """Normal curve with the mean and standard deviation of the plotted values, scaled to the bars' unit."""
    if cumulative:
        curve = "stats.norm.cdf(curve_x, mu, sigma)" + (" * n" if stat == "count" else "")
    else:
        scale = {"count": " * n * (edges[1] - edges[0])", "frequency": " * (edges[1] - edges[0])", "density": ""}[stat]
        curve = "stats.norm.pdf(curve_x, mu, sigma)" + scale
    label = lit(NORMAL_LABEL + "\nμ = %.4g, σ = %.4g") + " % (mu, sigma)"
    return ["mu, sigma = stats.norm.fit(values)  # mean and standard deviation (divisor n) of the plotted values",
            "curve_x = np.linspace(edges[0], edges[-1], 400)",
            f"curve_y = {curve}",
            *call("fit_line, = ax.plot", "curve_x, curve_y",
                  [("color", lit(color)), ("linewidth", lit(line_width)), ("zorder", "3"), ("label", label)])]


# --------------------------------------------------------------- generator
def generate(record: Dict[str, Any]) -> GeneratedScript:
    config, dataset = record["config"], record["dataset"]
    mapping, appearance, options = config["mapping"], config["appearance"], config["options"]
    notes: List[Issue] = []

    if not mapping["y"]:
        raise CodegenError([issue("error", "mapping_missing", "Choose the numeric column to draw as a histogram.")])
    column = mapping["y"][0]
    if len(mapping["y"]) > 1:
        notes.append(issue("warning", "y_columns_ignored",
                           f"A histogram draws one column; '{column}' is used and "
                           f"{len(mapping['y']) - 1} other column{'s' if len(mapping['y']) > 2 else ''} not drawn."))
    if mapping["group"]:
        notes.append(issue("warning", "group_ignored",
                           f"Histograms are not split by group; column '{mapping['group']}' is not used.",
                           column=mapping["group"]))

    all_values = to_matrix(dataset, [column])[:, 0]
    values = all_values[~np.isnan(all_values)]
    if values.size == 0:
        raise CodegenError([issue("error", "no_numeric_values",
                                  f"Column '{column}' has no numeric values, so there is nothing to put in a histogram.",
                                  column=column)])
    errors = check_log_axes(dataset, options, column, [])          # the values sit on the x axis; y shows the statistic
    if errors:
        raise CodegenError(errors)
    edges, bin_lines, bin_notes = _plan_bins(values, options, column)
    notes += bin_notes

    stat, cumulative = stat_of(options), options["cumulative"]
    bar_color = options["barColor"] or series_colors(appearance, 1)[0]

    fit = options["normalFit"]
    if fit and (values.size < 2 or float(values.min()) == float(values.max())):
        fit = False
        notes.append(issue("warning", "normal_fit_skipped",
                           "A normal fit needs at least two different values (the standard deviation would be 0), "
                           "so the overlay was left out."))
    if fit:
        notes.append(issue("info", "normal_fit_method",
                           "Normal fit: μ is the mean and σ the standard deviation (divisor n, maximum likelihood, "
                           "scipy.stats.norm.fit) of the plotted values, drawn in the same unit as the bars."
                           + (" With a cumulative histogram the curve is the normal cumulative distribution."
                              if cumulative else "")))
    if options["xScale"] == "log":
        notes.append(issue("info", "log_axis_equal_bins",
                           "Bins have equal width in data units, so they look uneven on a log x axis."))

    # ---- script
    data_lines, files, var = emit_data(dataset, [(column, "y")])
    prepare = [f"values = {var[column]}[~np.isnan({var[column]})]  # missing values are not counted",
               "n = values.size"]
    entries = 1 + (1 if fit else 0)
    show_legend = legend_visible(appearance["legend"], entries)
    axes_lines = emit_axes(appearance, options, column, y_label(stat, cumulative))
    if show_legend:
        axes_lines += emit_legend(appearance["legend"], f"handles=[bars.patches[0]{', fit_line' if fit else ''}]")

    header = emit_header(record, "histogram", uses_pandas=bool(files), data_file=bool(files))
    if fit:
        header.insert(2, "# The normal fit also needs scipy (scipy.stats.norm).")
        header.append("from scipy import stats")
    rc_lines, font_notes = emit_rcparams(appearance)
    hist_lines = [f"# Bar heights: {Y_LABELS[stat].lower()}{', cumulative' if cumulative else ''}.",
                  *_hist_call(stat, cumulative, appearance, options, bar_color, column)]
    fit_lines = _overlay_lines(stat, cumulative, _curve_color(appearance, bar_color), appearance["lineWidth"]) if fit else []
    script = assemble(
        header,
        [section("Data"), *data_lines, *prepare],
        [section("Bins"), *bin_lines],
        [section("Style"), *rc_lines],
        [section("Figure"), *emit_figure(record)],
        [section("Histogram"), *hist_lines],
        [section("Normal fit"), *fit_lines] if fit else [],
        [section("Axes and legend"), *axes_lines],
        ["plt.show()"],
    )
    fragment = Fragment(setup=[*data_lines, *prepare, *bin_lines], draw=[*hist_lines, *fit_lines, *axes_lines],
                        style=rc_items(appearance)[0], imports=extra_imports(header))
    return GeneratedScript(source=script, files=files, warnings=notes + font_notes, fragment=fragment)
