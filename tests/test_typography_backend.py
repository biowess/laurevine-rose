"""Typography presets (tasks 14-15), backend side: snapshot sanitising, resolver, PPTX theme fonts, PDF font set, bundled catalogue."""
import io
import re
import zipfile

from backend import typography as ty
from backend.exporter import export_presentation
from backend.fonts import CURATED_FONTS_CATALOG, extract_document_fonts

SNAP = {"id": "swiss-minimal", "roles": {
    "title": {"font": "Spline Sans", "bold": True}, "subtitle": {"font": "Arimo", "italic": False},
    "body": {"font": "Arimo"}, "label": {"font": "JetBrains Mono", "bold": True}, "caption": {"font": "Arimo"}}}


def _doc(typography=None):
    d = {"id": "d", "slides": [{"id": "s1", "layout": "titleContent", "objects": [
        {"id": "o1", "type": "text", "role": "title", "x": 10, "y": 10, "w": 400, "h": 60, "fontSize": 30, "html": "<p>Hello</p>"},
        {"id": "o2", "type": "text", "role": "kicker", "x": 10, "y": 90, "w": 400, "h": 30, "fontSize": 12, "html": "<p>LABEL</p>"}]}]}
    if typography:
        d["typography"] = typography
    return d


def test_sanitize_and_fallback():
    assert ty.sanitize(SNAP)["roles"]["label"]["font"] == "JetBrains Mono"
    assert ty.sanitize({"roles": {}}) is None and ty.sanitize(None) is None
    assert ty.role_spec(None, "title") == {}


def test_preset_fonts_are_in_bundled_catalogue():
    families = set(CURATED_FONTS_CATALOG.values())
    for role in SNAP["roles"].values():
        assert role["font"] in families


def test_pptx_theme_and_run_fonts():
    z = zipfile.ZipFile(export_presentation(_doc(SNAP)))
    theme = z.read([n for n in z.namelist() if "theme/theme" in n][0]).decode()
    assert re.search(r'<a:majorFont>\s*<a:latin typeface="Spline Sans"', theme)
    assert re.search(r'<a:minorFont>\s*<a:latin typeface="Arimo"', theme)
    slide = z.read("ppt/slides/slide1.xml").decode()
    assert 'typeface="Spline Sans"' in slide and 'typeface="JetBrains Mono"' in slide   # title role + label (kicker) role


def test_pdf_font_set_includes_preset_fonts():
    assert {"Spline Sans", "Arimo", "JetBrains Mono"} <= extract_document_fonts(_doc(SNAP))
