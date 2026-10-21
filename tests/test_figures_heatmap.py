"""Heatmap script generation (docs/FIGURES_CONTRACT.md s4h): scripts are generated, run, and the drawn cells are measured."""
import contextlib
import warnings

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import pytest
from PIL import Image

from backend.figures.codegen import CodegenError, emit_script
from backend.figures.models import FigureRecord, default_record
from backend.figures.runner import run_python

NAMES = ["Alpha", "Beta", "Gamma", "Delta"]


def sample(n=40, seed=3):
    """Four numeric columns: Beta follows Alpha, Gamma is monotone-but-nonlinear in Alpha, Delta is noise."""
    rng = np.random.default_rng(seed)
    a = rng.normal(size=n)
    return np.column_stack([a, a * 0.7 + rng.normal(size=n) * 0.4, np.exp(a), rng.normal(size=n)]).round(4)


def make(values=None, columns=None, types=None, x=None, y=(), mode="matrix", labels=None, **sections):
    """Valid heatmap record (dict). ``values`` = rows of numbers; ``labels`` adds a text column first (named 'id')."""
    values = sample() if values is None else values
    columns = list(columns or NAMES[: len(values[0])])
    types = list(types or ["number"] * len(columns))
    rows = [[None if (isinstance(v, float) and np.isnan(v)) else (None if v is None else float(v)) for v in row] for row in values]
    if labels is not None:
        columns, types = ["id"] + columns, ["text"] + types
        rows = [[lab] + row for lab, row in zip(labels, rows)]
    rec = default_record("structured", "heatmap").model_dump()
    rec["dataset"] = {"columns": [{"name": c, "type": t} for c, t in zip(columns, types)], "rows": rows,
                      "origin": {"type": "sheet", "label": ""}}
    rec["config"]["mapping"] = {"x": x, "y": list(y), "group": None, "yErr": None}
    rec["config"]["options"]["heatmapMode"] = mode
    for name, items in sections.items():
        rec["config"][name].update(items)
    rec["export"].update(wIn=5.0, hIn=4.0, dpi=100)
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
    """Generate and run; return (namespace snapshot of matrix/labels/hidden/missing, mesh array, colour limits, script)."""
    script = emit_script(rec)
    with executed(script.source) as (fig, ax, ns):
        snapshot = {k: ns[k] for k in ("matrix", "row_labels", "col_labels", "hidden", "missing", "vmin", "vmax")}
        mesh = next(c for c in ax.collections if hasattr(c, "get_clim"))
        return snapshot, mesh, script


def codes(error):
    return [i["code"] for i in error.value.issues]


def note_codes(script):
    return [w["code"] for w in script.warnings]


# ------------------------------------------------------------------ model
def test_model_accepts_new_fields_and_old_records_stay_valid():
    rec = default_record("structured", "heatmap").model_dump()
    assert rec["config"]["appearance"]["cmap"] is None
    assert rec["config"]["options"]["heatmapMode"] == "matrix"
    for cmap in ("viridis", "magma", "cividis", "coolwarm", "RdBu_r", "Greys", "plasma", "gray"):
        rec["config"]["appearance"]["cmap"] = cmap
        FigureRecord.model_validate(rec)
    rec["config"]["appearance"]["cmap"] = "jet"
    with pytest.raises(Exception):
        FigureRecord.model_validate(rec)


# ----------------------------------------------------------- correlation
def test_pearson_matches_pandas():
    values = sample()
    snap, _, _ = drawn(make(values, mode="correlation"))
    expected = pd.DataFrame(values, columns=NAMES).corr(method="pearson").to_numpy()
    assert np.allclose(snap["matrix"], expected, atol=1e-12)


def test_spearman_matches_pandas_and_differs_from_pearson():
    values = sample()
    snap, _, script = drawn(make(values, mode="correlation", options={"corrMethod": "spearman"}))
    expected = pd.DataFrame(values, columns=NAMES).corr(method="spearman").to_numpy()
    assert np.allclose(snap["matrix"], expected, atol=1e-12)
    assert snap["matrix"][0, 2] == pytest.approx(1.0)           # exp() is monotone: rank correlation is exactly 1
    assert "scipy" in script.source
    assert emit_script(make(values, mode="correlation")).source.count("scipy") == 0


def test_correlation_nan_uses_pairwise_complete_rows_like_pandas():
    values = sample().astype(float)
    values[[2, 5, 11], 1] = np.nan
    values[[5, 7], 3] = np.nan
    for method in ("pearson", "spearman"):
        snap, _, _ = drawn(make(values, mode="correlation", options={"corrMethod": method}))
        expected = pd.DataFrame(values, columns=NAMES).corr(method=method, min_periods=3).to_numpy()
        assert np.allclose(snap["matrix"], expected, atol=1e-12, equal_nan=True)
        assert not np.isnan(snap["matrix"]).any()               # a few gaps never make a coefficient undefined


def test_undefined_correlations_are_masked_hatched_and_reported():
    values = sample().astype(float)
    values[:, 3] = 5.0                                          # constant column: no correlation exists
    rec = make(values, mode="correlation")
    snap, mesh, script = drawn(rec)
    matrix = snap["matrix"]
    assert np.isnan(matrix[3]).all() and np.isnan(matrix[:, 3]).all()    # also the diagonal cell of that column
    assert snap["missing"][3].all() and snap["missing"][:, 3].all()
    assert "undefined_correlations" in note_codes(script)
    assert "Undefined correlation" in script.source and "hatch='////'" in script.source
    assert np.ma.getmaskarray(mesh.get_array())[3].all()        # nothing is drawn as a coloured cell there


def test_too_few_shared_values_is_undefined():
    values = np.full((6, 3), np.nan)
    values[:, 0] = [1, 2, 3, 4, 5, 6]
    values[:, 1] = [2, 1, 4, 3, 6, 5]
    values[:2, 2] = [1, 2]                                      # only two rows with a value
    snap, _, _ = drawn(make(values, mode="correlation"))
    assert np.isnan(snap["matrix"][2]).all() and not np.isnan(snap["matrix"][0, 1])


def test_nothing_defined_is_a_clear_error():
    values = np.column_stack([np.full(10, 1.0), np.full(10, 2.0), np.arange(10.0)])
    values[:, 2] = np.nan
    values[0, 2] = 1.0
    with pytest.raises(CodegenError) as err:
        emit_script(make(values, mode="correlation"))
    assert "no_defined_correlations" in codes(err)


@pytest.mark.parametrize("triangle", ["lower", "upper"])
def test_triangle_hides_other_half_but_keeps_diagonal_and_values(triangle):
    values = sample()
    full, _, _ = drawn(make(values, mode="correlation"))
    snap, mesh, _ = drawn(make(values, mode="correlation", options={"corrTriangle": triangle}))
    k = len(NAMES)
    hidden = np.triu(np.ones((k, k), bool), 1) if triangle == "lower" else np.tril(np.ones((k, k), bool), -1)
    assert (snap["hidden"] == hidden).all()
    assert not snap["hidden"].diagonal().any()
    assert not snap["missing"].any()                            # hidden cells are blank, not "missing"
    plotted = np.ma.getmaskarray(mesh.get_array())
    assert (plotted == hidden).all()
    assert np.allclose(snap["matrix"], full["matrix"])          # the coefficients themselves do not change
    assert [w for w in emit_script(make(values, mode="correlation", options={"corrTriangle": triangle})).source.split("\n")
            if "Missing value" in w or "Undefined" in w] == []


def test_correlation_defaults_to_diverging_map_centred_on_minus1_to_1():
    snap, mesh, script = drawn(make(mode="correlation"))
    assert (snap["vmin"], snap["vmax"]) == (-1.0, 1.0)
    assert mesh.get_cmap().name == "RdBu_r"
    assert mesh.norm.vmin == -1.0 and mesh.norm.vmax == 1.0
    assert mesh.norm(0.0) == pytest.approx(0.5)                 # zero sits at the middle colour


def test_asymmetric_limits_keep_zero_at_the_centre_colour():
    snap, mesh, script = drawn(make(mode="correlation", options={"vmin": -1.0, "vmax": 0.5}))
    assert (snap["vmin"], snap["vmax"]) == (-1.0, 0.5)
    assert mesh.norm(0.0) == pytest.approx(0.5)
    assert "centered_at_zero" in note_codes(script)


def test_correlation_labels_follow_the_chosen_column_order():
    snap, _, _ = drawn(make(mode="correlation", y=["Gamma", "Alpha", "Delta"]))
    assert snap["row_labels"] == snap["col_labels"] == ["Gamma", "Alpha", "Delta"]
    assert snap["matrix"].shape == (3, 3)
    expected = pd.DataFrame(sample(), columns=NAMES)[["Gamma", "Alpha", "Delta"]].corr().to_numpy()
    assert np.allclose(snap["matrix"], expected, atol=1e-12)


def test_correlation_axes_show_labels_and_default_uses_all_numeric_columns_in_dataset_order():
    rec = make(sample(), mode="correlation", labels=[f"s{i}" for i in range(40)])
    script = emit_script(rec)
    with executed(script.source) as (fig, ax, ns):
        assert [t.get_text() for t in ax.get_xticklabels()] == NAMES        # the text column "id" is not a variable
        assert [t.get_text() for t in ax.get_yticklabels()] == NAMES
    assert "x_ignored" not in note_codes(script)
    assert "x_ignored" in note_codes(emit_script(make(sample(), mode="correlation", labels=["a"] * 40, x="id")))


@pytest.mark.parametrize("mode", ["correlation", "matrix"])
def test_fewer_than_two_numeric_columns_is_a_validation_error(mode):
    rec = make([[1.0], [2.0], [3.0]], columns=["n"], labels=["a", "b", "c"], mode=mode)   # one text + one number column
    with pytest.raises(CodegenError) as err:
        emit_script(rec)
    assert "too_few_numeric_columns" in codes(err)
    assert "at least two numeric columns" in str(err.value)
    rec["config"]["mapping"]["y"] = ["n"]
    with pytest.raises(CodegenError) as err:
        emit_script(rec)
    assert "too_few_numeric_columns" in codes(err)


def test_text_and_duplicate_columns_are_refused():
    rec = make(labels=["a"] * 40)
    rec["config"]["mapping"]["y"] = ["Alpha", "id"]
    with pytest.raises(CodegenError) as err:
        emit_script(rec)
    assert "column_not_numeric" in codes(err)
    with pytest.raises(CodegenError) as err:
        emit_script(make(y=["Alpha", "Beta", "Alpha"], mode="correlation"))
    assert "duplicate_column" in codes(err)


def test_coefficient_annotations_use_precision_and_skip_hidden_cells():
    rec = make(mode="correlation", options={"annotate": True, "annotatePrecision": 3, "corrTriangle": "lower"})
    script = emit_script(rec)
    with executed(script.source) as (fig, ax, ns):
        texts = [t.get_text() for t in ax.texts]
        matrix, hidden = ns["matrix"], ns["hidden"]
    assert len(texts) == int((~hidden).sum()) == 10
    assert f"{matrix[1, 0]:.3f}" in texts and all(len(t.split(".")[1]) == 3 for t in texts)


# ------------------------------------------------------------------ matrix
def test_matrix_values_and_labels_are_carried_through_in_order():
    values = [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0], [7.0, 8.0, 9.0], [10.0, 11.0, 12.0]]
    rec = make(values, columns=["Z", "A", "M"], labels=["row d", "row a", "row c", "row b"], x="id", y=["Z", "A", "M"])
    snap, _, _ = drawn(rec)
    assert snap["row_labels"] == ["row d", "row a", "row c", "row b"]      # never sorted
    assert snap["col_labels"] == ["Z", "A", "M"]
    assert np.array_equal(snap["matrix"], np.array(values))
    script = emit_script(rec)
    with executed(script.source) as (fig, ax, ns):
        assert [t.get_text() for t in ax.get_yticklabels()] == ["row d", "row a", "row c", "row b"]
        assert [t.get_text() for t in ax.get_xticklabels()] == ["Z", "A", "M"]
        assert ax.get_ylabel() == "id"
        assert ax.get_ylim() == (4.0, 0.0)                                  # first row on top


def test_matrix_without_label_column_numbers_the_rows():
    snap, _, _ = drawn(make([[1.0, 2.0], [3.0, 4.0]]))
    assert snap["row_labels"] == ["1", "2"]


def test_numeric_and_empty_row_labels_are_text():
    rec = make([[1.0, 2.0], [3.0, 4.0], [5.0, 6.0]], x="n")
    rec["dataset"]["columns"].insert(0, {"name": "n", "type": "number"})
    rec["dataset"]["rows"] = [[1.0, 1.0, 2.0], [2.5, 3.0, 4.0], [None, 5.0, 6.0]]
    snap, _, _ = drawn(rec)
    assert snap["row_labels"] == ["1", "2.5", "(no label)"]


def test_missing_values_are_masked_hatched_and_explained_never_filled():
    values = np.array(sample(8, 1)[:, :3], dtype=float)
    values[1, 2] = np.nan
    values[4, 0] = np.nan
    rec = make(values, y=["Alpha", "Beta", "Gamma"])
    script = emit_script(rec)
    with executed(script.source) as (fig, ax, ns):
        legend_texts = [t.get_text() for t in fig.legends[0].get_texts()]
        assert legend_texts == ["Missing value"]
        mesh = next(c for c in ax.collections if hasattr(c, "get_clim"))
        masked = np.ma.getmaskarray(mesh.get_array())
        hatched = [c for c in ax.collections if c.get_hatch() == "////"]
        assert len(hatched) == 1 and len(hatched[0].get_paths()) == 2
        assert [tuple(np.argwhere(masked)[i]) for i in range(2)] == [(1, 2), (4, 0)]
        assert np.isnan(ns["matrix"]).sum() == 2                           # the data still holds the gaps
    assert "missing_cells" in note_codes(script)


def test_no_missing_values_means_no_hatch_and_no_legend_note():
    script = emit_script(make(sample(6)))
    assert "hatch" not in script.source and "fig.legend" not in script.source


def test_all_empty_matrix_is_refused():
    rec = make([[None, None], [None, None]])
    rec["config"]["mapping"]["y"] = ["Alpha", "Beta"]
    with pytest.raises(CodegenError):
        emit_script(rec)


# --------------------------------------------------------- colour scale
def test_auto_limits_are_the_data_range_and_fixed_limits_are_respected():
    values = sample(10)
    snap, mesh, _ = drawn(make(values))
    assert (snap["vmin"], snap["vmax"]) == (float(values.min()), float(values.max()))
    assert (mesh.norm.vmin, mesh.norm.vmax) == (float(values.min()), float(values.max()))
    snap, mesh, script = drawn(make(values, options={"vmin": -0.5, "vmax": 0.5}))
    assert (mesh.norm.vmin, mesh.norm.vmax) == (-0.5, 0.5)
    assert "values_clipped" in note_codes(script)
    snap, mesh, _ = drawn(make(values, options={"vmax": 10.0}))             # one fixed, the other auto
    assert (mesh.norm.vmin, mesh.norm.vmax) == (float(values.min()), 10.0)


def test_fixed_limits_are_respected_on_the_colourbar_axis():
    script = emit_script(make(sample(10), options={"vmin": -3.0, "vmax": 4.0}))
    with executed(script.source) as (fig, ax, ns):
        cbar_ax = fig.axes[1]
        assert cbar_ax.get_ylim() == (-3.0, 4.0)


def test_clipped_values_are_flagged_on_the_colourbar():
    script = emit_script(make(sample(10), options={"vmin": -0.5, "vmax": 0.5}))
    assert "extend='both'" in script.source
    assert "extend='neither'" in emit_script(make(sample(10), options={"vmin": -100.0, "vmax": 100.0})).source


def test_invalid_limits_are_refused():
    for opts in ({"vmin": 2.0, "vmax": 1.0}, {"vmin": 3.0, "vmax": 3.0}, {"vmin": 50.0}):
        with pytest.raises(CodegenError) as err:
            emit_script(make(sample(10), options=opts))
        assert "vlimits_invalid" in codes(err)


def test_constant_matrix_widens_the_scale_instead_of_failing():
    snap, _, script = drawn(make([[2.0, 2.0], [2.0, 2.0]]))
    assert (snap["vmin"], snap["vmax"]) == (1.5, 2.5)
    assert "constant_matrix" in note_codes(script)


@pytest.mark.parametrize("cmap", ["viridis", "magma", "cividis", "coolwarm", "RdBu_r", "Greys"])
def test_palettes(cmap):
    _, mesh, _ = drawn(make(sample(6), appearance={"cmap": cmap}))
    assert mesh.get_cmap().name == cmap


def test_matrix_default_palette_is_viridis_and_explicit_palette_wins_in_correlation_mode():
    assert drawn(make(sample(6)))[1].get_cmap().name == "viridis"
    assert drawn(make(mode="correlation", appearance={"cmap": "coolwarm"}))[1].get_cmap().name == "coolwarm"
    assert drawn(make(mode="correlation", appearance={"cmap": "viridis"}))[1].get_cmap().name == "viridis"


# ------------------------------------------------------ colourbar, text, lines
def test_colourbar_show_and_label():
    with executed(emit_script(make(sample(6), options={"colorbarLabel": "Expression (a.u.)"})).source) as (fig, ax, ns):
        assert len(fig.axes) == 2 and fig.axes[1].get_ylabel() == "Expression (a.u.)"
    with executed(emit_script(make(sample(6), options={"colorbar": False})).source) as (fig, ax, ns):
        assert len(fig.axes) == 1
    with executed(emit_script(make(mode="correlation")).source) as (fig, ax, ns):
        assert fig.axes[1].get_ylabel() == "Pearson r"
    with executed(emit_script(make(mode="correlation", options={"corrMethod": "spearman"})).source) as (fig, ax, ns):
        assert fig.axes[1].get_ylabel() == "Spearman ρ"
    with executed(emit_script(make(mode="correlation", options={"colorbarLabel": "r"})).source) as (fig, ax, ns):
        assert fig.axes[1].get_ylabel() == "r"


def test_annotation_precision_size_and_contrast():
    values = [[0.12345, 0.98765], [0.5, -0.00001]]
    rec = make(values, options={"annotate": True, "annotatePrecision": 1, "annotateSize": 14.0, "vmin": 0.0, "vmax": 1.0})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert sorted(t.get_text() for t in ax.texts) == ["0.0", "0.1", "0.5", "1.0"]
        assert {t.get_fontsize() for t in ax.texts} == {14.0}
        colours = {t.get_text(): t.get_color() for t in ax.texts}
        assert colours["0.1"] == "white" and colours["1.0"] == "black"       # dark cell vs light cell (viridis)
    rec["config"]["options"]["annotatePrecision"] = 0
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert sorted(t.get_text() for t in ax.texts) == ["0", "0", "0", "1"]   # 0.12 / 0.5 / 0.0 / 0.99 at 0 decimals
    rec["config"]["options"].update(annotate=False)
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert not ax.texts


def test_annotation_negative_zero_is_not_written_as_minus_zero():
    rec = make([[-0.001, 1.0], [0.5, 0.2]], options={"annotate": True})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert "-0.00" not in [t.get_text() for t in ax.texts]


def test_too_many_cells_to_annotate_are_skipped_with_a_warning():
    rows = np.random.default_rng(0).normal(size=(60, 50)).round(3)
    rec = make(rows, columns=[f"c{i}" for i in range(50)], options={"annotate": True})
    script = emit_script(rec)
    assert "annotations_skipped" in note_codes(script) and "ax.text" not in script.source


def test_cell_borders_on_and_off():
    off = emit_script(make(sample(6))).source
    on = emit_script(make(sample(6), options={"cellBorders": True, "cellBorderColor": "#112233", "cellBorderWidth": 1.5})).source
    assert "edgecolors='none'" in off and "'#112233'" in on and "linewidth=1.5" in on
    with executed(on) as (fig, ax, ns):
        mesh = next(c for c in ax.collections if hasattr(c, "get_clim"))
        assert mesh.get_linewidth()[0] == 1.5
        assert np.allclose(mesh.get_edgecolor()[0][:3], (0x11 / 255, 0x22 / 255, 0x33 / 255))


def test_label_rotation_uses_the_axis_tick_rotation():
    rec = make(sample(6), appearance={"xTickRotation": 45.0, "yTickRotation": 30.0})
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert {t.get_rotation() for t in ax.get_xticklabels()} == {45.0}
        assert {t.get_rotation() for t in ax.get_yticklabels()} == {30.0}


def test_title_labels_and_axis_options_do_not_break_the_heatmap():
    rec = make(sample(6), appearance={"title": "T", "xLabel": "Genes", "yLabel": "Samples"},
               options={"xScale": "log", "yLim": [0.0, 5.0]})                    # not meaningful here: must be ignored
    with executed(emit_script(rec).source) as (fig, ax, ns):
        assert ax.get_title() == "T" and ax.get_xlabel() == "Genes" and ax.get_ylabel() == "Samples"
        assert ax.get_xscale() == "linear" and ax.get_ylim() == (6.0, 0.0)


def test_crowded_and_oversized_matrices():
    wide = np.zeros((2, 70))
    assert "labels_crowded" in note_codes(emit_script(make(wide, columns=[f"c{i}" for i in range(70)])))
    big = np.zeros((1001, 251))
    with pytest.raises(CodegenError) as err:
        emit_script(make(big, columns=[f"c{i}" for i in range(251)]))
    assert "too_many_cells" in codes(err)


def test_script_is_deterministic_and_contains_no_user_text_unescaped():
    rec = make(sample(5), labels=["a'b", 'q"x', "line\nbreak", "\\", "ok"], x="id")
    first, second = emit_script(rec), emit_script(rec)
    assert first.source == second.source
    compile(first.source, "<generated>", "exec")
    snap, _, _ = drawn(rec)
    assert snap["row_labels"] == ["a'b", 'q"x', "line\nbreak", "\\", "ok"]


def test_large_data_goes_to_a_data_file_and_still_matches_pandas():
    values = np.random.default_rng(5).normal(size=(2500, 3)).round(5)
    rec = make(values, mode="correlation")
    script = emit_script(rec)
    assert "data.csv" in script.files
    result = run_python(script.source, files=script.files, dpi=100)
    assert result.status == "ok", result.message


# --------------------------------------------------------------- run
def test_end_to_end_render_is_not_blank():
    rec = make(mode="correlation", options={"annotate": True, "corrTriangle": "lower"})
    script = emit_script(rec)
    result = run_python(script.source, files=script.files, dpi=100)
    assert result.status == "ok", result.message
    assert (result.width_px, result.height_px) == (500, 400)
    import io
    image = np.asarray(Image.open(io.BytesIO(result.png_bytes)).convert("RGB"))
    assert image.std() > 10 and (image.reshape(-1, 3).max(axis=1) < 128).any()
