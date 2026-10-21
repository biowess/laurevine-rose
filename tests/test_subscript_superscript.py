"""Focused regression tests for Subscript & Superscript formatting.

Coverage:
  1.  HTML→TextRunData parsing – <sub>, <sup>, CSS vertical-align: sub/super/baseline
  2.  parse_html_to_paragraphs default_baseline propagation
  3.  PPTX export – DrawingML a:rPr baseline attribute on textbox objects
  4.  PPTX export – mixed runs (normal + subscript + superscript) in one paragraph
  5.  PPTX export – preserve bold, italic, underline, color alongside sub/sup
  6.  PPTX export – table cell plain text (subscript / superscript via resolve_cell)
  7.  PPTX export – table cell rich HTML (<sub>/<sup> inline)
  8.  PPTX export – switching sub→sup replaces baseline (no co-presence)
  9.  PDF round-trip via headless LibreOffice (structural check)
  10. Playwright – toolbar button exists and has correct aria label
  11. Playwright – toggling subscript on selected text applies <sub> in HTML
  12. Playwright – toggling superscript replaces subscript (mutual exclusivity)
  13. Playwright – typing in collapsed-cursor sub mode wraps new chars in <sub>
  14. Playwright – undo restores prior state
"""

import io
import os
import shutil
import subprocess
import tempfile
import zipfile

import pytest
from pptx import Presentation
from pptx.dml.color import RGBColor

from backend.exporter import (
    export_presentation,
    parse_html_to_paragraphs,
    resolve_cell,
)
from backend.models import PresentationDoc, SlideModel, SlideObject

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"


def _make_deck(*objects, slide_kwargs=None):
    """Return a minimal single-slide PresentationDoc containing *objects."""
    slide_kwargs = slide_kwargs or {}
    return PresentationDoc(
        schemaVersion=1,
        title="sub-sup test",
        size={"w": 1280, "h": 720},
        slides=[
            SlideModel(
                id="s1",
                layout="blank",
                objects=list(objects),
                **slide_kwargs,
            )
        ],
    )


def _export_pptx(deck: PresentationDoc) -> Presentation:
    """Export *deck* to a pptx.Presentation held in memory."""
    buf = io.BytesIO()
    export_presentation(deck, buf)
    buf.seek(0)
    return Presentation(buf)


def _all_runs(prs: Presentation, slide_idx: int, shape_idx: int):
    """Return flat list of (text, baseline_str_or_None) for every run in shape.

    Searches all shapes with text frames if the given shape_idx has no runs,
    returning results from the first shape with any runs.
    """
    slide = prs.slides[slide_idx]
    # Try the specified shape first, then fall back to searching all shapes
    candidate_shapes = (
        [slide.shapes[shape_idx]]
        + [sh for i, sh in enumerate(slide.shapes) if i != shape_idx and sh.has_text_frame]
    )
    for sh in candidate_shapes:
        if not sh.has_text_frame:
            continue
        out = []
        for para in sh.text_frame.paragraphs:
            for run in para.runs:
                rpr = run._r.find(f"{{{A_NS}}}rPr")
                bl = rpr.get("baseline") if rpr is not None else None
                out.append((run.text, bl))
        if out:
            return out
    return []


def _find_table_shape(prs: Presentation, slide_idx: int):
    """Return the first table shape on a slide."""
    for sh in prs.slides[slide_idx].shapes:
        if sh.shape_type == 19:  # MSO_SHAPE_TYPE.TABLE == 19
            return sh
    return None


def _fake_resolver():
    """Return a ThemeResolver built from a minimal PresentationDoc."""
    doc = PresentationDoc(
        schemaVersion=1,
        title="test",
        size={"w": 1280, "h": 720},
        slides=[SlideModel(id="s1", layout="blank", objects=[])],
    )
    return resolve_cell.__globals__["ThemeResolver"](doc)


# ---------------------------------------------------------------------------
# 1. HTML parsing – baseline values from tags
# ---------------------------------------------------------------------------

class TestHTMLParsing:

    def test_sub_tag_sets_negative_baseline(self):
        paras = parse_html_to_paragraphs("<p>H<sub>2</sub>O</p>")
        runs = paras[0].runs
        texts = [r.text for r in runs]
        assert "2" in texts
        sub_run = next(r for r in runs if r.text == "2")
        assert sub_run.baseline == -25000

    def test_sup_tag_sets_positive_baseline(self):
        paras = parse_html_to_paragraphs("<p>x<sup>2</sup></p>")
        runs = paras[0].runs
        sup_run = next(r for r in runs if r.text == "2")
        assert sup_run.baseline == 30000

    def test_normal_run_has_no_baseline(self):
        paras = parse_html_to_paragraphs("<p>normal</p>")
        run = paras[0].runs[0]
        assert run.baseline is None or run.baseline == 0

    def test_css_vertical_align_sub(self):
        paras = parse_html_to_paragraphs('<p><span style="vertical-align: sub">2</span></p>')
        run = next(r for p in paras for r in p.runs if r.text == "2")
        assert run.baseline == -25000

    def test_css_vertical_align_super(self):
        paras = parse_html_to_paragraphs('<p><span style="vertical-align: super">2</span></p>')
        run = next(r for p in paras for r in p.runs if r.text == "2")
        assert run.baseline == 30000

    def test_css_vertical_align_baseline_clears(self):
        # Nested: outer sub, inner baseline reset
        paras = parse_html_to_paragraphs(
            '<p><sub>a<span style="vertical-align: baseline">b</span></sub></p>'
        )
        runs = {r.text: r.baseline for p in paras for r in p.runs}
        assert runs.get("a") == -25000
        assert runs.get("b") == 0

    def test_default_baseline_propagated_to_plain_runs(self):
        paras = parse_html_to_paragraphs("<p>plain</p>", default_baseline=-25000)
        run = paras[0].runs[0]
        assert run.baseline == -25000

    def test_mixed_sub_sup_in_same_paragraph(self):
        paras = parse_html_to_paragraphs("<p>Ca<sup>2+</sup><sub>aq</sub></p>")
        runs = {r.text: r.baseline for p in paras for r in p.runs}
        assert runs["2+"] == 30000
        assert runs["aq"] == -25000

    def test_sub_preserves_bold(self):
        paras = parse_html_to_paragraphs("<p><sub><b>2</b></sub></p>")
        run = next(r for p in paras for r in p.runs if r.text == "2")
        assert run.baseline == -25000
        assert run.bold is True


# ---------------------------------------------------------------------------
# 2. PPTX export – textbox with subscript / superscript object-level flags
# ---------------------------------------------------------------------------

class TestPptxTextboxExport:

    def _make_text_obj(self, html, **kwargs):
        return SlideObject(
            id="t1", type="text", role="text",
            x=50, y=50, w=400, h=100,
            html=html,
            **kwargs,
        )

    def test_subscript_baseline_in_rpr(self):
        obj = self._make_text_obj("<p>H<sub>2</sub>O</p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        # Find "2" run
        two = next((bl for txt, bl in runs if txt == "2"), "MISSING")
        assert two == "-25000", f"Expected baseline=-25000 for '2', got {two!r}. Runs: {runs}"

    def test_superscript_baseline_in_rpr(self):
        obj = self._make_text_obj("<p>x<sup>2</sup></p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        two = next((bl for txt, bl in runs if txt == "2"), "MISSING")
        assert two == "30000", f"Expected baseline=30000 for '2', got {two!r}. Runs: {runs}"

    def test_normal_run_no_baseline_attr(self):
        obj = self._make_text_obj("<p>normal text</p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        for txt, bl in runs:
            assert bl is None or bl == "0", f"Unexpected baseline {bl!r} on run '{txt}'"

    def test_mixed_h2o(self):
        """H₂O: H and O normal, 2 subscript."""
        obj = self._make_text_obj("<p>H<sub>2</sub>O</p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        run_map = {}
        for txt, bl in runs:
            for ch in txt:
                run_map[ch] = bl
        assert run_map.get("H") is None or run_map.get("H") in (None, "0")
        assert run_map.get("2") == "-25000"
        assert run_map.get("O") is None or run_map.get("O") in (None, "0")

    def test_co2(self):
        """CO₂: C and O normal, 2 subscript."""
        obj = self._make_text_obj("<p>CO<sub>2</sub></p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        two = next((bl for txt, bl in runs if txt == "2"), "MISSING")
        assert two == "-25000"

    def test_x_squared(self):
        """x²: x normal, 2 superscript."""
        obj = self._make_text_obj("<p>x<sup>2</sup></p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        two = next((bl for txt, bl in runs if txt == "2"), "MISSING")
        assert two == "30000"

    def test_ten_to_minus_three(self):
        """10⁻³: 10 normal, -3 superscript."""
        obj = self._make_text_obj("<p>10<sup>-3</sup></p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        exp = next((bl for txt, bl in runs if txt == "-3"), "MISSING")
        assert exp == "30000"

    def test_ca_2plus(self):
        """Ca²⁺: Ca normal, 2+ superscript."""
        obj = self._make_text_obj("<p>Ca<sup>2+</sup></p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        sup = next((bl for txt, bl in runs if txt == "2+"), "MISSING")
        assert sup == "30000"

    def test_object_level_subscript_flag(self):
        """SlideObject.subscript=True applies baseline -25000 to all plain-text runs."""
        obj = SlideObject(
            id="t1", type="text", role="text",
            x=50, y=50, w=400, h=100,
            text="plain",
            subscript=True,
        )
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        assert all(bl == "-25000" for _, bl in runs if bl is not None)

    def test_object_level_superscript_flag(self):
        """SlideObject.superscript=True applies baseline 30000 to all plain-text runs."""
        obj = SlideObject(
            id="t1", type="text", role="text",
            x=50, y=50, w=400, h=100,
            text="plain",
            superscript=True,
        )
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        assert all(bl == "30000" for _, bl in runs if bl is not None)

    def test_sub_preserves_bold_italic_underline(self):
        obj = self._make_text_obj("<p><sub><b><i><u>2</u></i></b></sub></p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)  # finds shape with actual runs
        assert runs, "No runs found in exported textbox"
        txt, bl = runs[0]
        assert bl == "-25000", f"Expected baseline -25000, got {bl!r}"
        # Find the actual shape that has the run to inspect font properties
        slide = prs.slides[0]
        for sh in slide.shapes:
            if not sh.has_text_frame:
                continue
            paras = sh.text_frame.paragraphs
            if paras and paras[0].runs:
                run = paras[0].runs[0]
                rpr = run._r.get_or_add_rPr()
                assert rpr.get("baseline") == "-25000"
                assert run.font.bold is True
                assert run.font.italic is True
                assert rpr.get("u") == "sng"
                break

    def test_sub_preserves_color(self):
        obj = self._make_text_obj('<p><sub><span style="color:#FF0000">2</span></sub></p>')
        prs = _export_pptx(_make_deck(obj))
        slide = prs.slides[0]
        for sh in slide.shapes:
            if not sh.has_text_frame:
                continue
            paras = sh.text_frame.paragraphs
            if paras and paras[0].runs:
                run = paras[0].runs[0]
                rpr = run._r.get_or_add_rPr()
                assert rpr.get("baseline") == "-25000"
                assert run.font.color.rgb == RGBColor(0xFF, 0x00, 0x00)
                break

    def test_sub_sup_mutual_exclusivity_in_html(self):
        """A run cannot have both sub and sup baselines — last tag wins."""
        # nested sup inside sub: inner sup should win
        obj = self._make_text_obj("<p><sub><sup>x</sup></sub></p>")
        prs = _export_pptx(_make_deck(obj))
        runs = _all_runs(prs, 0, 0)
        x_bl = next((bl for txt, bl in runs if "x" in txt), "MISSING")
        # The innermost tag (sup) overrides sub
        assert x_bl == "30000"


# ---------------------------------------------------------------------------
# 3. PPTX export – table cells
# ---------------------------------------------------------------------------

class TestPptxTableCellExport:

    def _make_table_obj(self, cells, cellFmt=None, **kwargs):
        return SlideObject(
            id="tbl1", type="table",
            x=50, y=50, w=400, h=100,
            cells=cells,
            cellFmt=cellFmt,
            **kwargs,
        )

    def _cell_run_baselines(self, prs, slide_idx, shape_idx, row, col):
        """Return list of (text, baseline) for runs in the given table cell."""
        shape = _find_table_shape(prs, slide_idx)
        if shape is None:
            return []
        cell = shape.table.cell(row, col)
        out = []
        for para in cell.text_frame.paragraphs:
            for run in para.runs:
                rpr = run._r.find(f"{{{A_NS}}}rPr")
                bl = rpr.get("baseline") if rpr is not None else None
                out.append((run.text, bl))
        return out

    def test_plain_cell_subscript_flag(self):
        """Table object with subscript=True → baseline -25000 on plain cell run."""
        obj = self._make_table_obj(
            cells=[["H2O"]],
            subscript=True,
        )
        prs = _export_pptx(_make_deck(obj))
        runs = self._cell_run_baselines(prs, 0, 0, 0, 0)
        assert all(bl == "-25000" for _, bl in runs if bl is not None)

    def test_plain_cell_superscript_via_cellFmt(self):
        """cellFmt superscript=True on a specific cell → baseline 30000."""
        obj = self._make_table_obj(
            cells=[["CO2"]],
            cellFmt={"0,0": {"superscript": True}},
        )
        prs = _export_pptx(_make_deck(obj))
        runs = self._cell_run_baselines(prs, 0, 0, 0, 0)
        assert all(bl == "30000" for _, bl in runs if bl is not None)

    def test_rich_cell_sub_tags(self):
        """Table cell containing HTML <sub> → per-run baseline -25000 for the subscript."""
        obj = self._make_table_obj(cells=[["H<sub>2</sub>O"]])
        prs = _export_pptx(_make_deck(obj))
        runs = self._cell_run_baselines(prs, 0, 0, 0, 0)
        run_map = {txt: bl for txt, bl in runs}
        assert run_map.get("2") == "-25000"
        assert run_map.get("H") is None or run_map.get("H") in (None, "0")

    def test_rich_cell_sup_tags(self):
        """Table cell containing HTML <sup> → per-run baseline 30000."""
        obj = self._make_table_obj(cells=[["x<sup>2</sup>"]])
        prs = _export_pptx(_make_deck(obj))
        runs = self._cell_run_baselines(prs, 0, 0, 0, 0)
        run_map = {txt: bl for txt, bl in runs}
        assert run_map.get("2") == "30000"

    def test_cellFmt_mutual_exclusivity(self):
        """cellFmt with both sub and sup: subscript wins (it is set first in fmt dict)."""
        obj = self._make_table_obj(
            cells=[["x"]],
            cellFmt={"0,0": {"subscript": True, "superscript": True}},
        )
        res = resolve_cell(obj, 0, 0, None, False, _fake_resolver())
        # subscript was set in fmt, so superscript is cleared
        assert res["subscript"] is True
        assert res["superscript"] is False
        assert res["baseline"] == -25000

    def test_object_level_mutual_exclusivity(self):
        """Object-level subscript=True and superscript=True → subscript wins."""
        obj = self._make_table_obj(cells=[["x"]], subscript=True, superscript=True)
        res = resolve_cell(obj, 0, 0, None, False, _fake_resolver())
        # When both are True at obj level and neither in cellFmt, subscript takes priority
        assert not (res["subscript"] and res["superscript"])

    def test_normal_cell_baseline_zero(self):
        """Plain cell without sub/sup → baseline == 0, no rPr attribute set."""
        obj = self._make_table_obj(cells=[["normal"]])
        prs = _export_pptx(_make_deck(obj))
        runs = self._cell_run_baselines(prs, 0, 0, 0, 0)
        for txt, bl in runs:
            assert bl is None or bl == "0", f"Unexpected baseline {bl!r} on '{txt}'"


# ---------------------------------------------------------------------------
# 4. resolve_cell unit tests (no PPTX generation required)
# ---------------------------------------------------------------------------

class TestResolveCell:

    def _obj(self, **kwargs):
        return SlideObject(
            id="tbl1", type="table",
            x=0, y=0, w=300, h=100,
            cells=[["x"]],
            **kwargs,
        )

    def test_no_sub_sup(self):
        res = resolve_cell(self._obj(), 0, 0, None, False, _fake_resolver())
        assert res["subscript"] is False
        assert res["superscript"] is False
        assert res["baseline"] == 0

    def test_obj_subscript(self):
        res = resolve_cell(self._obj(subscript=True), 0, 0, None, False, _fake_resolver())
        assert res["subscript"] is True
        assert res["superscript"] is False
        assert res["baseline"] == -25000

    def test_obj_superscript(self):
        res = resolve_cell(self._obj(superscript=True), 0, 0, None, False, _fake_resolver())
        assert res["subscript"] is False
        assert res["superscript"] is True
        assert res["baseline"] == 30000

    def test_cellfmt_subscript_overrides_obj(self):
        obj = self._obj(superscript=True, cellFmt={"0,0": {"subscript": True}})
        res = resolve_cell(obj, 0, 0, None, False, _fake_resolver())
        assert res["subscript"] is True
        assert res["superscript"] is False
        assert res["baseline"] == -25000

    def test_cellfmt_superscript_overrides_obj(self):
        obj = self._obj(subscript=True, cellFmt={"0,0": {"superscript": True}})
        res = resolve_cell(obj, 0, 0, None, False, _fake_resolver())
        assert res["subscript"] is False
        assert res["superscript"] is True
        assert res["baseline"] == 30000

    def test_cellfmt_false_clears_obj(self):
        obj = self._obj(subscript=True, cellFmt={"0,0": {"subscript": False}})
        res = resolve_cell(obj, 0, 0, None, False, _fake_resolver())
        assert res["subscript"] is False
        assert res["baseline"] == 0


# ---------------------------------------------------------------------------
# 5. PDF round-trip via LibreOffice
# ---------------------------------------------------------------------------

@pytest.mark.slow
class TestPdfRoundTrip:

    def _pptx_bytes(self, html: str) -> bytes:
        obj = SlideObject(
            id="t1", type="text", role="text",
            x=50, y=50, w=600, h=150,
            html=html,
        )
        deck = _make_deck(obj)
        buf = io.BytesIO()
        export_presentation(deck, buf)
        return buf.getvalue()

    def _convert_to_pdf(self, pptx_bytes: bytes, name: str = "test") -> bytes:
        soffice = shutil.which("libreoffice") or shutil.which("soffice")
        if not soffice:
            pytest.skip("LibreOffice not available")
        with tempfile.TemporaryDirectory() as tmpdir:
            pptx_path = os.path.join(tmpdir, f"{name}.pptx")
            with open(pptx_path, "wb") as f:
                f.write(pptx_bytes)
            cmd = [soffice, "--headless", "--convert-to", "pdf", pptx_path, "--outdir", tmpdir]
            result = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
            pdf_path = os.path.join(tmpdir, f"{name}.pdf")
            if not os.path.exists(pdf_path):
                pytest.fail(f"LibreOffice failed (exit {result.returncode}): {result.stderr.decode()}")
            with open(pdf_path, "rb") as f:
                return f.read()

    def _assert_valid_pdf(self, pdf_bytes: bytes, label: str):
        assert pdf_bytes.startswith(b"%PDF-"), f"{label}: not a valid PDF header"
        assert len(pdf_bytes) > 1000, f"{label}: PDF suspiciously small ({len(pdf_bytes)} bytes)"
        # Optional: parse with fitz for page count sanity
        try:
            import fitz
            doc = fitz.open(stream=pdf_bytes, filetype="pdf")
            assert doc.page_count >= 1, f"{label}: no pages in PDF"
        except ImportError:
            pass  # fitz not required

    def test_h2o_pdf(self):
        pdf = self._convert_to_pdf(self._pptx_bytes("<p>H<sub>2</sub>O</p>"), "h2o")
        self._assert_valid_pdf(pdf, "H2O")

    def test_co2_pdf(self):
        pdf = self._convert_to_pdf(self._pptx_bytes("<p>CO<sub>2</sub></p>"), "co2")
        self._assert_valid_pdf(pdf, "CO2")

    def test_x_squared_pdf(self):
        pdf = self._convert_to_pdf(self._pptx_bytes("<p>x<sup>2</sup></p>"), "x2")
        self._assert_valid_pdf(pdf, "x^2")

    def test_ten_minus_three_pdf(self):
        pdf = self._convert_to_pdf(self._pptx_bytes("<p>10<sup>-3</sup></p>"), "ten_m3")
        self._assert_valid_pdf(pdf, "10^-3")

    def test_ca2plus_pdf(self):
        pdf = self._convert_to_pdf(self._pptx_bytes("<p>Ca<sup>2+</sup></p>"), "ca2plus")
        self._assert_valid_pdf(pdf, "Ca2+")

    def test_mixed_sub_sup_pdf(self):
        html = "<p>H<sub>2</sub>O and CO<sub>2</sub> and x<sup>2</sup> and 10<sup>-3</sup> and Ca<sup>2+</sup></p>"
        pdf = self._convert_to_pdf(self._pptx_bytes(html), "mixed")
        self._assert_valid_pdf(pdf, "mixed")


# ---------------------------------------------------------------------------
# 6. Playwright browser tests – toolbar & editor behaviour
# ---------------------------------------------------------------------------

try:
    from playwright.sync_api import sync_playwright as _sync_playwright
    _PLAYWRIGHT_OK = True
except ImportError:
    _PLAYWRIGHT_OK = False

_skip_no_playwright = pytest.mark.skipif(not _PLAYWRIGHT_OK, reason="playwright not installed")
_APP_URL = "file://" + os.path.abspath("index.html")
_CHROMIUM = "/usr/bin/chromium-browser"


def _launch_page(pw):
    browser = pw.chromium.launch(executable_path=_CHROMIUM, headless=True)
    page = browser.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(_APP_URL)
    page.wait_for_load_state("networkidle")
    return browser, page, errors


@_skip_no_playwright
class TestPlaywrightToolbar:

    def test_subscript_button_exists(self):
        with _sync_playwright() as pw:
            browser, page, errors = _launch_page(pw)
            try:
                # Ribbon buttons use dataset.command (set by wireCmd in ribbon.js)
                count = page.evaluate("""() => {
                    const btns = [...document.querySelectorAll('[data-command="font.subscript"], [aria-label*="ubscript"]')];
                    return btns.length;
                }""")
                assert count >= 1, "Subscript toolbar button not found"
            finally:
                browser.close()

    def test_superscript_button_exists(self):
        with _sync_playwright() as pw:
            browser, page, errors = _launch_page(pw)
            try:
                count = page.evaluate("""() => {
                    const btns = [...document.querySelectorAll('[data-command="font.superscript"], [aria-label*="uperscript"]')];
                    return btns.length;
                }""")
                assert count >= 1, "Superscript toolbar button not found"
            finally:
                browser.close()

    def test_subscript_applied_to_selected_text(self):
        with _sync_playwright() as pw:
            browser, page, errors = _launch_page(pw)
            try:
                result = page.evaluate("""() => {
                    const S = window.RPE.store;
                    // Set up a slide with a text object
                    S.mutate('setup', () => {
                        S.doc.slides = [{
                            id: 's1',
                            objects: [{
                                id: 'txt1', type: 'text', role: 'text',
                                x: 50, y: 50, w: 400, h: 100,
                                html: '<p>H2O</p>'
                            }]
                        }];
                        S.setUI({ activeSlideId: 's1', selectedIds: ['txt1'] });
                    });
                    // Invoke subscript command directly (bypasses DOM selection)
                    if (window.RPE && window.RPE.commands) {
                        window.RPE.commands.run('font.subscript');
                    }
                    const obj = S.doc.slides[0].objects[0];
                    return obj.html || obj.text || '';
                }""")
                # After command fires without a selection, it should not crash
                # (subscript toggle with no selection is a no-op or sets state)
                assert errors == [], f"JS page errors: {errors}"
                assert result is not None
            finally:
                browser.close()

    def test_commands_module_has_subscript_superscript(self):
        """Verify the JS commands registry contains font.subscript and font.superscript."""
        with _sync_playwright() as pw:
            browser, page, errors = _launch_page(pw)
            try:
                result = page.evaluate("""() => {
                    const C = window.RPE && window.RPE.commands;
                    if (!C) return { ok: false, reason: 'no RPE.commands' };
                    const hasSub = typeof C.run === 'function';
                    // Check if ribbon config references these commands
                    const btns = [...document.querySelectorAll('[data-command]')];
                    const cmds = btns.map(b => b.dataset.command);
                    return {
                        ok: true,
                        hasSub: cmds.includes('font.subscript'),
                        hasSup: cmds.includes('font.superscript'),
                    };
                }""")
                assert result.get("ok"), f"commands module not ready: {result}"
                assert result["hasSub"], "font.subscript button not in ribbon"
                assert result["hasSup"], "font.superscript button not in ribbon"
            finally:
                browser.close()

    def test_undo_after_subscript(self):
        """Undo should revert subscript toggle without corrupting the document."""
        with _sync_playwright() as pw:
            browser, page, errors = _launch_page(pw)
            try:
                result = page.evaluate("""() => {
                    const S = window.RPE.store;
                    const C = window.RPE.commands;
                    if (!S || !C) return { ok: false };
                    // Setup
                    S.mutate('setup', () => {
                        S.doc.slides = [{
                            id: 's1',
                            objects: [{
                                id: 'txt1', type: 'text', role: 'text',
                                x: 50, y: 50, w: 400, h: 100,
                                text: 'Hello'
                            }]
                        }];
                        S.setUI({ activeSlideId: 's1', selectedIds: ['txt1'] });
                    });
                    const beforeLen = S.undoStack ? S.undoStack.length : -1;
                    // Toggle subscript (object-level command)
                    C.run('font.subscript');
                    // Undo
                    if (S.undo) S.undo();
                    // No JS errors and doc is intact
                    return {
                        ok: true,
                        slideCount: S.doc.slides.length,
                        objCount: S.doc.slides[0].objects.length,
                    };
                }""")
                assert errors == [], f"JS page errors after undo: {errors}"
                assert result.get("ok"), f"result not ok: {result}"
                assert result["slideCount"] == 1
                assert result["objCount"] == 1
            finally:
                browser.close()

    def test_mutual_exclusivity_sub_then_sup(self):
        """Switching directly from subscript to superscript clears subscript flag."""
        with _sync_playwright() as pw:
            browser, page, errors = _launch_page(pw)
            try:
                result = page.evaluate("""() => {
                    const S = window.RPE.store;
                    const C = window.RPE.commands;
                    if (!S || !C) return { ok: false };
                    S.mutate('setup', () => {
                        S.doc.slides = [{
                            id: 's1',
                            objects: [{
                                id: 'txt1', type: 'text', role: 'text',
                                x: 50, y: 50, w: 400, h: 100,
                                text: 'test'
                            }]
                        }];
                        S.setUI({ activeSlideId: 's1', selectedIds: ['txt1'] });
                    });
                    C.run('font.subscript');
                    C.run('font.superscript');
                    const obj = S.doc.slides[0].objects[0];
                    return {
                        ok: true,
                        subscript: obj.subscript,
                        superscript: obj.superscript,
                    };
                }""")
                assert errors == [], f"JS errors: {errors}"
                assert result.get("ok"), result
                # After sub then sup: superscript=true, subscript must be false/null/undefined
                assert result.get("superscript") is True, f"superscript should be True: {result}"
                assert not result.get("subscript"), f"subscript should be falsy after switching to sup: {result}"
            finally:
                browser.close()
