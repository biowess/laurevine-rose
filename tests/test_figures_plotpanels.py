"""Scatter fit legend parts (options.fitEquation / fitR2, set by the Scatter options panel; contract 3c / 4d)."""
import pytest
from pydantic import ValidationError

from backend.figures.codegen import emit_script
from backend.figures.models import FigureRecord
from tests.test_figures_codegen import executed_ns, fit_label, make_scatter, run, xy_rows


def label_for(**options):
    rec = make_scatter(xy_rows(), options=dict({"fit": "linear"}, **options))
    script = emit_script(rec)
    run(script, rec)
    with executed_ns(script.source) as (fig, ax, ns):
        return fit_label(ax), script.source, ns["fit_results"][0]


def test_default_keeps_equation_and_r2_in_the_legend():
    label, source, result = label_for()
    first, second = label.split("\n")
    assert first == "Fit (linear)" and second.startswith("y = ") and "R² = " in second
    assert "fitEquation" not in source and result["r2"] > 0.5


@pytest.mark.parametrize("eq, r2, has_eq, has_r2", [(True, False, True, False), (False, True, False, True)])
def test_one_part_only(eq, r2, has_eq, has_r2):
    label, _, result = label_for(fitEquation=eq, fitR2=r2)
    first, second = label.split("\n")
    assert first == "Fit (linear)" and second.startswith("y = ") == has_eq and ("R² = " in second) == has_r2
    assert "R²" not in label.split("\n")[1] if not has_r2 else f"{result['r2']:.3f}" in second


def test_neither_part_leaves_only_the_fit_name_and_still_computes_r2():
    label, source, result = label_for(fitEquation=False, fitR2=False)
    assert label == "Fit (linear)" and "equation =" not in source and 0 < result["r2"] <= 1


def test_fit_parts_must_be_booleans():
    rec = make_scatter(xy_rows(), options={"fit": "linear", "fitEquation": "maybe"})
    with pytest.raises(ValidationError):
        FigureRecord.model_validate(rec)


# ---- records exactly as the Bar options / Histogram options sections write them (js/figures/plotpanels.js) ----
def _rec(plot_type, columns, rows, mapping, options, appearance=None):
    from backend.figures.models import default_record
    rec = default_record("structured", plot_type).model_dump()
    rec["dataset"] = {"columns": columns, "rows": rows, "origin": {"type": "sheet", "label": "t"}}
    rec["config"]["mapping"] = dict({"x": None, "y": [], "group": None, "yErr": None}, **mapping)
    rec["config"]["options"].update(options)
    rec["config"]["appearance"].update(appearance or {})
    return rec


def test_bar_options_as_written_by_the_panel_generate_a_script():
    cols = [{"name": "g", "type": "text"}, {"name": "a", "type": "number"}, {"name": "b", "type": "number"}, {"name": "e", "type": "number"}]
    rows = [["u", 1, 2, 0.1], ["v", 2, 3, 0.2], ["w", 3, 4, 0.1]]
    opts = {"orient": "horizontal", "barMode": "stacked", "barWidth": 0.6, "valueLabels": True, "valueFormat": "{:,.0f} kg",
            "errorBars": True, "axisNote": True, "yLim": [1, 5], "xLim": [1, 9], "series": {"b": {"color": "#00AA00"}}}
    rec = _rec("bar", cols, rows, {"x": "g", "y": ["a", "b"], "yErr": "e"}, opts, {"yTickRotation": 45})
    gs = emit_script(rec)
    assert "{:,.0f} kg" in gs.source and "#00AA00" in gs.source and "0.6" in gs.source
    assert any(w["code"] == "axis_truncated" for w in gs.warnings)   # xLim = [1, 9] is the value axis of a horizontal chart


def test_histogram_options_as_written_by_the_panel_generate_a_script():
    cols = [{"name": "a", "type": "number"}]
    rows = [[float(i % 7)] for i in range(40)]
    for mode, extra in (("count", {"bins": 8}), ("width", {"binWidth": 0.5}), ("method", {"binMethod": "fd"})):
        opts = dict({"binMode": mode, "stat": "frequency", "cumulative": True, "normalFit": True, "barColor": "#123456",
                     "barEdgeColor": "#222222", "barEdgeWidth": 0}, **extra)
        gs = emit_script(_rec("hist", cols, rows, {"y": ["a"]}, opts, {"alpha": 0.6}))
        assert "#123456" in gs.source and "norm" in gs.source
