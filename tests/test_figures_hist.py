"""Histogram script generation (docs/FIGURES_CONTRACT.md s4f): the script is run and the drawn bars are measured."""
import contextlib
import io
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pytest
from matplotlib.colors import to_rgb
from PIL import Image
from scipy import stats

from backend.figures.codegen import CodegenError, emit_script, hist
from backend.figures.models import default_record
from backend.figures.runner import run_python

RNG_VALUES = [float(v) for v in np.round(np.random.default_rng(7).normal(10.0, 2.0, 300), 4)]


def make(values, columns=("v",), types=None, y=("v",), group=None, **sections):
    """Valid histogram record (dict). ``values`` = list of numbers (one column) or rows; ``appearance=``/``options=`` merge in."""
    rec = default_record("structured", "hist").model_dump()
    rows = [[v] for v in values] if columns == ("v",) else values
    types = types or ["number"] * len(columns)
    rec["dataset"] = {"columns": [{"name": c, "type": t} for c, t in zip(columns, types)], "rows": rows,
                      "origin": {"type": "sheet", "label": ""}}
    rec["config"]["mapping"] = {"x": None, "y": list(y), "group": group, "yErr": None}
    for name, items in sections.items():
        rec["config"][name].update(items)
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


def drawn(rec):
    """Generate and run a record; return (heights, edges, values, y label, legend texts)."""
    script = emit_script(rec)
    with executed(script.source) as (fig, ax, ns):
        return np.array(ns["heights"], dtype=float), np.array(ns["edges"], dtype=float), np.array(ns["values"]), \
            ax.get_ylabel(), [t.get_text() for t in (ax.get_legend().get_texts() if ax.get_legend() else [])]


def codes(error):
    return [i["code"] for i in error.value.issues]


def warning_codes(script):
    return [w["code"] for w in script.warnings]


WITH_MISSING = RNG_VALUES[:100] + [None, None, None]
N_PRESENT = 100


# ------------------------------------------------------------ counts and bins
@pytest.mark.parametrize("options", [
    {"binMode": "count", "bins": 7},
    {"binMode": "width", "binWidth": 0.75},
    {"binMode": "method", "binMethod": "auto"},
    {"binMode": "method", "binMethod": "fd"},
    {"binMode": "method", "binMethod": "sturges"},
    {"binMode": "method", "binMethod": "scott"},
    {"binMode": "method", "binMethod": "sqrt"},
])
def test_counts_sum_to_n_in_every_bin_mode_and_missing_values_are_not_counted(options):
    heights, edges, values, _, _ = drawn(make(WITH_MISSING, options=options))
    assert values.size == N_PRESENT
    assert heights.sum() == N_PRESENT
    assert len(heights) == len(edges) - 1
    assert np.all(np.diff(edges) > 0)
    assert edges[0] <= values.min() and edges[-1] >= values.max()


def test_bin_count_mode_makes_equal_bins_from_minimum_to_maximum():
    heights, edges, values, _, _ = drawn(make([1.0, 2.0, 3.0, 4.0, 9.0], options={"bins": 4}))
    assert len(heights) == 4
    assert edges[0] == 1.0 and edges[-1] == 9.0
    assert np.allclose(np.diff(edges), 2.0)
    assert heights.tolist() == [2, 2, 0, 1]


def test_bin_width_mode_starts_at_the_minimum_and_the_last_bin_holds_the_maximum():
    heights, edges, _, _, _ = drawn(make([0.0, 0.3, 1.1, 2.0], options={"binMode": "width", "binWidth": 0.5}))
    assert np.allclose(edges, [0.0, 0.5, 1.0, 1.5, 2.0])
    assert heights.tolist() == [2, 0, 1, 1]


@pytest.mark.parametrize("width", [0.1, 0.2, 0.3, 0.7, 1 / 3])
def test_bin_width_rounding_never_drops_a_value(width):
    values = [float(v) for v in np.linspace(0.0, 1.0, 11)]
    heights, edges, _, _, _ = drawn(make(values, options={"binMode": "width", "binWidth": width}))
    assert heights.sum() == len(values)
    assert edges[-1] >= 1.0


@pytest.mark.parametrize("method", ["auto", "fd", "sturges", "scott", "sqrt"])
def test_method_bins_are_the_numpy_rule(method):
    _, edges, values, _, _ = drawn(make(RNG_VALUES, options={"binMode": "method", "binMethod": method}))
    assert np.allclose(edges, np.histogram_bin_edges(values, bins=method))


def test_bins_used_is_reported():
    script = emit_script(make(RNG_VALUES, options={"bins": 12}))
    note = next(w for w in script.warnings if w["code"] == "bins_used")
    assert note["level"] == "info" and note["message"].startswith("12 bins of width")


# ----------------------------------------------------------------- statistics
def test_density_integrates_to_one():
    heights, edges, _, _, _ = drawn(make(RNG_VALUES, options={"stat": "density", "bins": 25}))
    assert float(np.sum(heights * np.diff(edges))) == pytest.approx(1.0)


def test_legacy_density_flag_still_means_density_until_stat_is_set():
    legacy = drawn(make(RNG_VALUES, options={"density": True}))
    assert float(np.sum(legacy[0] * np.diff(legacy[1]))) == pytest.approx(1.0)
    explicit = drawn(make(RNG_VALUES, options={"density": True, "stat": "count"}))
    assert explicit[0].sum() == len(RNG_VALUES)


def test_frequency_is_the_fraction_of_values_and_adds_up_to_one():
    heights, _, values, _, _ = drawn(make(RNG_VALUES, options={"stat": "frequency"}))
    assert heights.sum() == pytest.approx(1.0)
    counts, _ = np.histogram(values, bins=len(heights))
    assert np.allclose(heights, counts / values.size)


@pytest.mark.parametrize("stat, total", [("count", len(RNG_VALUES)), ("frequency", 1.0), ("density", None)])
def test_cumulative_bars_never_fall_and_end_at_the_total(stat, total):
    heights, edges, _, _, _ = drawn(make(RNG_VALUES, options={"stat": stat, "cumulative": True, "bins": 15}))
    assert np.all(np.diff(heights) >= 0)
    if total is not None:
        assert heights[-1] == pytest.approx(total)
    else:                                     # cumulative density is the distribution function: it ends at 1
        assert heights[-1] == pytest.approx(1.0)


def test_y_axis_label_follows_the_statistic_until_the_user_sets_one():
    for stat, cumulative, text in [("count", False, "Count"), ("frequency", False, "Frequency (fraction)"),
                                   ("density", False, "Density"), ("count", True, "Cumulative count"),
                                   ("frequency", True, "Cumulative frequency (fraction)"),
                                   ("density", True, "Cumulative density")]:
        label = drawn(make(RNG_VALUES, options={"stat": stat, "cumulative": cumulative}))[3]
        assert label == text
    assert drawn(make(RNG_VALUES, options={"stat": "density"}, appearance={"yLabel": "Mice per bin"}))[3] == "Mice per bin"
    assert drawn(make(RNG_VALUES, appearance={"showYLabel": False}))[3] == ""
    assert drawn(make(RNG_VALUES))[3] == "Count"          # default; the x label is the column name


def test_x_axis_label_is_the_column_name():
    with executed(emit_script(make(RNG_VALUES)).source) as (_, ax, _):
        assert ax.get_xlabel() == "v"


# ---------------------------------------------------------------- normal fit
def test_normal_fit_is_labelled_and_drawn_in_the_unit_of_the_bars():
    values = np.array(RNG_VALUES)
    for stat in ("count", "frequency", "density"):
        script = emit_script(make(RNG_VALUES, options={"normalFit": True, "stat": stat, "bins": 20}))
        assert "from scipy import stats" in script.source and "# The normal fit also needs scipy" in script.source
        with executed(script.source) as (_, ax, ns):
            assert ns["mu"] == pytest.approx(values.mean()) and ns["sigma"] == pytest.approx(values.std())
            line = ax.lines[0]
            assert line.get_label().splitlines()[0] == "Normal fit (μ, σ)"
            assert f"μ = {ns['mu']:.4g}" in line.get_label()
            x, y = line.get_xydata().T
            width = ns["edges"][1] - ns["edges"][0]
            scale = {"count": values.size * width, "frequency": width, "density": 1.0}[stat]
            assert np.allclose(y, stats.norm.pdf(x, ns["mu"], ns["sigma"]) * scale)
            assert [t.get_text().splitlines()[0] for t in ax.get_legend().get_texts()] == ["v", "Normal fit (μ, σ)"]


def test_density_curve_and_density_bars_have_the_same_area_scale():
    script = emit_script(make(RNG_VALUES, options={"normalFit": True, "stat": "density", "bins": 30}))
    with executed(script.source) as (_, ax, ns):
        x, y = ax.lines[0].get_xydata().T
        assert float(np.sum(ns["heights"] * np.diff(ns["edges"]))) == pytest.approx(1.0)
        area = float(np.sum((y[1:] + y[:-1]) / 2 * np.diff(x)))
        assert area == pytest.approx(1.0, abs=0.02)                  # the curve covers the data range


def test_cumulative_normal_fit_is_the_normal_distribution_function():
    script = emit_script(make(RNG_VALUES, options={"normalFit": True, "cumulative": True, "stat": "count"}))
    assert "normal_fit_method" in warning_codes(script)
    with executed(script.source) as (_, ax, ns):
        x, y = ax.lines[0].get_xydata().T
        assert np.all(np.diff(y) >= 0)
        assert np.allclose(y, stats.norm.cdf(x, ns["mu"], ns["sigma"]) * ns["n"])


def test_normal_fit_is_skipped_for_identical_values_and_says_so():
    script = emit_script(make([5.0] * 6, options={"normalFit": True}))
    assert "normal_fit_skipped" in warning_codes(script)
    with executed(script.source) as (_, ax, _):
        assert len(ax.lines) == 0


def test_no_normal_fit_unless_chosen_and_no_scipy_import_then():
    script = emit_script(make(RNG_VALUES))
    assert "scipy" not in script.source
    with executed(script.source) as (_, ax, _):
        assert len(ax.lines) == 0 and ax.get_legend() is None


# ------------------------------------------------------------------ appearance
def test_bar_colour_edge_and_alpha_are_applied_to_every_bar():
    rec = make(RNG_VALUES, options={"barColor": "#009E73", "barEdgeColor": "#112233", "barEdgeWidth": 1.5},
               appearance={"alpha": 0.5})
    with executed(emit_script(rec).source) as (_, ax, _):
        for patch in ax.patches:
            assert patch.get_facecolor()[:3] == pytest.approx(to_rgb("#009E73"))
            assert patch.get_edgecolor()[:3] == pytest.approx(to_rgb("#112233"))
            assert patch.get_alpha() == 0.5 and patch.get_linewidth() == 1.5


def test_default_bar_colour_is_the_first_palette_colour_and_edge_width_zero_removes_the_outline():
    with executed(emit_script(make(RNG_VALUES, options={"barEdgeWidth": 0})).source) as (_, ax, _):
        assert ax.patches[0].get_facecolor()[:3] == pytest.approx(to_rgb("#0072B2"))
        assert all(p.get_linewidth() == 0 for p in ax.patches)
    with executed(emit_script(make(RNG_VALUES, appearance={"colors": ["#CC79A7"]})).source) as (_, ax, _):
        assert ax.patches[0].get_facecolor()[:3] == pytest.approx(to_rgb("#CC79A7"))


def test_legend_needs_a_second_entry_unless_forced_and_can_be_switched_off():
    assert drawn(make(RNG_VALUES))[4] == []
    assert drawn(make(RNG_VALUES, appearance={"legend": {"show": True, "pos": "best", "force": True}}))[4] == ["v"]
    assert drawn(make(RNG_VALUES, options={"normalFit": True}, appearance={"legend": {"show": False, "pos": "best",
                                                                                      "force": False}}))[4] == []


def test_log_axes_and_limits_are_applied():
    with executed(emit_script(make(RNG_VALUES, options={"yScale": "log", "xLim": [0.0, 20.0]})).source) as (_, ax, _):
        assert ax.get_yscale() == "log" and ax.get_xlim() == (0.0, 20.0)


# ----------------------------------------------------------------- validation
def test_no_numeric_values_is_an_error():
    with pytest.raises(CodegenError) as error:
        emit_script(make([None, None, None]))
    assert "column_empty" in codes(error)
    with pytest.raises(CodegenError) as error:
        emit_script(make([]))
    assert "no_rows" in codes(error)
    with pytest.raises(CodegenError) as error:                         # the generator refuses on its own as well
        hist.generate(make([None, None]))
    assert codes(error) == ["no_numeric_values"] and "no numeric values" in str(error.value)


def test_text_column_and_missing_column_choice_are_errors():
    rec = make([["a"], ["b"]], columns=("name",), types=["text"], y=("name",))
    with pytest.raises(CodegenError) as error:
        emit_script(rec)
    assert "column_not_numeric" in codes(error)
    with pytest.raises(CodegenError) as error:
        emit_script(make(RNG_VALUES, y=()))
    assert "mapping_missing" in codes(error)


def test_constant_data_gives_an_explicit_message_and_a_safe_bin_range():
    script = emit_script(make([4.2] * 10, options={"bins": 8}))
    note = next(w for w in script.warnings if w["code"] == "constant_data")
    assert "All 10 values in 'v' are equal (4.2)" in note["message"] and "one bar" in note["message"]
    with executed(script.source) as (_, ax, ns):
        edges = np.array(ns["edges"])
        assert len(edges) == 9 and edges[0] < 4.2 < edges[-1] and np.all(np.diff(edges) > 0)
        assert np.array(ns["heights"]).sum() == 10 and np.count_nonzero(ns["heights"]) == 1
    with executed(emit_script(make([0.0] * 3)).source) as (_, ax, ns):         # zero: absolute range of +-0.5
        assert ns["edges"][0] == -0.5 and ns["edges"][-1] == 0.5
    width = emit_script(make([3.0, 3.0], options={"binMode": "width", "binWidth": 2.0}))
    with executed(width.source) as (_, ax, ns):                                # one bin of exactly the chosen width
        assert np.allclose(ns["edges"], [2.0, 4.0]) and ns["heights"].tolist() == [2]
    with executed(emit_script(make([7.0], options={"binMode": "method"})).source) as (_, ax, ns):
        assert len(ns["edges"]) == 2 and ns["heights"].tolist() == [1]          # a single value is constant data too


def test_more_than_1000_bins_are_refused_in_every_bin_mode():
    with pytest.raises(CodegenError) as error:
        emit_script(make(RNG_VALUES, options={"bins": 1001}))
    assert codes(error) == ["too_many_bins"] and "at most 1,000" in str(error.value)
    emit_script(make(RNG_VALUES, options={"bins": 1000}))                      # the limit itself is fine
    with pytest.raises(CodegenError) as error:
        emit_script(make([0.0, 10.0] * 5, options={"binMode": "width", "binWidth": 0.001}))
    assert codes(error) == ["too_many_bins"] and "wider bin width" in str(error.value)
    outliers = [float(v) for v in np.random.default_rng(3).normal(0, 0.001, 2990)] + [1e6] * 10
    with pytest.raises(CodegenError) as error:
        emit_script(make(outliers, options={"binMode": "method", "binMethod": "fd"}))
    assert codes(error) == ["too_many_bins"]
    with pytest.raises(CodegenError) as error:                                 # constant data obeys the same limit
        emit_script(make([1.0] * 4, options={"bins": 5000}))
    assert codes(error) == ["too_many_bins"]


def test_width_mode_needs_a_width_and_values_too_close_for_the_bins_are_refused():
    with pytest.raises(CodegenError) as error:
        emit_script(make(RNG_VALUES, options={"binMode": "width"}))
    assert codes(error) == ["bin_width_missing"]
    with pytest.raises(CodegenError) as error:
        emit_script(make([1.0, 1.0 + 2 ** -52], options={"bins": 200}))
    assert codes(error) == ["bins_too_fine"]


def test_log_x_axis_refuses_values_of_zero_or_below():
    with pytest.raises(CodegenError) as error:
        emit_script(make([0.0, 1.0, 2.0], options={"xScale": "log"}))
    assert codes(error) == ["log_nonpositive"]
    assert "log_axis_equal_bins" in warning_codes(emit_script(make([1.0, 2.0, 5.0], options={"xScale": "log"})))


def test_extra_columns_and_group_are_ignored_with_a_note_not_silently():
    rows = [[1.0, 2.0, "a"], [2.0, 3.0, "b"], [3.0, 5.0, "a"], [4.0, 1.0, "b"]]
    rec = make(rows, columns=("v", "w", "g"), types=["number", "number", "text"], y=("v", "w"), group="g")
    script = emit_script(rec)
    assert {"y_columns_ignored", "group_ignored"} <= set(warning_codes(script))
    with executed(script.source) as (_, ax, ns):
        assert ns["values"].tolist() == [1.0, 2.0, 3.0, 4.0]


# ------------------------------------------------------------------- data file
def test_large_data_goes_to_the_data_file_and_every_value_is_counted(tmp_path, monkeypatch):
    values = [float(v) for v in np.random.default_rng(5).normal(0, 1, 2500)]
    script = emit_script(make(values, options={"normalFit": True}))
    assert list(script.files) == ["data.csv"] and "pandas" in script.source
    monkeypatch.chdir(tmp_path)
    (tmp_path / "data.csv").write_bytes(script.files["data.csv"])
    with executed(script.source) as (_, ax, ns):
        assert ns["n"] == 2500 and ns["heights"].sum() == 2500


# ------------------------------------------------------- runner (real process)
def test_script_runs_in_the_runner_and_draws_something():
    script = emit_script(make(RNG_VALUES, options={"normalFit": True, "stat": "density"}))
    result = run_python(script.source, files=script.files, dpi=100)
    assert result.ok, result.message
    image = Image.open(io.BytesIO(result.png_bytes))
    assert image.size == (500, 300)
    assert len(image.convert("RGB").getcolors(maxcolors=1_000_000)) > 5       # not blank


# --------------------------------------------------------------- model fields
def test_histogram_options_are_validated_by_the_model():
    from pydantic import ValidationError
    from backend.figures.models import Options

    defaults = Options()
    assert (defaults.binMode, defaults.binMethod, defaults.stat, defaults.cumulative, defaults.normalFit) == \
        ("count", "auto", None, False, False)
    Options(bins=100000, binMode="width", binWidth=0.25, stat="frequency", barColor="#112233", barEdgeWidth=5)
    for bad in ({"bins": 0}, {"bins": 100001}, {"binWidth": 0}, {"binWidth": -1.0}, {"binWidth": float("inf")},
                {"binMethod": "rice"}, {"binMode": "auto"}, {"stat": "percent"}, {"barEdgeWidth": -1},
                {"barColor": "red"}):
        with pytest.raises(ValidationError):
            Options(**bad)
