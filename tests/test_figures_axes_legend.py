"""Spines, axis lines, tick marks, legend frame and legend labels (docs/FIGURES_CONTRACT.md s3c)."""
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pytest
from pydantic import ValidationError

from backend.figures.codegen import emit_script
from backend.figures.models import FigureRecord, default_record


def make(plot_type="line", legend=None, **appearance):
    rec = default_record("structured", plot_type).model_dump()
    rec["dataset"] = {"columns": [{"name": n, "type": "number"} for n in ("x", "a", "b")],
                      "rows": [[1, 2.0, 1.0], [2, 3.5, 2.0], [3, 1.0, 4.0], [4, 5.0, 3.0]],
                      "origin": {"type": "sample", "label": "t"}}
    rec["config"]["mapping"] = {"x": "x", "y": ["a", "b"], "group": None, "yErr": None}
    rec["config"]["appearance"].update(appearance)
    if legend:
        rec["config"]["appearance"]["legend"].update(legend)
    return rec


def draw(rec):
    plt.close("all")
    src = emit_script(rec).source
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        exec(compile(src, "figure.py", "exec"), {"__name__": "__main__"})
    ax = plt.gcf().axes[0]
    plt.close("all")
    return src, ax


def shown(ax):
    return {name: ax.spines[name].get_visible() for name in ("top", "right", "left", "bottom")}


def test_defaults_keep_old_records_valid_and_the_script_unchanged():
    rec = default_record("structured", "line").model_dump()
    ap = rec["config"]["appearance"]
    assert (ap["spineTop"], ap["spineRight"], ap["axisLines"], ap["showTicks"]) == (None, None, True, True)
    assert ap["legend"]["frame"] is None and ap["legend"]["labels"] == {}
    for key in ("spineTop", "spineRight", "axisLines", "showTicks"):
        del ap[key]
    for key in ("frame", "labels"):
        del ap["legend"][key]
    FigureRecord.model_validate(rec)
    src = emit_script(make()).source
    assert "axes.spines.left" not in src and "tick.major.size" not in src and "legend_names" not in src


def test_spines_follow_despine_unless_chosen():
    assert shown(draw(make(despine=True))[1]) == {"top": False, "right": False, "left": True, "bottom": True}
    assert shown(draw(make(despine=False))[1])["top"] is True
    ax = draw(make(despine=True, spineTop=True))[1]
    assert (ax.spines["top"].get_visible(), ax.spines["right"].get_visible()) == (True, False)
    ax = draw(make(despine=False, spineRight=False))[1]
    assert (ax.spines["top"].get_visible(), ax.spines["right"].get_visible()) == (True, False)


def test_axis_lines_can_be_hidden():
    ax = draw(make(axisLines=False))[1]
    assert not ax.spines["left"].get_visible() and not ax.spines["bottom"].get_visible()


def test_ticks_can_be_hidden_labels_stay():
    ax = draw(make(showTicks=False))[1]
    assert ax.xaxis.get_major_ticks()[0].tick1line.get_markersize() == 0
    assert ax.yaxis.get_major_ticks()[0].tick1line.get_markersize() == 0
    assert [t.get_text() for t in ax.get_yticklabels() if t.get_text()]


@pytest.mark.parametrize("plot_type", ["line", "bar", "hist", "box", "heatmap"])
def test_new_axes_fields_work_for_every_plot_type(plot_type):
    rec = make(plot_type, spineTop=True, axisLines=False, showTicks=False)
    if plot_type == "heatmap":
        rec["config"]["mapping"]["y"] = ["x", "a"]
    src, ax = draw(rec)
    assert ax.spines["top"].get_visible() and not ax.spines["left"].get_visible()


def test_legend_frame_and_default_look():
    assert draw(make())[1].get_legend().get_frame_on() is True
    assert draw(make(legend={"pos": "outside"}))[1].get_legend().get_frame_on() is False
    assert draw(make(legend={"frame": False}))[1].get_legend().get_frame_on() is False
    assert draw(make(legend={"pos": "outside", "frame": True}))[1].get_legend().get_frame_on() is True


def test_legend_labels_rename_entries_only():
    rec = make(legend={"labels": {"a": "Dose A", "b": "  ", "zzz": "never used"}})
    src, ax = draw(rec)
    assert [t.get_text() for t in ax.get_legend().get_texts()] == ["Dose A", "b"]
    assert "'b': " not in src                           # a blank text never renames


def test_grid_subtlety_scales_major_and_minor_grid():
    src, ax = draw(make(grid=True, gridMinor=True, gridAlpha=0.5))
    assert "'grid.alpha': 0.5" in src and "alpha=0.35" in src
    assert "grid.alpha" not in emit_script(make(grid=True)).source          # default 1.0 leaves the script unchanged
    assert "alpha=0.7" in emit_script(make(gridMinor=True)).source
    with pytest.raises(ValidationError):
        FigureRecord.model_validate(make(gridAlpha=0.05))
