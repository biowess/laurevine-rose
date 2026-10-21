"""Sample data, the data-only Python run and column notes (docs/FIGURES_CONTRACT.md s3d, s4)."""
import copy

import numpy as np
import pytest
from fastapi.testclient import TestClient

from backend.figures import runner, samples
from backend.figures.codegen import emit_script
from backend.figures.dataset import column_notes, correlation_ready_columns, validate_dataset
from backend.figures.models import Dataset, DatasetOrigin, FigureRecord, default_record
from backend.server import app

client = TestClient(app)
TYPES = list(samples.PLOT_TYPES)


def _record(plot_type):
    s = samples.sample_for(plot_type)
    rec = default_record("structured", plot_type).model_dump()
    rec["dataset"] = copy.deepcopy(s["dataset"])
    rec["config"]["mapping"] = copy.deepcopy(s["mapping"])
    rec["config"]["options"].update(copy.deepcopy(s["options"]))
    return s, rec


# ----------------------------------------------------------------- samples
@pytest.mark.parametrize("plot_type", TYPES)
def test_sample_is_deterministic_valid_and_drawable(plot_type):
    s = samples.sample_for(plot_type)
    assert s == samples.sample_for(plot_type)
    assert s["plotType"] == plot_type and s["dataset"]["origin"] == {"type": "sample", "label": s["label"], "sampleId": s["sampleId"]}
    Dataset(**s["dataset"])
    assert not [i for i in validate_dataset(s["dataset"], plot_type, s["mapping"]) if i["level"] == "error"]
    s, rec = _record(plot_type)
    FigureRecord(**rec)                                  # mapping and options are accepted by the strict model
    script = emit_script(rec)
    res = runner.run_python(script.source, files=script.files, dpi=72)
    assert res.ok, res.message


def test_line_sample_has_three_series_with_sd_errors():
    s = samples.sample_for("line")
    names = [c["name"] for c in s["dataset"]["columns"]]
    assert len(s["mapping"]["y"]) == 3
    for y in s["mapping"]["y"]:
        assert s["options"]["series"][y] == {"error": "symmetric", "errorCol": y + " SD"} and y + " SD" in names
    assert min(r[0] for r in s["dataset"]["rows"]) > 0, "dose axis is log-safe"


def test_scatter_sample_has_two_groups_and_a_trend():
    s = samples.sample_for("scatter")
    groups = {r[2] for r in s["dataset"]["rows"]}
    assert groups == {"Wild type", "Knockout"} and s["mapping"]["group"] == "Genotype" and s["options"]["fit"] == "linear"
    for g in groups:
        x, y = zip(*[(r[0], r[1]) for r in s["dataset"]["rows"] if r[2] == g])
        assert np.corrcoef(x, y)[0, 1] > 0.6


def test_bar_sample_is_grouped_with_sem_columns():
    s = samples.sample_for("bar")
    names = [c["name"] for c in s["dataset"]["columns"]]
    assert s["options"]["barMode"] == "grouped" and s["options"]["errorBars"] is True
    assert all(y + " SEM" in names and s["options"]["series"][y]["errorCol"] == y + " SEM" for y in s["mapping"]["y"])
    assert len({r[0] for r in s["dataset"]["rows"]}) == len(s["dataset"]["rows"]), "one row per category"


def test_hist_sample_is_bimodal():
    vals = np.array([r[0] for r in samples.sample_for("hist")["dataset"]["rows"]])
    counts, edges = np.histogram(vals, bins=12)
    peaks = [i for i in range(1, 11) if counts[i] > counts[i - 1] and counts[i] >= counts[i + 1] and counts[i] > 12]
    assert len(vals) >= 200 and len(peaks) >= 2 and (vals < -0.5).sum() > 50 and (vals > 1.0).sum() > 50


def test_box_sample_has_four_conditions_with_outliers():
    rows = samples.sample_for("box")["dataset"]["rows"]
    conds = list(dict.fromkeys(r[0] for r in rows))
    assert len(conds) == 4
    for c in conds:
        v = np.array([r[1] for r in rows if r[0] == c])
        q1, q3 = np.percentile(v, [25, 75])
        assert len(v) == 25 and ((v > q3 + 1.5 * (q3 - q1)) | (v < q1 - 1.5 * (q3 - q1))).any()


def test_heatmap_sample_is_a_matrix_that_also_supports_correlation():
    s = samples.sample_for("heatmap")
    assert s["dataset"]["columns"][0]["type"] == "text" and len(correlation_ready_columns(s["dataset"])) >= 4
    s2, rec = _record("heatmap")
    rec["config"]["options"]["heatmapMode"] = "correlation"
    assert emit_script(rec).source


def test_samples_endpoint():
    r = client.get("/api/figures/samples/box")
    assert r.status_code == 200 and r.json() == samples.sample_for("box")
    assert client.get("/api/figures/samples/pie").status_code == 404


def test_origin_may_carry_a_data_script():
    assert DatasetOrigin(type="python", label="Python script", code="data = {'x': [1]}").code.startswith("data")
    with pytest.raises(ValueError):
        DatasetOrigin(type="python", bogus=1)


# ----------------------------------------------------------------- data-only Python run
def test_run_python_data_converts_dict_numpy_and_missing_values():
    res = runner.run_python_data('import numpy as np\ndata = {"x": np.arange(3), "y": [1.5, float("nan"), None], "g": ["a", "b", None]}')
    assert res.ok and res.png_bytes is None
    assert res.data["columns"] == [{"name": "x", "type": "number"}, {"name": "y", "type": "number"}, {"name": "g", "type": "text"}]
    assert res.data["rows"] == [[0, 1.5, "a"], [1, None, "b"], [2, None, None]]
    Dataset(**res.data)


def test_run_python_data_accepts_a_dataframe():
    res = runner.run_python_data('import pandas as pd\ndata = pd.DataFrame({"a": [1, 2], "b": ["u", "v"]})')
    assert res.ok and [c["type"] for c in res.data["columns"]] == ["number", "text"]


@pytest.mark.parametrize("source,needle", [
    ("x = 1", "variable named `data`"),
    ("data = [1, 2]", "dict of named lists"),
    ('data = {"a": [1, 2], "b": [1]}', "same length"),
    ('data = {"a": 5}', "must be a list"),
    ("data = {}", "dict of named lists"),
    ('data = {"a": [1]}\n1 / 0', "ZeroDivisionError"),
    ("import sys\nsys.exit(3)", "sys.exit"),
])
def test_run_python_data_reports_problems(source, needle):
    res = runner.run_python_data(source)
    assert not res.ok and res.status == "error" and needle in res.message


def test_run_python_data_has_a_timeout():
    res = runner.run_python_data("import time\ntime.sleep(30)\ndata = {'a': [1]}", timeout=1)
    assert res.status == "timeout" and not res.ok


def test_run_python_data_missing_module():
    res = runner.run_python_data("import definitely_not_installed_xyz\ndata = {'a': [1]}")
    assert res.status == "missing_dependency" and res.missing_module == "definitely_not_installed_xyz"


@pytest.mark.parametrize("source,expected", [
    ('data = {"x": [1, 2], "y": [3, 4]}', True),
    ('"""notes"""\n# comment\ndata = {"x": [1, 2]}', True),
    ("data = {'x': [1, 2]}\nprint(1)", False),
    ('data = {"x": list(range(3))}', False),
    ("data = [1, 2]", False),
    ("other = {'x': [1]}", False),
    ("data = {", False),
])
def test_is_literal_assignment(source, expected):
    assert runner.is_literal_assignment(source) is expected


def test_python_data_endpoint_literal_and_controlled():
    r = client.post("/api/figures/python/data", json={"source": 'data = {"x": [1, 2, 3], "y": [2, 4, 8]}'})
    b = r.json()
    assert r.status_code == 200 and b["ok"] and b["literal"] is True and b["rows"] == [[1, 2], [2, 4], [3, 8]]
    assert [c["name"] for c in b["columns"]] == ["x", "y"]
    b = client.post("/api/figures/python/data", json={"source": 'import numpy as np\ndata = {"x": np.linspace(0, 1, 3)}'}).json()
    assert b["ok"] and b["literal"] is False and len(b["rows"]) == 3


def test_python_data_endpoint_errors_are_200_with_message_and_line():
    r = client.post("/api/figures/python/data", json={"source": "a = 1\ndata = 1 / 0"})
    b = r.json()
    assert r.status_code == 200 and not b["ok"] and "ZeroDivisionError" in b["message"] and b["traceback"]["line"] == 2
    assert b["columns"] == [] and b["rows"] == []


def test_python_data_endpoint_rejects_malformed_requests():
    assert client.post("/api/figures/python/data", json={"nope": 1}).status_code == 400
    assert client.post("/api/figures/python/data", content=b"{", headers={"Content-Type": "application/json"}).status_code == 400
    assert client.post("/api/figures/python/data", content=b"x", headers={"Content-Type": "text/plain"}).status_code == 415


# ----------------------------------------------------------------- column notes in /dataset/parse
def test_column_notes_use_validate_dataset_messages():
    cols = [{"name": "t", "type": "number"}, {"name": "g", "type": "text"}, {"name": "e", "type": "number"}]
    rows = [[1, "a", None], [2, "b", None]]
    notes = column_notes(cols, rows, "line")
    assert "t" not in notes and "text" in notes["g"]["y"] and "text" in notes["g"]["x"]
    assert "no values" in notes["e"]["y"]
    assert "group" not in notes.get("g", {}), "text columns can group"
    assert column_notes(cols, rows, "nope") == {}
    assert "x" not in column_notes(cols, rows, "hist").get("g", {}), "roles a plot does not use are not reported"


def test_parse_endpoint_returns_column_notes_only_when_asked():
    text = "t,label\n1,a\n2,b\n"
    plain = client.post("/api/figures/dataset/parse", json={"text": text}).json()
    assert "columnNotes" not in plain
    b = client.post("/api/figures/dataset/parse", json={"text": text, "plotType": "scatter"}).json()
    assert b["ok"] and "text" in b["columnNotes"]["label"]["y"] and "t" not in b["columnNotes"]
    assert "columnNotes" not in client.post("/api/figures/dataset/parse", json={"text": text, "plotType": "pie"}).json()
