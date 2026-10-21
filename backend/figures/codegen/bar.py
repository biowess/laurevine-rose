"""Bar chart generator (docs/FIGURES_CONTRACT.md s4c, s4e).

One category axis and one value axis. Wide data: one bar series per Y column, one category per row. Long data
(``mapping.group``): one series per group of the single Y column, pivoted by (category, group). Categories and series
keep their order of first appearance. A (category, series) pair without a value is an empty slot - the other bars never
move into it - and nothing is averaged, summed or filled in: a repeated category (wide) or pair (long) is refused.
"""
from __future__ import annotations

import re
from typing import Any, Dict, List, Optional

import numpy as np

from backend.figures.codegen.common import (
    PALETTES, CodegenError, GeneratedScript, Issue, assemble, emit_axes, emit_figure, emit_header, emit_legend,
    emit_rcparams, format_array, issue, legend_visible, lit, one_line, section, series_colors, variable_name,
    Fragment, extra_imports, rc_items,
)
from backend.figures.codegen.line import DEFAULT_STYLE, _check_error_columns, _error_columns
from backend.figures.dataset import to_matrix

MAX_CATEGORIES = 200
MAX_SERIES = 50
NO_CATEGORY = "(no category)"        # label of rows whose category cell is empty
NO_GROUP = "(no group)"              # label of rows whose group cell is empty
ERROR_COLOR = "#333333"
_FORMAT = re.compile(r"^[^{}]*\{(?::[^{}]*)?\}[^{}]*$")   # exactly one replacement field: {} or {:spec}, no names or attributes


def _label(value: Any, empty: str) -> str:
    if value is None or value == "":
        return empty
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value)


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}{'' if count == 1 else 's'}"


def _check_value_format(template: str) -> List[Issue]:
    """The label template must be a plain ``str.format`` pattern for one number, e.g. ``{:.1f}`` or ``{:,.0f} kg``."""
    try:
        if not _FORMAT.match(template) or re.search(r"\d{4,}", template) or len(template.format(-1234.5678)) > 80:
            raise ValueError
    except (ValueError, IndexError, KeyError, TypeError):
        return [issue("error", "value_format_invalid",
                      f"The value label format '{template}' is not usable. Use one {{}} field with an optional number "
                      "format, for example {:.1f}, {:,.0f} or {:.1%}.")]
    return []


def _pivot(dataset: Dict[str, Any], x_column: Optional[str], group_column: Optional[str]) -> Dict[str, Any]:
    """Categories, series keys and, per requested column, a categories x series matrix (NaN = no value)."""
    names = [c["name"] for c in dataset["columns"]]
    rows = dataset["rows"]
    if x_column:
        position = names.index(x_column)
        categories_per_row = [_label(row[position], NO_CATEGORY) for row in rows]
    else:
        categories_per_row = [str(i + 1) for i in range(len(rows))]
    categories = list(dict.fromkeys(categories_per_row))
    errors: List[Issue] = []
    if len(categories) > MAX_CATEGORIES:
        errors.append(issue("error", "too_many_categories",
                            f"There are {len(categories)} categories; a bar chart draws at most {MAX_CATEGORIES}. "
                            "Filter the data or use another plot type."))
    if group_column:
        position = names.index(group_column)
        groups_per_row = [_label(row[position], NO_GROUP) for row in rows]
        keys = list(dict.fromkeys(groups_per_row))
        if len(keys) > MAX_SERIES:
            errors.append(issue("error", "too_many_groups",
                                f"Column '{group_column}' has {len(keys)} distinct values; a bar chart draws at most "
                                f"{MAX_SERIES} series. Pick a column with fewer groups.", column=group_column))
    else:
        groups_per_row, keys = [None] * len(rows), []
    if errors:
        return {"errors": errors}

    cells: Dict[tuple, int] = {}
    for index, (category, group) in enumerate(zip(categories_per_row, groups_per_row)):
        if (category, group) in cells:
            first = cells[(category, group)] + 1
            what = (f"category '{category}' and group '{group}'" if group_column else f"category '{category}'")
            fix = ("so each pair of category and group has one row" if group_column else "so each category has one row")
            return {"errors": [issue(
                "error", "duplicate_combination" if group_column else "duplicate_category",
                f"Data rows {first} and {index + 1} both have {what}. A bar chart does not average or add rows; "
                f"aggregate the data first {fix}.")]}
        cells[(category, group)] = index

    def matrix(column: str) -> np.ndarray:
        values = to_matrix(dataset, [column])[:, 0]
        if not group_column:
            return np.array([[values[cells[(c, None)]]] for c in categories])
        table = np.full((len(categories), len(keys)), np.nan)
        for (category, group), index in cells.items():
            table[categories.index(category), keys.index(group)] = values[index]
        return table

    return {"errors": [], "categories": categories, "keys": keys, "matrix": matrix}


def generate(record: Dict[str, Any]) -> GeneratedScript:
    config, dataset = record["config"], record["dataset"]
    mapping, appearance, options = config["mapping"], config["appearance"], config["options"]
    x_column, group_column = mapping["x"], mapping["group"]
    notes: List[Issue] = []
    errors: List[Issue] = []
    horizontal = options["orient"] == "horizontal"
    stacked = options["barMode"] == "stacked"

    y_columns = list(mapping["y"])
    if group_column and len(y_columns) > 1:
        notes.append(issue("warning", "y_columns_ignored",
                           f"With a group column the chart draws one value column; '{y_columns[0]}' is used and "
                           f"{_plural(len(y_columns) - 1, 'other Y column')} not drawn."))
        y_columns = y_columns[:1]
    if group_column and not x_column:
        errors.append(issue("error", "mapping_missing",
                            "Long-format bars (with a group column) need a category column for the X axis."))
    errors += _check_value_format(options["valueFormat"])
    if errors:
        raise CodegenError(errors)

    pivot = _pivot(dataset, x_column, group_column)
    if pivot["errors"]:
        raise CodegenError(pivot["errors"])
    categories, keys, matrix = pivot["categories"], pivot["keys"], pivot["matrix"]

    # ---- series: (name, style key, value column); styles are keyed by Y column (wide) or group label (long)
    series: List[Dict[str, Any]] = []
    if group_column:
        for column_index, key in enumerate(keys):
            series.append({"name": key, "column": y_columns[0], "slot": column_index})
    else:
        for y in y_columns:
            series.append({"name": y, "column": y, "slot": 0})
    for s in series:
        s["style"] = {**DEFAULT_STYLE, **options["series"].get(s["name"], {})}
        s["values"] = matrix(s["column"])[:, s["slot"]]
    if len(series) > MAX_SERIES:
        raise CodegenError([issue("error", "too_many_series", f"There are {len(series)} series; a bar chart draws at "
                                  f"most {MAX_SERIES}. Select fewer Y columns.")])

    colors = series_colors(appearance, len(series))
    palette_size = len(appearance["colors"] or PALETTES[appearance["palette"]])
    if len(series) > palette_size:
        notes.append(issue("warning", "palette_cycled",
                           f"There are more series than palette colours ({palette_size}), so colours repeat. "
                           "Add colours to the palette to tell every series apart."))
    for s, color in zip(series, colors):
        s["color"] = s["style"]["color"] or color
    drawn = [s for s in series if s["style"]["visible"]]
    if not drawn:
        raise CodegenError([issue("error", "no_visible_series", "Every series is hidden, so there is nothing to draw.")])

    # ---- error bars: the supplied columns are drawn as given; their meaning (SD, SEM, CI ...) belongs to the user
    error_names: List[str] = []
    for s in drawn:
        wanted = _error_columns(s["name"], s["style"], mapping, options)
        errors += _check_error_columns(dataset, s["name"], s["style"], wanted)
        s["error_columns"] = wanted
        error_names += [w for w in wanted if w]
    if errors:
        raise CodegenError(errors)
    for s in drawn:
        s["errors"] = None
        if s["error_columns"]:
            low_col, high_col = s["error_columns"][0], s["error_columns"][-1]
            s["errors"] = (matrix(low_col)[:, s["slot"]], matrix(high_col)[:, s["slot"]])
    if error_names:
        shared = [n for n in dict.fromkeys(error_names) if sum(1 for s in drawn if n in s["error_columns"]) > 1]
        for name in shared:
            notes.append(issue("info", "shared_error_column",
                               f"Error column '{name}' gives the error bars of several series; give a series its own "
                               "error column in its series options if they differ.", column=name))
        notes.append(issue("info", "error_bars_meaning",
                           "Error bars show the plus/minus size exactly as supplied in "
                           f"{', '.join(repr(n) for n in dict.fromkeys(error_names))}; the chart does not say whether "
                           "that is a standard deviation, standard error or confidence interval - state it in the caption."))
        if stacked:
            notes.append(issue("info", "stacked_error_bars",
                               "In a stacked chart each error bar is drawn at the end of its own segment, not at the stack total."))

    # ---- axes: value axis = y for vertical bars, x for horizontal; the category axis ignores scale and limits
    value_axis, category_axis = ("x", "y") if horizontal else ("y", "x")
    axis_options = dict(options)
    if options[f"{category_axis}Scale"] == "log" or options[f"{category_axis}Lim"]:
        axis_options[f"{category_axis}Scale"], axis_options[f"{category_axis}Lim"] = "linear", None
        notes.append(issue("warning", "category_axis_option_ignored",
                           f"The {category_axis} axis holds the categories, so its scale and limits are ignored."))
    scale, limits = axis_options[f"{value_axis}Scale"], axis_options[f"{value_axis}Lim"]
    values_all = np.concatenate([s["values"] for s in drawn])
    if scale == "log":
        if stacked:
            errors.append(issue("error", "stacked_log_axis", "Stacked bars cannot use a log axis: segment sizes would "
                                "not be comparable. Use a linear axis or grouped bars."))
        if limits and limits[0] <= 0:
            errors.append(issue("error", "log_limits_nonpositive", f"The {value_axis} axis limits ({limits[0]:g} to "
                                f"{limits[1]:g}) must be above 0 on a log scale."))
        if (values_all[np.isfinite(values_all)] <= 0).any():
            errors.append(issue("error", "log_nonpositive", f"A value of zero or below cannot be drawn on a log "
                                f"{value_axis} axis. Switch the axis to linear or remove those values."))
        if errors:
            raise CodegenError(errors)
        notes.append(issue("info", "log_axis_baseline", "On a log axis bars start at the edge of the axis, so bar "
                           "lengths are not proportional to the values."))
    truncated = bool(limits and scale == "linear" and (limits[0] > 0 or limits[1] < 0))
    if truncated:
        notes.append(issue("warning", "axis_truncated",
                           f"The {value_axis} axis limits ({limits[0]:g} to {limits[1]:g}) do not include 0, so bar lengths "
                           "no longer show the values in proportion. Include 0 or say so in the caption."
                           + ("" if options["axisNote"] else " (Turn on the axis note to print this on the figure.)")))
    if sum(int(np.isfinite(s["values"]).any()) for s in drawn) < len(drawn):
        empty = [s["name"] for s in drawn if not np.isfinite(s["values"]).any()]
        notes.append(issue("warning", "series_draws_nothing", f"Series {', '.join(repr(n) for n in empty)} has no values, "
                           "so it draws no bars."))
    if np.isnan(np.array([s["values"] for s in drawn])).any():
        notes.append(issue("info", "empty_slots", "Missing values are left as empty slots; the other bars keep their place."))

    # ---- script: data
    taken: set = {"categories", "positions", "series"}
    data_lines = ["# One list of categories, one array per series; NaN = no value (an empty slot, nothing is filled in).",
                  f"categories = {format_array(categories, False)}"]
    entries: List[str] = []
    for s in drawn:
        s["var"] = variable_name("value", s["name"], taken)
        data_lines += [f"# Series: {one_line(s['name'])}", f"{s['var']} = {format_array(list(_none(s['values'])), True)}"]
        error_var = "None"
        if s["errors"] is not None:
            low_var = variable_name("below", s["name"], taken)
            data_lines.append(f"{low_var} = {format_array(list(_none(s['errors'][0])), True)}")
            high_var = low_var
            if s["error_columns"][0] != s["error_columns"][-1]:
                high_var = variable_name("above", s["name"], taken)
                data_lines.append(f"{high_var} = {format_array(list(_none(s['errors'][1])), True)}")
            error_var = f"({low_var}, {high_var})"
        entries.append(f"    ({lit(s['name'])}, {s['var']}, {lit(s['color'])}, {error_var}),")
    series_lines = ["# One entry per series: (legend label, values, colour, (distance below, distance above) or None).",
                    "series = [", *entries, "]"]

    # ---- script: drawing
    n = len(drawn)
    draw_call, size_key, base_key = ("barh", "height", "left") if horizontal else ("bar", "width", "bottom")
    err_key = "xerr" if horizontal else "yerr"
    has_errors = any(s["errors"] is not None for s in drawn)
    constants = [f"BAR_WIDTH = {lit(options['barWidth'])}  # share of a category slot taken by the bars",
                 "positions = np.arange(len(categories))"]
    if options["valueLabels"]:
        constants.append(f"VALUE_FORMAT = {lit(options['valueFormat'])}  # str.format template of the value labels")
    if not stacked:
        constants.append("SLOT_WIDTH = BAR_WIDTH / len(series)  # every series owns one fixed slot in each category")

    helpers: List[str] = []
    if options["valueLabels"]:
        helpers = _label_helper(horizontal, stacked)

    loop = ["handles = []  # legend entries in series order"]
    if stacked:
        loop += ["positive = np.zeros(len(categories))  # running top of the positive part of each stack",
                 "negative = np.zeros(len(categories))  # running bottom of the negative part"]
    loop.append("for index, (label, values, color, errors) in enumerate(series):")
    loop.append("    shown = np.isfinite(values)  # a missing value draws no bar and leaves its slot empty")
    if stacked:
        loop += ["    amount = np.where(shown, values, 0.0)",
                 "    start = np.where(amount >= 0, positive, negative)  # negative values stack downwards from zero",
                 "    end = start + amount",
                 "    where = positions[shown]"]
        bar_keywords = [(size_key, "BAR_WIDTH"), (base_key, "start[shown]")]
        heights = "amount[shown]"
        tip = "end"
    else:
        loop += ["    where = positions[shown] + (index - (len(series) - 1) / 2) * SLOT_WIDTH",
                 "    end = values"]
        bar_keywords = [(size_key, "SLOT_WIDTH")]
        heights = "values[shown]"
        tip = "values"
    bar_keywords += [("color", "color"), ("linewidth", "0"), ("label", "label"), ("zorder", "2")]
    if appearance["alpha"] < 1:
        bar_keywords.append(("alpha", lit(appearance["alpha"])))
    kw = ", ".join(f"{k}={v}" for k, v in bar_keywords)
    loop.append(f"    bars = ax.{draw_call}(where, {heights}, {kw})")
    loop.append("    handles.append(bars)")
    if has_errors:
        anchor = f"{tip}[shown], where" if horizontal else f"where, {tip}[shown]"      # errorbar takes (x, y)
        cap = max((s["style"]["capSize"] for s in drawn if s["errors"] is not None), default=3.0)
        loop += ["    if errors is not None:",
                 "        below, above = errors",
                 f"        ax.errorbar({anchor}, {err_key}=[below[shown], above[shown]], fmt='none',",
                 f"                    ecolor={lit(ERROR_COLOR)}, elinewidth={lit(appearance['lineWidth'])}, "
                 f"capsize={lit(cap)}, zorder=3)"]
    if options["valueLabels"]:
        if stacked:
            loop.append("    label_bars(where, start[shown] + amount[shown] / 2, values[shown], color)")
        else:
            loop.append("    label_bars(where, end[shown], values[shown], errors, shown)")
    if stacked:
        loop += ["    positive = positive + np.where(amount > 0, amount, 0.0)",
                 "    negative = negative + np.where(amount < 0, amount, 0.0)"]

    # ---- script: axes, category ticks, legend, truncation note
    cat_ticks = ([f"ax.set_yticks(positions, labels=categories)", f"ax.set_ylim(len(categories) - 0.5, -0.5)  # first category on top"]
                 if horizontal else
                 [f"ax.set_xticks(positions, labels=categories)", "ax.set_xlim(-0.5, len(categories) - 0.5)"])
    value_label = drawn[0]["column"] if (group_column or len(drawn) == 1) else ""
    category_label = x_column or "Row"
    labels = (value_label, category_label) if horizontal else (category_label, value_label)
    axes_lines = list(cat_ticks)
    if options["valueLabels"] and not stacked:
        axes_lines.append(f"ax.margins({value_axis}=0.12)  # room for the value labels")
    axes_lines += emit_axes(appearance, axis_options, labels[0], labels[1])
    if appearance["grid"] or appearance["gridMinor"]:
        axes_lines.append(f"ax.grid(False, axis={lit(category_axis)})  # grid lines only along the value axis")
    if truncated and options["axisNote"]:
        note_where = ("(1, 1), xytext=(0, 3), textcoords='offset points', ha='right', va='bottom'")
        axes_lines.append(f"ax.annotate('Axis truncated: 0 is outside the axis', xy={note_where}, "
                          "xycoords='axes fraction', fontsize='small', style='italic', color='#555555')")
    if legend_visible(appearance["legend"], len(drawn)):
        axes_lines += emit_legend(appearance["legend"], "handles=handles")

    header = emit_header(record, "bar chart", uses_pandas=False, data_file=False)
    if options["valueLabels"] and stacked:
        header.append("from matplotlib.colors import to_rgb")
    rc_lines, font_notes = emit_rcparams(appearance)
    script = assemble(
        header,
        [section("Data"), *data_lines],
        [section("Style"), *rc_lines],
        [section("Figure"), *emit_figure(record)],
        [section("Series"), *series_lines, *constants],
        [section("Bars"), *helpers, *loop],
        [section("Axes and legend"), *axes_lines],
        ["plt.show()"],
    )
    fragment = Fragment(setup=[*data_lines, *series_lines, *constants, *helpers], draw=[*loop, *axes_lines],
                        style=rc_items(appearance)[0], imports=extra_imports(header))
    return GeneratedScript(source=script, files={}, warnings=notes + font_notes, fragment=fragment)


def _none(values: np.ndarray):
    """Floats for the script: NaN becomes None, which ``format_array`` writes as np.nan."""
    return [None if not np.isfinite(v) else float(v) for v in values]


def _label_helper(horizontal: bool, stacked: bool) -> List[str]:
    """``label_bars`` of the script: value text at the bar tip (grouped, beyond any error bar) or inside the segment."""
    if stacked:
        xy = "(centre, place)" if horizontal else "(place, centre)"
        return [
            "def text_color(background):",
            '    """Black or white, whichever reads better on the bar colour."""',
            "    red, green, blue = to_rgb(background)",
            "    return 'black' if 0.2126 * red + 0.7152 * green + 0.0722 * blue > 0.5 else 'white'",
            "",
            "",
            "def label_bars(places, centres, values, color):",
            '    """Each segment\'s own value, centred inside the segment."""',
            "    for place, centre, value in zip(places, centres, values):",
            f"        ax.annotate(VALUE_FORMAT.format(value), xy={xy}, "
            "ha='center', va='center', color=text_color(color), fontsize=plt.rcParams['xtick.labelsize'], zorder=4)",
            "",
        ]
    if horizontal:
        xy, offset, align = "(tip, place)", "(4 if up else -4, 0)", "ha='left' if up else 'right', va='center'"
    else:
        xy, offset, align = "(place, tip)", "(0, 3 if up else -3)", "ha='center', va='bottom' if up else 'top'"
    return [
        "def label_bars(places, ends, values, errors, shown):",
        '    """Each bar\'s value just beyond its tip (and beyond its error bar, if it has one)."""',
        "    for number, (place, end, value) in enumerate(zip(places, ends, values)):",
        "        up = value >= 0",
        "        reach = 0.0",
        "        if errors is not None:",
        "            size = errors[1 if up else 0][shown][number]",
        "            reach = 0.0 if np.isnan(size) else size",
        "        tip = end + reach if up else end - reach",
        f"        ax.annotate(VALUE_FORMAT.format(value), xy={xy}, xytext={offset}, textcoords='offset points',",
        f"                    {align}, fontsize=plt.rcParams['xtick.labelsize'], zorder=4)",
        "",
    ]
