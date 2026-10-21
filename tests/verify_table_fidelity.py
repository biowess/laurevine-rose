"""verify_table_fidelity.py - End-to-end visual fidelity verification.

Renders an identical table presentation through:
1. Playwright (Headless Chromium loading the editor's index.html)
2. Backend PPTX exporter -> LibreOffice headless -> pdftoppm

Compares cell fills, border positions, and text positions to ensure exact visual parity.
"""

import os
import shutil
import subprocess
import tempfile
import pytest
from PIL import Image

from backend.models import PresentationDoc, SlideModel, SlideObject, TableBorder, CellFmt
from backend.exporter import export_presentation


def make_test_deck() -> PresentationDoc:
    table_obj = SlideObject(
        id="tbl_fidelity",
        type="table",
        x=80.0,
        y=80.0,
        w=600.0,
        h=180.0,
        headerRow=True,
        banded=True,
        fontSize=16.0,
        cells=[
            ["Model", "Accuracy", "Latency"],
            ["ResNet-50", "76.1%", "12 ms"],
            ["Vision Transformer", "82.4%", "28 ms"],
        ],
        colW=[220.0, 180.0, 200.0],
        rowH=[50.0, 65.0, 65.0],
        tableBorder=TableBorder(width=1, color="#666666"),
        cellFmt={
            "1,1": CellFmt(fill="#3B6E8C", color="#FFFFFF", bold=True, align="center"),
            "1,2": CellFmt(align="right", italic=True),
            "2,1": CellFmt(bold=True, align="center"),
            "2,2": CellFmt(align="right"),
        },
    )

    slide = SlideModel(
        id="s1",
        layout="blank",
        bg="#FFFFFF",
        objects=[table_obj],
    )

    return PresentationDoc(
        title="Table Fidelity Test",
        themeId="journal",
        size={"w": 960, "h": 540},
        slides=[slide],
    )


@pytest.mark.asyncio
async def test_table_visual_fidelity_e2e():
    soffice_path = shutil.which("libreoffice") or shutil.which("soffice")
    pdftoppm_path = shutil.which("pdftoppm")
    if not soffice_path or not pdftoppm_path:
        pytest.skip("soffice or pdftoppm not found in environment")

    from playwright.async_api import async_playwright

    doc = make_test_deck()
    doc_dict = doc.model_dump()

    root_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    index_html = os.path.join(root_dir, "index.html")

    with tempfile.TemporaryDirectory() as tmpdir:
        # 1. Render in Playwright Chromium
        editor_png_path = os.path.join(tmpdir, "editor.png")
        async with async_playwright() as p:
            browser = await p.chromium.launch()
            page = await browser.new_page(viewport={"width": 1280, "height": 800})
            await page.goto(f"file://{index_html}")
            # Inject document into store
            await page.evaluate(
                """(doc) => {
                    RPE.store.replaceDoc(doc, 'saved');
                    RPE.commands.run('view.zoom', { value: 100 });
                }""",
                doc_dict,
            )
            # Wait for slide frame to render
            await page.wait_for_selector("#slideFrame .obj-table")
            await page.wait_for_timeout(300)
            frame_el = await page.query_selector("#slideFrame")
            assert frame_el is not None
            await frame_el.screenshot(path=editor_png_path)
            await browser.close()

        assert os.path.exists(editor_png_path), "Editor screenshot was not generated"

        # 2. Render in LibreOffice from exported PPTX
        buf = export_presentation(doc)
        pptx_path = os.path.join(tmpdir, "deck.pptx")
        with open(pptx_path, "wb") as f:
            f.write(buf.getvalue())

        cmd_pdf = [soffice_path, "--headless", "--convert-to", "pdf", pptx_path, "--outdir", tmpdir]
        res_pdf = subprocess.run(cmd_pdf, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
        assert res_pdf.returncode == 0, f"LibreOffice conversion failed: {res_pdf.stderr.decode()}"

        pdf_path = os.path.join(tmpdir, "deck.pdf")
        assert os.path.exists(pdf_path)

        cmd_ppm = [pdftoppm_path, "-png", "-scale-to-x", "960", "-scale-to-y", "540", pdf_path, os.path.join(tmpdir, "pptx_slide")]
        res_ppm = subprocess.run(cmd_ppm, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=20)
        assert res_ppm.returncode == 0

        pptx_png_path = os.path.join(tmpdir, "pptx_slide-1.png")
        assert os.path.exists(pptx_png_path)

        img_editor = Image.open(editor_png_path).convert("RGB")
        img_pptx = Image.open(pptx_png_path).convert("RGB")

        # Crop editor image if box-shadow added 1px margin
        if img_editor.size != (960, 540):
            img_editor = img_editor.crop((0, 0, 960, 540))

        # Verify sizes match exactly 960x540
        assert img_editor.size == (960, 540), f"Editor size mismatch: {img_editor.size}"
        assert img_pptx.size == (960, 540), f"PPTX size mismatch: {img_pptx.size}"

        # 3. Compare cell fills at cell center points
        # Table geometry:
        # x = 80, y = 80
        # colW = [220, 180, 200] -> col centers: 80+110=190, 80+220+90=390, 80+220+180+100=580
        # rowH = [50, 65, 65] -> row centers: 80+25=105, 80+50+32=162, 80+50+65+32=227
        #
        # (r=0, c=0): Header -> accent fill (#702D3B -> 112, 45, 59)
        # (r=1, c=1): Custom fill (#3B6E8C -> 59, 110, 140)
        # (r=2, c=0): Banded row 2 -> bandTint (light journal theme: blend (112,45,59,.05) over #FFF -> ~248, 244, 245)
        # (r=1, c=0): Row 1 unformatted -> transparent / white (#FFFFFF -> 255, 255, 255)

        # Sample cell fills in the padding area of each cell to avoid sampling text glyphs
        test_points = [
            ("Header (0,0)", 105, 95, (112, 45, 59)),
            ("Custom Fill (1,1)", 325, 145, (59, 110, 140)),
            ("Banded Row (2,0)", 105, 210, (248, 245, 245)),
            ("White Cell (1,0)", 105, 145, (255, 255, 255)),
        ]

        for name, px, py, expected_rgb in test_points:
            ed_pixel = img_editor.getpixel((px, py))
            pptx_pixel = img_pptx.getpixel((px, py))

            # Channel tolerance <= 3 per channel between editor and expected
            for ch in range(3):
                diff_ed = abs(ed_pixel[ch] - expected_rgb[ch])
                assert diff_ed <= 3, f"{name}: Editor pixel {ed_pixel} differs from expected {expected_rgb} on channel {ch} by {diff_ed}"

            # Channel tolerance <= 3 between editor and pptx rendering
            for ch in range(3):
                diff_cross = abs(ed_pixel[ch] - pptx_pixel[ch])
                assert diff_cross <= 3, f"{name}: Cross-render diff between editor {ed_pixel} and PPTX {pptx_pixel} on channel {ch} exceeds tolerance: {diff_cross}"

        # 4. Compare grid line positions (within ±2px)
        # Horizontal border between row 0 and row 1 is at y=130
        def find_darkest_y(img, x, y_start, y_end):
            darkest_y = y_start
            min_lum = 9999
            for y in range(y_start, y_end):
                r, g, b = img.getpixel((x, y))
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                if lum < min_lum:
                    min_lum = lum
                    darkest_y = y
            return darkest_y

        # Vertical border between col 0 and col 1 is at x=300
        def find_darkest_x(img, y, x_start, x_end):
            darkest_x = x_start
            min_lum = 9999
            for x in range(x_start, x_end):
                r, g, b = img.getpixel((x, y))
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                if lum < min_lum:
                    min_lum = lum
                    darkest_x = x
            return darkest_x

        ed_h_line = find_darkest_y(img_editor, 150, 127, 134)
        pptx_h_line = find_darkest_y(img_pptx, 150, 127, 134)
        diff_h_line = abs(ed_h_line - pptx_h_line)
        assert diff_h_line <= 2, f"Horizontal grid line position mismatch: editor={ed_h_line}, pptx={pptx_h_line}, diff={diff_h_line} > 2px"

        ed_v_line = find_darkest_x(img_editor, 160, 297, 304)
        pptx_v_line = find_darkest_x(img_pptx, 160, 297, 304)
        diff_v_line = abs(ed_v_line - pptx_v_line)
        assert diff_v_line <= 2, f"Vertical grid line position mismatch: editor={ed_v_line}, pptx={pptx_v_line}, diff={diff_v_line} > 2px"

        # 5. Compare text ink position (within ±3px)
        # In cell (1,0) text is "ResNet-50", left aligned. Find the left ink edge of 'R'
        def find_text_ink_left(img, y, x_start, x_end, bg_lum=250):
            for x in range(x_start, x_end):
                r, g, b = img.getpixel((x, y))
                lum = 0.299 * r + 0.587 * g + 0.114 * b
                if lum < bg_lum - 30: # significantly darker than background
                    return x
            return None

        ed_text_x = find_text_ink_left(img_editor, 162, 85, 120)
        pptx_text_x = find_text_ink_left(img_pptx, 162, 85, 120)
        assert ed_text_x is not None, "Could not find text ink in editor"
        assert pptx_text_x is not None, "Could not find text ink in PPTX"
        diff_text_x = abs(ed_text_x - pptx_text_x)
        assert diff_text_x <= 3, f"Text position mismatch: editor={ed_text_x}, pptx={pptx_text_x}, diff={diff_text_x} > 3px"

        print(f"\nSUCCESS: All table visual fidelity checks passed!")
        print(f"  - Cell fills: matched expected & cross-render <= 3 per channel")
        print(f"  - Horizontal grid line: editor={ed_h_line}, pptx={pptx_h_line} (diff={diff_h_line}px <= 2px)")
        print(f"  - Vertical grid line: editor={ed_v_line}, pptx={pptx_v_line} (diff={diff_v_line}px <= 2px)")
        print(f"  - Text ink position: editor={ed_text_x}, pptx={pptx_text_x} (diff={diff_text_x}px <= 3px)")


if __name__ == "__main__":
    import asyncio
    asyncio.run(test_table_visual_fidelity_e2e())
