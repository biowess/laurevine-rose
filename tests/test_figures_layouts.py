"""GET /api/figures/layouts (docs/FIGURES_CONTRACT.md s4t): the one layout table the composite codegen and the composer share."""
import matplotlib

matplotlib.use("Agg")
import pytest
from fastapi.testclient import TestClient

from backend.figures.codegen.composite import LAYOUTS, LAYOUT_LABELS
from backend.figures.models import COMPOSITE_LAYOUTS
from backend.server import app
from tests.test_figures_composite import composite, execute, plot

client = TestClient(app)
LABELS = ["2 × 2", "1 × 2", "2 × 1", "1 × 3", "1 + 2 (large left)", "2 × 3"]


def table():
    r = client.get("/api/figures/layouts")
    assert r.status_code == 200
    return {item["id"]: item for item in r.json()["layouts"]}


def test_endpoint_lists_every_named_layout_with_labels():
    t = table()
    assert list(t) == ["2x2", "1x2", "2x1", "1x3", "1+2", "2x3"]
    assert [t[k]["label"] for k in t] == LABELS
    assert LAYOUT_LABELS.keys() == LAYOUTS.keys() == COMPOSITE_LAYOUTS.keys()


@pytest.mark.parametrize("layout", list(LAYOUTS))
def test_slots_match_codegen_cells_and_model_slot_counts(layout):
    item = table()[layout]
    rows, cols, cells = LAYOUTS[layout]
    assert (item["rows"], item["cols"]) == (rows, cols)
    assert len(item["slots"]) == len(cells) == COMPOSITE_LAYOUTS[layout]
    assert [s["slot"] for s in item["slots"]] == list(range(len(cells)))
    assert [tuple(s["cell"]) for s in item["slots"]] == cells


@pytest.mark.parametrize("layout", list(LAYOUTS))
def test_slot_rects_tile_the_figure_without_overlap(layout):
    slots = table()[layout]["slots"]
    assert sum(s["w"] * s["h"] for s in slots) == pytest.approx(1.0)
    for s in slots:
        assert 0 <= s["x"] and 0 <= s["y"] and s["x"] + s["w"] <= 1 + 1e-9 and s["y"] + s["h"] <= 1 + 1e-9
    for i, a in enumerate(slots):
        for b in slots[i + 1:]:
            assert not (a["x"] < b["x"] + b["w"] - 1e-9 and b["x"] < a["x"] + a["w"] - 1e-9
                        and a["y"] < b["y"] + b["h"] - 1e-9 and b["y"] < a["y"] + a["h"] - 1e-9)


@pytest.mark.parametrize("layout", list(LAYOUTS))
def test_drawn_panels_sit_inside_their_served_rect(layout):
    """The overlay is positioned from the served rects: every drawn axes must lie in its slot's rect (y counted from the top)."""
    slots = table()[layout]["slots"]
    rec = composite([plot("line") for _ in slots], layout=layout)
    fig, ns, _ = execute(rec, preview=True)
    axes = [a for a in fig.axes if a.get_label() != "<colorbar>"]
    assert len(axes) >= len(slots)
    for a, s in zip(axes[:len(slots)], slots):
        bb = a.get_position()
        cx, cy = (bb.x0 + bb.x1) / 2, 1 - (bb.y0 + bb.y1) / 2
        assert s["x"] <= cx <= s["x"] + s["w"] and s["y"] <= cy <= s["y"] + s["h"], (layout, s["slot"])
