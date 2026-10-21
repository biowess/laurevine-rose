"""Composer controls (docs/FIGURES_CONTRACT.md s4s / s4t / s4u): font scope, label font + offset, composite aspect of the final render,
PNG / PDF export of a composite independent of any slide, save / reopen round trip of the record with its panel sources."""
import io
import json

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.figures import export as export_core
from backend.figures.models import FigureRecord
from backend.server import app
from tests.test_figures_composite import composite, execute, fresh, plot, render  # noqa: F401  (fresh = autouse fixture)

client = TestClient(app)


def two_panels(**settings):
    return composite([plot("line", appearance={"title": "T", "xLabel": "x", "titleSize": 20, "labelSize": 5}),
                      plot("line", appearance={"fontSize": 7})], layout="1x2", **settings)


# ------------------------------------------------------------- font scope
def test_apply_to_all_panels_replaces_local_sizes():
    fig, ns, _ = execute(two_panels(fontSize=16, fontApplyAll=True))
    for _slot, _letter, ax in ns["panels"]:
        assert ax.xaxis.get_ticklabels()[0].get_fontsize() == pytest.approx(16 * 0.9)
    first = ns["panels"][0][2]
    assert first.title.get_fontsize() == pytest.approx(16 * 1.2) and first.xaxis.label.get_fontsize() == 16


def test_respect_local_overrides_is_the_default():
    assert FigureRecord.model_validate(composite([plot("line")])).composite.fontApplyAll is False
    fig, ns, _ = execute(two_panels(fontSize=16))
    first, second = ns["panels"][0][2], ns["panels"][1][2]
    assert first.title.get_fontsize() == 20 and first.xaxis.label.get_fontsize() == 5      # the panel's own sizes stay
    assert second.xaxis.get_ticklabels()[0].get_fontsize() == pytest.approx(7 * 0.9)


# ------------------------------------------------------------ label style
@pytest.mark.parametrize("family, name", [("sans", "sans-serif"), ("serif", "serif"), ("mono", "monospace")])
def test_label_family_weight_and_offset(family, name):
    fig, ns, _ = execute(composite([plot("line"), plot("bar")], layout="1x2",
                                   labelStyle={"family": family, "size": 11, "weight": "normal", "placement": "top-left", "offset": 10}))
    label = ns["panels"][0][2].texts[0]
    assert label.get_text() == "A" and label.get_fontweight() == "normal" and label.get_fontsize() == 11
    assert label.get_fontfamily() == [name]
    near = execute(composite([plot("line"), plot("bar")], layout="1x2", labelStyle={"offset": 0}))[1]["panels"][0][2].texts[0]
    assert label.xyann[1] > near.xyann[1], "a larger offset moves the letter further from the axes"


# ------------------------------------------------- composite insert aspect
@pytest.mark.parametrize("w, h", [(8, 4), (5, 5), (7, 3.5)])
def test_final_render_aspect_equals_the_export_size(w, h):
    res, pixels = render(composite([plot("line"), plot("bar")], layout="1x2", w=w, h=h))
    assert (res["widthPx"], res["heightPx"]) == (round(w * 100), round(h * 100)) and pixels.shape[:2] == (res["heightPx"], res["widthPx"])
    assert res["widthPx"] / res["heightPx"] == pytest.approx(w / h, rel=0.01)    # the slide object's aspect = pixels, = the size set in the composer


# ----------------------------------------------- export, independent of the slide
def _export(rec, fmt, **kw):
    return export_core.export_figure(rec, fmt, **kw)


def test_composite_exports_png_and_pdf():
    rec = composite([plot("line"), plot("bar")], layout="1x2", w=6, h=3)
    rec["name"] = "My composite"
    png = _export(rec, "png", dpi=100)
    assert png.filename == "My_composite.png"
    assert Image.open(io.BytesIO(png.data)).size == (600, 300)
    pdf = _export(rec, "pdf", dpi=100)
    assert pdf.data.startswith(b"%PDF") and pdf.filename.endswith(".pdf")


@pytest.mark.parametrize("fmt, kw", [("py", {}), ("bundle", {}), ("png", {"background": "transparent"})])
def test_composite_export_refusals_are_readable(fmt, kw):
    with pytest.raises(export_core.ExportError) as e:
        _export(composite([plot("line")]), fmt, **kw)
    assert e.value.status == 422 and e.value.message


def test_empty_composite_cannot_be_exported():
    with pytest.raises(export_core.ExportError) as e:
        _export(composite([None, None]), "png")
    assert e.value.status == 422 and "at least one panel" in e.value.message


def test_export_endpoint_serves_a_composite():
    r = client.post("/api/figures/export", json={"record": composite([plot("line")], layout="1x2", w=4, h=2), "format": "png", "dpi": 100})
    assert r.status_code == 200 and Image.open(io.BytesIO(r.content)).size == (400, 200)


def test_latex_is_still_refused():
    rec = composite([plot("line")]); rec["kind"] = "latex"
    with pytest.raises(export_core.ExportError):
        _export(rec, "png")


# ------------------------------------------- save / reopen keeps panel sources
def test_record_round_trip_keeps_panel_sources_and_settings():
    rec = composite([plot("scatter"), plot("bar")], layout="1x2", fontApplyAll=True,
                    labelStyle={"family": "serif", "size": 9, "weight": "normal", "placement": "bottom-right", "offset": 4})
    doc = {"title": "t", "schemaVersion": 2, "slides": [], "size": {"w": 1280, "h": 720}, "figures": {rec["id"]: rec}}
    back = json.loads(json.dumps(doc))
    model = FigureRecord.model_validate(back["figures"][rec["id"]])
    assert model.model_dump() == FigureRecord.model_validate(rec).model_dump()
    panels = model.composite.panels
    assert [p.record.config.plotType for p in panels] == ["scatter", "bar"]
    assert panels[0].record.dataset.rows == rec["composite"]["panels"][0]["record"]["dataset"]["rows"]
    assert model.composite.fontApplyAll is True and model.composite.labelStyle.offset == 4
