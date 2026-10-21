"""Line plot generator: one Matplotlib line per Y column, all sharing the X column (docs/FIGURES_CONTRACT.md s4c).

Missing values stay NaN in the script, so Matplotlib leaves a gap; nothing is interpolated, smoothed or dropped.
"""
from __future__ import annotations

from typing import Any, Dict, List

from backend.figures.codegen.common import (
    LINE_STYLES, MARKERS, PALETTES, CodegenError, GeneratedScript, Issue, assemble, call, check_log_axes, emit_axes,
    emit_data, emit_figure, emit_header, emit_legend, emit_rcparams, issue, legend_visible, lit, one_line, rc_items,
    section, series_colors, Fragment,
)
from backend.figures.dataset import to_matrix
from backend.figures.models import SeriesStyle

DEFAULT_STYLE = SeriesStyle().model_dump()


def _error_columns(column: str, style: Dict[str, Any], mapping: Dict[str, Any], options: Dict[str, Any]) -> List[str]:
    """Columns that give the error bars of one series: [] (none), [err] (symmetric) or [low, high] (asymmetric).

    A series without its own error setting uses the shared symmetric ``mapping.yErr`` while ``options.errorBars`` is on."""
    if style["error"] == "symmetric":
        return [style["errorCol"]]
    if style["error"] == "asymmetric":
        return [style["errorLowCol"], style["errorHighCol"]]
    if options["errorBars"] and mapping["yErr"]:
        return [mapping["yErr"]]
    return []


def _check_error_columns(dataset: Dict[str, Any], column: str, style: Dict[str, Any], wanted: List[str]) -> List[Issue]:
    """Errors for missing, text or negative error columns (Matplotlib refuses negative error sizes)."""
    errors: List[Issue] = []
    kinds = {c["name"]: c["type"] for c in dataset["columns"]}
    if style["error"] == "symmetric" and not style["errorCol"]:
        errors.append(issue("error", "mapping_missing", f"Series '{column}' has symmetric error bars but no error column."))
    if style["error"] == "asymmetric" and not (style["errorLowCol"] and style["errorHighCol"]):
        errors.append(issue("error", "mapping_missing",
                            f"Series '{column}' has asymmetric error bars and needs both a lower and an upper error column."))
    for name in [n for n in wanted if n]:
        if name not in kinds:
            errors.append(issue("error", "column_missing", f"Error column '{name}' is not in the dataset.", column=name))
        elif kinds[name] != "number":
            errors.append(issue("error", "column_not_numeric", f"Error column '{name}' is text; error bars need numbers.", column=name))
        elif (to_matrix(dataset, [name])[:, 0] < 0).any():          # NaN < 0 is False
            errors.append(issue("error", "error_negative",
                                f"Error column '{name}' has negative values; error sizes are distances and must be 0 or more.",
                                column=name))
    return errors


def generate(record: Dict[str, Any]) -> GeneratedScript:
    config, dataset = record["config"], record["dataset"]
    mapping, appearance, options = config["mapping"], config["appearance"], config["options"]
    notes: List[Issue] = []
    errors: List[Issue] = []
    if mapping["group"]:
        notes.append(issue("warning", "group_ignored",
                           f"Column '{mapping['group']}' is set for grouping, but a line plot draws one line per Y column.",
                           column=mapping["group"]))

    # ---- which series are drawn: colours follow the position in mapping.y, so hiding one keeps the others' colours
    palette = series_colors(appearance, len(mapping["y"]))
    palette_size = len(appearance["colors"] or PALETTES[appearance["palette"]])
    series = []                                       # (column, resolved style, colour, error columns)
    for position, column in enumerate(mapping["y"]):
        style = {**DEFAULT_STYLE, **options["series"].get(column, {})}
        if not style["visible"]:
            continue
        wanted = _error_columns(column, style, mapping, options)
        errors += _check_error_columns(dataset, column, style, wanted)
        series.append((column, style, style["color"] or palette[position], wanted))
        if style["color"] is None and position >= palette_size and not any(n["code"] == "palette_cycled" for n in notes):
            notes.append(issue("warning", "palette_cycled",
                               f"There are more series than palette colours ({palette_size}), so colours repeat. "
                               "Give each series its own colour or add colours to the palette."))
        if not style["line"] and style["marker"] == "none" and not wanted:
            notes.append(issue("warning", "series_draws_nothing",
                               f"Series '{column}' has its line off and no markers or error bars, so nothing is drawn.", column=column))
    if not series:
        errors.append(issue("error", "no_visible_series", "Every series is hidden; show at least one to draw the plot."))
    errors += check_log_axes(dataset, options, mapping["x"], [s[0] for s in series])
    if errors:                                        # a shared error column is checked once per series: report it once
        raise CodegenError(list({(e["code"], e["message"]): e for e in errors}.values()))

    # ---- data: X, every drawn Y column and every error column, each column once
    uses = [(mapping["x"], "x")] if mapping["x"] else []
    for column, _, _, wanted in series:
        uses.append((column, "y"))
        uses += [(name, "err" if len(wanted) == 1 else "err_low" if name == wanted[0] else "err_high") for name in wanted]
    data_lines, files, var = emit_data(dataset, uses)
    if not mapping["x"]:
        data_lines.insert(0, f"x = np.arange(1, {len(dataset['rows'])} + 1)  # no X column is mapped: row numbers")

    # ---- one block per series
    series_lines: List[str] = []
    for number, (column, style, color, wanted) in enumerate(series, start=1):
        width = style["width"] if style["width"] is not None else appearance["lineWidth"]
        plot = [("label", lit(column)), ("color", lit(color))]
        if style["line"]:
            plot += [("linewidth", lit(width)), ("linestyle", lit(LINE_STYLES[style["style"]]))]
        else:
            plot.append(("linestyle", lit("none")))
        if style["step"] != "none":
            plot.append(("drawstyle", lit(f"steps-{style['step']}")))
        if style["marker"] != "none":
            marker_color = style["markerColor"] or color
            size = style["markerSize"] if style["markerSize"] is not None else appearance["markerSize"]
            plot += [("marker", lit(MARKERS[style["marker"]])), ("markersize", lit(size)),
                     ("markerfacecolor", lit(marker_color)), ("markeredgecolor", lit(marker_color))]
        if appearance["alpha"] < 1:
            plot.append(("alpha", lit(appearance["alpha"])))
        series_lines += [f"# Series {number}: {one_line(column)}", *call("ax.plot", f"x, {var[column]}", plot)]
        if wanted:
            yerr = var[wanted[0]] if len(wanted) == 1 else f"[{var[wanted[0]]}, {var[wanted[1]]}]"
            bars = [("yerr", yerr), ("fmt", lit("none")), ("ecolor", lit(color)), ("elinewidth", lit(width)),
                    ("capsize", lit(style["capSize"])), ("capthick", lit(width))]
            if appearance["alpha"] < 1:
                bars.append(("alpha", lit(appearance["alpha"])))
            series_lines += call("ax.errorbar", f"x, {var[column]}", bars)
        series_lines.append("")
    series_lines.pop()

    # ---- axes: automatic labels are the X column (or "Row") and, for a single series, its name
    visible = [s[0] for s in series]
    axes_lines = emit_axes(appearance, options, mapping["x"] or "Row", visible[0] if len(visible) == 1 else "")
    if legend_visible(appearance["legend"], len(series)):
        axes_lines += emit_legend(appearance["legend"])

    rc_lines, font_notes = emit_rcparams(appearance)
    uses_pandas = bool(files)
    source = assemble(
        emit_header(record, "line plot", uses_pandas=uses_pandas, data_file=uses_pandas),
        [section("Data"), "# Missing values are NaN: the line stops there and nothing is interpolated.", *data_lines],
        [section("Style"), *rc_lines],
        [section("Figure"), *emit_figure(record)],
        [section("Series"), *series_lines],
        [section("Axes and legend"), *axes_lines],
        ["plt.show()"],
    )
    fragment = Fragment(setup=data_lines, draw=[*series_lines, *axes_lines], style=rc_items(appearance)[0])
    return GeneratedScript(source=source, files=files, warnings=notes + font_notes, fragment=fragment)
