"""FigureRecord models, defaults, v1->v2 migration and size limits (docs/FIGURES_CONTRACT.md s3, s5)."""
import copy
import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError

from backend.exporter import export_presentation
from backend.figures import models as fm
from backend.figures.models import (
    KINDS,
    PLOT_TYPES,
    CompositePanel,
    Dataset,
    ExportSettings,
    FigureRecord,
    RenderState,
    default_config,
    default_record,
)
from backend.models import PresentationDoc, migrate_v1_to_v2, upgrade_document
from backend.sample_deck import create_representative_deck
from backend.server import app

ROOT = Path(__file__).resolve().parent.parent
PNG_1X1 = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def _v1_doc_dict():
    """A genuine v1 project file (schemaVersion 1, plot/figure objects without figureId)."""
    data = json.loads((ROOT / "representative_sample_deck.rpe.json").read_text(encoding="utf-8"))
    doc = data.get("doc", data)
    assert doc["schemaVersion"] == 1
    doc["slides"][0]["objects"] += [
        {"id": "legacy_plot", "type": "plot", "engine": "python", "kind": "line", "x": 10, "y": 10,
         "w": 300, "h": 200, "src": PNG_1X1},
        {"id": "legacy_fig", "type": "figure", "layout": "2x2", "labels": "A", "panels": [],
         "x": 0, "y": 0, "w": 400, "h": 300, "src": PNG_1X1},
    ]
    return doc


def _table_record():
    rec = default_record("structured", "scatter", id="fig_t")
    rec.dataset = Dataset(
        columns=[{"name": "dose", "type": "number"}, {"name": "group", "type": "text"}],
        rows=[[1, "a"], [2.5, "b"], [None, None]],
        origin={"type": "csv", "label": "t.csv", "fileName": "t.csv"},
    )
    rec.config.mapping.x = "dose"
    rec.originalCsv = "dose,group\n1,a\n2.5,b\n,\n"
    return rec


# ------------------------------------------------------------- defaults
@pytest.mark.parametrize("kind", KINDS)
@pytest.mark.parametrize("plot_type", PLOT_TYPES)
def test_default_record_is_valid_and_empty(kind, plot_type):
    rec = default_record(kind, plot_type)
    assert rec.kind == kind
    assert rec.config.plotType == plot_type
    assert rec.dataset.columns == [] and rec.dataset.rows == []
    assert rec.render.status == "none" and rec.render.preview is None
    # survives a JSON round trip unchanged
    again = FigureRecord.model_validate_json(rec.model_dump_json())
    assert again == rec


def test_default_record_details():
    assert default_record("python").sourceMode == "custom"
    assert default_record("structured").sourceMode == "structured"
    latex = default_record("latex")
    assert latex.latex is not None and latex.latex.engine == "pdflatex"
    comp = default_record("composite")
    assert comp.composite.layout == "2x2" and [p.slot for p in comp.composite.panels] == [0, 1, 2, 3]
    assert default_record("structured", "bar").id != default_record("structured", "bar").id
    assert default_record("structured", id="my_fig", name="X").name == "X"
    exp = default_record().export
    assert (exp.dpi, exp.format, exp.background) == (450, "png", "white")


def test_default_config_per_plot_type():
    assert default_config("bar").options.errorBars is True
    assert default_config("hist").options.bins == 20
    assert default_config("heatmap").appearance.grid is False
    assert default_config("scatter").appearance.markerSize == 6.0
    with pytest.raises(ValueError):
        default_config("pie")


def test_default_record_rejects_unknown_kind_and_plot_type():
    with pytest.raises(ValueError):
        default_record("pdf")
    with pytest.raises(ValueError):
        default_record("structured", "violin")


# --------------------------------------------------- valid / invalid records
def test_valid_record_with_data():
    rec = _table_record()
    assert FigureRecord.model_validate(rec.model_dump(mode="json")) == rec


def test_minimal_record_only_needs_id():
    rec = FigureRecord(id="abc")
    assert rec.kind == "structured" and rec.config.plotType == "line"


@pytest.mark.parametrize("bad_id", ["", "has space", "a/b", "x" * 65, "é"])
def test_invalid_id_rejected(bad_id):
    with pytest.raises(ValidationError):
        FigureRecord(id=bad_id)


def test_unknown_fields_rejected():
    with pytest.raises(ValidationError):
        FigureRecord(id="a", surprise=1)
    with pytest.raises(ValidationError):
        FigureRecord.model_validate({"id": "a", "config": {"plotType": "line", "mapping": {"z": "q"}}})
    with pytest.raises(ValidationError):
        FigureRecord.model_validate({"id": "a", "export": {"dpi": 300, "quality": 9}})


def test_render_diagnostics_and_runtime_are_free_form():
    rs = RenderState(status="error", error="boom", diagnostics=[{"line": 3, "msg": "x"}, "text"],
                     runtime={"python": "3.12", "matplotlib": "3.10"})
    assert rs.diagnostics[0]["line"] == 3
    with pytest.raises(ValidationError):
        RenderState(extra_key=1)


# ------------------------------------------------------------ enum rejection
@pytest.mark.parametrize(
    "path,value",
    [
        (("kind",), "svg"),
        (("sourceMode",), "auto"),
        (("config", "plotType"), "pie"),
        (("config", "options", "xScale"), "sqrt"),
        (("config", "appearance", "fontFamily"), "comic"),
        (("config", "appearance", "legend", "pos"), "nowhere"),
        (("dataset", "origin", "type"), "cloud"),
        (("export", "format"), "jpg"),
        (("export", "background"), "black"),
        (("render", "status"), "pending"),
    ],
)
def test_enum_rejection(path, value):
    data = default_record("structured", "line", id="e").model_dump(mode="json")
    node = data
    for key in path[:-1]:
        node = node[key]
    node[path[-1]] = value
    with pytest.raises(ValidationError):
        FigureRecord.model_validate(data)


def test_latex_and_composite_enum_rejection():
    with pytest.raises(ValidationError):
        fm.LatexSettings(engine="tex")
    with pytest.raises(ValidationError):
        fm.LatexSettings(mode="page")
    with pytest.raises(ValidationError):
        fm.CompositeSettings(labels="roman")
    with pytest.raises(ValidationError):
        fm.CompositeSettings(spacing="huge")
    with pytest.raises(ValidationError):
        fm.CompositeSettings(legend="top")
    with pytest.raises(ValidationError):
        fm.LabelStyle(weight="heavy")
    with pytest.raises(ValidationError):
        fm.LabelStyle(placement="middle")


def test_kind_blocks_must_match_kind():
    with pytest.raises(ValidationError):
        FigureRecord(id="a", kind="composite")                       # composite settings missing
    with pytest.raises(ValidationError):
        FigureRecord(id="a", kind="latex")                           # latex settings missing
    with pytest.raises(ValidationError):
        FigureRecord(id="a", kind="structured", latex=fm.LatexSettings())
    with pytest.raises(ValidationError):
        FigureRecord(id="a", kind="python", composite=fm.CompositeSettings())


# ---------------------------------------------------------------- dataset
def test_dataset_validation():
    ok = Dataset(columns=[{"name": "a"}, {"name": "b", "type": "text"}], rows=[[1, "x"], [None, None]])
    assert len(ok.rows) == 2
    with pytest.raises(ValidationError):   # duplicate names
        Dataset(columns=[{"name": "a"}, {"name": "a"}])
    with pytest.raises(ValidationError):   # empty name
        Dataset(columns=[{"name": ""}])
    with pytest.raises(ValidationError):   # ragged row
        Dataset(columns=[{"name": "a"}, {"name": "b"}], rows=[[1]])
    with pytest.raises(ValidationError):   # text in number column
        Dataset(columns=[{"name": "a"}], rows=[["oops"]])
    with pytest.raises(ValidationError):   # number in text column
        Dataset(columns=[{"name": "a", "type": "text"}], rows=[[3]])
    with pytest.raises(ValidationError):   # bool is not a number
        Dataset(columns=[{"name": "a"}], rows=[[True]])
    with pytest.raises(ValidationError):   # non-finite
        Dataset(columns=[{"name": "a"}], rows=[[float("nan")]])
    with pytest.raises(ValidationError):
        Dataset(columns=[{"name": "a"}], rows=[[float("inf")]])


def test_axis_limits_validation():
    assert default_config().options.model_copy(update={"xLim": [0, 1]}).xLim == [0, 1]
    with pytest.raises(ValidationError):
        fm.Options(xLim=[1, 0])
    with pytest.raises(ValidationError):
        fm.Options(yLim=[0, 1, 2])
    with pytest.raises(ValidationError):
        fm.Appearance(colors=["red"])
    assert fm.Appearance(colors=["#AABBCC"]).colors == ["#AABBCC"]


# --------------------------------------------------------------- composite
def test_composite_layout_and_panels():
    inner = default_record("structured", "bar", id="inner")
    comp = fm.CompositeSettings(layout="1x2", panels=[CompositePanel(slot=0, record=inner), CompositePanel(slot=1)])
    rec = FigureRecord(id="c", kind="composite", composite=comp)
    assert FigureRecord.model_validate(rec.model_dump(mode="json")) == rec
    with pytest.raises(ValidationError):
        fm.CompositeSettings(layout="7x1")
    with pytest.raises(ValidationError):
        fm.CompositeSettings(layout="two by two")
    with pytest.raises(ValidationError):   # slot outside layout
        fm.CompositeSettings(layout="1x2", panels=[CompositePanel(slot=2)])
    with pytest.raises(ValidationError):   # duplicate slot
        fm.CompositeSettings(layout="2x2", panels=[CompositePanel(slot=1), CompositePanel(slot=1)])
    with pytest.raises(ValidationError):   # no nested composites
        CompositePanel(slot=0, record=default_record("composite"))


# ------------------------------------------------------------- size limits
@pytest.mark.parametrize(
    "kwargs",
    [
        {"dpi": 71}, {"dpi": 1201}, {"wIn": 0.49}, {"hIn": 0.49}, {"wIn": 30.1}, {"hIn": 31},
    ],
)
def test_export_range_limits(kwargs):
    with pytest.raises(ValidationError):
        ExportSettings(**kwargs)


def test_export_pixel_limits():
    assert ExportSettings(wIn=30, hIn=0.5, dpi=540).wIn == 30            # 16200 px side: allowed
    with pytest.raises(ValidationError):
        ExportSettings(wIn=30, hIn=1, dpi=600)                           # 18000 px side
    with pytest.raises(ValidationError):
        ExportSettings(wIn=14, hIn=10, dpi=1000)                         # 140 MP, sides fine
    assert ExportSettings(wIn=10, hIn=10, dpi=1000).dpi == 1000          # 100 MP: allowed
    assert ExportSettings(wIn=0.5, hIn=0.5, dpi=72).dpi == 72


def test_record_size_limits(monkeypatch):
    monkeypatch.setattr(fm, "MAX_ROWS", 3)
    monkeypatch.setattr(fm, "MAX_COLUMNS", 2)
    monkeypatch.setattr(fm, "MAX_CELLS", 5)
    monkeypatch.setattr(fm, "MAX_SOURCE_CHARS", 10)
    monkeypatch.setattr(fm, "MAX_CSV_CHARS", 10)
    monkeypatch.setattr(fm, "MAX_PREVIEW_CHARS", 30)
    Dataset(columns=[{"name": "a"}, {"name": "b"}], rows=[[1, 2], [3, 4]])   # 4 cells, 2 rows: fine
    with pytest.raises(ValidationError):
        Dataset(columns=[{"name": "a"}], rows=[[1]] * 4)                     # too many rows
    with pytest.raises(ValidationError):
        Dataset(columns=[{"name": "a"}, {"name": "b"}, {"name": "c"}])       # too many columns
    with pytest.raises(ValidationError):
        Dataset(columns=[{"name": "a"}, {"name": "b"}], rows=[[1, 2]] * 3)   # 6 cells > 5
    assert FigureRecord(id="a", source="x" * 10).source == "x" * 10
    with pytest.raises(ValidationError):
        FigureRecord(id="a", source="x" * 11)
    with pytest.raises(ValidationError):
        FigureRecord(id="a", originalCsv="x" * 11)
    with pytest.raises(ValidationError):
        RenderState(preview="data:image/png;base64," + "A" * 20)             # > 30 chars
    assert RenderState(preview="data:image/png;base64,AAAA").preview is not None


def test_preview_must_be_image_data_url():
    with pytest.raises(ValidationError):
        RenderState(preview="http://example.com/x.png")
    with pytest.raises(ValidationError):
        RenderState(preview="data:text/html;base64,AAAA")


def test_document_figure_limit(monkeypatch):
    monkeypatch.setattr("backend.models.MAX_FIGURES_PER_DOC", 1)
    a, b = default_record(id="a"), default_record(id="b")
    PresentationDoc(figures={"a": a})
    with pytest.raises(ValidationError):
        PresentationDoc(figures={"a": a, "b": b})


# ------------------------------------------------------- document / migration
def test_new_document_is_v2_with_no_figures():
    doc = PresentationDoc()
    assert doc.schemaVersion == 2 and doc.figures == {}


def test_figures_key_must_match_record_id():
    with pytest.raises(ValidationError):
        PresentationDoc(figures={"other": default_record(id="fig_1")})


def test_invalid_schema_version_rejected():
    with pytest.raises(ValidationError):
        PresentationDoc(schemaVersion=0)


def test_v1_doc_round_trip_unchanged():
    v1 = _v1_doc_dict()
    original = copy.deepcopy(v1)
    v2 = migrate_v1_to_v2(v1)
    assert v1 == original, "migration must not mutate its input"
    assert v2["schemaVersion"] == 2 and v2["figures"] == {}
    assert v2["slides"] == original["slides"], "slides/objects carried over unchanged"
    objs = {o["id"]: o for s in v2["slides"] for o in s["objects"]}
    assert "figureId" not in objs["legacy_plot"] and "figureId" not in objs["legacy_fig"]
    # validate -> dump -> validate keeps legacy objects and extra fields
    doc = PresentationDoc.model_validate(v2)
    dumped = doc.model_dump(mode="json")
    again = PresentationDoc.model_validate(dumped)
    assert again == doc
    plot = next(o for s in again.slides for o in s.objects if o.id == "legacy_plot")
    assert plot.model_extra["engine"] == "python" and plot.src == PNG_1X1
    assert not any("figureId" in (o.model_extra or {}) for s in again.slides for o in s.objects)


def test_v1_model_upgrade_matches_dict_migration():
    deck = create_representative_deck()              # explicitly schemaVersion=1
    assert deck.schemaVersion == 1
    up = upgrade_document(deck)
    assert up.schemaVersion == 2 and up.figures == {}
    assert deck.schemaVersion == 1, "input model is not mutated"
    assert up.slides == deck.slides
    via_dict = PresentationDoc.model_validate(migrate_v1_to_v2(deck.model_dump(mode="json")))
    assert via_dict == up


def test_v2_round_trip_with_figures():
    deck = create_representative_deck()
    deck = upgrade_document(deck)
    a, b = _table_record(), default_record("composite", id="fig_c")
    deck.figures = {a.id: a, b.id: b}
    deck.slides[0].objects[0].figureId = a.id          # extra field on a slide object
    data = json.loads(deck.model_dump_json())
    assert data["schemaVersion"] == 2 and set(data["figures"]) == {"fig_t", "fig_c"}
    again = PresentationDoc.model_validate(data)
    assert again == deck
    assert again.figures["fig_t"].dataset.rows[1] == [2.5, "b"]
    assert again.slides[0].objects[0].figureId == "fig_t"
    # migration of a v2 dict is a no-op copy
    assert migrate_v1_to_v2(data) == data
    assert migrate_v1_to_v2(data) is not data


def test_migrate_edge_cases():
    assert migrate_v1_to_v2({"slides": []})["schemaVersion"] == 2           # missing version == v1
    assert migrate_v1_to_v2({"schemaVersion": None})["figures"] == {}
    with pytest.raises(ValueError):
        migrate_v1_to_v2({"schemaVersion": 3})
    with pytest.raises(ValueError):
        migrate_v1_to_v2({"schemaVersion": "2"})
    with pytest.raises(ValueError):
        migrate_v1_to_v2({"schemaVersion": True})
    with pytest.raises(ValueError):
        migrate_v1_to_v2({"figures": []})
    with pytest.raises(ValueError):
        migrate_v1_to_v2([])
    with pytest.raises(ValueError):
        upgrade_document(PresentationDoc(schemaVersion=3))


def test_exporter_accepts_v1_and_v2_dicts():
    v1 = _v1_doc_dict()
    assert export_presentation(v1).getbuffer().nbytes > 1000
    v2 = migrate_v1_to_v2(v1)
    v2["figures"] = {"fig_x": default_record(id="fig_x").model_dump(mode="json")}
    assert export_presentation(v2).getbuffer().nbytes > 1000


# --------------------------------------------------------------- server
def test_server_save_and_export_handle_v1_and_v2():
    client = TestClient(app)
    v1 = _v1_doc_dict()
    assert client.post("/api/presentation/save", json={"doc": v1}).status_code == 200
    r = client.post("/api/presentation/export", json={"format": "pptx", "doc": v1})
    assert r.status_code == 200 and r.content[:2] == b"PK"

    v2 = migrate_v1_to_v2(v1)
    v2["figures"] = {"fig_s": _table_record().model_copy(update={"id": "fig_s"}).model_dump(mode="json")}
    assert client.post("/api/presentation/save", json={"doc": v2}).status_code == 200
    assert client.post("/api/presentation/export", json={"format": "pptx", "doc": v2}).status_code == 200


def test_server_rejects_newer_or_bad_documents():
    client = TestClient(app)
    newer = _v1_doc_dict()
    newer["schemaVersion"] = 3
    assert client.post("/api/presentation/save", json={"doc": newer}).status_code == 400
    assert client.post("/api/presentation/export", json={"format": "pptx", "doc": newer}).status_code == 400
    bad = migrate_v1_to_v2(_v1_doc_dict())
    bad["figures"] = {"fig_z": {"id": "fig_z", "kind": "svg"}}              # enum violation
    assert client.post("/api/presentation/save", json={"doc": bad}).status_code == 422
