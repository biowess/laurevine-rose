"""Composite figure generator: ONE script built from the panel fragments (docs/FIGURES_CONTRACT.md s4s).

Every panel is a function of its own (so panel variables never collide) that draws into its own matplotlib SubFigure
(a rectangle of exactly the panel's own size, placed by ``backend.figures.layout``: panels are never scaled, the canvas
grows) inside a ``plt.rc_context`` holding that panel's rcParams, runs the plot's fragment (``emit_axes``) and falls back
to an error note inside the panel if it raises. Problems found while generating come back as ``GeneratedScript.warnings``;
problems found while the script runs are printed as ``RPE_DIAG {json}`` lines (``script_diagnostics`` reads them).
"""
from __future__ import annotations

import json
from typing import Any, Dict, List, Optional, Tuple

from backend.figures.codegen.common import (
    DATA_FILE, FONT_FAMILIES, CodegenError, GeneratedScript, Issue, assemble, emit_fragment, issue, lit, one_line,
    section,
)
from backend.figures import layout as lay
from backend.figures.models import Appearance

DIAG_MARK = "RPE_DIAG "

# name -> (rows, cols, [(row0, row1, col0, col1) per slot]); the same geometry as js/plots.js FIG_LAYOUTS
LAYOUTS: Dict[str, Tuple[int, int, List[Tuple[int, int, int, int]]]] = {
    "2x2": (2, 2, [(0, 1, 0, 1), (0, 1, 1, 2), (1, 2, 0, 1), (1, 2, 1, 2)]),
    "1x2": (1, 2, [(0, 1, 0, 1), (0, 1, 1, 2)]),
    "2x1": (2, 1, [(0, 1, 0, 1), (1, 2, 0, 1)]),
    "1x3": (1, 3, [(0, 1, 0, 1), (0, 1, 1, 2), (0, 1, 2, 3)]),
    "1+2": (2, 2, [(0, 2, 0, 1), (0, 1, 1, 2), (1, 2, 1, 2)]),     # large panel left over both rows, two small on the right
    "2x3": (2, 3, [(r, r + 1, c, c + 1) for r in range(2) for c in range(3)]),
}
# display names of the named layouts (served by GET /api/figures/layouts; the client has no copy of this table)
LAYOUT_LABELS: Dict[str, str] = {"2x2": "2 × 2", "1x2": "1 × 2", "2x1": "2 × 1", "1x3": "1 × 3", "1+2": "1 + 2 (large left)", "2x3": "2 × 3"}
# placement -> (xy corner in axes fraction, ha, va, direction of the gap: +1 up / -1 down)
PLACEMENTS = {
    "top-left": ((0, 1), "left", "bottom", 1), "top-right": ((1, 1), "right", "bottom", 1),
    "bottom-left": ((0, 0), "left", "top", -1), "bottom-right": ((1, 0), "right", "top", -1),
}
LABEL_GAP = 3.0                                 # points between the axes edge and the panel letter (+ labelStyle.offset)
_APPEARANCE_DEFAULTS = None


def grid(layout: str) -> Tuple[int, int, List[Tuple[int, int, int, int]]]:
    """(rows, cols, cells) of a layout name from the table or of any ``RxC``; cell = (row0, row1, col0, col1)."""
    if layout in LAYOUTS:
        return LAYOUTS[layout]
    rows, cols = (int(n) for n in layout.split("x"))
    return rows, cols, [(r, r + 1, c, c + 1) for r in range(rows) for c in range(cols)]


def layouts_table() -> List[Dict[str, Any]]:
    """The named layouts for the composer: ``[{id, label, rows, cols, slots:[{slot, x, y, w, h, cell}]}]``. ``x, y, w, h`` are
    fractions of the figure (cell geometry of ``LAYOUTS``, no spacing), ``cell`` = (row0, row1, col0, col1)."""
    out = []
    for lid, (rows, cols, cells) in LAYOUTS.items():
        slots = [{"slot": i, "x": c0 / cols, "y": r0 / rows, "w": (c1 - c0) / cols, "h": (r1 - r0) / rows, "cell": [r0, r1, c0, c1]}
                 for i, (r0, r1, c0, c1) in enumerate(cells)]
        out.append({"id": lid, "label": LAYOUT_LABELS[lid], "rows": rows, "cols": cols, "slots": slots})
    return out


def panel_letter(index: int, lower: bool) -> str:
    """A, B, ... Z, AA, AB, ... (lower case for ``labels: 'a'``)."""
    text, n = "", index
    while True:
        text, n = chr(65 + n % 26) + text, n // 26 - 1
        if n < 0:
            break
    return text.lower() if lower else text


def script_diagnostics(stdout: str) -> List[Issue]:
    """Issues the generated script printed (``RPE_DIAG {json}`` lines): failed panels, a legend that was not shared."""
    found: List[Issue] = []
    for line in (stdout or "").splitlines():
        if line.startswith(DIAG_MARK):
            try:
                item = json.loads(line[len(DIAG_MARK):])
            except ValueError:
                continue
            if isinstance(item, dict) and {"level", "code", "message"} <= set(item):
                found.append(item)
    return found


def _local_font(appearance: Dict[str, Any]) -> bool:
    """True when the panel sets a font of its own (anything but the defaults): the composite size does not apply."""
    global _APPEARANCE_DEFAULTS
    if _APPEARANCE_DEFAULTS is None:
        _APPEARANCE_DEFAULTS = Appearance().model_dump()
    keys = ("fontSize", "fontFamily", "fontName", "titleSize", "labelSize", "tickSize", "legendSize")
    return any(appearance[k] != _APPEARANCE_DEFAULTS[k] for k in keys)


def _indent(lines: List[str], n: int) -> List[str]:
    pad = " " * n
    return [pad + part if part else part for line in lines for part in line.split("\n")]


def _helpers(legend: str, preview: bool, empty_slots: bool) -> List[str]:
    lines = [
        "def _report(code, message, level='warning', **extra):",
        f"    print({lit(DIAG_MARK)} + json.dumps(dict(level=level, code=code, message=message, **extra)))",
        "",
        "def _note(ax, text):  # an error note inside a panel",
        "    ax.set_xticks([])",
        "    ax.set_yticks([])",
        "    for spine in ax.spines.values():",
        "        spine.set_visible(True)",
        "        spine.set_edgecolor('#B00020')",
        "        spine.set_linestyle((0, (4, 3)))",
        "    ax.text(0.5, 0.5, textwrap.fill(text, 34), ha='center', va='center', fontsize=8, color='#B00020',",
        "            transform=ax.transAxes)",
        "",
        "def _failed(fig, ax, before, slot, exc):  # the panel raised: drop what it added, keep the others",
        "    for extra in [a for a in fig.axes if a not in before and a is not ax]:",
        "        extra.remove()",
        "    ax.clear()",
        "    text = (type(exc).__name__ + ': ' + str(exc))[:200]",
        "    _note(ax, 'Panel ' + str(slot + 1) + ' failed. ' + text)",
        "    _report('panel_failed', 'Panel ' + str(slot + 1) + ' failed: ' + text, level='error', panel=slot)",
        "",
        "def _settle(fig, before):  # create tick artists now, while the panel's rcParams are active",
        "    for ax in [a for a in fig.axes if a not in before]:",
        "        for axis in (ax.xaxis, ax.yaxis):",
        "            axis.get_major_ticks()",
        "            axis.get_minor_ticks()",
    ]
    if preview and empty_slots:
        lines += [
            "",
            "def _placeholder(fig):  # preview only: a light dashed outline marks an empty panel",
            "    ax = fig.add_subplot()",
            "    ax.set_xticks([])",
            "    ax.set_yticks([])",
            "    ax.patch.set_alpha(0)",
            "    for spine in ax.spines.values():",
            "        spine.set_edgecolor('#BBBBBB')",
            "        spine.set_linewidth(0.8)",
            "        spine.set_linestyle((0, (4, 3)))",
            "    return ax",
        ]
    lines += [
        "",
        "def _check(fig, subs):  # titles, labels, legends and notes must stay inside their panel (and so inside the canvas)",
        "    fig.draw_without_rendering()",
        "    renderer = fig.canvas.get_renderer()",
        "    for slot, sf in subs.items():",
        "        box = sf.bbox",
        "        for ax in sf.axes:",
        "            tb = ax.get_tightbbox(renderer)",
        "            if tb is not None and (tb.x0 < box.x0 - 1 or tb.y0 < box.y0 - 1 or tb.x1 > box.x1 + 1 or tb.y1 > box.y1 + 1):",
        "                _report('panel_clipped', 'Panel ' + str(slot + 1) + ': a title, label, legend or note reaches past the panel edge.',",
        "                        panel=slot)",
        "                break",
        "",
        "def _layout_report(fig):  # the real canvas and panel rectangles (fractions, y from the top) for the composer overlay",
        "    w, h = fig.get_size_inches()",
        "    slots = [dict(slot=s, x=round(x / w, 5), y=round(y / h, 5), w=round(pw / w, 5), h=round(ph / h, 5))",
        "             for s, (x, y, pw, ph) in PLACE.items()]",
        "    _report('composite_layout', 'Canvas %.2f x %.2f in' % (w, h), level='info', wIn=round(w, 3), hIn=round(h, 3), slots=slots)",
    ]
    return lines


def _legend_lines(mode: str) -> List[str]:
    """Shared legend in a strip of its own at the right / bottom edge: the strip is as big as the legend (measured first), so
    the canvas grows by it and the panels keep their size."""
    right = mode == "right"
    return [
        section("Shared legend"),
        "def _entry(handle, text):  # what the eye compares: label, colour, marker, line style",
        "    if hasattr(handle, 'get_marker'):",
        "        color, mark, style = handle.get_color(), handle.get_marker(), handle.get_linestyle()",
        "    else:",
        "        face = np.atleast_2d(handle.get_facecolor())",
        "        color = face[0] if face.size else 'none'",
        "        paths = handle.get_paths() if hasattr(handle, 'get_paths') else []",
        "        mark = tuple(np.round(paths[0].vertices.ravel(), 2)) if len(paths) else 'patch'",
        "        style = str(handle.get_linestyle()) if hasattr(handle, 'get_linestyle') else ''",
        "    return (text, to_hex(color, keep_alpha=True), mark, str(style))",
        "",
        "_SHARED = {}  # 'need' = inches the legend strip needs (found while measuring), 'ncol' = its columns",
        "",
        "def _share_legend(fig, gs, panels, strip):",
        "    shown = []",
        "    for slot, letter, ax in panels:",
        "        legend = ax.get_legend()",
        "        if legend is not None:",
        "            handles = list(getattr(legend, 'legend_handles', None) or legend.legendHandles)",
        "            texts = [t.get_text() for t in legend.get_texts()]",
        "            shown.append((slot, ax, handles, texts, [_entry(h, t) for h, t in zip(handles, texts)]))",
        "    reason = None",
        "    if not shown:",
        "        reason = 'no panel shows a legend'",
        "    for other in shown[1:]:",
        "        if other[4] != shown[0][4]:",
        "            reason = ('panel ' + str(other[0] + 1) + ' has other legend entries than panel ' + str(shown[0][0] + 1)",
        "                      + ' (labels, colours, markers or line styles differ)')",
        "            break",
        "    if reason:",
        "        if strip is None:",
        "            _report('legend_not_shared', 'legend not shared: ' + reason)",
        "        return",
        "    handles, texts = shown[0][2], shown[0][3]",
        "    size = shown[0][1].get_legend().get_texts()[0].get_fontsize()",
        "    if strip is None:  # measuring pass: the strip is as big as the legend, which never gets wider / taller than the canvas",
        "        renderer = fig.canvas.get_renderer()",
        f"        for ncol in {'range(1, len(texts) + 1)' if right else 'range(min(len(texts), 6), 0, -1)'}:",
        "            lg = fig.legend(handles, texts, loc='center', ncol=ncol, frameon=False, fontsize=size)",
        "            box = lg.get_window_extent(renderer)",
        "            lg.remove()",
        "            _SHARED['ncol'] = ncol",
        f"            _SHARED['need'] = {'box.width' if right else 'box.height'} / fig.dpi + 0.2",
        f"            if {'box.height' if right else 'box.width'} / fig.dpi <= {'CANVAS[1]' if right else 'CANVAS[0]'} - 0.2:",
        "                break",
        "        return",
        f"    cell = {'gs[:, -1]' if right else 'gs[-1, :]'}",
        "    fig.add_subfigure(cell).legend(handles, texts, loc='center', ncol=_SHARED['ncol'], frameon=False, fontsize=size)",
        "    for item in shown:",
        "        item[1].get_legend().remove()",
    ]


def plan_for(record: Dict[str, Any]) -> lay.Plan:
    """The layout of a composite record (``export.wIn x hIn`` is the minimum canvas); also used by render / export to check sizes."""
    comp, export = record["composite"], record["export"]
    rows, cols, cells = grid(comp["layout"])
    return lay.plan(rows, cols, cells, lay.panel_sizes(comp), comp["spacing"], comp["alignH"], comp["alignV"],
                    export["wIn"], export["hIn"])


def generate(record: Dict[str, Any], *, preview: bool = False) -> GeneratedScript:
    comp, export = record["composite"], record["export"]
    rows, cols, cells = grid(comp["layout"])
    by_slot = {p["slot"]: p["record"] for p in comp["panels"]}
    drawn = [s for s in range(len(cells)) if by_slot.get(s) is not None]
    if not drawn and not preview:
        raise CodegenError([issue("error", "composite_empty", "Every panel is empty; put a plot in at least one panel.")])
    pl = plan_for(record)

    notes: List[Issue] = []
    if pl.grown:
        notes.append(issue("info", "canvas_grown", f"The canvas grew from {export['wIn']:g} x {export['hIn']:g} in to "
                           f"{pl.canvas_w:.2f} x {pl.canvas_h:.2f} in so that every panel keeps its own size."))
    files: Dict[str, bytes] = {}
    imports: List[str] = []
    blocks: List[List[str]] = []                # one function per panel
    calls: List[str] = []
    letters = 0
    for slot, (r0, r1, c0, c1) in enumerate(cells):
        ty0, ty1, tx0, tx1 = pl.spans[slot]
        sub = f"fig.add_subfigure(gs[{ty0}:{ty1}, {tx0}:{tx1}])"
        panel = by_slot.get(slot)
        if panel is None:
            if preview:
                calls.append(f"_placeholder({sub})")
            continue
        letter = panel_letter(letters, comp["labels"] == "a")
        letters += 1
        ax = f"ax_p{slot}"
        title = f"Panel {slot + 1}: {panel['config']['plotType'] if panel['kind'] == 'structured' else panel['kind']}"
        try:
            if panel["kind"] != "structured" or panel["sourceMode"] == "custom":
                raise CodegenError([issue("error", "panel_not_structured",
                                          "Only structured plots can be used in a composite panel in this release.")])
            appearance = dict(panel["config"]["appearance"])
            if comp.get("fontApplyAll"):                          # "Apply to all panels": the panel's own sizes are replaced
                appearance.update(fontSize=comp["fontSize"], titleSize=None, labelSize=None, tickSize=None, legendSize=None)
            elif not _local_font(appearance):
                appearance["fontSize"] = comp["fontSize"]
            frag_sub = emit_fragment({**panel, "config": {**panel["config"], "appearance": appearance}}, ax)
            frag = frag_sub.fragment
            for name, data in frag_sub.files.items():            # one data file per panel
                renamed = f"panel{slot}_{name}"
                files[renamed] = data
                frag.setup = [line.replace(lit(DATA_FILE), lit(renamed)) for line in frag.setup]
            imports += [i for i in frag.imports if i not in imports]
            for item in frag_sub.warnings:
                if not any(n["code"] == item["code"] and n["message"] == item["message"] for n in notes):
                    notes.append({**item, "panel": slot})
            rc = [f"RC_{slot} = {{", *[f"    {lit(k)}: {lit(v)}," for k, v in frag.style], "}"]
            blocks.append([section(title), *rc, "",
                           f"def draw_panel_{slot}(fig):  # fig = the panel's SubFigure ({panel['export']['wIn']:g} x {panel['export']['hIn']:g} in)",
                           f"    with plt.rc_context(RC_{slot}):",
                           "        before = list(fig.axes)",
                           f"        {ax} = fig.add_subplot()",
                           "        try:",
                           *_indent([*frag.setup, *frag.draw], 12),
                           "            _settle(fig, before)",
                           "        except Exception as exc:",
                           f"            _failed(fig, {ax}, before, {slot}, exc)",
                           f"    return {ax}"])
        except CodegenError as exc:
            first = exc.issues[0]
            message = f"Panel {slot + 1} could not be drawn: {first['message']}"
            notes.append(issue("error", "panel_failed", message, panel=slot))
            blocks.append([section(title), f"def draw_panel_{slot}(fig):",
                           f"    {ax} = fig.add_subplot()",
                           f"    _note({ax}, {lit(message)})",
                           f"    return {ax}"])
        calls += [f"subs[{slot}] = {sub}", f"panels.append(({slot}, {letter!r}, draw_panel_{slot}(subs[{slot}])))"]

    uses_pandas = bool(files)
    style = comp["labelStyle"]
    corner, ha, va, sign = PLACEMENTS[style["placement"]]
    gap = round(max(1.0, LABEL_GAP + style["offset"]), 2) * sign
    side = comp["legend"] if comp["legend"] != "none" else None
    header = [f"# {one_line(record['name'])}",
              f"# Generated by Scientific Figure Studio (composite figure, {comp['layout']}). Needs matplotlib and numpy"
              + (" and pandas." if uses_pandas else "."),
              *([f"# Data files: panel<N>_{DATA_FILE} - keep them next to this script and run it from that folder."]
                if uses_pandas else []),
              "import json", "import textwrap", "import matplotlib.pyplot as plt", "import numpy as np",
              *(["import pandas as pd"] if uses_pandas else []),
              *(["from matplotlib.colors import to_hex"] if side else []), *imports]
    place = ", ".join(f"{s}: ({x:.4f}, {y:.4f}, {w:.4f}, {h:.4f})" for s, (x, y, w, h) in sorted(pl.rects.items()))
    layout_block = [section("Layout (inches): every panel keeps its own size, the canvas grows to hold them"),
                    f"CANVAS = ({pl.canvas_w:.4f}, {pl.canvas_h:.4f})",
                    f"XS = {[round(v, 4) for v in pl.xs]}  # widths of the placement grid",
                    f"YS = {[round(v, 4) for v in pl.ys]}  # heights of the placement grid",
                    f"PLACE = {{{place}}}  # slot -> x, y, width, height of the panel (y from the top)",
                    f"PAD = {lay.PANEL_PAD_IN}  # whitespace inside every panel",
                    f"LEGEND_SIDE = {lit(side)}"]
    labels = [] if comp["labels"] == "none" else [
        "    for slot, letter, ax in panels:",
        f"        ax.annotate(letter, xy={corner}, xycoords='axes fraction', xytext=(0, {lit(gap)}), "
        "textcoords='offset points',",
        f"                    ha={lit(ha)}, va={lit(va)}, fontsize={lit(style['size'])}, fontweight={lit(style['weight'])}, "
        f"family={lit(FONT_FAMILIES[style['family']])}, annotation_clip=False)"]
    build = [section("Figure"),
             "def build(strip=None):  # strip = inches reserved for the shared legend (None: not known yet)",
             "    widths = XS + ([strip] if strip and LEGEND_SIDE == 'right' else [])",
             "    heights = YS + ([strip] if strip and LEGEND_SIDE == 'bottom' else [])",
             "    fig = plt.figure(figsize=(sum(widths), sum(heights)), layout='constrained')",
             "    fig.get_layout_engine().set(w_pad=PAD, h_pad=PAD, wspace=0, hspace=0)",
             "    gs = fig.add_gridspec(len(heights), len(widths), width_ratios=widths, height_ratios=heights)",
             "    panels = []  # (slot, letter, Axes) of every drawn panel",
             "    subs = {}    # slot -> the panel's SubFigure",
             *_indent(calls, 4), *labels,
             *(["    if LEGEND_SIDE:", "        _share_legend(fig, gs, panels, strip)"] if side else []),
             "    return fig, panels, subs",
             "",
             "fig, panels, subs = build()",
             *(["if _SHARED.get('need'):  # grow the canvas by the legend strip; the panels are drawn again at the same size",
                "    plt.close(fig)",
                "    fig, panels, subs = build(_SHARED['need'])"] if side else []),
             "_check(fig, subs)",
             "_layout_report(fig)"]
    shared = _legend_lines(comp["legend"]) if side else []
    empty_slots = len(drawn) < len(cells)
    source = assemble(header, _helpers(comp["legend"], preview, empty_slots), *blocks, layout_block, shared, build,
                      ["plt.show()"])
    return GeneratedScript(source=source, files=files, warnings=notes)
