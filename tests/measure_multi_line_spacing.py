"""
Multi-line spacing measurement protocol (Task B Part 2).
Measures line pitch, baselines, total text block height, and PPTX XML
for cases (a) to (g) across lineHeight 1.0, 1.2, 1.5 and spaceAfter 0, 12.
"""
import io
import os
import shutil
import subprocess
import tempfile
import numpy as np
from PIL import Image
from pptx import Presentation
from playwright.sync_api import sync_playwright

from backend.models import PresentationDoc, SlideModel, SlideObject
from backend.exporter import export_presentation

def render_pptx_to_png(doc: PresentationDoc, tmpdir: str) -> str:
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    pdftoppm = shutil.which("pdftoppm")
    pptx_path = os.path.join(tmpdir, "slide.pptx")
    pdf_path = os.path.join(tmpdir, "slide.pdf")
    buf = export_presentation(doc)
    with open(pptx_path, "wb") as f:
        f.write(buf.getvalue())
    cmd = [soffice, "--headless", "--convert-to", "pdf", pptx_path, "--outdir", tmpdir]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    png_prefix = os.path.join(tmpdir, "page")
    cmd_ppm = [pdftoppm, "-r", "96", "-scale-to-x", "1280", "-scale-to-y", "720", "-png", pdf_path, png_prefix]
    subprocess.run(cmd_ppm, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return f"{png_prefix}-1.png", pptx_path

def measure_lines_from_png(png_path: str, box: tuple):
    x, y, w, h = box
    img = Image.open(png_path).convert("L")
    crop = img.crop((x, y, x + w, y + h))
    arr = np.array(crop)
    dark = (arr < 200)
    row_counts = dark.sum(axis=1)

    lines = []
    in_line = False
    start_y = 0
    for r, count in enumerate(row_counts):
        if count > 0 and not in_line:
            in_line = True
            start_y = r
        elif count == 0 and in_line:
            in_line = False
            lines.append((y + start_y, y + r))
    if in_line:
        lines.append((y + start_y, y + len(row_counts)))
    return lines

def get_xml_metrics(pptx_path: str):
    prs = Presentation(pptx_path)
    sp = prs.slides[0].shapes[1]
    tf = sp.text_frame
    res = []
    for p in tf.paragraphs:
        p_info = {}
        ln = p._p.xpath('.//a:lnSpc/a:spcPct')
        p_info['spcPct'] = ln[0].get('val') if ln else None
        runs = p._p.xpath('.//a:r/a:rPr')
        p_info['run_sz'] = [r.get('sz') for r in runs]
        end_rpr = p._p.xpath('.//a:endParaRPr')
        p_info['endParaRPr_sz'] = end_rpr[0].get('sz') if end_rpr else None
        res.append(p_info)
    return res

def run_all_measurements():
    # Cases definition: (name, fontSize, lineHeight, spaceAfter, html)
    cases = [
        # (a) all lines the same size (various line heights & spaceAfter)
        ("case_a_lh10_sa0", 18, 1.0, 0, "<p>First line of text</p><p>Second line of text</p><p>Third line of text</p>"),
        ("case_a_lh12_sa0", 18, 1.2, 0, "<p>First line of text</p><p>Second line of text</p><p>Third line of text</p>"),
        ("case_a_lh15_sa0", 18, 1.5, 0, "<p>First line of text</p><p>Second line of text</p><p>Third line of text</p>"),
        ("case_a_lh12_sa12", 18, 1.2, 12, "<p>First line of text</p><p>Second line of text</p><p>Third line of text</p>"),

        # (b) one line larger than base size
        ("case_b_larger", 18, 1.2, 0, "<p>First line of text</p><p><span style=\"font-size: 28pt;\">Second large line</span></p><p>Third line of text</p>"),

        # (c) one line SMALLER than base size (shrunk)
        ("case_c_smaller", 24, 1.2, 0, "<p>First line of text</p><p style=\"font-size: 14pt;\"><span style=\"font-size: 14pt;\">Second small line</span></p><p>Third line of text</p>"),

        # (d) one line with large word and small words on same line
        ("case_d_mixed_inline", 18, 1.2, 0, "<p>Small <span style=\"font-size: 36pt;\">LARGE</span> word</p><p>Next line here</p>"),

        # (e) several paragraphs with mixed sizes
        ("case_e_mixed_paras", 18, 1.2, 0, "<p style=\"font-size: 14pt;\"><span style=\"font-size: 14pt;\">Fourteen point</span></p><p style=\"font-size: 24pt;\"><span style=\"font-size: 24pt;\">Twenty four point</span></p><p style=\"font-size: 18pt;\"><span style=\"font-size: 18pt;\">Eighteen point</span></p>"),

        # (f) blank paragraph between paragraphs (at base size and resized)
        ("case_f_blank_base", 18, 1.2, 0, "<p>Line before blank</p><p><br></p><p>Line after blank</p>"),
        ("case_f_blank_resized", 18, 1.2, 0, "<p>Line before blank</p><p style=\"font-size: 28pt;\"><br></p><p>Line after blank</p>"),

        # (g) same box after repeated grow/shrink steps
        ("case_g_stepped", 18, 1.2, 0, "<p style=\"font-size: 14pt;\"><span style=\"font-size: 14pt;\">Line 1 (14pt)</span></p><p><span style=\"font-size: 28pt;\">Line 2 (28pt)</span></p><p><span style=\"font-size: 24pt;\">Line 3 (24pt)</span></p>"),
    ]

    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True)
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.goto('http://localhost:8000')
        page.wait_for_load_state("networkidle")

        print("==========================================================================================================")
        print("MULTI-LINE SPACING MEASUREMENT PROTOCOL RESULTS")
        print("Font: Arial (installed in Chromium and LibreOffice)")
        print("==========================================================================================================")
        print(f"{'Case':22} | {'Ed Pitch (px)':18} | {'LO Pitch (px)':18} | {'Ed Total H':10} | {'LO Total H':10} | {'XML endParaRPr'}")
        print("-" * 106)

        results = []
        for name, font_size, lh, sa, html in cases:
            # 1. Editor measurement
            ed_info = page.evaluate('''(arg) => {
                const S = window.RPE.store;
                S.mutate('Clear', () => { S.activeSlide().objects = []; });
                const tb = {
                    id: 't_meas', type: 'text', role: 'body',
                    x: 100, y: 100, w: 700, h: 450,
                    font: 'Arial', fontSize: arg.fontSize,
                    color: '#000000',
                    lineHeight: arg.lh, spaceAfter: arg.sa,
                    html: arg.html
                };
                S.mutate('Add', () => { S.activeSlide().objects.push(tb); });
                S.select(['t_meas']);
                const scale = window.RPE.canvas.getScale();
                const slideEl = document.querySelector('.slide--edit');
                const slideRect = slideEl.getBoundingClientRect();
                const paras = Array.from(document.querySelectorAll('.slide--edit [data-id=\"t_meas\"] .obj__text p'));
                const lines = paras.map(p => {
                    const rect = p.getBoundingClientRect();
                    return {
                        top: (rect.top - slideRect.top) / scale,
                        bottom: (rect.bottom - slideRect.top) / scale,
                        height: rect.height / scale,
                    };
                });
                const totalH = lines.length ? lines[lines.length - 1].bottom - lines[0].top : 0;
                return { lines, totalH };
            }''', {"fontSize": font_size, "lh": lh, "sa": sa, "html": html})

            ed_pitches = [round(ed_info['lines'][i+1]['top'] - ed_info['lines'][i]['top'], 2) for i in range(len(ed_info['lines']) - 1)]
            ed_total_h = round(ed_info['totalH'], 2)

            # 2. LibreOffice PPTX measurement
            tb_obj = SlideObject(
                id="t_meas", type="text",
                x=100, y=100, w=700, h=450,
                font="Arial", fontSize=font_size,
                color="#000000",
                lineHeight=lh, spaceAfter=sa,
                html=html
            )
            doc = PresentationDoc(title="Measure", themeId="slate", slides=[SlideModel(id="s1", layout="blank", objects=[tb_obj])])
            with tempfile.TemporaryDirectory() as tmpdir:
                png, pptx_path = render_pptx_to_png(doc, tmpdir)
                lo_lines = measure_lines_from_png(png, (100, 100, 700, 450))
                lo_pitches = [lo_lines[i+1][0] - lo_lines[i][0] for i in range(len(lo_lines) - 1)]
                lo_total_h = (lo_lines[-1][1] - lo_lines[0][0]) if lo_lines else 0
                xml_info = get_xml_metrics(pptx_path)

            end_rprs = [x['endParaRPr_sz'] for x in xml_info]
            results.append({
                "case": name,
                "ed_pitches": ed_pitches,
                "lo_pitches": lo_pitches,
                "ed_total_h": ed_total_h,
                "lo_total_h": lo_total_h,
                "xml_endParaRPr": end_rprs
            })
            print(f"{name:22} | {str(ed_pitches):18} | {str(lo_pitches):18} | {ed_total_h:<10} | {lo_total_h:<10} | {str(end_rprs)}")

        print("-" * 106)
        return results

if __name__ == "__main__":
    run_all_measurements()
