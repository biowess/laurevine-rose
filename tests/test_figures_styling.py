"""Title block styling fields read by every generator: appearance.subtitle / showTitle (docs/FIGURES_CONTRACT.md s3c)."""
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pytest

from backend.figures.codegen import emit_script
from backend.figures.models import FigureRecord, default_record

TYPES = ("line", "scatter", "bar", "hist", "box", "heatmap")


def make(plot_type, **appearance):
    rec = default_record("structured", plot_type).model_dump()
    rec["dataset"] = {"columns": [{"name": "x", "type": "number"}, {"name": "a", "type": "number"}],
                      "rows": [[1, 2.0], [2, 3.5], [3, 1.0], [4, 5.0]], "origin": {"type": "sample", "label": "t"}}
    rec["config"]["mapping"] = {"x": "x", "y": ["x", "a"] if plot_type == "heatmap" else ["a"], "group": None, "yErr": None}
    rec["config"]["appearance"].update(appearance)
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


def texts(ax):
    return [t.get_text() for t in ax.texts] + [ax.get_title()]


def test_subtitle_defaults_to_empty_and_old_records_stay_valid():
    rec = default_record("structured", "line").model_dump()
    assert rec["config"]["appearance"]["subtitle"] == ""
    del rec["config"]["appearance"]["subtitle"]
    assert FigureRecord.model_validate(rec).config.appearance.subtitle == ""


def test_subtitle_over_500_chars_is_refused():
    rec = default_record("structured", "line").model_dump()
    rec["config"]["appearance"]["subtitle"] = "x" * 501
    with pytest.raises(ValueError):
        FigureRecord.model_validate(rec)


@pytest.mark.parametrize("plot_type", TYPES)
def test_subtitle_is_drawn_under_the_title_for_every_plot_type(plot_type):
    src, ax = draw(make(plot_type, title="Main", subtitle="n = 4 samples"))
    assert "Main" in texts(ax) and "n = 4 samples" in texts(ax)
    assert "pad=" in src                                  # title lifted above the subtitle


@pytest.mark.parametrize("plot_type", TYPES)
def test_empty_subtitle_adds_nothing(plot_type):
    src, ax = draw(make(plot_type, title="Main"))
    assert "xytext=(0, 4)" not in src and "pad=" not in src and "Main" in texts(ax)


def test_show_title_false_hides_title_and_subtitle():
    src, ax = draw(make("line", title="Main", subtitle="Sub", showTitle=False))
    assert "Main" not in texts(ax) and "Sub" not in texts(ax) and "Sub" not in src


def test_subtitle_without_title_is_still_shown():
    _, ax = draw(make("scatter", subtitle="Only a subtitle"))
    assert "Only a subtitle" in texts(ax)


def test_subtitle_is_written_as_a_literal_and_uses_label_size():
    src, ax = draw(make("line", title="T", subtitle="it's \"quoted\"\\n", labelSize=13))
    assert "it's \"quoted\"\\n" in texts(ax)
    assert "fontsize=13" in src
