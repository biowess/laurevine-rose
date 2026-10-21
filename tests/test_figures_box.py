"""Box plot script generation (docs/FIGURES_CONTRACT.md s4g): the script is run and the drawn artists are measured."""
import contextlib
import os
import tempfile
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pytest
from matplotlib.colors import to_rgba

from backend.figures.codegen import CodegenError, emit_script
from backend.figures.models import default_record
from backend.figures.runner import run_python

SPIKY = [1, 2, 3, 4, 5, 6, 7, 8, 9, 30]      # n = 10, linear quartiles 3.25 / 5.5 / 7.75, IQR 4.5, upper fence 14.5


def make(rows, columns=("g", "v"), group="g", **sections):
    """Valid box record (dict). ``rows`` = [[group, value], ...] (or [[value], ...] with columns=('v',))."""
    rec = default_record("structured", "box").model_dump()
    types = ["number" if c == "v" else "text" for c in columns]
    rec["dataset"] = {"columns": [{"name": c, "type": t} for c, t in zip(columns, types)], "rows": rows,
                      "origin": {"type": "sheet", "label": ""}}
    rec["config"]["mapping"] = {"x": None, "y": ["v"], "group": group, "yErr": None}
    for name, items in sections.items():
        rec["config"][name].update(items)
    rec["export"].update(wIn=6.0, hIn=4.0, dpi=100)
    return rec


def grouped(**data):
    """rows for {'A': [values], 'B': [values]}; group order = key order."""
    return [[g, v] for g, values in data.items() for v in values]


@contextlib.contextmanager
def executed(source, record_warnings=None):
    """Run a generated script in this process (Agg backend) and yield (figure, axes, script namespace)."""
    with matplotlib.rc_context(), warnings.catch_warnings(record=record_warnings is not None) as caught:
        warnings.simplefilter("always" if record_warnings is not None else "ignore")
        plt.close("all")
        namespace = {"__name__": "__main__"}
        exec(compile(source, "<generated>", "exec"), namespace)
        fig = plt.gcf()
        try:
            yield fig, fig.axes[0], namespace
        finally:
            if record_warnings is not None:
                record_warnings.extend(caught)
            plt.close("all")


def run(rec):
    """Generate and run; return (namespace stats list, bxp artists, axes, figure) - figure is closed afterwards."""
    script = emit_script(rec)
    with executed(script.source) as (fig, ax, ns):
        return ns, ns["bp"], ax, fig, script


def codes(error):
    return [i["code"] for i in error.value.issues]


def warning_codes(script):
    return [w["code"] for w in script.warnings]


def note(script, code):
    return next(w for w in script.warnings if w["code"] == code)


def overlay_points(ax):
    return sum(len(c.get_offsets()) for c in ax.collections)


# ------------------------------------------------------------------ quartiles
def test_quartiles_match_numpy_linear_and_are_what_is_drawn():
    data = {"A": [2.5, 3.1, 4.8, 5.0, 6.2, 7.7, 9.0, 11.3], "B": [1.0, 1.5, 2.0, 8.0, 9.0], "C": [4.0, 4.0, 4.5, 5.0]}
    rec = make(grouped(**data))
    with executed(emit_script(rec).source) as (fig, ax, ns):
        stats, bp = ns["stats"], ns["bp"]
        for k, values in enumerate(data.values()):
            q1, med, q3 = np.percentile(values, [25, 50, 75])
            assert stats[k]["q1"] == pytest.approx(q1) and stats[k]["med"] == pytest.approx(med)
            assert stats[k]["q3"] == pytest.approx(q3) and stats[k]["n"] == len(values)
            ys = bp["boxes"][k].get_path().vertices[:, 1]          # what Matplotlib really drew
            assert (ys.min(), ys.max()) == (pytest.approx(q1), pytest.approx(q3))
            assert bp["medians"][k].get_ydata()[0] == pytest.approx(med)


def test_quartile_method_linear_vs_midpoint_documented_values():
    values = [1, 2, 3, 4, 5, 6]                                   # positions 1.25 and 3.75
    rows = [[v] for v in values]
    for method, q1, q3 in (("linear", 2.25, 4.75), ("midpoint", 2.5, 4.5)):
        rec = make(rows, columns=("v",), group=None, options={"quartileMethod": method})
        with executed(emit_script(rec).source) as (fig, ax, ns):
            assert (ns["stats"][0]["q1"], ns["stats"][0]["q3"]) == (q1, q3)
            assert ns["stats"][0]["q1"] == np.percentile(values, 25, method=method)
            assert ns["stats"][0]["med"] == 3.5


def test_midpoint_applies_to_percentile_whiskers_too():
    rec = make([[v] for v in SPIKY], columns=("v",), group=None, options={"whisker": "percentile", "quartileMethod": "midpoint"})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        low, high = np.percentile(SPIKY, [5, 95], method="midpoint")
        assert (ns["stats"][0]["whislo"], ns["stats"][0]["whishi"]) == (low, high)


# ------------------------------------------------------------------- whiskers
@pytest.mark.parametrize("rule, low, high, fliers", [
    ("iqr", 1, 9, [30]),                       # fences -3.5 .. 14.5: the largest value inside is 9
    ("minmax", 1, 30, []),
    ("percentile", 1.45, 20.55, [1, 30]),      # 5th / 95th percentile, linear
])
def test_whisker_rules(rule, low, high, fliers):
    rec = make([[v] for v in SPIKY], columns=("v",), group=None, options={"whisker": rule})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        stat, bp = ns["stats"][0], ns["bp"]
        assert (stat["whislo"], stat["whishi"]) == (pytest.approx(low), pytest.approx(high))
        assert sorted(stat["fliers"]) == fliers
        ends = sorted(np.concatenate([w.get_ydata() for w in bp["whiskers"]]))   # drawn whisker segments
        assert min(ends) == pytest.approx(low) and max(ends) == pytest.approx(high)
        assert sum(len(f.get_ydata()) for f in bp["fliers"]) == len(fliers)


def test_iqr_rule_whiskers_end_on_observations_not_on_the_fence():
    rec = make([[v] for v in [10, 11, 12, 13, 14, 15, 16, 17, 18, 100, -50]], columns=("v",), group=None)
    with executed(emit_script(rec).source) as (fig, ax, ns):
        values = np.array([10, 11, 12, 13, 14, 15, 16, 17, 18, 100, -50])
        q1, q3 = np.percentile(values, [25, 75])
        inside = values[(values >= q1 - 1.5 * (q3 - q1)) & (values <= q3 + 1.5 * (q3 - q1))]
        assert (ns["stats"][0]["whislo"], ns["stats"][0]["whishi"]) == (inside.min(), inside.max())
        assert sorted(ns["stats"][0]["fliers"]) == [-50, 100]


# ------------------------------------------------------------------- outliers
def test_outliers_are_drawn_by_default_and_counted_in_a_note():
    rec = make(grouped(A=SPIKY, B=[1, 2, 3, 4, 5, 6, 7, 8, -40]))
    ns, bp, ax, fig, script = run(rec)
    assert ns["outlier_counts"] == [1, 1]
    assert [len(f.get_ydata()) for f in bp["fliers"]] == [1, 1]
    assert "outliers_shown" in warning_codes(script) and "outliers_hidden" not in warning_codes(script)
    assert "A: 1" in note(script, "outliers_shown")["message"]


def test_hidden_outliers_are_reported_with_their_number_and_still_count_in_statistics():
    rec = make(grouped(A=SPIKY, B=[1, 2, 3, 4, 5, 6, 7, 8, -40]), options={"showOutliers": False})
    ns, bp, ax, fig, script = run(rec)
    assert len(bp["fliers"]) == 0
    message = note(script, "outliers_hidden")["message"]
    assert message.startswith("2 values") and "A: 1" in message and "B: 1" in message
    assert ns["stats"][0]["mean"] == pytest.approx(np.mean(SPIKY))
    assert ns["stats"][0]["n"] == 10                                   # the hidden value is still in n and the quartiles


def test_no_outliers_no_note():
    rec = make([[v] for v in range(1, 12)], columns=("v",), group=None)
    codes_found = warning_codes(emit_script(rec))
    assert "outliers_shown" not in codes_found and "outliers_hidden" not in codes_found


def test_percentile_whiskers_say_that_values_beyond_are_not_outliers():
    rec = make([[v] for v in SPIKY], columns=("v",), group=None, options={"whisker": "percentile"})
    assert "percentile_whiskers" in warning_codes(emit_script(rec))


# --------------------------------------------------------------- empty groups
def test_group_without_valid_values_is_flagged_marked_and_keeps_its_place():
    rows = grouped(A=[1, 2, 3, 4], B=[None, None], C=[5, 6, 7])
    ns, bp, ax, fig, script = run(make(rows))
    assert ns["labels"] == ["A", "B", "C"]
    assert len(bp["boxes"]) == 2 and ns["positions"] == [1, 3]       # C keeps slot 3
    assert "(no valid values)" in [t.get_text() for t in ax.get_xticklabels()][1]
    assert "group_empty" in warning_codes(script) and "'B'" in note(script, "group_empty")["message"]


def test_all_values_missing_is_refused():
    with pytest.raises(CodegenError) as error:
        emit_script(make(grouped(A=[None, None], B=[None])))
    assert codes(error)                     # dataset validation (column_empty) or no_numeric_values


def test_single_value_group_warns():
    script = emit_script(make(grouped(A=[1, 2, 3], B=[5])))
    assert "group_single_value" in warning_codes(script)


# ------------------------------------------------------------ overlay (points)
def test_overlay_draws_every_value_within_the_whiskers_once():
    rec = make(grouped(A=SPIKY, B=[2, 3, 4, 5, 6, 7, 8]), options={"showPoints": True})
    ns, bp, ax, fig, script = run(rec)
    assert overlay_points(ax) == 9 + 7                                # 30 is an outlier, drawn as a circle instead
    assert ns["overlay_counts"] == [9, 7]
    drawn_total = overlay_points(ax) + sum(len(f.get_ydata()) for f in bp["fliers"])
    assert drawn_total == 10 + 7                                      # every valid value appears exactly once


def test_overlay_with_minmax_whiskers_shows_all_values():
    rec = make([[v] for v in SPIKY], columns=("v",), group=None, options={"showPoints": True, "whisker": "minmax"})
    ns, bp, ax, fig, script = run(rec)
    assert overlay_points(ax) == 10 and sum(len(f.get_ydata()) for f in bp["fliers"]) == 0


def test_overlay_with_hidden_outliers_leaves_them_out_and_the_note_says_how_many():
    rec = make([[v] for v in SPIKY], columns=("v",), group=None, options={"showPoints": True, "showOutliers": False})
    ns, bp, ax, fig, script = run(rec)
    assert overlay_points(ax) == 9
    assert note(script, "outliers_hidden")["message"].startswith("1 value ")


def test_overlay_ignores_missing_values_and_stays_inside_the_box_slot():
    rows = grouped(A=[1, 2, None, 3, 4, 5], B=[7, 8, 9])
    rec = make(rows, options={"showPoints": True, "boxWidth": 0.5})
    ns, bp, ax, fig, script = run(rec)
    assert overlay_points(ax) == 5 + 3
    for collection, center in zip(ax.collections, (1, 2)):
        xs = collection.get_offsets()[:, 0]
        assert np.all(np.abs(xs - center) <= 0.2 + 1e-9)             # 0.8 x boxWidth / 2


def test_jitter_is_deterministic():
    rec = make(grouped(A=[1, 2, 3, 4, 5, 6], B=[3, 4, 5, 6, 7]), options={"showPoints": True})
    first, second = emit_script(rec), emit_script(rec)
    assert first.source == second.source
    xs = []
    for script in (first, second):
        with executed(script.source) as (fig, ax, ns):
            xs.append(np.concatenate([c.get_offsets()[:, 0] for c in ax.collections]))
    assert np.array_equal(xs[0], xs[1]) and len(set(np.round(xs[0], 6))) > 6      # reproducible, and actually spread out


def test_changing_one_group_does_not_move_the_points_of_another():
    a = emit_script(make(grouped(A=[1, 2, 3, 4], B=[3, 4, 5, 6]), options={"showPoints": True}))
    b = emit_script(make(grouped(A=[1, 2, 3, 4, 5], B=[3, 4, 5, 6]), options={"showPoints": True}))
    out = []
    for script in (a, b):
        with executed(script.source) as (fig, ax, ns):
            out.append(ax.collections[1].get_offsets()[:, 0].copy())
    assert np.array_equal(out[0], out[1])


# ------------------------------------------------------------ order and labels
def test_groups_keep_first_appearance_order_and_label_oddities():
    rows = [["B", 1], ["A", 2], ["B", 3], [None, 4], ["A", 5], ["", 6], ["C", 7], ["C", 8]]
    ns, bp, ax, fig, script = run(make(rows))
    assert ns["labels"] == ["B", "A", "(no group)", "C"]
    assert [t.get_text() for t in ax.get_xticklabels()] == ns["labels"]
    assert ns["groups"][2].tolist() == [4, 6]


def test_numeric_group_column_is_labelled_as_text():
    rec = make([[2.0, 1], [1.5, 2], [2.0, 3], [None, 4]], columns=("g", "v"))
    rec["dataset"]["columns"][0]["type"] = "number"
    ns, bp, ax, fig, script = run(rec)
    assert ns["labels"] == ["2", "1.5", "(no group)"]


def test_no_group_column_draws_one_box_named_after_the_column():
    ns, bp, ax, fig, script = run(make([[v] for v in range(1, 9)], columns=("v",), group=None))
    assert ns["labels"] == ["v"] and len(bp["boxes"]) == 1
    assert ax.get_ylabel() == "v"


def test_x_column_works_as_group_and_group_wins_when_both_are_set():
    rec = make(grouped(A=[1, 2, 3], B=[4, 5, 6]), group=None)
    rec["config"]["mapping"]["x"] = "g"
    assert run(rec)[0]["labels"] == ["A", "B"]
    rec = make(grouped(A=[1, 2, 3], B=[4, 5, 6]), columns=("g", "v"))
    rec["dataset"]["columns"].append({"name": "h", "type": "text"})
    for row in rec["dataset"]["rows"]:
        row.append("z")
    rec["config"]["mapping"]["x"] = "h"
    script = emit_script(rec)
    assert "x_ignored" in warning_codes(script)


def test_more_than_fifty_groups_refused():
    rows = [[f"g{i}", float(i)] for i in range(51)]
    with pytest.raises(CodegenError) as error:
        emit_script(make(rows))
    assert codes(error) == ["too_many_groups"]


def test_extra_y_columns_are_ignored_with_a_warning():
    rec = make(grouped(A=[1, 2, 3], B=[4, 5, 6]))
    rec["dataset"]["columns"].append({"name": "w", "type": "number"})
    for row in rec["dataset"]["rows"]:
        row.append(1.0)
    rec["config"]["mapping"]["y"] = ["v", "w"]
    assert "y_columns_ignored" in warning_codes(emit_script(rec))


# --------------------------------------------------------------------- notches
def test_notches_refused_when_a_group_is_too_small():
    rec = make(grouped(A=list(range(1, 13)), B=list(range(1, 10))), options={"notch": True})
    with pytest.raises(CodegenError) as error:
        emit_script(rec)
    assert codes(error) == ["notch_n_too_small"]
    assert "'B' (n = 9)" in str(error.value) and "'A'" not in str(error.value)


def test_notches_drawn_with_the_documented_interval():
    values = [4.1, 4.8, 5.0, 5.2, 5.5, 5.6, 5.9, 6.1, 6.4, 6.8, 7.0, 7.3]
    rec = make([[v] for v in values], columns=("v",), group=None, options={"notch": True})
    ns, bp, ax, fig, script = run(rec)
    q1, med, q3 = np.percentile(values, [25, 50, 75])
    half = 1.57 * (q3 - q1) / np.sqrt(len(values))
    assert ns["stats"][0]["cilo"] == pytest.approx(med - half) and ns["stats"][0]["cihi"] == pytest.approx(med + half)
    plain = run(make([[v] for v in values], columns=("v",), group=None))[1]
    assert len(bp["boxes"][0].get_path().vertices) > len(plain["boxes"][0].get_path().vertices)    # notched outline
    assert "notch_method" in warning_codes(script)


def test_notch_reaching_past_the_quartiles_is_warned():
    values = [1, 2, 2, 2, 2, 2, 2, 2, 9, 10, 11, 12]       # q1 = 2, median = 2, q3 = 9.25, notch 2 -/+ 3.29 starts below q1
    rec = make([[v] for v in values], columns=("v",), group=None, options={"notch": True})
    script = emit_script(rec)
    assert "notch_beyond_box" in warning_codes(script)
    tame = make([[v] for v in range(1, 13)], columns=("v",), group=None, options={"notch": True})
    assert "notch_beyond_box" not in warning_codes(emit_script(tame))


# ----------------------------------------------------------------------- mean
def test_mean_marker_is_the_mean_of_all_valid_values_including_outliers():
    rec = make(grouped(A=SPIKY, B=[2, 3, 4, 5, None]), options={"showMean": True})
    ns, bp, ax, fig, script = run(rec)
    assert [m.get_ydata()[0] for m in bp["means"]] == [pytest.approx(np.mean(SPIKY)), pytest.approx(3.5)]
    assert len(run(make(grouped(A=SPIKY)))[1]["means"]) == 0           # off by default


# ------------------------------------------------------------------- styling
def test_box_colours_follow_group_position_or_one_override_with_alpha():
    ns, bp, ax, fig, script = run(make(grouped(A=[1, 2, 3], B=[2, 3, 4], C=[3, 4, 5]), appearance={"alpha": 0.5}))
    faces = [p.get_facecolor() for p in bp["boxes"]]
    assert faces[0] == to_rgba("#0072B2", 0.5) and faces[1] == to_rgba("#D55E00", 0.5) and faces[2] == to_rgba("#009E73", 0.5)
    ns, bp, ax, fig, script = run(make(grouped(A=[1, 2, 3], B=[2, 3, 4]), options={"boxColor": "#112233"}))
    assert {p.get_facecolor() for p in bp["boxes"]} == {to_rgba("#112233")}


def test_median_and_whisker_styling():
    rec = make(grouped(A=[1, 2, 3, 4, 5, 6], B=[2, 3, 4, 5, 6, 7]),
               options={"medianColor": "#FF0000", "medianWidth": 4, "whiskerColor": "#00AA00", "whiskerStyle": "dashed",
                        "boxEdgeColor": "#222222"})
    ns, bp, ax, fig, script = run(rec)
    assert all(m.get_color() == "#FF0000" and m.get_linewidth() == 4 for m in bp["medians"])
    assert all(w.get_color() == "#00AA00" and w.get_linestyle() == "--" for w in bp["whiskers"])
    assert all(c.get_linestyle() == "-" for c in bp["caps"])
    assert bp["boxes"][0].get_edgecolor() == to_rgba("#222222")


def test_default_median_contrasts_with_the_fill():
    ns, bp, ax, fig, script = run(make(grouped(A=[1, 2, 3], B=[2, 3, 4])))        # dark blue, orange
    assert [m.get_color() for m in bp["medians"]] == ["#FFFFFF", "#000000"]
    assert run(make(grouped(A=[1, 2, 3]), options={"medianWidth": None}, appearance={"lineWidth": 2.0}))[1]["medians"][0].get_linewidth() == 4.0


# --------------------------------------------------------------- orientation
def test_horizontal_boxes_use_the_x_axis_for_values_and_start_at_the_top():
    caught = []
    rec = make(grouped(A=[1, 2, 3, 4, 5, 6], B=[2, 3, 4, 5, 6, 40]), options={"orient": "horizontal", "showPoints": True})
    with executed(emit_script(rec).source, caught) as (fig, ax, ns):
        bp = ns["bp"]
        xs = bp["boxes"][0].get_path().vertices[:, 0]
        q1, q3 = np.percentile([1, 2, 3, 4, 5, 6], [25, 75])
        assert (xs.min(), xs.max()) == (pytest.approx(q1), pytest.approx(q3))
        assert ax.get_ylim()[0] > ax.get_ylim()[1]                         # inverted: first group on top
        assert [t.get_text() for t in ax.get_yticklabels()] == ["A", "B"]
        assert ax.get_xlabel() == "v" and ax.get_ylabel() == "g"
        assert overlay_points(ax) == 6 + 5
        assert np.all(np.abs(ax.collections[0].get_offsets()[:, 1] - 1) <= 0.2 + 1e-9)
    assert not [w for w in caught if "vert" in str(w.message) or "orientation" in str(w.message)]


def test_scale_and_limits_belong_to_the_value_axis():
    vertical = emit_script(make(grouped(A=[1, 2, 3], B=[4, 5, 6]), options={"yScale": "log", "yLim": [0.5, 10], "xLim": [0, 4]}))
    assert "category_axis_option_ignored" in warning_codes(vertical) and "ax.set_yscale('log')" in vertical.source
    horizontal = emit_script(make(grouped(A=[1, 2, 3], B=[4, 5, 6]), options={"orient": "horizontal", "xScale": "log", "yLim": [0, 4]}))
    assert "ax.set_xscale('log')" in horizontal.source and "category_axis_option_ignored" in warning_codes(horizontal)


@pytest.mark.parametrize("orient, option", [("vertical", "yScale"), ("horizontal", "xScale")])
def test_log_axis_refuses_values_of_zero_or_below(orient, option):
    rec = make(grouped(A=[1, 2, 3], B=[0, 5, 6]), options={"orient": orient, option: "log"})
    with pytest.raises(CodegenError) as error:
        emit_script(rec)
    assert codes(error) == ["log_nonpositive"]


# ----------------------------------------------------------------- legend note
@pytest.mark.parametrize("layout", ["tight", "constrained"])
def test_legend_note_states_the_rules_and_stays_clear_of_the_axes(layout):
    rec = make(grouped(A=SPIKY, B=[2, 3, 4, 5, 6, 7, 8]), options={"legendNote": True, "showMean": True, "showPoints": True},
               appearance={"layout": layout})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        text = fig.texts[0].get_text().replace("\n", " ")
        assert "Q1–Q3" in text and "median" in text and "1.5 × IQR" in text
        assert "Open circles" in text and "Diamond: mean" in text and "Dots: individual observations within the whiskers" in text
        fig.canvas.draw()
        renderer = fig.canvas.get_renderer()
        assert fig.texts[0].get_window_extent(renderer).y1 <= ax.get_tightbbox(renderer).y0 + 1.0
        assert fig.texts[0].get_window_extent(renderer).x1 <= fig.bbox.x1


@pytest.mark.parametrize("rule, phrase", [("minmax", "minimum and maximum"), ("percentile", "5th and 95th percentiles"),
                                          ("iqr", "within 1.5 × IQR")])
def test_legend_note_names_the_chosen_whisker_rule(rule, phrase):
    rec = make(grouped(A=SPIKY), options={"legendNote": True, "whisker": rule, "quartileMethod": "midpoint"})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        text = fig.texts[0].get_text().replace("\n", " ")
        assert phrase in text and "midpoint quartiles" in text


def test_legend_note_reports_hidden_outliers_and_notches():
    values = [4.1, 4.8, 5.0, 5.2, 5.5, 5.6, 5.9, 6.1, 6.4, 6.8, 7.0, 40]
    rec = make([[v] for v in values], columns=("v",), group=None, options={"legendNote": True, "showOutliers": False, "notch": True})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        text = fig.texts[0].get_text().replace("\n", " ")
        assert "1 value beyond the whiskers not shown" in text and "Notches" in text


def test_no_legend_note_by_default():
    with executed(emit_script(make(grouped(A=[1, 2, 3]))).source) as (fig, ax, ns):
        assert fig.texts == []


# ------------------------------------------------------------- larger data, run
def test_large_data_goes_to_a_data_file_and_gives_the_same_statistics():
    rng = np.random.default_rng(3)
    rows = [[g, round(float(v), 4)] for g in "ABC" for v in rng.normal(10 + "ABC".index(g), 2, 900)]
    script = emit_script(make(rows))
    assert "data.csv" in script.files and "pd.read_csv" in script.source
    old = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp:
        for name, content in script.files.items():
            with open(os.path.join(tmp, name), "wb") as handle:
                handle.write(content)
        os.chdir(tmp)
        try:
            with executed(script.source) as (fig, ax, ns):
                for k, g in enumerate("ABC"):
                    values = np.array([r[1] for r in rows if r[0] == g])
                    assert ns["stats"][k]["med"] == pytest.approx(np.median(values)) and ns["stats"][k]["n"] == 900
        finally:
            os.chdir(old)


def test_script_runs_in_the_real_runner():
    rec = make(grouped(A=SPIKY, B=[2, 3, 4, 5, 6, 7, 8]), options={"showPoints": True, "showMean": True, "legendNote": True})
    result = run_python(emit_script(rec).source, dpi=100)
    assert result.ok, result.message
    assert (result.width_px, result.height_px) == (600, 400)


def test_defaults_show_outliers_and_nothing_else_extra():
    options = default_record("structured", "box").model_dump()["config"]["options"]
    assert options["showOutliers"] is True and options["showMean"] is False and options["notch"] is False
    assert options["whisker"] == "iqr" and options["quartileMethod"] == "linear" and options["legendNote"] is False
