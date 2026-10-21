"""Bar chart script generation (docs/FIGURES_CONTRACT.md s4e): the script is run and the drawn bars are measured."""
import contextlib
import io
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pytest
from PIL import Image

from backend.figures.codegen import CodegenError, emit_script
from backend.figures.models import default_record
from backend.figures.runner import run_python

BLUE, ORANGE = "#0072B2", "#D55E00"


def make(rows, columns=("cat", "a", "b"), y=("a",), x="cat", group=None, y_err=None, series=None, **sections):
    """Valid bar record (dict). The first column is text, the others are numbers; ``appearance=``/``options=`` merge in."""
    rec = default_record("structured", "bar").model_dump()
    kinds = ["text"] + ["number"] * (len(columns) - 1)
    if group:
        kinds[columns.index(group)] = "text"
    rec["dataset"] = {"columns": [{"name": c, "type": k} for c, k in zip(columns, kinds)], "rows": rows,
                      "origin": {"type": "sheet", "label": ""}}
    config = rec["config"]
    config["mapping"] = {"x": x, "y": list(y), "group": group, "yErr": y_err}
    for name, values in sections.items():
        config[name].update(values)
    config["options"]["series"] = series or {}
    rec["export"].update(wIn=5.0, hIn=3.0, dpi=100)
    return rec


@contextlib.contextmanager
def executed(source):
    """Run a generated script in this process (Agg backend) and yield (figure, axes, script namespace)."""
    with matplotlib.rc_context(), warnings.catch_warnings():
        warnings.simplefilter("ignore")
        plt.close("all")
        namespace = {"__name__": "__main__"}
        exec(compile(source, "<generated>", "exec"), namespace)
        fig = plt.gcf()
        try:
            yield fig, fig.axes[0], namespace
        finally:
            plt.close("all")


def codes(error):
    return [i["code"] for i in error.value.issues]


def error_segments(ax):
    """One list of error-bar segments ([[x0, y0], [x1, y1]]) per errorbar call in the axes."""
    found = [c for c in ax.containers if type(c).__name__ == "ErrorbarContainer"]
    return [[seg.tolist() for seg in c.lines[2][0].get_segments()] for c in found]


def warning_codes(script):
    return [w["code"] for w in script.warnings]


def bars(container):
    """[(centre along the category axis, length along the value axis)] of a vertical BarContainer."""
    return [(p.get_x() + p.get_width() / 2, p.get_height()) for p in container.patches]


WIDE = [["A", 1.0, 2.0], ["B", 3.0, 4.0], ["C", 5.0, 6.0]]


# ---------------------------------------------------------------- grouped
def test_grouped_bars_sit_in_fixed_slots_and_a_missing_combination_leaves_its_slot_empty():
    rows = [["A", 1.0, 2.0], ["B", 3.0, None], ["C", 5.0, 6.0]]
    with executed(emit_script(make(rows, y=("a", "b"))).source) as (fig, ax, ns):
        first, second = [c for c in ax.containers if len(c.patches)]
        assert np.allclose([c for c, _ in bars(first)], [-0.2, 0.8, 1.8])       # slot 0 of 0.8 / 2 = 0.4 per bar
        assert np.allclose([h for _, h in bars(first)], [1, 3, 5])
        assert np.allclose([c for c, _ in bars(second)], [0.2, 2.2])           # nothing at 1.2 ...
        assert np.allclose([h for _, h in bars(second)], [2, 6])
        assert np.allclose([p.get_width() for p in first.patches], 0.4)        # ... and the first series did not move
        assert [t.get_text() for t in ax.get_xticklabels()] == ["A", "B", "C"]


def test_bar_width_sets_the_share_of_the_slot():
    with executed(emit_script(make(WIDE, y=("a", "b"), options={"barWidth": 0.5})).source) as (fig, ax, ns):
        assert np.allclose([p.get_width() for c in ax.containers for p in c.patches], 0.25)
    with executed(emit_script(make(WIDE, y=("a", "b"), options={"barWidth": 0.5, "barMode": "stacked"})).source) as (_, ax, _):
        assert np.allclose([p.get_width() for c in ax.containers for p in c.patches], 0.5)


def test_axis_starts_at_zero_by_default_and_includes_negative_values():
    with executed(emit_script(make(WIDE)).source) as (fig, ax, ns):
        assert ax.get_ylim()[0] == 0
    with executed(emit_script(make([["A", -2.0, 0], ["B", 3.0, 0]])).source) as (fig, ax, ns):
        assert ax.get_ylim()[0] < -2 and ax.get_ylim()[1] > 3


def test_series_colours_follow_the_palette_and_a_per_series_colour_wins():
    rec = make(WIDE, y=("a", "b"), series={"b": {"color": "#112233"}})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        first, second = ax.containers
        assert matplotlib.colors.to_hex(first.patches[0].get_facecolor()).upper() == BLUE
        assert matplotlib.colors.to_hex(second.patches[0].get_facecolor()).upper() == "#112233"


def test_hidden_series_are_not_drawn_and_a_single_series_has_no_legend_unless_forced():
    rec = make(WIDE, y=("a", "b"), series={"b": {"visible": False}})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert len(ax.containers) == 1 and ax.get_legend() is None
        assert np.allclose([p.get_width() for p in ax.containers[0].patches], 0.8)
    with executed(emit_script(make(WIDE, y=("a", "b"))).source) as (fig, ax, ns):
        assert [t.get_text() for t in ax.get_legend().get_texts()] == ["a", "b"]


def test_category_labels_can_be_rotated():
    with executed(emit_script(make(WIDE, appearance={"xTickRotation": 45})).source) as (fig, ax, ns):
        assert all(t.get_rotation() == 45 for t in ax.get_xticklabels())


# ---------------------------------------------------------------- stacked
def test_stacked_bars_add_up_and_missing_values_add_nothing():
    rows = [["A", 1.0, 3.0], ["B", 2.0, None], ["C", 4.0, 5.0]]
    with executed(emit_script(make(rows, y=("a", "b"), options={"barMode": "stacked"})).source) as (fig, ax, ns):
        first, second = [c for c in ax.containers if len(c.patches)]
        assert [(p.get_y(), p.get_height()) for p in first.patches] == [(0, 1), (0, 2), (0, 4)]
        assert [(p.get_y(), p.get_height()) for p in second.patches] == [(1, 3), (4, 5)]    # B has no segment
        tops = [p.get_y() + p.get_height() for p in second.patches]
        assert tops == [4, 9]                                                               # stack totals 1+3 and 4+5


def test_stacked_negative_values_go_below_zero_and_never_mix_with_the_positive_part():
    rows = [["A", 2.0, 3.0, -1.0], ["B", -1.0, 2.0, -2.0]]
    rec = make(rows, columns=("cat", "a", "b", "c"), y=("a", "b", "c"), options={"barMode": "stacked"})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        a, b, c = ax.containers
        assert [(p.get_y(), p.get_height()) for p in a.patches] == [(0, 2), (0, -1)]
        assert [(p.get_y(), p.get_height()) for p in b.patches] == [(2, 3), (0, 2)]         # B: positive part starts at 0
        assert [(p.get_y(), p.get_height()) for p in c.patches] == [(0, -1), (-1, -2)]      # B: below a's -1
        low, high = ax.get_ylim()
        assert low < -3 and high > 5


# ------------------------------------------------------------- horizontal
def test_horizontal_bars_put_categories_on_the_y_axis_first_one_on_top():
    rows = [["A", 1.0, 2.0], ["B", 3.0, 4.0]]
    with executed(emit_script(make(rows, y=("a", "b"), options={"orient": "horizontal"},
                                   appearance={"xLabel": "Count"})).source) as (fig, ax, ns):
        first, second = ax.containers
        assert [p.get_width() for p in first.patches] == [1, 3]                  # lengths run along x
        assert np.allclose([p.get_y() + p.get_height() / 2 for p in first.patches], [-0.2, 0.8])
        assert np.allclose([p.get_y() + p.get_height() / 2 for p in second.patches], [0.2, 1.2])
        assert [t.get_text() for t in ax.get_yticklabels()] == ["A", "B"]
        assert ax.get_ylim()[0] > ax.get_ylim()[1]                               # inverted: "A" is drawn above "B"
        assert ax.get_xlim()[0] == 0 and ax.get_xlabel() == "Count" and ax.get_ylabel() == "cat"


def test_horizontal_scale_and_limits_apply_to_the_value_axis_and_the_category_axis_ignores_them():
    rec = make(WIDE, options={"orient": "horizontal", "xLim": [0, 10], "yLim": [0, 1]})
    script = emit_script(rec)
    assert "category_axis_option_ignored" in warning_codes(script)
    with executed(script.source) as (fig, ax, ns):
        assert ax.get_xlim() == (0, 10) and ax.get_ylim() == (2.5, -0.5)


# ------------------------------------------------------------ error bars
def test_error_bars_come_from_the_supplied_column_and_are_not_given_a_meaning():
    rows = [["A", 1.0, 0.5], ["B", 3.0, 1.0]]
    script = emit_script(make(rows, y=("a",), y_err="b", options={"errorBars": True}))
    assert "error_bars_meaning" in warning_codes(script)
    assert "standard" not in script.source.lower() and "sem" not in script.source.lower().split()
    with executed(script.source) as (fig, ax, ns):
        (segments,) = error_segments(ax)
        assert segments == [[[0.0, 0.5], [0.0, 1.5]], [[1.0, 2.0], [1.0, 4.0]]]         # value -/+ the column, as given


def test_error_bars_follow_the_chosen_series_and_can_be_asymmetric_and_horizontal():
    rows = [["A", 2.0, 0.5, 1.5], ["B", 4.0, 1.0, 2.0]]
    series = {"a": {"error": "asymmetric", "errorLowCol": "lo", "errorHighCol": "hi"}}
    rec = make(rows, columns=("cat", "a", "lo", "hi"), y=("a",), series=series, options={"orient": "horizontal"})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        (segments,) = error_segments(ax)
        assert segments == [[[1.5, 0.0], [3.5, 0.0]], [[3.0, 1.0], [6.0, 1.0]]]         # x: value - lo .. value + hi


def test_stacked_error_bars_sit_at_the_end_of_their_own_segment():
    rows = [["A", 2.0, 3.0, 0.5], ["B", 1.0, 1.0, 0.25]]
    rec = make(rows, columns=("cat", "a", "b", "e"), y=("a", "b"), y_err="e", options={"barMode": "stacked", "errorBars": True})
    script = emit_script(rec)
    assert "stacked_error_bars" in warning_codes(script)
    with executed(script.source) as (fig, ax, ns):
        centres = sorted(np.mean([point[1] for point in seg]) for segments in error_segments(ax) for seg in segments)
        assert centres == [1.0, 2.0, 2.0, 5.0]                                           # a ends at 2 and 1, b at 2+3 and 1+1


def test_missing_negative_and_text_error_columns_are_refused():
    rows = [["A", 1.0, -0.5], ["B", 2.0, 0.5]]
    with pytest.raises(CodegenError) as err:
        emit_script(make(rows, y=("a",), y_err="b", options={"errorBars": True}))
    assert codes(err) == ["error_negative"]
    series = {"a": {"error": "symmetric"}}
    with pytest.raises(CodegenError) as err:
        emit_script(make(WIDE, y=("a",), series=series))
    assert "mapping_missing" in codes(err)


# ------------------------------------------------------------- long format
def test_long_data_is_pivoted_with_categories_and_series_in_order_of_first_appearance():
    rows = [["B", "y", 2.0], ["A", "x", 1.0], ["B", "x", 3.0], ["A", "y", 4.0]]
    rec = make(rows, columns=("cat", "grp", "val"), y=("val",), group="grp")
    script = emit_script(rec)
    assert emit_script(rec).source == script.source                                    # deterministic
    with executed(script.source) as (fig, ax, ns):
        assert [t.get_text() for t in ax.get_xticklabels()] == ["B", "A"]
        first, second = ax.containers
        assert (first.get_label(), second.get_label()) == ("y", "x")
        assert [h for _, h in bars(first)] == [2, 4] and [h for _, h in bars(second)] == [3, 1]
        assert ax.get_ylabel() == "val"


def test_long_data_with_a_missing_pair_leaves_an_empty_slot():
    rows = [["A", "x", 1.0], ["A", "y", 2.0], ["B", "x", 3.0]]
    rec = make(rows, columns=("cat", "grp", "val"), y=("val",), group="grp")
    with executed(emit_script(rec).source) as (fig, ax, ns):
        x_bars, y_bars = ax.containers
        assert np.allclose([c for c, _ in bars(x_bars)], [-0.2, 0.8])
        assert np.allclose([c for c, _ in bars(y_bars)], [0.2])


def test_repeated_categories_or_pairs_are_refused_instead_of_averaged():
    with pytest.raises(CodegenError) as err:
        emit_script(make([["A", 1.0, 1.0], ["A", 2.0, 2.0]]))
    assert codes(err) == ["duplicate_category"] and "rows 1 and 2" in err.value.issues[0]["message"]
    rows = [["A", "x", 1.0], ["A", "x", 2.0]]
    with pytest.raises(CodegenError) as err:
        emit_script(make(rows, columns=("cat", "grp", "val"), y=("val",), group="grp"))
    assert codes(err) == ["duplicate_combination"]


def test_long_data_needs_a_category_column_and_uses_only_the_first_value_column():
    rows = [["A", "x", 1.0, 9.0]]
    rec = make(rows, columns=("cat", "grp", "val", "other"), y=("val", "other"), group="grp")
    assert "y_columns_ignored" in warning_codes(emit_script(rec))
    rec["config"]["mapping"]["x"] = None
    with pytest.raises(CodegenError) as err:
        emit_script(rec)
    assert "mapping_missing" in codes(err)


# ----------------------------------------------- truncation, labels, limits
def test_limits_that_hide_zero_give_a_visible_warning_and_an_optional_note_on_the_figure():
    rec = make(WIDE, options={"yLim": [2, 6]})
    script = emit_script(rec)
    found = [w for w in script.warnings if w["code"] == "axis_truncated"]
    assert found and found[0]["level"] == "warning"
    with executed(script.source) as (fig, ax, ns):
        assert not any("truncated" in t.get_text() for t in ax.texts)
    with executed(emit_script(make(WIDE, options={"yLim": [2, 6], "axisNote": True})).source) as (fig, ax, ns):
        assert any("Axis truncated" in t.get_text() for t in ax.texts)
    assert "axis_truncated" not in warning_codes(emit_script(make(WIDE, options={"yLim": [0, 6], "axisNote": True})))
    horizontal = emit_script(make(WIDE, options={"orient": "horizontal", "xLim": [-5, -1]}))
    assert "axis_truncated" in warning_codes(horizontal)                                # 0 is above the limits


def test_value_labels_use_the_format_string_beyond_the_bar_tip():
    rows = [["A", 1.25, 0.5], ["B", -2.0, 0.5]]
    rec = make(rows, y=("a",), options={"valueLabels": True, "valueFormat": "{:.1f} kg"})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        labels = {t.get_text(): t for t in ax.texts}
        assert set(labels) == {"1.2 kg", "-2.0 kg"}                                     # formatted by str.format
        assert labels["1.2 kg"].xyann[1] > 0 > labels["-2.0 kg"].xyann[1]               # above / below the bar
        assert labels["1.2 kg"].xy == (0.0, 1.25)


def test_stacked_value_labels_sit_inside_their_segments_and_skip_missing_values():
    rows = [["A", 2.0, 4.0], ["B", 1.0, None]]
    rec = make(rows, y=("a", "b"), options={"barMode": "stacked", "valueLabels": True, "valueFormat": "{:g}"})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        placed = sorted((t.get_text(), t.xy) for t in ax.texts)
        assert placed == [("1", (1.0, 0.5)), ("2", (0.0, 1.0)), ("4", (0.0, 4.0))]


def test_unusable_value_formats_are_refused():
    for template in ["{:d}", "{0.real}", "{}{}", "no field", "{:99999g}"]:
        with pytest.raises(CodegenError) as err:
            emit_script(make(WIDE, options={"valueLabels": True, "valueFormat": template}))
        assert codes(err) == ["value_format_invalid"]


def test_log_axis_rules():
    with pytest.raises(CodegenError) as err:
        emit_script(make([["A", 0.0, 1.0]], options={"yScale": "log"}))
    assert codes(err) == ["log_nonpositive"]
    with pytest.raises(CodegenError) as err:
        emit_script(make(WIDE, y=("a", "b"), options={"yScale": "log", "barMode": "stacked"}))
    assert codes(err) == ["stacked_log_axis"]
    assert "log_axis_baseline" in warning_codes(emit_script(make(WIDE, options={"yScale": "log"})))


def test_an_all_missing_group_warns_and_a_missing_error_value_only_skips_that_error_bar():
    rows = [["A", "x", 1.0], ["A", "y", None], ["B", "x", 2.0]]
    script = emit_script(make(rows, columns=("cat", "grp", "val"), y=("val",), group="grp"))
    assert "series_draws_nothing" in warning_codes(script)
    with executed(script.source) as (fig, ax, ns):
        assert [len(c.patches) for c in ax.containers] == [2, 0]
        fig.canvas.draw()                                                                # the empty series breaks nothing
    rows = [["A", 1.0, 0.5], ["B", 2.0, None]]
    with executed(emit_script(make(rows, y=("a",), y_err="b", options={"errorBars": True})).source) as (fig, ax, ns):
        segments = error_segments(ax)[0]
        assert len(segments) == 2 and np.isfinite(segments[0]).all() and not np.isfinite(segments[1]).any()
        fig.canvas.draw()


# --------------------------------------------------------------- misc
def test_row_numbers_are_the_categories_without_a_category_column():
    with executed(emit_script(make(WIDE, x=None)).source) as (fig, ax, ns):
        assert [t.get_text() for t in ax.get_xticklabels()] == ["1", "2", "3"] and ax.get_xlabel() == "Row"


def test_names_with_quotes_and_newlines_cannot_break_the_script():
    rows = [["it's \"A\"\nline", 1.0, 1.0]]
    rec = make(rows, columns=("cat'x", "a\"", "b"), x="cat'x", y=("a\"",), appearance={"title": "T'\"\\\n"})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert ax.get_xticklabels()[0].get_text() == "it's \"A\"\nline"


def test_script_runs_in_the_runner_and_draws_bars():
    rec = make(WIDE, y=("a", "b"))
    script = emit_script(rec)
    res = run_python(script.source, dpi=100, files=script.files)
    assert res.ok, f"{res.message}\n{res.stderr}"
    img = Image.open(io.BytesIO(res.png_bytes))
    assert img.size == (500, 300)
    rgb = np.asarray(img.convert("RGB")).astype(int)
    assert (np.abs(rgb - np.array([0x00, 0x72, 0xB2])).sum(axis=-1) < 40).sum() > 100   # first series colour
    assert (np.abs(rgb - np.array([0xD5, 0x5E, 0x00])).sum(axis=-1) < 40).sum() > 100   # second series colour
