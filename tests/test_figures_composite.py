"""Composite figures (docs/FIGURES_CONTRACT.md s4s): GridSpec layouts, panel labels, spacing, fonts, shared legend,
panel isolation, preview placeholders and the render branch. Scripts are run in-process (Agg) to inspect the figure."""
import base64
import contextlib
import io
import re
from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pytest
from PIL import Image
from pydantic import ValidationError

from backend.figures import jobs, render as render_core
from backend.figures.codegen import CodegenError, emit_axes, emit_script
from backend.figures.codegen.common import rename_name
from backend.figures.codegen.composite import LAYOUTS, PLACEMENTS, panel_letter, script_diagnostics
from backend.figures.models import CompositeSettings, default_record

ROOT = Path(__file__).resolve().parent.parent
XY = [("x", "number"), ("a", "number"), ("b", "number"), ("g", "text")]
ROWS = [[i, i * 1.5 + (i % 3), (i % 4) + 1.0, "pq"[i % 2]] for i in range(1, 11)]
KINDS = ["line", "scatter", "bar", "hist", "box", "line"]


def plot(kind="line", y=("a",), rows=None, cols=XY, **sections):
    """Valid structured record (dict) of one plot type with a small data set."""
    rec = default_record("structured", kind).model_dump()
    rows = ROWS if rows is None else rows
    rec["dataset"] = {"columns": [{"name": n, "type": t} for n, t in cols], "rows": rows,
                      "origin": {"type": "sheet", "label": ""}}
    mapping = {"line": {"x": "x", "y": list(y)}, "scatter": {"x": "x", "y": list(y)}, "bar": {"x": "x", "y": list(y)},
               "hist": {"y": list(y)}, "box": {"y": list(y), "group": "g"}}[kind]
    rec["config"]["mapping"].update(mapping)
    for name, items in sections.items():
        rec["config"][name].update(items)
    return rec


def composite(panels, layout="2x2", w=7, h=5, **settings):
    rec = default_record("composite").model_dump()
    rec["composite"].update(layout=layout, panels=[{"slot": i, "record": r} for i, r in enumerate(panels)], **settings)
    rec["export"].update(wIn=w, hIn=h, dpi=100)
    return rec


def execute(rec, preview=False):
    """Run the generated script in this process -> (figure, namespace, stdout). The caller closes the figure."""
    script = emit_script(rec, preview=preview)
    out, ns = io.StringIO(), {"__name__": "composite_test"}
    plt.close("all")
    with contextlib.redirect_stdout(out):
        exec(compile(script.source, "composite.py", "exec"), ns)
    fig = ns["fig"]
    fig.canvas.draw()
    return fig, ns, out.getvalue()


def overlaps(a, b):
    return a.x0 < b.x1 and b.x0 < a.x1 and a.y0 < b.y1 and b.y0 < a.y1


def render(rec, purpose="final"):
    res = render_core.render_job(jobs.create(), rec, purpose, 100)
    assert res["status"] == "ok", res["diagnostics"]
    img = Image.open(io.BytesIO(base64.b64decode(res["preview"].split(",", 1)[1]))).convert("RGB")
    return res, np.asarray(img)


@pytest.fixture(autouse=True)
def fresh():
    render_core.clear_cache()
    jobs.reset()
    yield
    plt.close("all")


# ------------------------------------------------------------------ layouts
def js_layouts():
    """FIG_LAYOUTS of js/plots.js: name -> [[x, y, w, h], ...]"""
    text = (ROOT / "js" / "plots.js").read_text(encoding="utf-8")
    block = text[text.index("const FIG_LAYOUTS = {"):text.index("function defaultsFor")]
    found = re.findall(r"'([^']+)': \{ label: '[^']*', rects: \[(.*?)\] \}", block)
    return {name: eval("[" + body + "]") for name, body in found}


def test_layout_table_matches_js_fig_layouts():
    js = js_layouts()
    assert set(js) == set(LAYOUTS)
    for name, (rows, cols, cells) in LAYOUTS.items():
        spans = [(round(y * rows), round((y + h) * rows), round(x * cols), round((x + w) * cols)) for x, y, w, h in js[name]]
        assert cells == spans, name


@pytest.mark.parametrize("layout", list(LAYOUTS))
def test_layout_renders_every_panel(layout):
    rows, cols, cells = LAYOUTS[layout]
    rec = composite([plot(KINDS[i]) for i in range(len(cells))], layout=layout)
    fig, ns, _ = execute(rec)
    assert len(ns["panels"]) == len(cells)
    for (slot, _letter, ax), cell in zip(ns["panels"], cells):
        spec = ax.get_subplotspec()
        assert (spec.rowspan.start, spec.rowspan.stop, spec.colspan.start, spec.colspan.stop) == cell
    assert fig.get_size_inches().tolist() == [7, 5]
    _, pixels = render(rec)
    assert pixels.shape == (500, 700, 3)
    quarter_h, quarter_w = 500 // rows, 700 // cols
    for r0, r1, c0, c1 in cells:                     # every panel area has ink
        area = pixels[r0 * quarter_h:r1 * quarter_h, c0 * quarter_w:c1 * quarter_w]
        assert (area < 250).any(), (layout, (r0, c0))


def test_one_plus_two_geometry():
    fig, ns, _ = execute(composite([plot("line"), plot("bar"), plot("hist")], layout="1+2"))
    big, top, bottom = (ax.get_position() for _, _, ax in ns["panels"])
    assert big.height > top.height + bottom.height * 0.9 and big.x1 < top.x0 + 0.02 and top.y0 > bottom.y1 - 0.02
    assert abs(top.height - bottom.height) < 0.02 and abs(top.width - bottom.width) < 1e-6


def test_model_accepts_one_plus_two_and_legacy_labels():
    assert CompositeSettings(layout="1+2").layout == "1+2"
    assert CompositeSettings(labels="upper").labels == "A" and CompositeSettings(labels="lower").labels == "a"
    with pytest.raises(ValidationError):
        CompositeSettings(layout="7x1")
    with pytest.raises(ValidationError):
        CompositeSettings(layout="1+2", panels=[{"slot": 3}])


def test_all_empty_panels_are_an_error_in_final_only():
    rec = composite([None, None])
    with pytest.raises(CodegenError) as err:
        emit_script(rec)
    assert err.value.issues[0]["code"] == "composite_empty"
    emit_script(rec, preview=True)


# ------------------------------------------------------------------- labels
def test_panel_letters():
    assert [panel_letter(i, False) for i in (0, 1, 25, 26, 27)] == ["A", "B", "Z", "AA", "AB"]
    assert panel_letter(2, True) == "c"


@pytest.mark.parametrize("placement", list(PLACEMENTS))
@pytest.mark.parametrize("mode, expected", [("A", ["A", "B", "C", "D"]), ("a", ["a", "b", "c", "d"])])
def test_labels_do_not_touch_their_axes(placement, mode, expected):
    rec = composite([plot(k) for k in KINDS[:4]], labels=mode,
                    labelStyle={"family": "serif", "size": 14, "weight": "bold", "placement": placement, "offset": -50})
    fig, ns, _ = execute(rec)
    renderer = fig.canvas.get_renderer()
    seen = []
    for _slot, letter, ax in ns["panels"]:
        label = [t for t in ax.texts if t.get_text() == letter]
        assert len(label) == 1
        assert not overlaps(label[0].get_window_extent(renderer), ax.get_window_extent(renderer)), (placement, letter)
        assert label[0].get_fontsize() == 14 and label[0].get_fontweight() == "bold"
        seen.append(letter)
    assert seen == expected


def test_default_label_is_upper_left_outside_and_none_draws_nothing():
    fig, ns, _ = execute(composite([plot("line"), plot("bar")], layout="1x2"))
    ax = ns["panels"][0][2]
    label = ax.texts[0]
    assert label.get_text() == "A" and label.get_ha() == "left" and label.get_va() == "bottom"
    fig2, ns2, _ = execute(composite([plot("line"), plot("bar")], layout="1x2", labels="none"))
    assert all(not ax.texts for _, _, ax in ns2["panels"])


def test_letters_skip_empty_slots():
    fig, ns, _ = execute(composite([plot("line"), None, plot("bar"), None]))
    assert [letter for _, letter, _ in ns["panels"]] == ["A", "B"]


# ------------------------------------------------------------------ spacing
def test_spacing_presets_order_the_gaps():
    gaps = {}
    for spacing in ("tight", "normal", "wide"):
        fig, ns, _ = execute(composite([plot("line") for _ in range(4)], spacing=spacing, labels="none"))
        a, b = ns["panels"][0][2].get_position(), ns["panels"][1][2].get_position()
        c = ns["panels"][2][2].get_position()
        gaps[spacing] = (b.x0 - a.x1, a.y0 - c.y1)
    assert gaps["tight"][0] < gaps["normal"][0] < gaps["wide"][0]
    assert gaps["tight"][1] < gaps["normal"][1] < gaps["wide"][1]


def test_long_axis_labels_not_clipped_with_constrained_layout():
    label_60 = "Long measurement of concentration over extended time period (nm)"
    assert len(label_60) >= 60
    p1 = plot("line", appearance={"xLabel": label_60, "yLabel": label_60})
    p2 = plot("scatter", appearance={"xLabel": label_60, "yLabel": label_60})
    rec = composite([p1, p2], layout="1x2", w=8, h=5)
    fig, ns, _ = execute(rec)
    assert fig.get_layout_engine() is not None
    renderer = fig.canvas.get_renderer()
    fig_w = fig.bbox.width
    fig_h = fig.bbox.height
    for slot, letter, ax in ns["panels"]:
        for name, lbl in [("x", ax.xaxis.label), ("y", ax.yaxis.label)]:
            bb = lbl.get_window_extent(renderer)
            assert bb.x0 >= 0, f"Panel {letter} {name}-label clipped left: {bb.x0}"
            assert bb.x1 <= fig_w, f"Panel {letter} {name}-label clipped right: {bb.x1} > {fig_w}"
            assert bb.y0 >= 0, f"Panel {letter} {name}-label clipped bottom: {bb.y0}"
            assert bb.y1 <= fig_h, f"Panel {letter} {name}-label clipped top: {bb.y1} > {fig_h}"


# -------------------------------------------------------------------- fonts
def test_global_font_size_applies_unless_the_panel_sets_its_own():
    own = plot("line", appearance={"fontSize": 7})
    fig, ns, _ = execute(composite([plot("line", appearance={"title": "T", "xLabel": "x"}), own], layout="1x2",
                                   fontSize=16))
    first, second = ns["panels"][0][2], ns["panels"][1][2]
    assert first.get_title() == "T" and first.title.get_fontsize() == pytest.approx(19.2)   # 16 x 1.2
    assert first.xaxis.label.get_fontsize() == 16
    assert second.xaxis.get_ticklabels()[0].get_fontsize() == pytest.approx(7 * 0.9)
    assert first.xaxis.get_ticklabels()[0].get_fontsize() == pytest.approx(16 * 0.9)


# ----------------------------------------------------------- shared legend
def two_series(**sections):
    return plot("line", y=("a", "b"), **sections)


@pytest.mark.parametrize("mode", ["bottom", "right"])
def test_legend_shared_when_entries_are_identical(mode):
    fig, ns, out = execute(composite([two_series(), two_series(), plot("hist")], layout="1x3", legend=mode))
    assert len(fig.legends) == 1 and [t.get_text() for t in fig.legends[0].get_texts()] == ["a", "b"]
    assert all(ax.get_legend() is None for _, _, ax in ns["panels"])
    assert not script_diagnostics(out)


def test_legend_not_shared_when_entries_differ():
    other = plot("line", y=("b", "a"))                               # same names, other colours
    for second in (plot("line", y=("a", "x")), other):
        fig, ns, out = execute(composite([two_series(), second], layout="1x2", legend="bottom"))
        diags = script_diagnostics(out)
        assert len(diags) == 1 and diags[0]["code"] == "legend_not_shared"
        assert diags[0]["message"].startswith("legend not shared: ") and diags[0]["level"] == "warning"
        assert not fig.legends and all(ax.get_legend() is not None for _, _, ax in ns["panels"])


def test_legend_not_shared_when_no_panel_has_one():
    _, _, out = execute(composite([plot("hist"), plot("box")], layout="1x2", legend="right"))
    assert script_diagnostics(out)[0]["message"] == "legend not shared: no panel shows a legend"


def test_legend_labels_renamed_in_a_panel_are_part_of_the_comparison():
    renamed = two_series(appearance={"legend": {"show": True, "pos": "best", "force": False, "frame": None,
                                                 "labels": {"a": "Alpha"}}})
    _, _, out = execute(composite([two_series(), renamed], layout="1x2", legend="bottom"))
    assert script_diagnostics(out)[0]["code"] == "legend_not_shared"


# ------------------------------------------------------------ failed panels
def test_codegen_failure_isolates_the_panel():
    bad = plot("line", rows=[[1, -1.0, 1.0, "p"], [2, 2.0, 2.0, "p"]], options={"yScale": "log"})
    rec = composite([plot("line"), bad, plot("bar"), plot("hist")])
    script = emit_script(rec)
    failed = [w for w in script.warnings if w["code"] == "panel_failed"]
    assert len(failed) == 1 and failed[0]["panel"] == 1 and failed[0]["level"] == "error"
    assert failed[0]["message"].startswith("Panel 2 could not be drawn")
    fig, ns, out = execute(rec)
    assert len(ns["panels"]) == 4
    note = [t for t in ns["panels"][1][2].texts if "Panel 2" in t.get_text()]
    assert note and ns["panels"][0][2].lines and ns["panels"][2][2].patches
    _, pixels = render(rec)
    assert (pixels < 250).any()


def test_runtime_failure_isolates_the_panel():
    rec = composite([plot("line"), plot("scatter"), plot("bar"), plot("hist")])
    source = emit_script(rec).source
    head, tail = source.split("def draw_panel_1(", 1)
    tail = tail.replace("        try:\n", "        try:\n            raise RuntimeError('boom')\n", 1)
    out, ns = io.StringIO(), {"__name__": "composite_test"}
    with contextlib.redirect_stdout(out):
        exec(compile(head + "def draw_panel_1(" + tail, "composite.py", "exec"), ns)
    diags = script_diagnostics(out.getvalue())
    assert [(d["code"], d["panel"], d["level"]) for d in diags] == [("panel_failed", 1, "error")]
    assert "boom" in diags[0]["message"] and len(ns["panels"]) == 4
    assert ns["panels"][1][2].texts and not ns["panels"][1][2].collections
    assert ns["panels"][0][2].lines and ns["panels"][3][2].patches
    assert len(ns["fig"].axes) == 4


def test_python_and_latex_panels_are_reported_not_drawn():
    custom = default_record("python").model_dump()
    custom["source"] = "import matplotlib.pyplot as plt\nplt.plot([1, 2])\n"
    script = emit_script(composite([plot("line"), custom], layout="1x2"))
    failed = [w for w in script.warnings if w["code"] == "panel_failed"]
    assert failed[0]["panel"] == 1 and "structured" in failed[0]["message"]


# ---------------------------------------------------------------- render
def test_render_final_has_no_placeholder_and_preview_has_a_dashed_one():
    rec = composite([plot("line"), plot("bar"), plot("hist")], labels="none")
    _, final = render(rec, "final")
    _, preview = render(rec, "preview")
    bottom_right_final = final[260:490, 370:690]
    bottom_right_preview = preview[260:490, 370:690]
    assert (bottom_right_final == 255).all()                 # nothing in an empty panel of the final image
    assert (bottom_right_preview < 250).any() and (bottom_right_preview >= 150).all()   # light, never dark
    assert (preview[:240, :340] == final[:240, :340]).all()   # the drawn panels are identical in both


def test_render_returns_script_diagnostics_and_caches_by_purpose():
    rec = composite([two_series(), plot("line", y=("b", "a"))], layout="1x2", legend="bottom", w=6, h=3)
    res, pixels = render(rec)
    assert pixels.shape == (300, 600, 3)
    assert any(d["message"].startswith("legend not shared: ") for d in res["diagnostics"])
    assert "draw_panel_0" in res["source"] and not res["cached"]
    again, _ = render(rec)
    assert again["cached"] and again["hash"] == res["hash"]
    other, _ = render(rec, "preview")
    assert other["hash"] != res["hash"]
    rec["composite"]["panels"][0]["record"]["render"]["preview"] = "data:image/png;base64,AAAA"   # cached previews do not matter
    assert render(rec)[0]["cached"]


def test_render_reports_failed_panel_with_index():
    bad = plot("line", rows=[[1, -1.0, 1.0, "p"], [2, 2.0, 2.0, "p"]], options={"yScale": "log"})
    res, _ = render(composite([plot("line"), bad], layout="1x2"))
    assert [d["panel"] for d in res["diagnostics"] if d["code"] == "panel_failed"] == [1]


def test_render_composite_with_data_files_for_many_rows():
    rows = [[i, float(i % 17), 1.0, "p"] for i in range(2500)]           # above INLINE_LIMIT: data goes to a file
    rec = composite([plot("line", rows=rows), plot("line", rows=rows, appearance={"title": "other"})], layout="1x2")
    script = emit_script(rec)
    assert sorted(script.files) == ["panel0_data.csv", "panel1_data.csv"] and "import pandas as pd" in script.source
    assert render(rec)[1].min() < 250


# ------------------------------------------------------------------ emit_axes
@pytest.mark.parametrize("kind", ["line", "scatter", "bar", "hist", "box"])
def test_emit_axes_is_the_standalone_plot_onto_a_named_axes(kind):
    rec = plot(kind)
    standalone, frag = emit_script(rec), emit_axes(rec, "panel_ax")
    for line in standalone.fragment.draw:
        for part in line.split("\n"):
            assert part in standalone.source
    text = "\n".join(frag.fragment.draw + frag.fragment.setup)
    assert "panel_ax" in text and not re.search(r"(?<![\w.])ax\b", text)
    assert frag.source == standalone.source                           # standalone output is untouched


def test_emit_axes_keeps_keyword_names_and_strings():
    assert rename_name(["fig.colorbar(mesh, ax=ax)", "ax.set_title('ax stays')", "x.ax = ax"], "ax", "p") == \
        ["fig.colorbar(mesh, ax=p)", "p.set_title('ax stays')", "x.ax = p"]
    with pytest.raises(CodegenError):
        emit_axes(plot("line"), "not valid")
