"""Colour palettes (tasks 16-17), backend side: snapshot sanitising, resolver tokens, PPTX colours (slide bg, header text), PDF smoke."""
import re
import shutil
import zipfile

import pytest

from backend import palettes as pal
from backend.exporter import ThemeResolver, export_presentation, export_presentation_to_pdf
from backend.models import PresentationDoc

DARK = {"id": "dark-auditorium", "roles": {
    "bg": "#142033", "card": "#1B283E", "surface": "#25354D", "border": "#50647D", "text": "#F5F7FA", "title": "#F5F7FA",
    "muted": "#A2B3C7", "onAccent": "#142033", "accent": "#72D5C9", "accent2": "#9BB9FF"}, "chart": ["#72D5C9", "#9BB9FF"], "dark": True}


def _doc(palette=None):
    d = {"id": "d", "themeId": "clinical-blue", "slides": [{"id": "s1", "layout": "titleContent", "objects": [
        {"id": "o1", "type": "text", "role": "title", "x": 10, "y": 10, "w": 400, "h": 60, "fontSize": 30, "html": "<p>Hello</p>"},
        {"id": "t1", "type": "table", "x": 10, "y": 120, "w": 400, "h": 80, "cells": [["A", "B"], ["1", "2"]], "headerRow": True, "fontSize": 14}]}]}
    if palette:
        d["palette"] = palette
    return d


def test_sanitize_and_fallback():
    s = pal.sanitize(DARK)
    assert s["roles"]["onAccent"] == "#142033" and s["table"]["headerText"] == "#142033" and s["dark"] is True
    assert pal.sanitize({"roles": {"bg": "nope"}}) is None and pal.sanitize(None) is None
    assert pal.theme_overrides(None) == {}                      # old document: theme colours untouched
    assert pal.sanitize({"roles": {k: DARK["roles"][k] for k in ("bg", "text", "accent", "accent2")}})["roles"]["card"] == "#142033"


def test_model_drops_invalid_and_resolver_uses_palette():
    assert PresentationDoc.model_validate(_doc({"roles": {}})).palette is None
    r = ThemeResolver(PresentationDoc.model_validate(_doc(DARK)))
    assert tuple(r.resolve_color("bg")) == (0x14, 0x20, 0x33) and tuple(r.resolve_color("accent")) == (0x72, 0xD5, 0xC9)
    assert tuple(r.resolve_color("surface")) == (0x25, 0x35, 0x4D)


def test_pptx_background_and_table_header_follow_palette():
    z = zipfile.ZipFile(export_presentation(_doc(DARK)))
    xml = z.read("ppt/slides/slide1.xml").decode()
    assert re.search(r'<p:bg>.*?srgbClr val="142033"', xml, re.S)        # slide background = palette bg
    assert 'srgbClr val="72D5C9"' in xml                                   # table header fill = palette accent
    old = zipfile.ZipFile(export_presentation(_doc())).read("ppt/slides/slide1.xml").decode()
    assert 'srgbClr val="72D5C9"' not in old and re.search(r'<p:bg>.*?srgbClr val="FFFFFF"', old, re.S)   # old doc unchanged


@pytest.mark.skipif(not shutil.which("soffice"), reason="LibreOffice not installed")
def test_pdf_renders_with_palette():
    out = export_presentation_to_pdf(_doc(DARK)).getvalue()
    assert out.startswith(b"%PDF")
