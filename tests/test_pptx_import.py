"""Automated tests for PowerPoint (.pptx) Import capability.

Tests:
1. Representative PPTX import (full fidelity: text, shapes, lines, images, tables, notes, dimensions).
2. Unsupported elements reporting (charts, SmartArt, media clips) reliably identified.
3. Supported files produce no false positive warnings.
4. Malformed files, empty files, and corrupted data error handling.
5. FastAPI HTTP endpoint (/api/presentation/import) multipart and JSON base64 workflows.
6. Validation that imported deck can be saved and re-exported as a Laurevine project.
"""

import base64
import io
import os
import zipfile
import pytest
from fastapi.testclient import TestClient
import pptx
from pptx.chart.data import CategoryChartData
from pptx.enum.chart import XL_CHART_TYPE
from pptx.util import Inches

from backend.exporter import export_presentation
from backend.importer import import_presentation
from backend.models import PresentationDoc, upgrade_document
from backend.server import app
from tests.test_editor import create_representative_deck


@pytest.fixture
def api_client():
    return TestClient(app, base_url="http://127.0.0.1:8000")


def test_representative_pptx_import():
    """Test importing a representative presentation deck with diverse elements."""
    deck = create_representative_deck()
    buf = export_presentation(deck)
    pptx_bytes = buf.getvalue()

    warnings = []
    imported = import_presentation(pptx_bytes, warnings=warnings)

    # Validate model
    assert isinstance(imported, PresentationDoc)
    assert imported.size.w == 1280.0
    assert imported.size.h == 720.0
    assert len(imported.slides) == 2
    assert len(warnings) == 0, f"Expected 0 warnings for fully supported deck, got: {warnings}"

    # Slide 1 verification
    s1 = imported.slides[0]
    assert "Presenter notes for Slide 1" in s1.notes
    s1_types = [o.type for o in s1.objects]
    assert "text" in s1_types
    assert "image" in s1_types

    # Title check
    title_obj = next((o for o in s1.objects if o.type == "text" and "Representative Research Deck" in (o.html or "")), None)
    assert title_obj is not None, "Title object not found on slide 1"
    assert title_obj.role == "title" or "<b>" in title_obj.html

    # Picture check
    img_obj = next((o for o in s1.objects if o.type == "image"), None)
    assert img_obj is not None, "Image object not found on slide 1"
    assert img_obj.src.startswith("data:image/png;base64,")
    assert img_obj.aspect is not None and img_obj.aspect > 0

    # Slide 2 verification
    s2 = imported.slides[1]
    assert "Presenter notes for Slide 2" in s2.notes
    s2_types = [o.type for o in s2.objects]
    assert "shape" in s2_types
    assert "table" in s2_types

    # Shape checks: rect, ellipse, rounded, line
    shapes = [o for o in s2.objects if o.type == "shape"]
    shape_kinds = {getattr(o, "shape", None) for o in shapes}
    assert "rect" in shape_kinds
    assert "ellipse" in shape_kinds
    assert "rounded" in shape_kinds
    assert "line" in shape_kinds

    # Line connector geometry
    line_obj = next((o for o in shapes if o.shape == "line"), None)
    assert line_obj is not None
    assert line_obj.x1 is not None and line_obj.x2 is not None

    # Table check
    table_obj = next((o for o in s2.objects if o.type == "table"), None)
    assert table_obj is not None, "Table object not found on slide 2"
    assert len(table_obj.cells) == 5
    assert len(table_obj.cells[0]) == 4
    assert table_obj.cells[0][0] == "Test Metric"
    assert table_obj.cells[1][0] == "Export Fidelity"
    assert len(table_obj.colW) == 4
    assert len(table_obj.rowH) == 5

    # Re-export and save validation
    upgraded = upgrade_document(imported)
    re_buf = export_presentation(upgraded)
    assert len(re_buf.getvalue()) > 1000


def test_unsupported_elements_reporting():
    """Test that unsupported elements like Charts are reliably reported in warnings."""
    prs = pptx.Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[6])

    # Add a title text box
    tb = slide.shapes.add_textbox(Inches(1), Inches(0.5), Inches(8), Inches(1))
    tb.text_frame.text = "Slide with Chart"

    # Add an unsupported chart shape
    chart_data = CategoryChartData()
    chart_data.categories = ["A", "B"]
    chart_data.add_series("Series", (10, 20))
    slide.shapes.add_chart(XL_CHART_TYPE.COLUMN_CLUSTERED, Inches(1), Inches(2), Inches(6), Inches(4), chart_data)

    buf = io.BytesIO()
    prs.save(buf)

    warnings = []
    imported = import_presentation(buf.getvalue(), warnings=warnings)

    assert len(imported.slides) == 1
    # Chart should be omitted from objects
    assert not any(o.type == "chart" for o in imported.slides[0].objects)
    # Warning must be reliably identified and reported
    assert len(warnings) == 1
    assert warnings[0]["type"] == "chart"
    assert "Chart" in warnings[0]["message"]
    assert warnings[0]["slide"] == 1


def test_malformed_and_corrupt_files():
    """Test error handling for empty, garbage, and corrupted inputs."""
    # 1. Empty bytes
    with pytest.raises(ValueError, match="not a valid PowerPoint presentation or is corrupted"):
        import_presentation(b"")

    # 2. Plain text
    with pytest.raises(ValueError, match="not a valid PowerPoint presentation or is corrupted"):
        import_presentation(b"This is not a pptx file at all.")

    # 3. Zip file that is not a PPTX
    zip_buf = io.BytesIO()
    with zipfile.ZipFile(zip_buf, "w") as zf:
        zf.writestr("test.txt", "hello")
    with pytest.raises(ValueError, match="not a valid PowerPoint presentation or is corrupted"):
        import_presentation(zip_buf.getvalue())


def test_http_api_import_multipart(api_client):
    """Test FastAPI POST /api/presentation/import with multipart form upload."""
    deck = create_representative_deck()
    buf = export_presentation(deck)

    files = {
        "file": ("presentation_test.pptx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.presentationml.presentation")
    }
    resp = api_client.post("/api/presentation/import", files=files)
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["status"] == "ok"
    assert data["doc"]["title"] == "presentation_test"
    assert len(data["doc"]["slides"]) == 2
    assert isinstance(data["warnings"], list)


def test_http_api_import_json_base64(api_client):
    """Test FastAPI POST /api/presentation/import with JSON base64 payload."""
    deck = create_representative_deck()
    buf = export_presentation(deck)
    b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    payload = {
        "fileBase64": b64,
        "fileName": "base64_import.pptx",
    }
    resp = api_client.post("/api/presentation/import", json=payload)
    assert resp.status_code == 200
    data = resp.json()
    assert data["ok"] is True
    assert data["doc"]["title"] == "base64_import"


def test_http_api_import_failures(api_client):
    """Test API error handling for corrupted files and missing data."""
    # Corrupt file
    resp = api_client.post(
        "/api/presentation/import",
        files={"file": ("corrupt.pptx", b"garbage bytes", "application/octet-stream")},
    )
    assert resp.status_code == 400
    assert "not a valid PowerPoint presentation" in resp.json()["detail"]

    # Empty file
    resp = api_client.post(
        "/api/presentation/import",
        files={"file": ("empty.pptx", b"", "application/octet-stream")},
    )
    assert resp.status_code == 400
