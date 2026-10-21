"""Box / Heatmap option panels (js/figures/plotpanels.js): the option values the panels write are accepted by the models and the
generators, and the panel's outlier count agrees with the backend (contract s4g, s4h, s4l)."""
import numpy as np
import pytest

from backend.figures.codegen import CodegenError, emit_script
from backend.figures.models import FigureRecord
from tests.test_figures_box import grouped, make as make_box, warning_codes as box_codes
from tests.test_figures_heatmap import make as make_heat

U = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100]     # same data as test 22 in tests/test_js_checks.js: one value beyond the whiskers
V = [1, 2, 3, 4, 5]


def panel_count(values, method, rule):
    """Python twin of beyondWhiskers() in plotpanels.js."""
    if rule == "minmax":
        return 0
    s = np.sort(np.asarray(values, dtype=float))
    if rule == "percentile":
        lo, hi = np.percentile(s, [5, 95], method=method)
    else:
        q1, q3 = np.percentile(s, [25, 75], method=method)
        lo, hi = q1 - 1.5 * (q3 - q1), q3 + 1.5 * (q3 - q1)
    return int(((s < lo) | (s > hi)).sum())


@pytest.mark.parametrize("method", ["linear", "midpoint"])
@pytest.mark.parametrize("rule", ["iqr", "percentile"])
def test_panel_hidden_count_matches_the_backend(method, rule):
    rec = make_box(grouped(u=U, v=V), options={"showOutliers": False, "quartileMethod": method, "whisker": rule})
    script = emit_script(rec)
    hidden = [w for w in script.warnings if w["code"] == "outliers_hidden"]
    expected = panel_count(U, method, rule) + panel_count(V, method, rule)
    if expected:
        assert hidden and hidden[0]["message"].startswith(f"{expected} value")
    else:
        assert not hidden


def test_minmax_has_nothing_beyond_the_whiskers():
    script = emit_script(make_box(grouped(u=U, v=V), options={"showOutliers": False, "whisker": "minmax"}))
    assert "outliers_hidden" not in box_codes(script)


def test_every_box_option_the_panel_writes_is_valid_and_drawn():
    options = {"orient": "horizontal", "showOutliers": False, "showPoints": True, "showMean": True, "whisker": "percentile", "quartileMethod": "midpoint",
               "medianColor": "#AA0000", "medianWidth": 3, "boxColor": "#00FF00"}
    emit_script(FigureRecord.model_validate(make_box(grouped(u=U, v=V), options=options)))
    per_group = make_box(grouped(u=U, v=V), options={"boxColor": None}, appearance={"colors": ["#112233", "#00FF00"], "palette": "muted"})
    assert "112233" in emit_script(per_group).source.lower()


def test_notch_is_refused_below_ten_values_which_is_why_the_panel_disables_it():
    with pytest.raises(CodegenError) as e:
        emit_script(make_box(grouped(u=U, v=V), options={"notch": True}))
    assert any(i["code"] == "notch_n_too_small" for i in e.value.issues)
    emit_script(make_box(grouped(u=U, v=V + [6, 7, 8, 9, 10]), options={"notch": True}))   # 10 values: allowed


def test_panel_written_heatmap_options_are_valid_in_both_modes():
    opts = {"heatmapMode": "correlation", "corrMethod": "spearman", "corrTriangle": "lower", "annotate": True, "annotatePrecision": 3, "annotateSize": 7,
            "vmin": -1, "vmax": 0.5, "colorbarLabel": "rho", "cellBorders": True, "cellBorderColor": "#000000", "cellBorderWidth": 1}
    script = emit_script(make_heat(options=opts, appearance={"cmap": None, "xTickRotation": 45, "yTickRotation": -30}))
    assert "centered_at_zero" in [w["code"] for w in script.warnings]    # asymmetric limits with the automatic diverging palette: zero stays in the middle
    matrix = emit_script(make_heat(labels=list("abcdefghij") * 4, x="id", y=("Alpha", "Beta"), options={"vmin": 0, "vmax": 5, "colorbar": False}, appearance={"cmap": "magma"}))
    assert matrix.source


def test_one_selected_column_is_refused_which_is_why_the_panel_keeps_two():
    with pytest.raises(CodegenError) as e:
        emit_script(make_heat(y=("Alpha",)))
    assert any(i["code"] == "too_few_numeric_columns" for i in e.value.issues)


def test_inverted_limits_are_refused_which_is_why_the_panel_does_not_write_them():
    with pytest.raises(CodegenError) as e:
        emit_script(make_heat(options={"vmin": 5, "vmax": 1}))
    assert any(i["code"] == "vlimits_invalid" for i in e.value.issues)
