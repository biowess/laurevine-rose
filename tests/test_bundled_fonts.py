"""Tests for bundled font catalog, licensing, and export integration.

Validates that:
1. All 38 curated GFL/OFL fonts are present in `fonts/`.
2. Every font directory has TrueType (.ttf) files.
3. Every font directory has its license file (OFL.txt or LICENSE.txt).
4. `fonts/fonts.css` contains @font-face rules for every font.
5. `normalize_font_name` in backend/exporter.py maps each font correctly.
6. PDF export properly embeds bundled fonts via LibreOffice.
"""

import os
import shutil
import subprocess
import tempfile
import pytest
from backend.exporter import normalize_font_name, export_presentation
from backend.models import PresentationDoc, SlideModel, SlideObject
from backend.server import export_presentation_endpoint, ExportRequest

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
FONTS_DIR = os.path.join(BASE_DIR, "fonts")

EXPECTED_FONTS = [
    ("outfit", "Outfit"),
    ("spline-sans", "Spline Sans"),
    ("arimo", "Arimo"),
    ("source-sans-3", "Source Sans 3"),
    ("open-dyslexic", "OpenDyslexic"),
    ("tex-gyre-termes", "TeX Gyre Termes"),
    ("cormorant-garamond", "Cormorant Garamond"),
    ("amiri", "Amiri"),
    ("cairo", "Cairo"),
    ("noto-sans-arabic", "Noto Sans Arabic"),
    ("tajawal", "Tajawal"),
    ("scheherazade-new", "Scheherazade New"),
    ("inter", "Inter"),
    ("roboto", "Roboto"),
    ("open-sans", "Open Sans"),
    ("lato", "Lato"),
    ("montserrat", "Montserrat"),
    ("poppins", "Poppins"),
    ("raleway", "Raleway"),
    ("oswald", "Oswald"),
    ("fira-sans", "Fira Sans"),
    ("plus-jakarta-sans", "Plus Jakarta Sans"),
    ("merriweather", "Merriweather"),
    ("playfair-display", "Playfair Display"),
    ("lora", "Lora"),
    ("pt-serif", "PT Serif"),
    ("bitter", "Bitter"),
    ("cinzel", "Cinzel"),
    ("libre-baskerville", "Libre Baskerville"),
    ("eb-garamond", "EB Garamond"),
    ("jetbrains-mono", "JetBrains Mono"),
    ("fira-code", "Fira Code"),
    ("inconsolata", "Inconsolata"),
    ("source-code-pro", "Source Code Pro"),
    ("space-mono", "Space Mono"),
    ("caveat", "Caveat"),
    ("pacifico", "Pacifico"),
    ("space-grotesk", "Space Grotesk"),
]


def test_font_catalog_count_and_licenses():
    """Ensure total 38 fonts exist with TTF files and licenses."""
    assert len(EXPECTED_FONTS) >= 30 and len(EXPECTED_FONTS) <= 40
    assert os.path.isdir(FONTS_DIR), "fonts directory must exist"

    for font_id, font_name in EXPECTED_FONTS:
        folder = os.path.join(FONTS_DIR, font_id)
        assert os.path.isdir(folder), f"Font folder missing: {folder}"

        files = os.listdir(folder)
        ttfs = [f for f in files if f.endswith(".ttf")]
        assert len(ttfs) > 0, f"No TTF file found in {folder}"

        lics = [f for f in files if "ofl" in f.lower() or "license" in f.lower()]
        assert len(lics) > 0, f"No license file found in {folder}"


def test_fonts_css_contains_all_faces():
    """Ensure fonts/fonts.css exists and defines @font-face for each font."""
    css_path = os.path.join(FONTS_DIR, "fonts.css")
    assert os.path.exists(css_path), "fonts/fonts.css must exist"
    with open(css_path, "r", encoding="utf-8") as f:
        content = f.read()

    for _, font_name in EXPECTED_FONTS:
        assert f"font-family: '{font_name}'" in content, f"Missing @font-face for {font_name}"


def test_normalize_font_name_curated_fonts():
    """Ensure normalize_font_name maps all curated fonts and common variations."""
    for _, font_name in EXPECTED_FONTS:
        assert normalize_font_name(font_name) == font_name
        assert normalize_font_name(font_name.lower()) == font_name

    # Specific aliases
    assert normalize_font_name("Source Sans") == "Source Sans 3"
    assert normalize_font_name("Source Sans Pro") == "Source Sans 3"
    assert normalize_font_name("Open Dyslexic") == "OpenDyslexic"
    assert normalize_font_name("TeXGyreTermes") == "TeX Gyre Termes"


@pytest.mark.asyncio
async def test_pdf_export_embeds_bundled_fonts():
    """Ensure PDF export embeds bundled fonts via LibreOffice."""
    doc = PresentationDoc(
        id="deck_test_fonts",
        title="Bundled Fonts Test",
        themeId="journal",
        slides=[
            SlideModel(
                id="s1",
                objects=[
                    SlideObject(id="o1", type="text", role="title", font="TeX Gyre Termes", html="<h1>Termes</h1>", x=50, y=50, w=500, h=80),
                    SlideObject(id="o2", type="text", role="body", font="OpenDyslexic", html="<p>OpenDyslexic</p>", x=50, y=140, w=500, h=80),
                    SlideObject(id="o3", type="text", role="body", font="Amiri", html="<p>Amiri Arabic</p>", x=50, y=230, w=500, h=80),
                    SlideObject(id="o4", type="text", role="body", font="Arimo", html="<p>Arimo text</p>", x=50, y=320, w=500, h=80),
                ],
            )
        ],
    )

    req = ExportRequest(format="pdf", doc=doc.model_dump())
    resp = await export_presentation_endpoint(req)

    body_bytes = b""
    async for chunk in resp.body_iterator:
        body_bytes += chunk

    assert len(body_bytes) > 1000, "PDF bytes should be non-empty"

    pdffonts = shutil.which("pdffonts")
    if pdffonts:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(body_bytes)
            pdf_path = f.name
        try:
            out = subprocess.run([pdffonts, pdf_path], capture_output=True, text=True, timeout=10).stdout
        finally:
            os.unlink(pdf_path)
        assert any("TeXGyreTermes" in line or "TeX Gyre Termes" in line for line in out.splitlines()), \
            f"TeXGyreTermes missing in pdffonts output:\n{out}"
        assert any("OpenDyslexic" in line for line in out.splitlines()), \
            f"OpenDyslexic missing in pdffonts output:\n{out}"
        assert any("Amiri" in line for line in out.splitlines()), \
            f"Amiri missing in pdffonts output:\n{out}"
        assert any("Arimo" in line for line in out.splitlines()), \
            f"Arimo missing in pdffonts output:\n{out}"


def test_font_catalog_enumeration_and_mapping():
    """Ensure font catalog enumerates all bundled fonts and maps style variants."""
    from backend.fonts import get_font_catalog

    catalog = get_font_catalog()
    assert len(catalog.families) >= 38

    # Test static family style mapping
    termes = catalog.resolve_family("TeX Gyre Termes")
    assert termes is not None
    assert not termes.is_variable
    styles = termes.get_style_files()
    assert "regular" in styles and "bold" in styles and "italic" in styles and "bold_italic" in styles
    for st, p in styles.items():
        assert os.path.exists(p), f"File for {st} does not exist: {p}"

    # Test variable family style mapping with cache
    outfit = catalog.resolve_family("Outfit")
    assert outfit is not None
    assert outfit.is_variable
    outfit_styles = outfit.get_style_files()
    assert "regular" in outfit_styles and "bold" in outfit_styles
    for st, p in outfit_styles.items():
        assert os.path.exists(p), f"File for {st} does not exist: {p}"

    # Test incomplete family graceful fallback (Pacifico only has regular)
    pacifico = catalog.resolve_family("Pacifico")
    assert pacifico is not None
    pac_styles = pacifico.get_style_files()
    assert "regular" in pac_styles
    assert "bold" in pac_styles
    # Fallback to regular when bold/italic is not provided
    assert pac_styles["bold"] == pac_styles["regular"]


@pytest.mark.asyncio
async def test_pdf_export_bundled_font_variants_true_type_embedding():
    """Ensure PDF export embeds bundled fonts as vector TrueType subsets with variants."""
    from backend.exporter import export_presentation_to_pdf

    doc = PresentationDoc(
        id="deck_variants_test",
        title="Font Variants Test",
        themeId="journal",
        slides=[
            SlideModel(
                id="s1",
                objects=[
                    SlideObject(id="o1", type="text", role="title", font="Outfit", html="<p><b>Bold Outfit</b> and Regular Outfit</p>", x=50, y=50, w=500, h=80),
                    SlideObject(id="o2", type="text", role="body", font="Bitter", html="<p><b>Bold Bitter</b> and <i>Italic Bitter</i></p>", x=50, y=140, w=500, h=80),
                    SlideObject(id="o3", type="text", role="body", font="JetBrains Mono", html="<p>JetBrains Mono code</p>", x=50, y=230, w=500, h=80),
                ],
            )
        ],
    )

    warnings = []
    pdf_buffer = export_presentation_to_pdf(doc, warnings=warnings)
    pdf_bytes = pdf_buffer.getvalue()
    assert len(pdf_bytes) > 1000

    pdffonts = shutil.which("pdffonts")
    if pdffonts:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(pdf_bytes)
            pdf_path = f.name
        try:
            out = subprocess.run([pdffonts, pdf_path], capture_output=True, text=True, timeout=10).stdout
        finally:
            os.unlink(pdf_path)
        lines = out.splitlines()
        assert any("Outfit" in l for l in lines), f"Outfit missing in pdffonts output:\n{out}"
        assert any("Bitter" in l for l in lines), f"Bitter missing in pdffonts output:\n{out}"
        assert any("JetBrains" in l or "JetBrainsMono" in l for l in lines), \
            f"JetBrains Mono missing in pdffonts output:\n{out}"
        # TrueType embedding: pdffonts marks embedded fonts with 'yes' in the 'emb' column
        outfit_lines = [l for l in lines if "Outfit" in l]
        assert all("yes" in l for l in outfit_lines), \
            f"Expected Outfit fonts to be embedded (TrueType):\n{out}"


@pytest.mark.asyncio
async def test_pdf_export_missing_font_fallback_and_warning():
    """Ensure missing/unbundled fonts fall back gracefully with a warning."""
    from backend.exporter import export_presentation_to_pdf

    doc = PresentationDoc(
        id="deck_missing_font",
        title="Missing Font Test",
        themeId="journal",
        slides=[
            SlideModel(
                id="s1",
                objects=[
                    SlideObject(id="o1", type="text", role="body", font="NonExistentSuperFont123", html="<p>Unknown Font</p>", x=50, y=50, w=500, h=80),
                ],
            )
        ],
    )

    warnings = []
    pdf_buffer = export_presentation_to_pdf(doc, warnings=warnings)
    pdf_bytes = pdf_buffer.getvalue()
    assert len(pdf_bytes) > 1000

    # Warning must be emitted for the unbundled font
    assert any(w.get("code") == "FONT_NOT_BUNDLED" for w in warnings), f"Expected FONT_NOT_BUNDLED in warnings: {warnings}"

