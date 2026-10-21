"""POST /api/figures/export and GET /api/figures/pixels (docs/FIGURES_CONTRACT.md s4j)."""
import io
import subprocess
import sys
import zipfile

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.figures import export as export_core
from backend.figures.models import default_record
from backend.figures.runner import run_python
from backend.server import app
from tests.test_figures_render import structured

client = TestClient(app)

SCRIPT = "import matplotlib.pyplot as plt\nplt.figure(figsize=(4, 3))\nplt.plot([1, 2, 3])\nplt.show()\n"


def rec(w=6.0, h=4.0, dpi=450, **export):
    return structured("line", w=w, h=h, dpi=dpi, **export)


def big_rec(rows=2500):
    r = rec()
    r["dataset"]["rows"] = [[i, (i * 7) % 13] for i in range(rows)]
    return r


def export(record, fmt, **extra):
    return client.post("/api/figures/export", json={"record": record, "format": fmt, **extra})


def image(res):
    assert res.status_code == 200, res.text
    img = Image.open(io.BytesIO(res.content))
    img.load()
    return img


# ------------------------------------------------------------------ pixels
def test_pixels_math_and_caps():
    assert client.get("/api/figures/pixels", params={"w": 6, "h": 4, "dpi": 450}).json() == \
        {"wPx": 2700, "hPx": 1800, "megapixels": 4.86}
    assert client.get("/api/figures/pixels", params={"w": 6, "h": 4, "dpi": 150}).json()["wPx"] == 900
    over = client.get("/api/figures/pixels", params={"w": 30, "h": 30, "dpi": 1200}).json()
    assert over["wPx"] == 36000 and "per-side" in over["warning"]
    mp = client.get("/api/figures/pixels", params={"w": 14, "h": 14, "dpi": 1100}).json()
    assert mp["wPx"] == 15400 and "120 MP" in mp["warning"] and "refused" in mp["warning"]
    large = client.get("/api/figures/pixels", params={"w": 20, "h": 20, "dpi": 450}).json()
    assert large["megapixels"] == 81.0 and "large file" in large["warning"] and "refused" not in large["warning"]


def test_pixels_rejects_out_of_range():
    for params in ({"w": 0.1, "h": 4, "dpi": 300}, {"w": 6, "h": 31, "dpi": 300}, {"w": 6, "h": 4, "dpi": 50},
                   {"w": 6, "h": 4, "dpi": 2000}, {"w": "x", "h": 4, "dpi": 300}):
        assert client.get("/api/figures/pixels", params=params).status_code == 422


# --------------------------------------------------------------- png / pdf
def test_png_uses_export_size_and_dpi():
    res = export(rec(6, 4, 450), "png")
    assert res.headers["content-type"] == "image/png"
    assert image(res).size == (2700, 1800)
    assert image(export(rec(6, 4, 450), "png", dpi=150)).size == (900, 600)     # request dpi wins
    assert image(export(rec(6, 4, 150), "png")).size == (900, 600)              # else the record's dpi


def test_png_ignores_stale_preview_and_renders_current_record():
    r = rec(5, 2, 200)
    r["render"].update(status="ok", preview="data:image/png;base64,iVBORw0KGgo=")
    assert image(export(r, "png")).size == (1000, 400)


def test_pdf_is_valid_and_page_size_is_figure_size():
    res = export(rec(6, 4, 150), "pdf")
    assert res.status_code == 200 and res.content.startswith(b"%PDF")
    assert res.headers["content-type"] == "application/pdf"
    import fitz
    with fitz.open(stream=res.content, filetype="pdf") as pdf:
        assert pdf.page_count == 1
        assert (round(pdf[0].rect.width), round(pdf[0].rect.height)) == (432, 288)  # 6 x 4 in at 72 pt


def test_transparent_png_and_pdf_only():
    img = image(export(rec(2, 2, 100), "png", background="transparent"))
    assert img.mode == "RGBA" and img.getpixel((0, 0))[3] == 0
    assert image(export(rec(2, 2, 100), "png", background="white")).getpixel((0, 0))[:3] == (255, 255, 255)
    assert export(rec(2, 2, 100), "pdf", background="transparent").content.startswith(b"%PDF")
    for fmt in ("py", "bundle"):
        res = export(rec(), fmt, background="transparent")
        assert res.status_code == 400 and "only available for PNG and PDF" in res.json()["detail"]
    r = rec()
    r["kind"], r["name"] = "latex", "t"
    assert export(r, "png").status_code in (400, 422)


def test_filename_from_name_and_headers():
    r = rec(2, 2, 100)
    r["name"] = "Dose / response: run #3"
    res = export(r, "png")
    assert res.headers["content-disposition"] == 'attachment; filename="Dose_response_run_3.png"'
    assert res.headers["access-control-expose-headers"] == "Content-Disposition"
    r["name"] = "Größe é 図"
    res = export(r, "pdf")
    cd = res.headers["content-disposition"]
    assert cd.startswith('attachment; filename="') and cd.isascii() and "filename*=UTF-8''" in cd
    r["name"] = "///"
    assert export(r, "py").headers["content-disposition"] == 'attachment; filename="figure.py"'


def test_custom_script_png_uses_script_size():
    r = default_record("python").model_dump()
    r["source"], r["export"]["dpi"] = SCRIPT, 300
    assert image(export(r, "png")).size == (1200, 900)
    r["source"] = "  "
    assert export(r, "png").status_code == 422


# --------------------------------------------------------------------- caps
def test_caps_enforced():
    assert export(rec(), "png", dpi=71).status_code == 400
    assert export(rec(), "png", dpi=1201).status_code == 400
    assert export(rec(), "png", dpi=300.5).status_code == 400
    assert export(rec(), "gif").status_code == 400
    assert export(rec(), "png", background="red").status_code == 400
    assert client.post("/api/figures/export", json={"format": "png"}).status_code == 400
    assert client.post("/api/figures/export", content=b"{", headers={"content-type": "application/json"}).status_code == 400
    assert client.post("/api/figures/export", content=b"x", headers={"content-type": "text/plain"}).status_code == 415
    too_big = rec(30, 30, 1200)                                        # record itself breaks the pixel caps
    assert export(too_big, "png").status_code == 400
    res = export(rec(20, 20, 450), "png", dpi=1000)                    # request dpi pushes a valid record over the cap
    assert res.status_code == 422 and "per-side" in res.json()["detail"]
    res = export(rec(14, 14, 300), "pdf", dpi=1100)                    # 15400 px per side but 237 MP
    assert res.status_code == 422 and "120 MP" in res.json()["detail"]
    r = default_record("python").model_dump()
    r["source"] = "import matplotlib.pyplot as plt\nplt.figure(figsize=(30, 30))\nplt.plot([1])\n"
    res = export(r, "png", dpi=1000)                                   # custom script: the runner enforces the cap
    assert res.status_code == 422 and "limit" in res.json()["detail"]


def test_invalid_figure_gives_readable_message():
    r = rec()
    r["config"]["mapping"]["y"] = ["missing_col"]
    res = export(r, "png")
    assert res.status_code == 422 and "missing_col" in res.json()["detail"]


# ----------------------------------------------------------------- py / zip
def run_standalone(source, files, tmp_path):
    (tmp_path / "figure.py").write_text(source, encoding="utf-8")
    for name, data in files.items():
        (tmp_path / name).write_bytes(data)
    proc = subprocess.run([sys.executable, "figure.py"], cwd=tmp_path, capture_output=True, text=True, timeout=120,
                          env={"MPLBACKEND": "Agg", "PATH": "/usr/bin:/bin", "HOME": str(tmp_path),
                               "MPLCONFIGDIR": str(tmp_path)})
    assert proc.returncode == 0, proc.stderr
    return proc


def test_py_script_header_and_runner_reproduces_size():
    res = export(rec(6, 4, 450), "py")
    assert res.headers["content-disposition"] == 'attachment; filename="Untitled_plot.py"'
    source = res.text
    head = source.split("\n\n", 1)[0]
    assert "Generated by Scientific Figure Studio" in head and "matplotlib" in head and "python" in head
    assert "How to run: python figure.py" in head and "Data note:" in head
    assert source.count("plt.show()") == 1 and source.rstrip().endswith("plt.show()")
    compile(source, "figure.py", "exec")
    result = run_python(source, dpi=450)
    assert result.ok, result.message
    assert (result.width_px, result.height_px) == (2700, 1800)
    assert image(export(rec(6, 4, 450), "png")).size == (result.width_px, result.height_px)


def test_py_script_runs_standalone_and_saves_png(tmp_path):
    res = export(rec(6, 4, 450), "py")
    run_standalone(res.text, {}, tmp_path)
    out = tmp_path / "Untitled_plot.png"
    assert out.exists() and Image.open(out).size == (2700, 1800)


def test_custom_py_keeps_user_script_and_size():
    r = default_record("python").model_dump()
    r["source"], r["export"]["dpi"] = SCRIPT, 300
    source = export(r, "py").text
    assert SCRIPT in source and "own script" in source.split("\n\n", 1)[0]
    result = run_python(source, dpi=300)
    assert result.ok and (result.width_px, result.height_px) == (1200, 900)


def test_bundle_zip_with_companion_data(tmp_path):
    r = big_rec()
    res = export(r, "bundle")
    assert res.status_code == 200 and res.headers["content-type"] == "application/zip"
    assert res.headers["content-disposition"] == 'attachment; filename="Untitled_plot.zip"'
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        assert sorted(zf.namelist()) == ["data.csv", "figure.py"]
        source, data = zf.read("figure.py").decode(), zf.read("data.csv")
    assert "data.csv" in source.split("\n\n", 1)[0] and len(data.splitlines()) == 2501
    run_standalone(source, {"data.csv": data}, tmp_path)
    assert Image.open(tmp_path / "Untitled_plot.png").size == (2700, 1800)
    res = export(r, "py")                                              # a lone script would not run without its data
    assert res.status_code == 400 and "bundle" in res.json()["detail"]


def test_bundle_without_data_is_a_zip_with_script_only():
    res = export(rec(), "bundle")
    with zipfile.ZipFile(io.BytesIO(res.content)) as zf:
        assert zf.namelist() == ["figure.py"]


def test_helpers():
    assert export_core.safe_stem("a b/c") == "a_b_c" and export_core.safe_stem("") == "figure"
    assert len(export_core.safe_stem("x" * 500)) == 80
    assert export_core.pixels(0.5, 0.5, 72) == {"wPx": 36, "hPx": 36, "megapixels": 0.0}


# ------------------------------------------------------------------ LaTeX records: tex / pdf / png (contract s4j)
def latex_rec(mode="document", native=False, w=3.0, dpi=300, source=None):
    r = default_record("latex", name="Tex fig").model_dump()
    r.update(source=source or "\\documentclass{article}\n\\begin{document}\nHello $x^2$\n\\end{document}\n", sourceMode="custom")
    r["latex"].update(mode=mode, native=native)
    r["export"].update(wIn=w, hIn=2.0, dpi=dpi)
    return r


needs_tex = pytest.mark.skipif(export_core.latex_core.find_engine("pdflatex") is None, reason="no TeX engine installed")


def test_latex_tex_export_is_the_complete_file_and_other_kinds_refuse_tex():
    r = latex_rec()
    res = export(r, "tex")
    assert res.status_code == 200 and res.content.decode() == r["source"] and 'filename="Tex_fig.tex"' in res.headers["content-disposition"]
    frag = latex_rec(mode="fragment", source="$x$")
    body = export(frag, "tex").content.decode()
    assert body.startswith("\\documentclass") and "$x$" in body and body.rstrip().endswith("\\end{document}")
    assert export(rec(), "tex").status_code == 400
    assert export(latex_rec(source="  "), "tex").status_code == 422
    assert export(latex_rec(), "py").status_code == 400


def test_latex_transparent_png_is_refused_without_pymupdf(monkeypatch):
    monkeypatch.setattr(export_core.latex_core, "_mu", None)
    res = export(latex_rec(), "png", background="transparent")
    assert res.status_code == 422 and "PyMuPDF" in res.json()["detail"]


@needs_tex
def test_latex_pdf_and_png_export_sizes():
    assert export(latex_rec(), "pdf").content.startswith(b"%PDF")
    img = image(export(latex_rec(w=3.0, dpi=300), "png"))                # custom: width = wIn * dpi, aspect kept
    assert img.size[0] == 900
    nat = image(export(latex_rec(native=True, w=3.0, dpi=100), "png"))   # native: the page size at dpi (wIn ignored)
    assert nat.size[0] != 300 and 0.69 < nat.size[0] / nat.size[1] < 0.78
    bad = export(latex_rec(source="\\documentclass{article}\\begin{document}\\oops\\end{document}"), "png")
    assert bad.status_code == 422 and bad.json()["detail"]
