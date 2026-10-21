"""Box plot script generation (docs/FIGURES_CONTRACT.md s4g).

Raw observations in (one numeric column, optionally split by a grouping column), ``ax.bxp`` out. The statistics are
computed INSIDE the generated script with plain numpy calls and handed to Matplotlib, so the script shows exactly how
every box, whisker and outlier came about. This module repeats the same numpy calls only to check the data and to
write the notes (outlier counts, empty groups, notch eligibility); it does not use or import the other generators.
"""
from __future__ import annotations

import textwrap
from typing import Any, Dict, List, Optional

import numpy as np

from backend.figures.codegen.common import (
    CodegenError, GeneratedScript, Issue, assemble, check_log_axes, emit_axes, emit_data, emit_figure, emit_header,
    emit_rcparams, issue, lit, section, series_colors, Fragment, extra_imports, rc_items,
)
from backend.figures.dataset import to_matrix

MAX_GROUPS = 50
NOTCH_MIN_N = 10            # notches need at least this many values in every drawn group
NOTCH_FACTOR = 1.57         # notch half height = 1.57 x IQR / sqrt(n)  (McGill, Tukey & Larsen 1978)
JITTER_SEED = 12345         # the strip overlay is seeded with [JITTER_SEED, group index]: same data, same picture
NO_GROUP = "(no group)"
EMPTY_GROUP_SUFFIX = "(no valid values)"
EDGE_DEFAULT = "#333333"
MEAN_FILL_DEFAULT = "#FFFFFF"
DOT_COLOR = "#333333"
WHISKER_TEXT = {"iqr": "Whiskers: most extreme values within 1.5 × IQR of the box.",
                "minmax": "Whiskers: minimum and maximum.",
                "percentile": "Whiskers: 5th and 95th percentiles."}
METHOD_TEXT = {"linear": "linear-interpolation quartiles", "midpoint": "midpoint quartiles"}


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def _label(value: Any) -> str:
    if value is None or value == "":
        return NO_GROUP
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _names(items: List[str], limit: int = 5) -> str:
    shown = ", ".join(repr(i) for i in items[:limit])
    return shown + (f" and {len(items) - limit} more" if len(items) > limit else "")


# ------------------------------------------------------------- statistics
def describe(values: np.ndarray, whisker: str, method: str) -> Dict[str, Any]:
    """The numbers of one box. Mirrors the ``describe`` function written into the script (same numpy calls)."""
    q1, med, q3 = np.percentile(values, [25, 50, 75], method=method)
    iqr = q3 - q1
    if whisker == "iqr":
        inside = values[(values >= q1 - 1.5 * iqr) & (values <= q3 + 1.5 * iqr)]
        low, high = (inside.min(), inside.max()) if inside.size else (q1, q3)
    elif whisker == "minmax":
        low, high = values.min(), values.max()
    else:
        low, high = np.percentile(values, [5, 95], method=method)
    return {"q1": float(q1), "med": float(med), "q3": float(q3), "whislo": float(low), "whishi": float(high),
            "fliers": values[(values < low) | (values > high)], "mean": float(values.mean()), "n": int(values.size),
            "cilo": float(med - NOTCH_FACTOR * iqr / np.sqrt(values.size)),
            "cihi": float(med + NOTCH_FACTOR * iqr / np.sqrt(values.size))}


def _split(dataset: Dict[str, Any], value_column: str, group_column: Optional[str]):
    """([labels in order of first appearance], [valid values per label]). Missing values are left out."""
    values = to_matrix(dataset, [value_column])[:, 0]
    if not group_column:
        return [value_column], [values[~np.isnan(values)]]
    position = [c["name"] for c in dataset["columns"]].index(group_column)
    row_labels = [_label(row[position]) for row in dataset["rows"]]
    labels = list(dict.fromkeys(row_labels))
    row_labels_array = np.array(row_labels)
    groups = [values[row_labels_array == label] for label in labels]
    return labels, [g[~np.isnan(g)] for g in groups]


def _luminance(hex_color: str, alpha: float) -> float:
    """Relative luminance of ``hex_color`` drawn with ``alpha`` on a white page."""
    channels = [int(hex_color[i:i + 2], 16) / 255 for i in (1, 3, 5)]
    channels = [alpha * c + (1 - alpha) for c in channels]
    linear = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2]


def _contrast(hex_color: str, alpha: float) -> str:
    return "#000000" if _luminance(hex_color, alpha) > 0.179 else "#FFFFFF"


# ------------------------------------------------------------ legend note
def _note_text(options: Dict[str, Any], hidden: int, any_beyond: bool) -> str:
    parts = [f"Box: Q1–Q3 ({METHOD_TEXT[options['quartileMethod']]}); line: median.", WHISKER_TEXT[options["whisker"]]]
    if options["showOutliers"]:
        if any_beyond:
            parts.append("Open circles: values beyond the whiskers.")
    elif hidden:
        parts.append(f"{_plural(hidden, 'value')} beyond the whiskers not shown.")
    if options["notch"]:
        parts.append(f"Notches: median ± {NOTCH_FACTOR} × IQR / √n.")
    if options["showMean"]:
        parts.append("Diamond: mean.")
    if options["showPoints"]:
        parts.append("Dots: individual observations" + (" within the whiskers." if any_beyond else "."))
    return " ".join(parts)


def _wrap(text: str, width_in: float, size: float) -> str:
    chars = max(24, int(width_in * 72 * 0.96 / (size * 0.52)))      # average glyph is about half an em wide
    return "\n".join(textwrap.wrap(text, width=chars))


# --------------------------------------------------------------- generator
def generate(record: Dict[str, Any]) -> GeneratedScript:
    config, dataset = record["config"], record["dataset"]
    mapping, appearance, options = config["mapping"], config["appearance"], config["options"]
    notes: List[Issue] = []
    horizontal = options["orient"] == "horizontal"
    whisker, method = options["whisker"], options["quartileMethod"]

    if not mapping["y"]:
        raise CodegenError([issue("error", "mapping_missing", "Choose the numeric column to draw as a box plot.")])
    column = mapping["y"][0]
    if len(mapping["y"]) > 1:
        notes.append(issue("warning", "y_columns_ignored",
                           f"A box plot draws one value column; '{column}' is used and "
                           f"{_plural(len(mapping['y']) - 1, 'other Y column')} not drawn. Use a group column to compare groups."))
    group_column = mapping["group"] or mapping["x"]
    if mapping["group"] and mapping["x"] and mapping["x"] != mapping["group"]:
        notes.append(issue("warning", "x_ignored",
                           f"The groups come from '{mapping['group']}'; column '{mapping['x']}' on X is not used.",
                           column=mapping["x"]))

    labels, groups = _split(dataset, column, group_column)
    if len(labels) > MAX_GROUPS:
        raise CodegenError([issue("error", "too_many_groups", f"There are {len(labels)} groups; a box plot draws at "
                                  f"most {MAX_GROUPS}. Filter the data or choose a column with fewer groups.")])
    drawn = [i for i, g in enumerate(groups) if g.size]
    if not drawn:
        raise CodegenError([issue("error", "no_numeric_values", f"Column '{column}' has no numeric values, so there is "
                                  "nothing to put in a box plot.", column=column)])

    # ---- axes: value axis = y (vertical) or x (horizontal); the category axis ignores scale and limits
    value_axis, category_axis = ("x", "y") if horizontal else ("y", "x")
    axis_options = dict(options)
    if options[f"{category_axis}Scale"] == "log" or options[f"{category_axis}Lim"]:
        axis_options[f"{category_axis}Scale"], axis_options[f"{category_axis}Lim"] = "linear", None
        notes.append(issue("warning", "category_axis_option_ignored",
                           f"The {category_axis} axis holds the groups, so its scale and limits are ignored."))
    errors = check_log_axes(dataset, axis_options, column if horizontal else None, [] if horizontal else [column])
    if errors:
        raise CodegenError(errors)

    stats = {i: describe(groups[i], whisker, method) for i in drawn}

    # ---- group flags
    empty = [labels[i] for i, g in enumerate(groups) if not g.size]
    if empty:
        notes.append(issue("warning", "group_empty",
                           f"{_plural(len(empty), 'group')} {_names(empty)} {'has' if len(empty) == 1 else 'have'} no "
                           "valid values, so no box is drawn; the group stays on the axis and is marked."))
    single = [labels[i] for i in drawn if stats[i]["n"] == 1]
    if single:
        notes.append(issue("warning", "group_single_value",
                           f"{_plural(len(single), 'group')} {_names(single)} {'has' if len(single) == 1 else 'have'} "
                           "only one value, so the box collapses to a line."))

    # ---- notches
    if options["notch"]:
        small = [f"'{labels[i]}' (n = {stats[i]['n']})" for i in drawn if stats[i]["n"] < NOTCH_MIN_N]
        if small:
            raise CodegenError([issue(
                "error", "notch_n_too_small",
                f"Notches need at least {NOTCH_MIN_N} values per box; {', '.join(small[:5])}"
                f"{' and more' if len(small) > 5 else ''} {'has' if len(small) == 1 else 'have'} fewer. "
                "Turn notches off or leave out the small groups.")])
        beyond = [labels[i] for i in drawn if stats[i]["cilo"] < stats[i]["q1"] or stats[i]["cihi"] > stats[i]["q3"]]
        if beyond:
            notes.append(issue("warning", "notch_beyond_box",
                               f"For {_names(beyond)} the notch reaches past the quartiles, so the box is drawn folded "
                               "back on itself. The data are too variable for the notch to be informative at this size."))
        notes.append(issue("info", "notch_method",
                           f"Notches span the median ± {NOTCH_FACTOR} × IQR / √n, an approximate 95% interval for the "
                           "median (McGill, Tukey and Larsen, 1978). It is a rough guide, not a test."))

    # ---- outliers
    counts = {i: int(stats[i]["fliers"].size) for i in drawn}
    total_beyond = sum(counts.values())
    per_group = ", ".join(f"{labels[i]}: {counts[i]}" for i in drawn if counts[i])
    if total_beyond and options["showOutliers"]:
        notes.append(issue("info", "outliers_shown",
                           f"{_plural(total_beyond, 'value')} lie{'s' if total_beyond == 1 else ''} beyond the whiskers "
                           f"and {'is' if total_beyond == 1 else 'are'} drawn as open circles ({per_group})."))
    if total_beyond and not options["showOutliers"]:
        notes.append(issue("warning", "outliers_hidden",
                           f"{_plural(total_beyond, 'value')} beyond the whiskers {'is' if total_beyond == 1 else 'are'} "
                           f"not drawn because outliers are hidden ({per_group}). They still count in every statistic."))
    if whisker == "percentile" and total_beyond:
        notes.append(issue("info", "percentile_whiskers",
                           "With percentile whiskers the values beyond them are simply the lowest and highest 5%; "
                           "they are not outliers by any rule."))

    # ---- colours and legend note
    base = series_colors(appearance, len(labels)) if group_column else series_colors(appearance, 1)
    fills = [options["boxColor"] or base[i % len(base)] for i in range(len(labels))]
    edge = options["boxEdgeColor"] or EDGE_DEFAULT
    median_colors = [options["medianColor"] or _contrast(fill, appearance["alpha"]) for fill in fills]
    whisker_color = options["whiskerColor"] or edge
    line_width = appearance["lineWidth"]
    median_width = options["medianWidth"] or round(2 * line_width, 3)
    size = appearance["legendSize"] or round(appearance["fontSize"] * 0.9, 1)
    note_lines: List[str] = []
    reserve = 0.0
    if options["legendNote"]:
        text = _wrap(_note_text(options, 0 if options["showOutliers"] else total_beyond, bool(total_beyond)),
                     record["export"]["wIn"], size)
        reserve = round((text.count("\n") + 1) * size * 1.3 / 72 / record["export"]["hIn"] + 0.04, 3)
        if reserve > 0.4:
            notes.append(issue("warning", "legend_note_large",
                               "The legend note takes a large part of the figure height; make the figure taller or "
                               "the legend font smaller."))
        note_lines = [f"NOTE = {lit(text)}"]

    # ---- script: data and groups
    data_lines, files, var = emit_data(dataset, ([(group_column, "x")] if group_column else []) + [(column, "y")])
    y = var[column]
    if group_column:
        group_lines = [
            "# Groups in order of first appearance; a missing group value is called '(no group)'.",
            "def as_label(v):",
            "    if isinstance(v, float):",
            f"        return {lit(NO_GROUP)} if np.isnan(v) else (str(int(v)) if v.is_integer() else str(v))",
            f"    return v if v != '' else {lit(NO_GROUP)}",
            "",
            "row_labels = [as_label(v) for v in x]",
            "labels = list(dict.fromkeys(row_labels))",
            "row_labels = np.array(row_labels)",
            f"groups = [{y}[row_labels == label] for label in labels]",
        ]
    else:
        group_lines = [f"labels = [{lit(column)}]", f"groups = [{y}]"]
    group_lines += ["groups = [g[~np.isnan(g)] for g in groups]  # missing values are left out of every statistic",
                    "drawn = [i for i, g in enumerate(groups) if g.size]  # a group without values draws no box"]

    whisker_lines = {
        "iqr": ["    # whiskers: the most extreme values within 1.5 x IQR of the box; the rest are outliers",
                "    inside = values[(values >= q1 - 1.5 * iqr) & (values <= q3 + 1.5 * iqr)]",
                "    low, high = (inside.min(), inside.max()) if inside.size else (q1, q3)"],
        "minmax": ["    # whiskers: minimum and maximum (there are no outliers)",
                   "    low, high = values.min(), values.max()"],
        "percentile": ["    # whiskers: 5th and 95th percentile (same quartile method)",
                       "    low, high = np.percentile(values, [5, 95], method=QUARTILE_METHOD)"],
    }[whisker]
    stat_lines = [
        f"QUARTILE_METHOD = {lit(method)}  # numpy percentile method: 'linear' or 'midpoint'",
        "",
        "def describe(values, label):",
        "    q1, med, q3 = np.percentile(values, [25, 50, 75], method=QUARTILE_METHOD)",
        "    iqr = q3 - q1",
        *whisker_lines,
        "    stat = {'label': label, 'q1': q1, 'med': med, 'q3': q3, 'whislo': low, 'whishi': high,",
        "            'fliers': values[(values < low) | (values > high)], 'mean': values.mean(), 'n': values.size}",
        *([f"    stat['cilo'] = med - {NOTCH_FACTOR} * iqr / np.sqrt(values.size)  # approximate interval for the median",
           f"    stat['cihi'] = med + {NOTCH_FACTOR} * iqr / np.sqrt(values.size)"] if options["notch"] else []),
        "    return stat",
        "",
        "stats = [describe(groups[i], labels[i]) for i in drawn]",
        "positions = [i + 1 for i in drawn]",
        "outlier_counts = [s['fliers'].size for s in stats]  # values beyond the whiskers, per box",
    ]

    # ---- script: drawing
    orient_key, orient_value = _orientation_keyword(horizontal)
    box_args = [("positions", "positions"), ("widths", lit(options["boxWidth"])), ("patch_artist", "True"),
                *([(orient_key, orient_value)] if orient_key else []), ("manage_ticks", "False"), ("zorder", "2"),
                ("showfliers", lit(options["showOutliers"])), ("showmeans", lit(options["showMean"])),
                ("shownotches", lit(options["notch"])), ("meanline", "False"),
                ("boxprops", lit({"edgecolor": edge, "linewidth": line_width})),
                ("medianprops", lit({"linewidth": median_width, "solid_capstyle": "butt"})),
                ("whiskerprops", lit({"color": whisker_color, "linewidth": line_width,
                                      "linestyle": {"solid": "-", "dashed": "--", "dotted": ":",
                                                    "dashdot": "-."}[options["whiskerStyle"]]})),
                ("capprops", lit({"color": whisker_color, "linewidth": line_width})),
                ("flierprops", lit({"marker": "o", "markerfacecolor": "none", "markeredgecolor": edge,
                                    "markersize": appearance["markerSize"], "markeredgewidth": 0.8})),
                ("meanprops", lit({"marker": "D", "markerfacecolor": options["meanColor"] or MEAN_FILL_DEFAULT,
                                   "markeredgecolor": edge, "markersize": round(appearance["markerSize"] * 1.3, 2),
                                   "markeredgewidth": 0.8}))]
    draw_lines = [
        f"fills = {lit(fills)}",
        f"median_colors = {lit(median_colors)}",
        "bp = ax.bxp(", "    stats,", *[f"    {k}={v}," for k, v in box_args], ")",
        f"for patch, i in zip(bp['boxes'], drawn):",
        f"    patch.set_facecolor(to_rgba(fills[i], {lit(appearance['alpha'])}))",
        "for line, i in zip(bp['medians'], drawn):",
        "    line.set_color(median_colors[i])",
    ]
    if options["showMean"]:
        draw_lines += ["for marker in bp['means']:", "    marker.set_zorder(4)  # keep the mean above the dots"]
    if options["showPoints"]:
        xy = "shown, position + jitter" if horizontal else "position + jitter, shown"
        draw_lines += [
            "",
            f"# Every value within the whiskers once, spread across the box width with a fixed seed ({JITTER_SEED}).",
            "# Values beyond the whiskers are the circles above (or, if hidden, left out and counted).",
            "overlay_counts = []",
            "for stat, i in zip(stats, drawn):",
            "    values = groups[i]",
            "    shown = values[(values >= stat['whislo']) & (values <= stat['whishi'])]",
            f"    jitter = np.random.default_rng([{JITTER_SEED}, i]).uniform(-0.5, 0.5, shown.size) * {lit(round(options['boxWidth'] * 0.8, 4))}",
            "    position = i + 1",
            *_scatter_call(xy, appearance),
            "    overlay_counts.append(shown.size)",
        ]

    # ---- script: axes
    cat_ticks = ("ax.set_yticks(range(1, len(labels) + 1), labels=tick_labels)",
                 f"ax.set_ylim(len(labels) + 0.5, 0.5)  # first group on top") if horizontal else \
                ("ax.set_xticks(range(1, len(labels) + 1), labels=tick_labels)", "ax.set_xlim(0.5, len(labels) + 0.5)")
    tick_lines = [f"tick_labels = [label if g.size else label + '\\n' + {lit(EMPTY_GROUP_SUFFIX)} for label, g in zip(labels, groups)]",
                  *cat_ticks]
    category_label = group_column or ""
    labels_xy = (column, category_label) if horizontal else (category_label, column)
    axes_lines = tick_lines + emit_axes(appearance, axis_options, labels_xy[0], labels_xy[1])
    if appearance["grid"] or appearance["gridMinor"]:
        axes_lines.append(f"ax.grid(False, axis={lit(category_axis)})  # grid lines only along the value axis")

    header = emit_header(record, "box plot", uses_pandas=bool(files), data_file=bool(files))
    header.insert(2, "# Quartiles use numpy.percentile(method=...), which needs numpy 1.22 or newer.")
    header.append("from matplotlib.colors import to_rgba")
    figure_lines = emit_figure(record)
    note_draw: List[str] = []
    if note_lines:
        rect = f"(0, {reserve}, 1, {round(1 - reserve, 3)})" if appearance["layout"] == "constrained" else f"(0, {reserve}, 1, 1)"
        note_draw = [*note_lines, f"fig.get_layout_engine().set(rect={rect})  # keep the note clear of the axes",
                     f"fig.text(0.01, 0.01, NOTE, ha='left', va='bottom', fontsize={lit(size)}, color='#444444')"]
    rc_lines, font_notes = emit_rcparams(appearance)
    script = assemble(
        header,
        [section("Data"), *data_lines],
        [section("Groups"), *group_lines],
        [section("Statistics"), *stat_lines],
        [section("Style"), *rc_lines],
        [section("Figure"), *figure_lines, *note_draw],
        [section("Boxes"), *draw_lines],
        [section("Axes"), *axes_lines],
        ["plt.show()"],
    )
    note_below: List[str] = []                  # as a fragment the note sits under the axes (there is no figure margin)
    if note_lines:
        tick = appearance["tickSize"] or round(appearance["fontSize"] * 0.9, 1)
        offset = round(tick * 1.4 + (1.5 * (appearance["labelSize"] or appearance["fontSize"]) if labels_xy[0] else 0) + 8, 1)
        note_below = [*note_lines, f"ax.annotate(NOTE, xy=(0, 0), xycoords='axes fraction', xytext=(0, -{offset}), "
                      f"textcoords='offset points', ha='left', va='top', fontsize={lit(size)}, color='#444444')"]
    fragment = Fragment(setup=[*data_lines, *group_lines, *stat_lines], draw=[*draw_lines, *note_below, *axes_lines],
                        style=rc_items(appearance)[0], imports=extra_imports(header))
    return GeneratedScript(source=script, files=files, warnings=notes + font_notes, fragment=fragment)


def _scatter_call(xy: str, appearance: Dict[str, Any]) -> List[str]:
    size = round(appearance["markerSize"] ** 2, 4)
    return [f"    ax.scatter({xy}, s={lit(size)}, color={lit(DOT_COLOR)}, alpha=0.7, edgecolors='white', "
            "linewidths=0.4, zorder=3)"]


def _orientation_keyword(horizontal: bool):
    """Matplotlib 3.10 renamed ``vert=False`` to ``orientation='horizontal'``; write what the installed version understands."""
    if not horizontal:
        return None, None                      # vertical is the default in every version
    try:
        from matplotlib import __version_info__ as version
    except ImportError:
        return "vert", "False"
    return ("orientation", "'horizontal'") if tuple(version[:2]) >= (3, 10) else ("vert", "False")
