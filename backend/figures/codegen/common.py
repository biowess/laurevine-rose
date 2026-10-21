"""Shared building blocks of the Matplotlib script generators (docs/FIGURES_CONTRACT.md s2, s4c).

``emit_script(record)`` turns a FigureRecord (or its dict) into a self-contained Matplotlib script plus optional
companion files. Generated scripts import only matplotlib, numpy and, for big data sets, pandas.
Generators work on the plain dict of a validated record (``FigureRecord.model_dump()``).
"""
from __future__ import annotations

import csv
import io
import re
import textwrap
import tokenize
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Callable, Dict, List, Optional, Sequence, Tuple, Union

import numpy as np
from pydantic import ValidationError

from backend.figures.dataset import to_matrix, validate_dataset
from backend.figures.models import FigureRecord

INLINE_LIMIT = 2000          # up to this many rows the data sits in the script, above it in DATA_FILE
DATA_FILE = "data.csv"
RULE_WIDTH = 78

# Okabe-Ito based and colorblind-safe. "default" drops the pale yellow and starts with blue; "colorblind" is the
# published order; "muted" is Paul Tol's muted set; "grayscale" is for black-and-white print.
PALETTES: Dict[str, List[str]] = {
    "default": ["#0072B2", "#D55E00", "#009E73", "#CC79A7", "#E69F00", "#56B4E9", "#000000", "#7F7F7F"],
    "colorblind": ["#000000", "#E69F00", "#56B4E9", "#009E73", "#F0E442", "#0072B2", "#D55E00", "#CC79A7"],
    "muted": ["#332288", "#88CCEE", "#44AA99", "#117733", "#999933", "#DDCC77", "#CC6677", "#882255", "#AA4499"],
    "grayscale": ["#000000", "#555555", "#8C8C8C", "#B3B3B3"],
}
LINE_STYLES = {"solid": "-", "dashed": "--", "dotted": ":", "dashdot": "-."}
MARKERS = {"circle": "o", "square": "s", "triangle_up": "^", "triangle_down": "v", "diamond": "D",
           "plus": "+", "cross": "x", "star": "*"}                     # marker "none" -> no marker
FONT_FAMILIES = {"sans": "sans-serif", "serif": "serif", "mono": "monospace"}
GRID_COLOR = "#D9D9D9"

Issue = Dict[str, Any]


def issue(level: str, code: str, message: str, **extra: Any) -> Issue:
    """Same shape as backend.figures.dataset issues: {level, code, message, column?}."""
    return {"level": level, "code": code, "message": message, **extra}


class CodegenError(ValueError):
    """The record cannot be turned into a correct figure. ``issues`` lists every blocking problem."""

    def __init__(self, issues: Sequence[Issue]):
        self.issues = list(issues)
        more = len(self.issues) - 1
        suffix = f" (and {more} more problem{'s' if more > 1 else ''})" if more else ""
        super().__init__(self.issues[0]["message"] + suffix)


@dataclass
class Fragment:
    """The part of a plot script that draws onto an Axes (composite figures place several of these, s4s).

    ``setup`` (data, statistics, helpers) and ``draw`` (marks, axes, legend) are Python source that uses the Axes
    variable ``ax`` and the Figure variable ``fig``; ``style`` are the rcParams items of the plot; ``imports`` are the
    extra import lines beyond matplotlib.pyplot / numpy / pandas."""
    setup: List[str] = field(default_factory=list)
    draw: List[str] = field(default_factory=list)
    style: List[Tuple[str, Any]] = field(default_factory=list)
    imports: List[str] = field(default_factory=list)


@dataclass
class GeneratedScript:
    source: str                                                  # Matplotlib script (pass to run_python)
    files: Dict[str, bytes] = field(default_factory=dict)        # companion files (pass as run_python(files=...))
    warnings: List[Issue] = field(default_factory=list)          # non-blocking notes for the user
    fragment: Optional[Fragment] = None                          # set by the six plot generators (emit_axes)


# registry filled by backend/figures/codegen/__init__.py: plotType -> generator(record dict) -> GeneratedScript
# (the key "composite" holds the composite generator, which takes the extra keyword ``preview``)
GENERATORS: Dict[str, Callable[..., GeneratedScript]] = {}


# ----------------------------------------------------------------- dispatcher
def normalize_record(record: Union[FigureRecord, Dict[str, Any]]) -> Dict[str, Any]:
    """Validate a raw dict (defaults filled, unknown keys rejected) and return the plain dict generators use."""
    if isinstance(record, dict):
        try:
            record = FigureRecord.model_validate(record)
        except ValidationError as exc:
            first = exc.errors()[0]
            where = ".".join(str(p) for p in first["loc"]) or "record"
            raise CodegenError([issue("error", "invalid_record",
                                      f"The figure settings are not valid at '{where}': {first['msg']}.")]) from exc
    return record.model_dump()


def emit_script(record: Union[FigureRecord, Dict[str, Any]], *, preview: bool = False) -> GeneratedScript:
    """Matplotlib script for ``record.config.plotType`` (``kind`` composite: one GridSpec script, ``preview`` draws a
    dashed outline in empty panels). Raises CodegenError instead of producing a wrong plot."""
    rec = normalize_record(record)
    if rec["kind"] == "composite":
        return GENERATORS["composite"](rec, preview=preview)
    config = rec["config"]
    generator = GENERATORS.get(config["plotType"])
    if generator is None:
        raise CodegenError([issue("error", "no_generator", f"No script generator exists for '{config['plotType']}' plots.")])
    found = validate_dataset(rec["dataset"], config["plotType"], config["mapping"])
    errors = [i for i in found if i["level"] == "error"]
    if errors:
        raise CodegenError(errors)
    script = generator(rec)
    script.warnings = [i for i in found if i["level"] != "error"] + script.warnings
    return script


def rename_name(lines: Sequence[str], old: str, new: str) -> List[str]:
    """``lines`` with the identifier ``old`` renamed to ``new``; attribute names (``x.old``), keyword names (``old=``)
    and text inside string literals are left alone."""
    if old == new:
        return list(lines)
    source = "\n".join(lines)
    toks = list(tokenize.generate_tokens(io.StringIO(source).readline))
    starts = [0]
    for line in source.split("\n"):
        starts.append(starts[-1] + len(line) + 1)
    spans = []
    for i, tok in enumerate(toks):
        if tok.type != tokenize.NAME or tok.string != old:
            continue
        before = toks[i - 1].string if i else ""
        after = toks[i + 1].string if i + 1 < len(toks) else ""
        if before == "." or (after == "=" and toks[i + 1].type == tokenize.OP):
            continue
        spans.append((starts[tok.start[0] - 1] + tok.start[1], starts[tok.end[0] - 1] + tok.end[1]))
    for a, b in reversed(spans):
        source = source[:a] + new + source[b:]
    return source.split("\n")


def emit_fragment(record: Union[FigureRecord, Dict[str, Any]], ax_name: str = "ax") -> GeneratedScript:
    """``emit_script`` for a structured record, returned as a fragment that draws onto the Axes variable ``ax_name``
    (the Figure variable is ``fig``). ``.source`` is the standalone script; ``.fragment`` holds the reusable parts."""
    if not ax_name.isidentifier():
        raise CodegenError([issue("error", "invalid_axes_name", f"'{ax_name}' is not a valid Python name.")])
    script = emit_script(record)
    if script.fragment is None:
        raise CodegenError([issue("error", "no_fragment", "This plot type cannot be drawn onto given axes.")])
    frag = script.fragment
    script.fragment = Fragment(setup=rename_name(frag.setup, "ax", ax_name), draw=rename_name(frag.draw, "ax", ax_name),
                               style=frag.style, imports=frag.imports)
    return script


def extra_imports(header: Sequence[str]) -> List[str]:
    """Import lines of a generator header beyond the three every script has (pyplot, numpy, pandas)."""
    base = {"import matplotlib.pyplot as plt", "import numpy as np", "import pandas as pd"}
    return [h for h in header if h.startswith(("import ", "from ")) and h not in base]


# ------------------------------------------------------------- text helpers
def lit(value: Any) -> str:
    """Python literal for a str/number/bool/list. repr() escapes quotes, newlines and control characters."""
    return repr(value)


def one_line(text: Any) -> str:
    """Single-line text that is safe inside a ``#`` comment."""
    return " ".join(str(text).split())


def section(title: str) -> str:
    return f"# ---- {title} ".ljust(RULE_WIDTH, "-")


def call(func: str, positional: str, keywords: Sequence[Tuple[str, str]]) -> List[str]:
    """``func(positional, key=value, ...)`` with one keyword per line (values are already Python source)."""
    return [f"{func}(", f"    {positional},", *[f"    {key}={value}," for key, value in keywords], ")"]


def variable_name(prefix: str, text: str, taken: set) -> str:
    """``prefix_slug`` made unique within ``taken`` (ASCII identifiers only; the prefix keeps it valid)."""
    slug = re.sub(r"[^0-9A-Za-z]+", "_", text).strip("_").lower() or "col"
    name, n = f"{prefix}_{slug}", 2
    while name in taken:
        name, n = f"{prefix}_{slug}_{n}", n + 1
    taken.add(name)
    return name


# -------------------------------------------------------------------- palette
def series_colors(appearance: Dict[str, Any], count: int) -> List[str]:
    """``count`` colours: the user's own list if set, else the palette; both repeat when there are more series."""
    base = appearance["colors"] or PALETTES[appearance["palette"]]
    return [base[i % len(base)] for i in range(count)]


# ----------------------------------------------------------- header and data
def emit_header(record: Dict[str, Any], noun: str, *, uses_pandas: bool, data_file: bool) -> List[str]:
    lines = [f"# {one_line(record['name'])}",
             f"# Generated by Scientific Figure Studio ({noun}). Needs matplotlib and numpy"
             + (" and pandas." if uses_pandas else ".")]
    if data_file:
        lines.append(f"# Data file: {DATA_FILE} - keep it next to this script and run the script from that folder.")
    lines += ["import matplotlib.pyplot as plt", "import numpy as np"]
    if uses_pandas:
        lines.append("import pandas as pd")
    return lines


def format_array(values: Sequence[Any], numeric: bool, per_line: int = 8) -> str:
    """Array literal; missing values are np.nan (numbers) or '' (text). Long arrays wrap, 8 values per line."""
    if numeric:
        items = ["np.nan" if v is None else repr(v) for v in values]
        head, tail = "np.array([", "], dtype=float)"
    else:
        items = [repr("" if v is None else v) for v in values]
        head, tail = "[", "]"
    if len(items) <= per_line:
        return head + ", ".join(items) + tail
    rows = [", ".join(items[i:i + per_line]) for i in range(0, len(items), per_line)]
    return head + "\n" + "".join(f"    {row},\n" for row in rows) + tail


def emit_data(dataset: Dict[str, Any], uses: Sequence[Tuple[str, str]]) -> Tuple[List[str], Dict[str, bytes], Dict[str, str]]:
    """Data section for the columns in ``uses`` ([(column, role)], role 'x' or any prefix such as 'y', 'err').

    Up to INLINE_LIMIT rows the values are written into the script; above that they go to DATA_FILE (returned as an
    extra file, only the used columns) and the script reads it with pandas. Returns (lines, files, {column: variable}).
    """
    names = [c["name"] for c in dataset["columns"]]
    numeric = {c["name"]: c["type"] == "number" for c in dataset["columns"]}
    rows = dataset["rows"]
    taken: set = {"x"}
    variables: Dict[str, str] = {}
    for column, role in uses:
        if column not in variables:
            variables[column] = "x" if role == "x" else variable_name(role, column, taken)
    columns = list(variables)

    lines: List[str] = []
    files: Dict[str, bytes] = {}
    if len(rows) > INLINE_LIMIT:
        buffer = io.StringIO()
        writer = csv.writer(buffer, lineterminator="\n")
        writer.writerow(columns)
        positions = [names.index(c) for c in columns]
        for row in rows:
            writer.writerow(["" if row[p] is None else row[p] for p in positions])
        files[DATA_FILE] = buffer.getvalue().encode("utf-8")
        lines.append(f"data = pd.read_csv({lit(DATA_FILE)}, keep_default_na=False, na_values=[''])")
        for column in columns:
            tail = ".to_numpy(dtype=float)" if numeric[column] else ".fillna('').astype(str).tolist()"
            lines += [f"# Column: {one_line(column)}", f"{variables[column]} = data[{lit(column)}]{tail}"]
    else:
        for column in columns:
            position = names.index(column)
            values = [row[position] for row in rows]
            lines += [f"# Column: {one_line(column)}", f"{variables[column]} = {format_array(values, numeric[column])}"]
    return lines, files, variables


# --------------------------------------------------- style, figure, axes, legend
@lru_cache(maxsize=1)
def _installed_fonts() -> Optional[frozenset]:
    """Lower-case family names Matplotlib knows, or None if matplotlib cannot be imported in this process."""
    try:
        from matplotlib import font_manager
    except ImportError:
        return None
    return frozenset(f.name.lower() for f in font_manager.fontManager.ttflist)


def emit_rcparams(appearance: Dict[str, Any]) -> Tuple[List[str], List[Issue]]:
    """``plt.rcParams.update({...})`` for fonts, spines, grid and tick direction, plus notes about the font."""
    params, notes = rc_items(appearance)
    return ["plt.rcParams.update({", *[f"    {lit(k)}: {lit(v)}," for k, v in params], "})"], notes


def rc_items(appearance: Dict[str, Any]) -> Tuple[List[Tuple[str, Any]], List[Issue]]:
    """The rcParams (key, value) pairs ``emit_rcparams`` writes, plus notes about the font."""
    notes: List[Issue] = []
    base = appearance["fontSize"]

    def size(key: str, factor: float) -> float:
        return appearance[key] if appearance[key] is not None else round(base * factor, 1)

    generic = FONT_FAMILIES[appearance["fontFamily"]]
    families = [generic]
    if appearance["fontName"]:
        families.insert(0, appearance["fontName"])
        fonts = _installed_fonts()
        if fonts is not None and appearance["fontName"].lower() not in fonts:
            notes.append(issue("warning", "font_not_installed",
                               f"Font '{appearance['fontName']}' is not installed here; Matplotlib falls back to {generic}."))

    grid_major, grid_minor = appearance["grid"], appearance["gridMinor"]
    params = [
        ("font.family", families), ("font.size", base),
        ("axes.titlesize", size("titleSize", 1.2)), ("axes.labelsize", size("labelSize", 1.0)),
        ("xtick.labelsize", size("tickSize", 0.9)), ("ytick.labelsize", size("tickSize", 0.9)),
        ("legend.fontsize", size("legendSize", 0.9)),
        ("axes.spines.top", _spine(appearance, "spineTop")), ("axes.spines.right", _spine(appearance, "spineRight")),
        ("axes.grid", grid_major or grid_minor),
        ("axes.grid.which", "both" if grid_major and grid_minor else "minor" if grid_minor else "major"),
        ("grid.linestyle", LINE_STYLES[appearance["gridStyle"]]), ("grid.color", GRID_COLOR), ("grid.linewidth", 0.6),
        ("axes.axisbelow", True),
        ("xtick.direction", appearance["tickDirection"]), ("ytick.direction", appearance["tickDirection"]),
    ]
    if appearance.get("gridAlpha", 1.0) != 1.0:
        params.append(("grid.alpha", appearance["gridAlpha"]))
    if not appearance.get("axisLines", True):
        params += [("axes.spines.left", False), ("axes.spines.bottom", False)]
    if not appearance.get("showTicks", True):
        params += [(f"{a}tick.{w}.size", 0) for a in "xy" for w in ("major", "minor")]
    return params, notes


def _spine(appearance: Dict[str, Any], key: str) -> bool:
    """Top / right line: the explicit choice, else the opposite of ``despine`` (open axes)."""
    value = appearance.get(key)
    return (not appearance["despine"]) if value is None else bool(value)


def emit_figure(record: Dict[str, Any]) -> List[str]:
    export, layout = record["export"], record["config"]["appearance"]["layout"]
    return [f"fig, ax = plt.subplots(figsize=({lit(export['wIn'])}, {lit(export['hIn'])}), layout={lit(layout)})"]


def _wrap_label(label: str, max_width: int = 35) -> str:
    if not label or len(label) <= max_width or "\n" in label:
        return label
    return textwrap.fill(label, width=max_width, break_long_words=True)


def emit_axes(appearance: Dict[str, Any], options: Dict[str, Any], xlabel: str, ylabel: str) -> List[str]:
    """Title, axis labels, scales, limits, minor ticks/grid and tick-label rotation (``xlabel``/``ylabel`` are the
    automatic labels, used when the user left Appearance.xLabel / yLabel empty)."""
    lines: List[str] = []
    title = appearance["title"]
    xlabel, ylabel = appearance["xLabel"] or xlabel, appearance["yLabel"] or ylabel
    subtitle = appearance.get("subtitle", "")
    sub_size = appearance["labelSize"] if appearance["labelSize"] is not None else appearance["fontSize"]
    if appearance["showTitle"] and title:
        pad = f", pad={lit(round(sub_size * 1.25 + 8, 1))}" if subtitle else ""
        lines.append(f"ax.set_title({lit(title)}{pad})")
    if appearance["showTitle"] and subtitle:     # Matplotlib has no subtitle: a muted line just above the axes, under the title
        lines.append(f"ax.annotate({lit(subtitle)}, xy=(0.5, 1), xycoords='axes fraction', xytext=(0, 4), "
                     f"textcoords='offset points', ha='center', va='bottom', fontsize={lit(sub_size)}, color='#555555')")
    if appearance["showXLabel"] and xlabel:
        lines.append(f"ax.set_xlabel({lit(_wrap_label(xlabel))})")
    if appearance["showYLabel"] and ylabel:
        lines.append(f"ax.set_ylabel({lit(_wrap_label(ylabel))})")
    for axis in ("x", "y"):
        if options[f"{axis}Scale"] == "log":
            lines.append(f"ax.set_{axis}scale('log')")
        limits = options[f"{axis}Lim"]
        if limits:
            lines.append(f"ax.set_{axis}lim({lit(limits[0])}, {lit(limits[1])})")
    if appearance["gridMinor"]:                       # after set_*scale, which resets the tick locators
        lines += ["ax.minorticks_on()", f"ax.grid(which='minor', linewidth=0.4, alpha={lit(round(0.7 * appearance.get('gridAlpha', 1.0), 3))})"]
    for axis in ("x", "y"):
        angle = appearance[f"{axis}TickRotation"]
        if angle:
            lines.append(f"ax.tick_params(axis='{axis}', labelrotation={lit(angle)})")
            if axis == "x" and abs(angle) < 90:       # slanted labels end at their tick
                lines.append(f"plt.setp(ax.get_xticklabels(), ha='{'right' if angle > 0 else 'left'}', rotation_mode='anchor')")
    return lines


def legend_visible(legend: Dict[str, Any], visible_series: int) -> bool:
    """Legend only when there is something to tell apart (more than one series) unless the user forces it."""
    return bool(legend["show"] and (visible_series > 1 or legend["force"]))


def emit_legend(legend: Dict[str, Any], args: str = "") -> List[str]:
    """``ax.legend(...)``; ``args`` is extra leading Python source such as ``handles=handles`` (explicit entry order).
    ``legend.frame`` None keeps the old look (framed, but not when outside); ``legend.labels`` renames entries by their text."""
    lead = f"{args}, " if args else ""
    outside, frame = legend["pos"] == "outside", legend.get("frame")
    place = "loc='center left', bbox_to_anchor=(1.02, 0.5)" if outside else f"loc={lit(legend['pos'])}"
    if frame is None and outside:
        frame = False
    lines = [f"ax.legend({lead}{place}{'' if frame is None else ', frameon=' + lit(bool(frame))})"]
    names = {k: v for k, v in (legend.get("labels") or {}).items() if v.strip()}
    if names:
        lines += [f"legend_names = {lit(names)}", "for entry in ax.get_legend().get_texts():",
                  "    entry.set_text(legend_names.get(entry.get_text(), entry.get_text()))"]
    return lines


def check_log_axes(dataset: Dict[str, Any], options: Dict[str, Any], x_column: Optional[str],
                   y_columns: Sequence[str]) -> List[Issue]:
    """Errors for log axes that would hide data: limits <= 0 or plotted values <= 0 (missing values are ignored)."""
    errors: List[Issue] = []
    for axis, columns in (("x", [x_column] if x_column else []), ("y", list(y_columns))):
        if options[f"{axis}Scale"] != "log":
            continue
        limits = options[f"{axis}Lim"]
        if limits and limits[0] <= 0:
            errors.append(issue("error", "log_limits_nonpositive",
                                f"The {axis} axis limits ({limits[0]:g} to {limits[1]:g}) must be above 0 on a log scale."))
        for name in columns:
            bad = np.flatnonzero(to_matrix(dataset, [name])[:, 0] <= 0)        # NaN <= 0 is False
            if bad.size:
                errors.append(issue(
                    "error", "log_nonpositive",
                    f"Column '{name}' has {bad.size} value{'s' if bad.size > 1 else ''} of zero or below "
                    f"(first: data row {bad[0] + 1}), which cannot be drawn on a log {axis} axis. "
                    "Switch the axis to linear or remove those values.", column=name))
    return errors


def assemble(*blocks: Sequence[str]) -> str:
    """Join blocks of lines with one blank line between them; the script ends with a newline."""
    return "\n\n".join("\n".join(block) for block in blocks if block) + "\n"
