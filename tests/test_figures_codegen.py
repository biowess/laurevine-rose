"""Line plot script generation (docs/FIGURES_CONTRACT.md s4c): script -> runner -> image, plus the plot's structure."""
import contextlib
import io
import re
import warnings
from typing import get_args

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from matplotlib.collections import PathCollection
from PIL import Image
from scipy import stats

from backend.figures.codegen import CodegenError, emit_script
from backend.figures.codegen.common import DATA_FILE, INLINE_LIMIT, LINE_STYLES, MARKERS, PALETTES
from backend.figures.models import FigureRecord, LineStyleName, MarkerName, ScatterMarkerName, default_record
from backend.figures.runner import run_python

BLUE = "#0072B2"
DEFAULT_ROWS = [[1, 1.0, 4.0], [2, 2.0, 3.0], [3, 3.0, 5.0], [4, 4.0, 2.0]]


def make(rows=None, columns=("x", "a", "b"), y=("a",), x="x", series=None, **sections):
    """Valid line-plot record (dict). ``appearance=``, ``options=``, ``mapping=`` update that part of the config."""
    rec = default_record("structured", "line").model_dump()
    rec["dataset"] = {"columns": [{"name": c, "type": "number"} for c in columns],
                      "rows": DEFAULT_ROWS if rows is None else rows, "origin": {"type": "sheet", "label": ""}}
    config = rec["config"]
    config["mapping"] = {"x": x, "y": list(y), "group": None, "yErr": None}
    for name, values in sections.items():
        config[name].update(values)
    config["options"]["series"] = series or {}
    rec["export"].update(wIn=5.0, hIn=3.0, dpi=100)
    return rec


def run(script, rec):
    res = run_python(script.source, dpi=rec["export"]["dpi"], files=script.files)
    assert res.ok, f"{res.message}\n{res.stderr}\n{script.source}"
    return res


@contextlib.contextmanager
def executed_ns(source):
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


@contextlib.contextmanager
def executed(source):
    """Run a generated script in this process (Agg backend) and yield (figure, axes); rcParams stay as the script set them."""
    with executed_ns(source) as (fig, ax, _):
        yield fig, ax


def codes(error):
    return [i["code"] for i in error.value.issues]


# ------------------------------------------------------------ script -> image
def test_script_runs_and_gives_a_non_blank_png_of_the_export_size():
    rec = make(y=("a", "b"))
    img = Image.open(io.BytesIO(run(emit_script(rec), rec).png_bytes))
    assert img.size == (500, 300)                                   # 5 x 3 in at 100 dpi
    rgb = np.asarray(img.convert("RGB")).astype(int)
    assert (np.abs(rgb - np.array([255, 255, 255])).sum(axis=-1) > 30).sum() > 300     # real ink, not a blank page
    assert (np.abs(rgb - np.array([0x00, 0x72, 0xB2])).sum(axis=-1) < 40).any()        # first palette colour is drawn


def test_emit_script_accepts_a_validated_record():
    rec = make()
    assert emit_script(FigureRecord.model_validate(rec)).source == emit_script(rec).source


# ------------------------------------------------------------ missing values
@pytest.mark.parametrize("step, gap_x", [("none", 3.0), ("post", 3.5), ("pre", 2.5), ("mid", 3.0)])
def test_missing_values_leave_a_gap_and_are_never_bridged(step, gap_x):
    rows = [[1, 5.0], [2, 5.0], [3, None], [4, 5.0], [5, 5.0]]
    rec = make(rows=rows, columns=("x", "a"), series={"a": {"step": step}})
    script = emit_script(rec)
    code = "\n".join(line for line in script.source.splitlines() if not line.lstrip().startswith("#"))
    assert "np.nan" in code and "interp" not in code and "dropna" not in code
    with executed(script.source) as (fig, ax):
        ydata = ax.lines[0].get_ydata()
        assert len(ydata) == 5 and np.isnan(ydata[2]) and not np.isnan(ydata[[0, 1, 3, 4]]).any()
        fig.canvas.draw()
        pixels = np.asarray(fig.canvas.buffer_rgba())[..., :3].astype(int)

        def inked(x):
            col, row = ax.transData.transform((x, 5.0))
            r, c = pixels.shape[0] - int(round(row)), int(round(col))
            window = pixels[r - 2:r + 3, c - 1:c + 2]
            return bool((np.abs(window - np.array([0x00, 0x72, 0xB2])).sum(axis=-1) < 60).any())

        assert inked(1.5) and inked(4.5)           # the line is there on both sides ...
        assert not inked(gap_x)                    # ... and open where the value is missing


def test_missing_values_are_reported_as_a_warning():
    script = emit_script(make(rows=[[1, 1.0], [2, None], [3, 3.0]], columns=("x", "a")))
    assert [w["code"] for w in script.warnings] == ["missing_values"]


# ------------------------------------------------------------------ data
def test_data_is_inline_up_to_the_limit_and_a_csv_file_above_it():
    at_limit = make(rows=[[i, float(i)] for i in range(INLINE_LIMIT)], columns=("x", "a"))
    script = emit_script(at_limit)
    assert script.files == {} and "pandas" not in script.source and "read_csv" not in script.source

    rows = [[i, None if i == 7 else i * 0.5, 9.0] for i in range(INLINE_LIMIT + 1)]
    rec = make(rows=rows, columns=("x", "a", "unused"))
    script = emit_script(rec)
    assert list(script.files) == [DATA_FILE] and f"pd.read_csv('{DATA_FILE}'" in script.source
    assert "9.0, 9.0" not in script.source and "unused" not in script.source          # only used columns are kept
    table = pd.read_csv(io.BytesIO(script.files[DATA_FILE]), keep_default_na=False, na_values=[""])
    assert list(table.columns) == ["x", "a"] and len(table) == INLINE_LIMIT + 1
    assert np.isnan(table["a"][7]) and table["a"][8] == 4.0                          # missing value stays missing
    png = Image.open(io.BytesIO(run(script, rec).png_bytes))
    assert png.size == (500, 300)


def test_text_in_titles_and_column_names_cannot_break_the_script():
    tricky = 'He said "hi" \\ it\'s\nnew line # µ'
    rec = make(columns=("x", 'a"b', "a b"), y=('a"b', "a b"), appearance={"title": tricky, "xLabel": tricky})
    script = emit_script(rec)
    run(script, rec)
    with executed(script.source) as (fig, ax):
        assert ax.get_title() == tricky and ax.get_xlabel() == tricky
        assert [line.get_label() for line in ax.lines] == ['a"b', "a b"]            # same slug, still two variables


def test_no_x_column_plots_against_row_numbers():
    rec = make(x=None)
    with executed(emit_script(rec).source) as (fig, ax):
        assert list(ax.lines[0].get_xdata()) == [1, 2, 3, 4] and ax.get_xlabel() == "Row"


# ---------------------------------------------------------------- series
def test_series_style_options_reach_the_plot():
    series = {
        "a": {"color": "#112233", "width": 3.0, "style": "dashed", "marker": "diamond", "markerSize": 9.0,
              "markerColor": "#445566"},
        "b": {"line": False, "marker": "circle", "step": "post"},
    }
    with executed(emit_script(make(y=("a", "b"), series=series)).source) as (fig, ax):
        a, b = ax.lines
        assert (a.get_color(), a.get_linewidth(), a.get_linestyle(), a.get_marker(), a.get_markersize()) == \
               ("#112233", 3.0, "--", "D", 9.0)
        assert a.get_markerfacecolor() == "#445566" and a.get_markeredgecolor() == "#445566"
        assert b.get_linestyle() == "None" and b.get_marker() == "o" and b.get_drawstyle() == "steps-post"
        assert b.get_color().upper() == PALETTES["default"][1]            # colour follows the series position
        assert a.get_drawstyle() == "default"                              # no smoothing, no steps unless asked


def test_hidden_series_are_not_drawn_and_do_not_shift_colours():
    rec = make(y=("a", "b"), series={"a": {"visible": False}})
    script = emit_script(rec)
    assert "y_a" not in script.source
    with executed(script.source) as (fig, ax):
        assert [line.get_label() for line in ax.lines] == ["b"]
        assert ax.lines[0].get_color().upper() == PALETTES["default"][1]
    with pytest.raises(CodegenError) as info:
        emit_script(make(y=("a",), series={"a": {"visible": False}}))
    assert codes(info) == ["no_visible_series"]


def test_symmetric_and_asymmetric_error_bars_with_caps():
    rows = [[1, 10.0, 20.0, 1.0, 2.0, 3.0], [2, 11.0, 21.0, 1.5, 0.5, 1.0]]
    series = {"a": {"error": "symmetric", "errorCol": "e", "capSize": 5.0},
              "b": {"error": "asymmetric", "errorLowCol": "lo", "errorHighCol": "hi", "capSize": 0.0}}
    rec = make(rows=rows, columns=("x", "a", "b", "e", "lo", "hi"), y=("a", "b"), series=series)
    with executed(emit_script(rec).source) as (fig, ax):
        sym, asym = ax.containers
        assert np.allclose(sym.lines[2][0].get_segments()[0], [[1, 9.0], [1, 11.0]])      # 10 -/+ 1
        assert len(sym.lines[1]) == 2                                                     # caps on both ends
        assert np.allclose(asym.lines[2][0].get_segments()[0], [[1, 18.0], [1, 23.0]])    # 20 - 2 .. 20 + 3
        assert len(asym.lines[1]) == 0                                                    # capSize 0 = no caps


def test_shared_error_column_applies_only_while_error_bars_are_on():
    rows = [[1, 1.0, 0.1], [2, 2.0, 0.2]]
    kwargs = dict(rows=rows, columns=("x", "a", "e"))
    off = make(**kwargs, mapping={"yErr": "e"})
    on = make(**kwargs, mapping={"yErr": "e"}, options={"errorBars": True})
    with executed(emit_script(off).source) as (fig, ax):
        assert ax.containers == []
    with executed(emit_script(on).source) as (fig, ax):
        assert len(ax.containers) == 1


def test_legend_only_for_several_visible_series_unless_forced():
    def legend(rec):
        with executed(emit_script(rec).source) as (fig, ax):
            return ax.get_legend()

    assert legend(make(y=("a",))) is None
    assert [t.get_text() for t in legend(make(y=("a", "b"))).get_texts()] == ["a", "b"]
    assert legend(make(y=("a", "b"), series={"b": {"visible": False}})) is None
    assert legend(make(y=("a",), appearance={"legend": {"show": True, "pos": "best", "force": True}})) is not None
    assert legend(make(y=("a", "b"), appearance={"legend": {"show": False, "pos": "best", "force": True}})) is None


def test_legend_outside_sits_right_of_the_axes_inside_the_figure():
    rec = make(y=("a", "b"), appearance={"legend": {"show": True, "pos": "outside", "force": False}})
    with executed(emit_script(rec).source) as (fig, ax):
        fig.canvas.draw()
        box, axes_box = ax.get_legend().get_window_extent(), ax.get_window_extent()
        assert box.x0 >= axes_box.x1 and box.x1 <= fig.bbox.x1


def test_palette_is_okabe_ito_based_and_repeats_with_a_note():
    assert PALETTES["default"][:3] == ["#0072B2", "#D55E00", "#009E73"] and "#F0E442" not in PALETTES["default"]
    assert PALETTES["colorblind"][1] == "#E69F00"
    names = [f"s{i}" for i in range(9)]
    rows = [[1] + [float(i) for i in range(9)], [2] + [float(i) + 1 for i in range(9)]]
    script = emit_script(make(rows=rows, columns=("x", *names), y=names))
    assert [w["code"] for w in script.warnings] == ["palette_cycled"]
    custom = emit_script(make(appearance={"colors": ["#102030"]}))
    assert "'#102030'" in custom.source


def test_series_that_draws_nothing_is_flagged():
    script = emit_script(make(series={"a": {"line": False, "marker": "none"}}))
    assert [w["code"] for w in script.warnings] == ["series_draws_nothing"]


def test_marker_and_line_style_names_match_the_model():
    assert set(MARKERS) | {"none"} == set(get_args(MarkerName))
    assert set(LINE_STYLES) == set(get_args(LineStyleName))


# ------------------------------------------------------------ appearance
def test_appearance_becomes_rcparams_and_axes_settings():
    appearance = dict(
        title="T", xLabel="X axis", yLabel="Y axis", fontFamily="serif", fontSize=12.0, labelSize=14.0, legendSize=8.0,
        despine=False, grid=True, gridMinor=True, gridStyle="dashed", tickDirection="inout",
        xTickRotation=45.0, yTickRotation=30.0)
    rec = make(appearance=appearance, options={"xLim": [0.0, 10.0], "yLim": [-1.0, 8.0]})
    with executed(emit_script(rec).source) as (fig, ax):
        rc = matplotlib.rcParams
        assert rc["font.family"] == ["serif"] and rc["font.size"] == 12.0
        assert (rc["axes.titlesize"], rc["axes.labelsize"], rc["xtick.labelsize"], rc["legend.fontsize"]) == (14.4, 14.0, 10.8, 8.0)
        assert rc["axes.spines.top"] is True and rc["axes.spines.right"] is True
        assert rc["axes.grid.which"] == "both" and rc["grid.linestyle"] == "--"
        assert rc["xtick.direction"] == rc["ytick.direction"] == "inout"
        assert (ax.get_title(), ax.get_xlabel(), ax.get_ylabel()) == ("T", "X axis", "Y axis")
        assert ax.get_xlim() == (0.0, 10.0) and ax.get_ylim() == (-1.0, 8.0)
        assert ax.xaxis.get_minorticklocs().size > 0                       # minor ticks are on for the minor grid
        assert ax.xaxis.get_majorticklabels()[1].get_rotation() == 45.0
        assert ax.xaxis.get_majorticklabels()[1].get_ha() == "right"
        assert ax.yaxis.get_majorticklabels()[1].get_rotation() == 30.0


def test_open_axes_hide_top_and_right_spines_and_grid_can_be_off():
    with executed(emit_script(make(appearance={"grid": False})).source) as (fig, ax):
        assert not ax.spines["top"].get_visible() and not ax.spines["right"].get_visible()
        assert matplotlib.rcParams["axes.grid"] is False


def test_font_name_comes_first_with_the_family_as_fallback():
    with executed(emit_script(make(appearance={"fontName": "DejaVu Serif", "fontFamily": "serif"})).source):
        assert matplotlib.rcParams["font.family"] == ["DejaVu Serif", "serif"]
    script = emit_script(make(appearance={"fontName": "No Such Font 123"}))
    assert [w["code"] for w in script.warnings] == ["font_not_installed"]
    run(script, make())                                                   # still renders with the fallback


def test_title_and_label_visibility_and_automatic_labels():
    with executed(emit_script(make(appearance={"title": "T"})).source) as (fig, ax):
        assert (ax.get_title(), ax.get_xlabel(), ax.get_ylabel()) == ("T", "x", "a")      # X column, single series name
    hidden = {"title": "T", "xLabel": "X", "yLabel": "Y", "showTitle": False, "showXLabel": False, "showYLabel": False}
    with executed(emit_script(make(appearance=hidden)).source) as (fig, ax):
        assert (ax.get_title(), ax.get_xlabel(), ax.get_ylabel()) == ("", "", "")
    with executed(emit_script(make(y=("a", "b"))).source) as (fig, ax):
        assert ax.get_ylabel() == ""                                                        # several series: legend names them


@pytest.mark.parametrize("layout, engine", [("tight", "TightLayoutEngine"), ("constrained", "ConstrainedLayoutEngine")])
def test_figure_size_and_layout_engine(layout, engine):
    rec = make(appearance={"layout": layout})
    rec["export"].update(wIn=7.5, hIn=2.5)
    with executed(emit_script(rec).source) as (fig, ax):
        assert tuple(fig.get_size_inches()) == (7.5, 2.5)
        assert type(fig.get_layout_engine()).__name__ == engine


# ------------------------------------------------------------ validation
def test_log_axis_with_zero_is_a_validation_error_not_a_bad_plot():
    rec = make(rows=[[1, 0.0, 1.0], [2, 2.0, 1.0], [3, 4.0, 1.0]], options={"yScale": "log"})
    with pytest.raises(CodegenError) as info:
        emit_script(rec)
    issue = info.value.issues[0]
    assert issue["code"] == "log_nonpositive" and issue["level"] == "error" and issue["column"] == "a"
    assert "data row 1" in issue["message"] and "log y axis" in str(info.value)


def test_log_axis_checks_x_values_limits_and_ignores_missing_and_hidden_data():
    with pytest.raises(CodegenError) as info:
        emit_script(make(rows=[[0, 1.0], [1, 2.0]], columns=("x", "a"), options={"xScale": "log"}))
    assert codes(info) == ["log_nonpositive"]
    with pytest.raises(CodegenError) as info:
        emit_script(make(options={"yScale": "log", "yLim": [0.0, 10.0]}))
    assert codes(info) == ["log_limits_nonpositive"]
    ok = make(rows=[[1, 1.0, 0.0], [2, None, 5.0], [3, 3.0, 5.0]], y=("a", "b"), series={"b": {"visible": False}},
              options={"yScale": "log"})
    assert "ax.set_yscale('log')" in emit_script(ok).source                 # NaN and a hidden series do not block


def test_error_bar_problems_are_errors():
    rows = [[1, 1.0, -0.5, 0.5], [2, 2.0, 0.5, 0.5]]
    columns = ("x", "a", "neg", "pos")

    def failing(series):
        with pytest.raises(CodegenError) as info:
            emit_script(make(rows=rows, columns=columns, series={"a": series}))
        return codes(info)

    assert failing({"error": "symmetric", "errorCol": "neg"}) == ["error_negative"]
    assert failing({"error": "symmetric"}) == ["mapping_missing"]
    assert failing({"error": "asymmetric", "errorLowCol": "pos"}) == ["mapping_missing"]
    assert failing({"error": "symmetric", "errorCol": "nope"}) == ["column_missing"]


def test_a_bad_shared_error_column_is_reported_once():
    rows = [[1, 1.0, 2.0, -0.1], [2, 2.0, 3.0, 0.1]]
    rec = make(rows=rows, columns=("x", "a", "b", "e"), y=("a", "b"), mapping={"yErr": "e"}, options={"errorBars": True})
    with pytest.raises(CodegenError) as info:
        emit_script(rec)
    assert codes(info) == ["error_negative"]


def test_dataset_problems_are_reported_with_the_dataset_codes():
    rec = make()
    rec["dataset"]["columns"][1]["type"] = "text"
    rec["dataset"]["rows"] = [[1, "u", 4.0], [2, "v", 3.0]]
    with pytest.raises(CodegenError) as info:
        emit_script(rec)
    assert codes(info) == ["column_not_numeric"]
    with pytest.raises(CodegenError) as info:
        emit_script(make(y=()))
    assert codes(info) == ["mapping_missing"]


def test_unsupported_plot_types_and_invalid_settings_are_rejected(monkeypatch):
    rec = make()
    rec["config"]["plotType"] = "hist"
    from backend.figures.codegen import common
    monkeypatch.delitem(common.GENERATORS, "hist", raising=False)
    with pytest.raises(CodegenError) as info:
        emit_script(rec)
    assert codes(info) == ["no_generator"]
    rec = make()
    rec["config"]["appearance"]["surprise"] = 1
    with pytest.raises(CodegenError) as info:
        emit_script(rec)
    assert codes(info) == ["invalid_record"] and "surprise" in str(info.value)


def test_out_of_range_and_unknown_choices_are_rejected_by_the_model():
    for section, key, value in [("appearance", "tickDirection", "sideways"), ("appearance", "xTickRotation", 120.0),
                                ("appearance", "layout", "loose")]:
        rec = make()
        rec["config"][section][key] = value
        with pytest.raises(CodegenError) as info:
            emit_script(rec)
        assert codes(info) == ["invalid_record"] and key in str(info.value)
    rec = make(series={"a": {"marker": "hexagon"}})
    with pytest.raises(CodegenError) as info:
        emit_script(rec)
    assert codes(info) == ["invalid_record"]


# =========================================================================== scatter plots
SUPERSCRIPT_POWERS = {"": 0, "x": 1, "x²": 2, "x³": 3, "x⁴": 4, "x⁵": 5}
FORBIDDEN_WORDS = [r"signific", r"\bcaus", r"\bp[- ]?values?\b", r"\beffects?\b", r"\bbecause\b", r"\bleads? to\b",
                   r"\bdrives?\b", r"\bimpact", r"\bexplain"]
RNG = np.random.default_rng(7)
XS = np.arange(1.0, 13.0)
YS = np.round(1.5 * XS + 2 + RNG.normal(0, 0.8, XS.size), 3)                       # noisy straight line
YS_CURVE = np.round(0.05 * XS ** 3 - 0.8 * XS ** 2 + 3 * XS + 1 + RNG.normal(0, 0.5, XS.size), 3)
NUMBERS = [("x", "number"), ("y", "number")]


def make_scatter(rows, columns=NUMBERS, y=("y",), group=None, **sections):
    """Valid scatter record (dict). ``columns`` = [(name, type)]; ``appearance=``/``options=`` update that section."""
    rec = default_record("structured", "scatter").model_dump()
    rec["dataset"] = {"columns": [{"name": n, "type": t} for n, t in columns], "rows": rows,
                      "origin": {"type": "sheet", "label": ""}}
    rec["config"]["mapping"] = {"x": "x", "y": list(y), "group": group, "yErr": None}
    for name, values in sections.items():
        rec["config"][name].update(values)
    rec["export"].update(wIn=5.0, hIn=3.0, dpi=100)
    return rec


def xy_rows(xs=XS, ys=YS):
    return [[float(a), None if b is None else float(b)] for a, b in zip(xs, ys)]


def grouped_rows():
    """Two groups, interleaved: A has slope 2 / intercept 1, B has slope -1 / intercept 10."""
    rows = []
    for i in range(1, 7):
        rows += [[float(i), 2.0 * i + 1 + (0.3 if i % 2 else -0.3), "A"], [float(i), 10.0 - i + (0.2 if i % 3 else -0.4), "B"]]
    return rows


GROUPED = [("x", "number"), ("y", "number"), ("g", "text")]


def legend_texts(ax):
    return [t.get_text() for t in ax.get_legend().get_texts()]


def parse_equation(label):
    """Coefficients (highest power first) of the equation line of a fit label ('y = 2x² − 3x + 1, R² = 0.99')."""
    body = label.split("\n")[1].split(", R²")[0].split("=", 1)[1].replace("−", "-").replace(" ", "")
    terms = re.findall(r"([+-]?\d+(?:\.\d+)?(?:e[+-]\d+)?)(x[²³⁴⁵]?)?", body)
    degree = max(SUPERSCRIPT_POWERS[t[1]] for t in terms)
    found = {SUPERSCRIPT_POWERS[power]: float(number) for number, power in terms}
    return [found[p] for p in range(degree, -1, -1)]


def parse_r2(text):
    return float(re.search(r"R² = (-?[0-9.]+)", text).group(1))


def fit_label(ax, index=0):
    return [t for t in legend_texts(ax) if t.startswith("Fit (")][index]


def drawn_points(ax):
    return [c for c in ax.collections if isinstance(c, PathCollection)]


def test_scatter_script_runs_and_draws_the_points_with_automatic_labels():
    rec = make_scatter(xy_rows())
    script = emit_script(rec)
    res = run(script, rec)
    assert Image.open(io.BytesIO(res.png_bytes)).size == (500, 300)
    with executed(script.source) as (fig, ax):
        (points,) = drawn_points(ax)
        np.testing.assert_array_equal(points.get_offsets(), np.column_stack([XS, YS]))
        assert ax.get_xlabel() == "x" and ax.get_ylabel() == "y"
        assert ax.get_legend() is None and not ax.lines          # one series, no fit: nothing to tell apart
        assert tuple(points.get_facecolors()[0][:3]) == matplotlib.colors.to_rgb(PALETTES["default"][0])


def test_marker_type_size_colour_alpha_and_outline_reach_the_points():
    rec = make_scatter(xy_rows(), appearance={"markerSize": 8.0, "alpha": 0.5, "colors": ["#123456"]},
                       options={"marker": "square", "markerEdgeColor": "#FF0000", "markerEdgeWidth": 1.2})
    script = emit_script(rec)
    assert "marker='s'" in script.source
    with executed(script.source) as (fig, ax):
        (points,) = drawn_points(ax)
        assert list(points.get_sizes()) == [64.0] and points.get_alpha() == 0.5
        assert tuple(points.get_facecolors()[0][:3]) == matplotlib.colors.to_rgb("#123456")
        assert tuple(points.get_edgecolors()[0][:3]) == matplotlib.colors.to_rgb("#FF0000")
        assert list(points.get_linewidths()) == [1.2]


def test_without_an_outline_colour_the_outline_follows_the_point_colour_and_can_be_switched_off():
    with executed(emit_script(make_scatter(xy_rows(), options={"markerEdgeWidth": 0})).source) as (fig, ax):
        (points,) = drawn_points(ax)
        assert list(points.get_linewidths()) == [0.0]
        assert tuple(points.get_edgecolors()[0][:3]) == tuple(points.get_facecolors()[0][:3])


def test_stroke_markers_have_no_outline_and_say_so():
    script = emit_script(make_scatter(xy_rows(), options={"marker": "plus", "markerEdgeColor": "#FF0000"}))
    assert [w["code"] for w in script.warnings if w["level"] == "warning"] == ["outline_ignored"]
    assert "facecolors" not in script.source and "marker='+'" in script.source
    with executed(script.source) as (fig, ax):
        assert len(drawn_points(ax)) == 1


def test_scatter_marker_names_match_the_model():
    assert set(get_args(ScatterMarkerName)) == set(MARKERS) == set(get_args(MarkerName)) - {"none"}


def test_no_fit_unless_asked_for():
    script = emit_script(make_scatter(xy_rows()))
    assert "polyfit" not in script.source and "scipy" not in script.source
    assert not [w for w in script.warnings if w["code"].startswith("fit_")]


def test_linear_fit_equation_and_r2_match_numpy():
    rec = make_scatter(xy_rows(), options={"fit": "linear"})
    script = emit_script(rec)
    run(script, rec)
    slope, intercept = np.polyfit(XS, YS, 1)
    r2 = 1 - np.sum((YS - (slope * XS + intercept)) ** 2) / np.sum((YS - YS.mean()) ** 2)
    with executed_ns(script.source) as (fig, ax, ns):
        (result,) = ns["fit_results"]
        np.testing.assert_allclose(result["coefficients"], [slope, intercept], rtol=1e-12)
        assert result["r2"] == pytest.approx(r2, rel=1e-12) and result["points"] == XS.size
        label = fit_label(ax)
        assert label.split("\n")[0] == "Fit (linear)"
        np.testing.assert_allclose(parse_equation(label), [slope, intercept], rtol=1e-3)
        assert abs(parse_r2(label) - r2) < 6e-4
        (line,) = ax.lines
        np.testing.assert_allclose(line.get_ydata(), slope * line.get_xdata() + intercept, rtol=1e-12)
        assert line.get_xdata().min() == XS.min() and line.get_xdata().max() == XS.max()   # never extrapolated


def test_fit_line_is_dashed_and_labelled_apart_from_the_observations():
    with executed(emit_script(make_scatter(xy_rows(), options={"fit": "linear"})).source) as (fig, ax):
        (line,) = ax.lines
        (points,) = drawn_points(ax)
        assert line.get_linestyle() == "--" and line.get_label().startswith("Fit (linear)")
        assert points.get_label() == "y"                                   # observations keep the column name
        assert [t.split("\n")[0] for t in legend_texts(ax)] == ["y", "Fit (linear)"]
        assert line.get_zorder() > points.get_zorder()


def test_confidence_band_for_a_line_uses_the_t_distribution():
    n, x_mean = XS.size, XS.mean()
    slope, intercept = np.polyfit(XS, YS, 1)
    s = np.sqrt(np.sum((YS - (slope * XS + intercept)) ** 2) / (n - 2))
    for level in (0.95, 0.9):
        rec = make_scatter(xy_rows(), options={"fit": "linear", "fitBand": True, "fitLevel": level})
        script = emit_script(rec)
        run(script, rec)
        with executed(script.source) as (fig, ax):
            band = ax.collections[1]                                       # after the points
            grid = ax.lines[0].get_xdata()
            fitted = slope * grid + intercept
            half = stats.t.ppf(0.5 + level / 2, n - 2) * s * np.sqrt(1 / n + (grid - x_mean) ** 2 / np.sum((XS - x_mean) ** 2))
            vertices = band.get_paths()[0].vertices
            np.testing.assert_allclose([vertices[:, 1].min(), vertices[:, 1].max()],
                                       [(fitted - half).min(), (fitted + half).max()], rtol=1e-9)
            assert vertices[:, 0].min() == XS.min() and vertices[:, 0].max() == XS.max()
            assert any("confidence band" in t and "t-distribution" in t for t in legend_texts(ax))
            assert f"{level * 100:g}% confidence band" in legend_texts(ax)[2]
        note = next(w for w in script.warnings if w["code"] == "fit_method")
        assert "t-distribution" in note["message"] and "not a prediction interval" in note["message"]
        assert "from scipy import stats" in script.source and "scipy" in script.source.splitlines()[2]


def test_scipy_is_only_imported_when_a_band_is_drawn():
    assert "scipy" not in emit_script(make_scatter(xy_rows(), options={"fit": "polynomial"})).source
    assert "stats.t.ppf" in emit_script(make_scatter(xy_rows(), options={"fit": "polynomial", "fitBand": True})).source


@pytest.mark.parametrize("degree", [2, 3, 5])
def test_polynomial_fit_matches_numpy(degree):
    script = emit_script(make_scatter(xy_rows(ys=YS_CURVE), options={"fit": "polynomial", "fitDegree": degree}))
    expected = np.polyfit(XS, YS_CURVE, degree)
    r2 = 1 - np.sum((YS_CURVE - np.polyval(expected, XS)) ** 2) / np.sum((YS_CURVE - YS_CURVE.mean()) ** 2)
    with executed_ns(script.source) as (fig, ax, ns):
        np.testing.assert_allclose(ns["fit_results"][0]["coefficients"], expected, rtol=1e-12)
        label = fit_label(ax)
        assert label.split("\n")[0] == f"Fit (polynomial, degree {degree})"
        np.testing.assert_allclose(parse_equation(label), expected, rtol=1e-3)
        assert abs(parse_r2(label) - r2) < 6e-4
        (line,) = ax.lines
        np.testing.assert_allclose(line.get_ydata(), np.polyval(expected, line.get_xdata()), rtol=1e-9, atol=1e-9)
        assert line.get_linestyle() == "--"


def test_polynomial_band_matches_an_independent_calculation():
    rec = make_scatter(xy_rows(ys=YS_CURVE), options={"fit": "polynomial", "fitDegree": 2, "fitBand": True})
    script = emit_script(rec)
    run(script, rec)
    design = np.vander(XS, 3)
    beta = np.linalg.lstsq(design, YS_CURVE, rcond=None)[0]
    s2 = np.sum((YS_CURVE - design @ beta) ** 2) / (XS.size - 3)
    covariance = s2 * np.linalg.inv(design.T @ design)
    with executed(script.source) as (fig, ax):
        grid = ax.lines[0].get_xdata()
        grid_design = np.vander(grid, 3)
        half = stats.t.ppf(0.975, XS.size - 3) * np.sqrt(np.einsum("ij,jk,ik->i", grid_design, covariance, grid_design))
        fitted = grid_design @ beta
        vertices = ax.collections[1].get_paths()[0].vertices
        np.testing.assert_allclose([vertices[:, 1].min(), vertices[:, 1].max()],
                                   [(fitted - half).min(), (fitted + half).max()], rtol=1e-8)


@pytest.mark.parametrize("degree", [2, 3, 4, 5])
def test_polynomial_degree_guard_refuses_points_up_to_degree_plus_one(degree):
    for points in (degree, degree + 1):
        rec = make_scatter(xy_rows(XS[:points], YS_CURVE[:points]), options={"fit": "polynomial", "fitDegree": degree})
        with pytest.raises(CodegenError) as info:
            emit_script(rec)
        assert codes(info) == ["fit_too_few_points"]
        message = str(info.value)
        assert f"at least {degree + 2} points" in message and f"has {points}" in message and "series 'y'" in message
    emit_script(make_scatter(xy_rows(XS[:degree + 2], YS_CURVE[:degree + 2]), options={"fit": "polynomial", "fitDegree": degree}))


def test_linear_fit_needs_more_than_two_points_and_missing_values_do_not_count():
    with pytest.raises(CodegenError) as info:
        emit_script(make_scatter(xy_rows(XS[:2], YS[:2]), options={"fit": "linear"}))
    assert codes(info) == ["fit_too_few_points"] and "at least 3 points" in str(info.value)
    ys = list(YS[:6])
    ys[1] = ys[4] = None                                                   # 4 usable points, degree 3 needs 5
    with pytest.raises(CodegenError) as info:
        emit_script(make_scatter(xy_rows(XS[:6], ys), options={"fit": "polynomial", "fitDegree": 3}))
    assert codes(info) == ["fit_too_few_points"] and "has 4" in str(info.value)


def test_fits_that_cannot_be_determined_are_refused():
    with pytest.raises(CodegenError) as info:
        emit_script(make_scatter(xy_rows([2.0] * 6, YS[:6]), options={"fit": "linear"}))
    assert codes(info) == ["fit_degenerate_x"] and "1 distinct x value" in str(info.value)
    with pytest.raises(CodegenError) as info:
        emit_script(make_scatter(xy_rows(XS[:6], [3.0] * 6), options={"fit": "linear"}))
    assert codes(info) == ["fit_constant_y"] and "R² is undefined" in str(info.value)


def test_missing_values_are_not_drawn_not_filled_and_not_fitted():
    ys = list(YS)
    ys[3] = None
    script = emit_script(make_scatter(xy_rows(ys=ys), options={"fit": "linear"}))
    assert any(w["code"] == "missing_values" for w in script.warnings)
    keep = np.array([i != 3 for i in range(XS.size)])
    with executed_ns(script.source) as (fig, ax, ns):
        np.testing.assert_allclose(ns["fit_results"][0]["coefficients"], np.polyfit(XS[keep], YS[keep], 1), rtol=1e-12)
        assert ns["fit_results"][0]["points"] == XS.size - 1


def test_grouped_scatter_has_one_series_per_group_in_order_of_first_appearance():
    rec = make_scatter(grouped_rows(), GROUPED, group="g")
    script = emit_script(rec)
    run(script, rec)
    with executed(script.source) as (fig, ax):
        a, b = drawn_points(ax)
        rows = np.array([[r[0], r[1]] for r in grouped_rows()])
        is_a = np.array([r[2] == "A" for r in grouped_rows()])
        np.testing.assert_array_equal(a.get_offsets(), rows[is_a])
        np.testing.assert_array_equal(b.get_offsets(), rows[~is_a])
        assert [a.get_label(), b.get_label()] == ["A", "B"] and legend_texts(ax) == ["A", "B"]
        assert [tuple(c.get_facecolors()[0][:3]) for c in (a, b)] == [matplotlib.colors.to_rgb(c) for c in PALETTES["default"][:2]]
        assert ax.get_ylabel() == "y" and not ax.lines


def test_grouped_scatter_fits_each_group_on_its_own():
    rows = grouped_rows()
    script = emit_script(make_scatter(rows, GROUPED, group="g", options={"fit": "linear", "fitBand": True}))
    with executed_ns(script.source) as (fig, ax, ns):
        for result, name in zip(ns["fit_results"], "AB"):
            xs = np.array([r[0] for r in rows if r[2] == name])
            ys = np.array([r[1] for r in rows if r[2] == name])
            assert result["series"] == name
            np.testing.assert_allclose(result["coefficients"], np.polyfit(xs, ys, 1), rtol=1e-12)
        a_fit, b_fit = ax.lines
        assert [l.get_linestyle() for l in (a_fit, b_fit)] == ["--", "--"]
        assert [matplotlib.colors.to_hex(l.get_color()).upper() for l in (a_fit, b_fit)] == [c.upper() for c in PALETTES["default"][:2]]
        firsts = [t.split("\n")[0] for t in legend_texts(ax)]
        assert firsts == ["A", "Fit (linear): A", "95% confidence band: A, t-distribution",
                          "B", "Fit (linear): B", "95% confidence band: B, t-distribution"]
        slope_a = parse_equation(fit_label(ax, 0))[0]
        slope_b = parse_equation(fit_label(ax, 1))[0]
        assert slope_a > 1.5 > 0 > slope_b                                  # each group has its own slope
        assert len(ax.collections) == 4                                     # 2 point clouds + 2 bands


def test_a_group_with_too_few_points_is_named_in_the_refusal():
    rows = grouped_rows() + [[1.0, 5.0, "C"], [2.0, 6.0, "C"], [3.0, 7.5, "C"]]
    with pytest.raises(CodegenError) as info:
        emit_script(make_scatter(rows, GROUPED, group="g", options={"fit": "polynomial", "fitDegree": 3}))
    assert codes(info) == ["fit_too_few_points"] and "series 'C'" in str(info.value) and "series 'A'" not in str(info.value)


def test_numeric_group_columns_and_rows_without_a_group_value():
    rows = [[1.0, 2.0, 1], [2.0, 3.0, 1], [3.0, 5.0, 2], [4.0, 4.0, 2], [5.0, 6.0, None], [6.0, 7.0, None]]
    columns = [("x", "number"), ("y", "number"), ("g", "number")]
    with executed(emit_script(make_scatter(rows, columns, group="g")).source) as (fig, ax):
        assert legend_texts(ax) == ["1", "2", "(no group)"]                 # missing group values are shown, never dropped
        assert [len(c.get_offsets()) for c in drawn_points(ax)] == [2, 2, 2]


def test_group_column_that_is_also_the_x_column_still_works():
    rows = [[1.0, 2.0], [1.0, 3.0], [2.0, 5.0]]
    with executed(emit_script(make_scatter(rows, group="x")).source) as (fig, ax):
        assert legend_texts(ax) == ["1", "2"]


def test_with_a_group_only_the_first_y_column_is_drawn_and_a_note_says_so():
    rows = [r + [r[1] * 2] for r in grouped_rows()]
    columns = GROUPED + [("z", "number")]
    script = emit_script(make_scatter(rows, columns, y=("y", "z"), group="g"))
    assert [w["code"] for w in script.warnings] == ["y_columns_ignored"] and "'y' is used" in script.warnings[0]["message"]
    with executed(script.source) as (fig, ax):
        assert len(drawn_points(ax)) == 2


def test_several_y_columns_without_a_group_are_separate_series_with_their_own_fits():
    rows = [[float(x), float(a), float(b)] for x, a, b in zip(XS, YS, YS_CURVE)]
    columns = [("x", "number"), ("a", "number"), ("b", "number")]
    script = emit_script(make_scatter(rows, columns, y=("a", "b"), options={"fit": "linear"}))
    with executed_ns(script.source) as (fig, ax, ns):
        assert [r["series"] for r in ns["fit_results"]] == ["a", "b"]
        assert legend_texts(ax)[0] == "a" and fit_label(ax, 1).startswith("Fit (linear): b")
        assert ax.get_ylabel() == ""                                        # two Y columns: the legend names them


def test_error_columns_are_not_drawn_and_the_note_says_so():
    rec = make_scatter(xy_rows(), columns=NUMBERS + [("e", "number")], options={"errorBars": True})
    rec["dataset"]["rows"] = [r + [0.1] for r in rec["dataset"]["rows"]]
    rec["config"]["mapping"]["yErr"] = "e"
    assert [w["code"] for w in emit_script(rec).warnings] == ["error_bars_ignored"]


def test_legend_rules_with_fits():
    assert emit_script(make_scatter(xy_rows())).source.count("ax.legend") == 0
    assert "handles=handles" in emit_script(make_scatter(xy_rows(), options={"fit": "linear"})).source
    hidden = emit_script(make_scatter(xy_rows(), options={"fit": "linear"}, appearance={"legend": {"show": False, "pos": "best", "force": False}}))
    assert "ax.legend" not in hidden.source and any(w["code"] == "fit_legend_hidden" for w in hidden.warnings)
    outside = emit_script(make_scatter(xy_rows(), options={"fit": "linear"}, appearance={"legend": {"show": True, "pos": "outside", "force": False}}))
    assert "handles=handles, loc='center left'" in outside.source
    forced = emit_script(make_scatter(xy_rows(), appearance={"legend": {"show": True, "pos": "best", "force": True}}))
    with executed(forced.source) as (fig, ax):
        assert legend_texts(ax) == ["y"]


def test_limits_and_log_scales_come_from_the_shared_axes_code():
    rec = make_scatter(xy_rows(), options={"xScale": "log", "yScale": "log", "xLim": [0.5, 20.0], "yLim": [1.0, 40.0]})
    with executed(emit_script(rec).source) as (fig, ax):
        assert ax.get_xscale() == "log" and ax.get_yscale() == "log"
        assert ax.get_xlim() == (0.5, 20.0) and ax.get_ylim() == (1.0, 40.0)
    zero = make_scatter(xy_rows(ys=[0.0] + list(YS[1:])), options={"yScale": "log"})
    with pytest.raises(CodegenError) as info:
        emit_script(zero)
    assert codes(info) == ["log_nonpositive"]


def test_fit_on_a_log_x_axis_is_sampled_evenly_in_log_space_and_noted():
    script = emit_script(make_scatter(xy_rows(), options={"fit": "linear", "xScale": "log"}))
    assert any(w["code"] == "fit_on_log_axis" for w in script.warnings)
    with executed(script.source) as (fig, ax):
        steps = np.diff(np.log(ax.lines[0].get_xdata()))
        np.testing.assert_allclose(steps, steps[0], rtol=1e-9)


def test_output_never_claims_causes_or_significance():
    rec = make_scatter(grouped_rows(), GROUPED, group="g", options={"fit": "polynomial", "fitDegree": 2, "fitBand": True})
    script = emit_script(rec)
    with executed(script.source) as (fig, ax):
        text = " ".join([script.source, *(w["message"] for w in script.warnings), *legend_texts(ax)]).lower()
    assert [w for w in FORBIDDEN_WORDS if re.search(w, text)] == []


def test_more_than_fifty_groups_are_refused():
    rows = [[float(i), float(i), f"g{i}"] for i in range(51)]
    with pytest.raises(CodegenError) as info:
        emit_script(make_scatter(rows, GROUPED, group="g"))
    assert codes(info) == ["too_many_groups"]
    emit_script(make_scatter(rows[:50], GROUPED, group="g"))


def test_palette_repeats_with_a_note_when_groups_outnumber_colours():
    rows = [[float(i), float(i), f"g{i}"] for i in range(10)]
    script = emit_script(make_scatter(rows, GROUPED, group="g"))
    assert any(w["code"] == "palette_cycled" for w in script.warnings)


def test_group_names_with_quotes_and_newlines_cannot_break_the_script():
    names = ['a"b', "it's", "two\nlines"]
    rows = [[float(i), float(i), names[i % 3]] for i in range(9)]
    with executed(emit_script(make_scatter(rows, GROUPED, group="g")).source) as (fig, ax):
        assert legend_texts(ax) == names


def test_big_grouped_data_goes_to_a_csv_file_and_still_fits_with_a_band():
    rng = np.random.default_rng(3)
    count = INLINE_LIMIT + 100
    xs = rng.uniform(0, 10, count)
    groups = np.where(np.arange(count) % 2, "A", "B")
    ys = np.where(groups == "A", 2 * xs + 1, -xs + 9) + rng.normal(0, 1, count)
    rows = [[float(x), float(y), g] for x, y, g in zip(xs, ys, groups)]
    rec = make_scatter(rows, GROUPED, group="g", options={"fit": "linear", "fitBand": True})
    script = emit_script(rec)
    assert DATA_FILE in script.files and "pd.read_csv" in script.source
    res = run(script, rec)
    assert Image.open(io.BytesIO(res.png_bytes)).size == (500, 300)


def test_scatter_option_values_outside_the_model_are_rejected():
    for key, value in [("fitDegree", 1), ("fitDegree", 6), ("fit", "quadratic"), ("fitLevel", 0.2), ("marker", "none"),
                       ("markerEdgeColor", "red"), ("markerEdgeWidth", -1.0)]:
        rec = make_scatter(xy_rows())
        rec["config"]["options"][key] = value
        with pytest.raises(CodegenError) as info:
            emit_script(rec)
        assert codes(info) == ["invalid_record"] and key in str(info.value)
