"""LaTeX backend: backend/figures/latex.py, templates.py, router.py (docs/FIGURES_CONTRACT.md s4u).

Tests that need a TeX engine skip themselves when none is installed; everything else (log parsing, wrapper, request
validation, rasterizing, the no_compiler path) runs without TeX."""
import base64
import io
import os
import shutil
import subprocess
import time

import pytest
from fastapi.testclient import TestClient
from matplotlib.figure import Figure
from PIL import Image

from backend.figures import latex
from backend.server import app

client = TestClient(app)
COMPILE, RENDER, TEMPLATES = "/api/figures/latex/compile", "/api/figures/latex/render", "/api/figures/latex/templates"


def _has_sty(name):
    kpse = shutil.which("kpsewhich")
    return bool(kpse and subprocess.run([kpse, name], capture_output=True, text=True).stdout.strip())


needs_tex = pytest.mark.skipif(latex.find_engine("pdflatex") is None, reason="no TeX engine installed")
needs_pgf = pytest.mark.skipif(latex.find_engine("pdflatex") is None or not (_has_sty("pgfplots.sty") and _has_sty("pgfplotstable.sty")),
                               reason="pdflatex with pgfplots is not installed")
DOC = "\\documentclass{article}\n\\begin{document}\nHello $x^2$\n\\end{document}\n"


def make_pdf(w_in=2.0, h_in=1.0):
    fig = Figure(figsize=(w_in, h_in))
    fig.text(0.1, 0.4, "Hi", fontsize=20)
    buf = io.BytesIO()
    fig.savefig(buf, format="pdf", transparent=True)
    return buf.getvalue()


def png_of(url):
    assert url.startswith("data:image/png;base64,")
    return Image.open(io.BytesIO(base64.b64decode(url.split(",", 1)[1]))).convert("RGB")


def non_blank(img):
    return img.getextrema() != ((255, 255),) * 3


def post(url, **body):
    res = client.post(url, json=body)
    assert res.status_code == 200, res.text
    return res.json()


# ------------------------------------------------------------------ wrapper (no TeX)
def test_wrapper_is_exact_and_conditional():
    w = latex.build_wrapper("$x$")
    assert w["prefix"].startswith("\\documentclass[border=4pt]{standalone}") and w["prefix"].endswith("\\begin{document}\n")
    assert w["suffix"] == "\n\\end{document}\n" and w["lineOffset"] == w["prefix"].count("\n")
    assert "pgfplots" not in w["prefix"] and "{tikz}" not in w["prefix"]
    assert "\\usepackage{pgfplots}" in latex.build_wrapper("\\begin{axis}\\end{axis}")["prefix"]
    assert "\\usepackage{tikz}" in latex.build_wrapper("\\begin{tikzpicture}\\end{tikzpicture}")["prefix"]
    assert latex.build_wrapper("x\n")["suffix"] == "\\end{document}\n"


# ------------------------------------------------------------------ log parsing (no TeX)
def test_parse_log_file_line_error_maps_to_source_lines():
    log = "./main.tex:9: Undefined control sequence.\nl.9 \\foo\n\n./main.tex:3: Missing $ inserted.\n./main.tex:12: ==> x\n"
    p = latex.parse_log(log, offset=5, source_lines=10)
    assert p["errors"][0] == {"line": 4, "message": "Undefined control sequence.", "context": "\\foo"}
    assert p["errors"][1] == {"line": None, "message": "Missing $ inserted.", "inWrapper": True}     # inside the wrapper
    assert len(p["errors"]) == 2                                                                      # `==>` noise dropped
    assert latex.parse_log("./main.tex:9: Oops.", offset=0)["errors"][0]["line"] == 9               # document mode: untouched
    assert latex.parse_log("./main.tex:99: Late.", offset=5, source_lines=10)["errors"][0]["inWrapper"] is True


def test_parse_log_other_file_and_bang_format():
    p = latex.parse_log("/usr/share/texlive/x/foo.sty:42: Package foo Error: bad.\n", offset=5)
    assert p["errors"][0]["file"].endswith("foo.sty") and p["errors"][0]["line"] == 42
    p = latex.parse_log("! Undefined control sequence.\n<recently read> \\bar\n\nl.7 \\bar\n")
    assert p["errors"] == [{"line": 7, "message": "Undefined control sequence.", "context": "\\bar"}]


def test_parse_log_missing_files_overfull_rerun():
    log = ("! LaTeX Error: File `nopkg.sty' not found.\n! LaTeX Error: File `fig.png' not found.\n"
           "./main.tex:4: I can't find file `data'.\nThe font \"Nope Sans\" cannot be found.\n"
           "Overfull \\hbox (3.0pt too wide) in paragraph at lines 5--6\nOverfull \\vbox (1pt too high) has occurred\n"
           "Underfull \\hbox (badness 10000)\nLaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.\n")
    p = latex.parse_log(log)
    kinds = {m["file"]: m["kind"] for m in p["missing"]}
    assert kinds == {"nopkg.sty": "package", "fig.png": "file", "data": "file", "Nope Sans": "font"}
    pkg = p["missing"][0]["message"]
    assert "nopkg.sty" in pkg and "TeX distribution" in pkg and "never downloads packages" in pkg
    assert p["overfull"] == 2 and p["rerun"] is True
    assert latex.parse_log("Output written on main.pdf (1 page).")["rerun"] is False


# ------------------------------------------------------------------ requests, templates, no_compiler (no TeX)
def test_templates_endpoint_shape():
    t = client.get(TEMPLATES).json()["templates"]
    assert [x["id"] for x in t] == ["line_plot", "scatter_fit", "grouped_bar", "document_math"]
    for x in t:
        assert set(x) == {"id", "name", "description", "mode", "engine", "source"} and x["mode"] == "document" and x["engine"] == "pdflatex"
        assert x["source"].lstrip().startswith("\\documentclass") and "\\end{document}" in x["source"]
    assert all("pgfplots" in x["source"] for x in t[:3]) and "amsmath" in t[3]["source"]
    assert not any(w in x["source"].lower() for x in t for w in ("todo", "coming soon", "pending"))


@pytest.mark.parametrize("url,body,code", [
    (COMPILE, {"source": 5}, 400), (COMPILE, {}, 400), (COMPILE, {"source": "x", "mode": "bogus"}, 400),
    (COMPILE, {"source": "x", "engine": "bash"}, 400), (COMPILE, {"source": "x", "dpi": 10}, 400),
    (COMPILE, {"source": "x", "dpi": 100.5}, 400), (COMPILE, [1], 400),
    (RENDER, {}, 400), (RENDER, {"source": "x", "pdfBase64": "AAAA"}, 400), (RENDER, {"pdfBase64": "!!!"}, 400),
    (RENDER, {"source": "x", "wIn": 0.1}, 400), (RENDER, {"source": "x", "wIn": "a"}, 400), (RENDER, {"source": "x", "dpi": 5000}, 400),
])
def test_malformed_requests_are_400(url, body, code):
    assert client.post(url, json=body).status_code == code


def test_content_type_and_json_errors():
    assert client.post(COMPILE, content="x", headers={"content-type": "text/plain"}).status_code == 415
    assert client.post(COMPILE, content="{oops", headers={"content-type": "application/json"}).status_code == 400


def test_empty_and_wrong_mode_sources_are_invalid_not_run(monkeypatch):
    monkeypatch.setattr(latex.subprocess, "Popen", lambda *a, **k: pytest.fail("nothing may run"))
    assert post(COMPILE, source="  \n")["status"] == "invalid"
    r = post(COMPILE, source="\\documentclass{article}\\begin{document}x\\end{document}", mode="fragment")
    assert r["status"] == "invalid" and "mode to document" in r["message"] and r["ok"] is False
    assert latex.compile_latex("x" * (latex.MAX_SOURCE_CHARS + 1)).status == "invalid"


def test_no_compiler_path(monkeypatch):
    monkeypatch.setattr(latex, "find_engine", lambda e: None)
    monkeypatch.setattr(latex.subprocess, "Popen", lambda *a, **k: pytest.fail("nothing may run"))
    r = post(COMPILE, source=DOC, engine="lualatex")
    assert r["status"] == "no_compiler" and r["ok"] is False and r["preview"] is None and r["pdfBase64"] is None
    assert "lualatex" in r["message"] and "TeX distribution" in r["message"] and r["errors"] == []
    f = post(COMPILE, source="$x$", mode="fragment")
    assert f["status"] == "no_compiler" and f["wrapped"] is True and f["wrapper"]["prefix"].startswith("\\documentclass")
    assert post(RENDER, source=DOC)["status"] == "no_compiler"


def test_asset_names_are_restricted(tmp_path):
    for bad in ("../x.png", "/abs.png", "a/../b.png", ".hidden.png", "main.tex", "x.exe", "c:x.png", ""):
        with pytest.raises(ValueError):
            latex._write_assets(tmp_path, {bad: b"x"})
    latex._write_assets(tmp_path, {"img/a.png": b"x", "data.csv": "a,b"})
    assert (tmp_path / "img" / "a.png").read_bytes() == b"x" and (tmp_path / "data.csv").read_text() == "a,b"


# ------------------------------------------------------------------ rasterizing and /latex/render from a PDF (no TeX)
def test_render_from_pdf_natural_and_scaled_width():
    pdf64 = base64.b64encode(make_pdf(2, 1)).decode()
    r = post(RENDER, pdfBase64=pdf64, dpi=100)
    assert r["ok"] and r["status"] == "ok" and (r["widthPx"], r["heightPx"]) == (200, 100) and r["pages"] == 1 and r["dpi"] == 100
    img = png_of(r["preview"])
    assert img.size == (200, 100) and non_blank(img)
    r = post(RENDER, pdfBase64="data:application/pdf;base64," + pdf64, dpi=300, wIn=3)       # width = wIn * dpi, aspect kept
    assert (r["widthPx"], r["heightPx"]) == (900, 450) and png_of(r["preview"]).size == (900, 450)


def test_render_failures_are_distinguished():
    r = post(RENDER, pdfBase64=base64.b64encode(b"hello").decode())
    assert r["status"] == "render_failed" and r["ok"] is False and r["preview"] is None and "not a PDF" in r["message"]
    r = post(RENDER, pdfBase64=base64.b64encode(b"%PDF-1.4 garbage").decode())
    assert r["status"] == "render_failed"
    r = post(RENDER, pdfBase64=base64.b64encode(make_pdf()).decode(), wIn=30, dpi=1200)      # 36000 px wide
    assert r["status"] == "invalid" and "px" in r["message"]
    big = base64.b64encode(make_pdf(30, 30)).decode()
    r = post(RENDER, pdfBase64=big, dpi=1000)                                              # 30000 px per side
    assert r["status"] == "render_failed" and "limit" in r["message"]
    assert post(RENDER, pdfBase64=big, dpi=200)["ok"] is True                              # 6000 x 6000 = 36 MP


def test_pdf_size_cap(monkeypatch):
    monkeypatch.setattr(latex, "MAX_PDF_BYTES", 100)
    r = post(RENDER, pdfBase64=base64.b64encode(make_pdf()).decode())
    assert r["status"] == "render_failed" and "limit" in r["message"]


@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="pdftoppm not installed")
def test_pdftoppm_is_the_sole_rasterizer():
    """pdftoppm is the only supported rasterizer after PyMuPDF removal."""
    pdf = make_pdf(2, 1)
    ras = latex.rasterize_pdf(pdf, 100)
    assert ras["rasterizer"] == "pdftoppm" and (ras["widthPx"], ras["heightPx"]) == (200, 100)
    assert latex.rasterize_pdf(pdf, 300, 3)["widthPx"] == 900
    assert latex.pdf_pages(pdf) in (1, None)
    r = post(RENDER, pdfBase64=base64.b64encode(pdf).decode(), dpi=100)
    assert r["ok"] and r["rasterizer"] == "pdftoppm"


def test_no_rasterizer_is_render_failed_but_keeps_pdf(monkeypatch):
    pdf = make_pdf()
    monkeypatch.setattr(latex, "compile_latex", lambda *a, **k: latex.CompileResult("ok", pdf=pdf, pages=1))
    monkeypatch.setattr(latex.shutil, "which", lambda n: None)
    r = post(COMPILE, source=DOC)
    assert r["status"] == "render_failed" and r["ok"] is False and r["preview"] is None
    assert "rasterizer" in r["message"] and base64.b64decode(r["pdfBase64"]) == pdf


def test_compile_preview_caps_dpi_at_150(monkeypatch):
    pdf = make_pdf(2, 1)
    monkeypatch.setattr(latex, "compile_latex", lambda *a, **k: latex.CompileResult("ok", pdf=pdf, pages=1))
    r = post(COMPILE, source=DOC, dpi=600)
    assert r["dpi"] == 150 and r["widthPx"] == 300 and r["ok"] and r["status"] == "ok"
    assert base64.b64decode(r["pdfBase64"]).startswith(b"%PDF") and png_of(r["preview"]).size == (300, 150)


# ------------------------------------------------------------------ real TeX
@needs_tex
def test_document_mode_is_compiled_unmodified_in_fresh_dirs(monkeypatch):
    seen = []
    real = latex._run_engine

    def spy(exe, root, work, remaining):
        seen.append((str(work), (work / "main.tex").read_text(), sorted(p.name for p in work.iterdir())))
        return real(exe, root, work, remaining)

    monkeypatch.setattr(latex, "_run_engine", spy)
    for _ in range(2):
        r = post(COMPILE, source=DOC.replace("\n", "\r\n"), mode="document", dpi=72)
        assert r["ok"] and r["wrapped"] is False and r["wrapper"] is None and r["errors"] == [] and r["passes"] == 1
    assert seen[0][1] == DOC and seen[1][1] == DOC                      # byte for byte (newlines normalised)
    assert seen[0][0] != seen[1][0] and seen[1][2] == ["main.tex"]       # fresh folder, nothing stale
    assert not os.path.exists(seen[0][0])                                # and removed afterwards


@needs_tex
def test_compile_ok_response_shape_and_preview():
    r = post(COMPILE, source=DOC, dpi=100)
    assert r["ok"] and r["status"] == "ok" and r["message"] == "" and r["pages"] == 1 and r["dpi"] == 100
    assert base64.b64decode(r["pdfBase64"]).startswith(b"%PDF")
    img = png_of(r["preview"])
    assert img.size == (r["widthPx"], r["heightPx"]) and non_blank(img) and r["log"] and r["durationMs"] >= 0
    assert r["missing"] == [] and r["overfull"] == 0


@needs_tex
def test_fragment_is_wrapped_and_errors_map_to_fragment_lines():
    r = post(COMPILE, source="$a + b$", mode="fragment", dpi=100)
    assert r["ok"] and r["wrapped"] is True and "standalone" in r["wrapper"]["prefix"]
    bad = "$a$\n$b$\n\\undefinedmacro\n$c$\n"
    r = post(COMPILE, source=bad, mode="fragment")
    assert r["status"] == "compile_failed" and r["ok"] is False and r["preview"] is None and r["pdfBase64"] is None
    assert r["errors"][0]["line"] == 3 and "Undefined control sequence" in r["errors"][0]["message"]
    assert r["message"] == "Line 3: Undefined control sequence."
    assert r["wrapper"]["prefix"] + bad + r["wrapper"]["suffix"] != bad


@needs_tex
def test_document_error_lines_are_file_lines():
    r = post(COMPILE, source="\\documentclass{article}\n\\begin{document}\n\n\\oops\n\\end{document}\n")
    assert r["status"] == "compile_failed" and r["wrapped"] is False and r["errors"][0]["line"] == 4


@needs_tex
def test_missing_package_is_named():
    r = post(COMPILE, source="\\documentclass{article}\n\\usepackage{definitelynotapkg}\n\\begin{document}x\\end{document}")
    assert r["status"] == "compile_failed"
    assert r["missing"][0]["file"] == "definitelynotapkg.sty" and r["missing"][0]["kind"] == "package"
    assert "definitelynotapkg.sty" in r["message"] and "never downloads packages" in r["message"]


@needs_tex
def test_overfull_count_and_rerun_pass():
    r = post(COMPILE, source="\\documentclass{article}\n\\begin{document}\n\\hbox to 10pt{\\rule{30pt}{5pt}}\n\\end{document}\n")
    assert r["ok"] and r["overfull"] >= 1
    r = post(COMPILE, source="\\documentclass{article}\n\\begin{document}\n\\section{A}\\label{a}\nSee \\ref{a}.\n\\end{document}\n")
    assert r["ok"] and r["passes"] == 2 and "undefined" not in r["log"].lower().replace("undefined references", "")


@needs_tex
def test_timeout_kills_the_engine():
    t0 = time.monotonic()
    res = latex.compile_latex("\\documentclass{article}\n\\begin{document}\n\\def\\a{\\a}\\a\n\\end{document}\n", timeout=2)
    assert res.status == "timeout" and not res.ok and "2 s" in res.message and time.monotonic() - t0 < 15


@needs_tex
def test_no_shell_escape_and_no_reading_outside(tmp_path, monkeypatch):
    marker = tmp_path / "pwned.txt"
    r = latex.compile_latex(f"\\documentclass{{article}}\n\\begin{{document}}\n\\immediate\\write18{{touch {marker}}}x\n\\end{{document}}\n")
    assert not marker.exists() and r.status in ("ok", "compile_failed")
    secret = tmp_path / "secret.tex"
    secret.write_text("\\typeout{LEAKED-CONTENT}\n")
    r = latex.compile_latex(f"\\documentclass{{article}}\n\\begin{{document}}\n\\input{{{secret}}}\n\\end{{document}}\n")
    assert "LEAKED-CONTENT" not in r.log and r.status == "compile_failed"


@needs_tex
def test_environment_is_scrubbed(monkeypatch, tmp_path):
    monkeypatch.setenv("MY_SECRET_TOKEN", "hunter2")
    monkeypatch.setenv("TEXINPUTS", "/tmp/evil")
    env = latex._tex_env(tmp_path, tmp_path / "work")
    assert "MY_SECRET_TOKEN" not in env and env["TEXINPUTS"] == str(tmp_path / "work") + os.pathsep
    assert env["openout_any"] == "p" and env["openin_any"] == "p" and "PATH" in env
    assert latex.FLAGS == ("-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "-file-line-error")


@needs_tex
def test_assets_are_available_to_the_source():
    res = latex.compile_latex("\\documentclass{article}\n\\begin{document}\n\\input{part.tex}\n\\end{document}\n",
                              assets={"part.tex": "Included $y$ text."})
    assert res.ok and res.pages == 1


@needs_tex
def test_render_final_from_source_scales_to_width():
    r = post(RENDER, source="$E = mc^2$", mode="fragment", wIn=4, dpi=200)
    assert r["ok"] and r["widthPx"] == 800 and r["wrapped"] is True and non_blank(png_of(r["preview"]))
    assert post(RENDER, source="\\oops", mode="fragment")["status"] == "compile_failed"


@needs_pgf
def test_every_template_compiles_and_renders():
    for t in client.get(TEMPLATES).json()["templates"]:
        r = post(COMPILE, source=t["source"], mode=t["mode"], engine=t["engine"], dpi=100)
        assert r["ok"], (t["id"], r["message"], r["errors"])
        assert r["pages"] == 1 and non_blank(png_of(r["preview"]))
        assert r["overfull"] == 0, t["id"]


@pytest.mark.parametrize("engine", ["xelatex", "lualatex"])
def test_other_engines(engine):
    if latex.find_engine(engine) is None:
        pytest.skip(f"{engine} not installed")
    assert post(COMPILE, source=DOC, engine=engine, dpi=72)["ok"] is True


WRAPPER = "/api/figures/latex/wrapper"


def test_wrapper_endpoint_runs_nothing_and_matches_compile_wrapper():
    r = client.post(WRAPPER, json={"source": "$x^2$"}).json()
    w = latex.build_wrapper("$x^2$\n".replace("\n", ""))
    assert r["ok"] and r["wrapper"]["prefix"] == w["prefix"] and r["tex"] == w["prefix"] + "$x^2$" + w["suffix"]
    assert r["wrapper"]["lineOffset"] == w["prefix"].count("\n")


def test_wrapper_endpoint_refusals():
    assert client.post(WRAPPER, json={"source": "  "}).json()["ok"] is False
    full = client.post(WRAPPER, json={"source": "\\documentclass{article}"}).json()
    assert full["ok"] is False and full["wrapper"] is None
    assert client.post(WRAPPER, json={"source": 3}).status_code == 400
    assert client.post(WRAPPER, content="x", headers={"content-type": "text/plain"}).status_code == 415


# ------------------------------------------------------------------ export bar / final PNG from the compiled PDF (contract s4u, s4v)
def test_render_keeps_aspect_for_any_width_never_stretches():
    pdf64 = base64.b64encode(make_pdf(3, 2)).decode()                  # page 3 x 2 in, aspect 1.5
    for w_in, dpi in [(1, 100), (2.5, 300), (7, 150), (0.5, 1200)]:
        r = post(RENDER, pdfBase64=pdf64, dpi=dpi, wIn=w_in)
        assert r["ok"] and r["widthPx"] == round(w_in * dpi)
        assert abs(r["heightPx"] - r["widthPx"] / 1.5) <= 1, (w_in, dpi, r["widthPx"], r["heightPx"])
        assert png_of(r["preview"]).size == (r["widthPx"], r["heightPx"])


def test_final_pixel_width_is_inches_times_dpi_and_native_uses_the_page_size():
    pdf64 = base64.b64encode(make_pdf(3, 2)).decode()
    r = post(RENDER, pdfBase64=pdf64, dpi=450)                          # native: no wIn -> the PDF page at dpi
    assert (r["widthPx"], r["heightPx"], r["dpi"]) == (1350, 900, 450)
    r = post(RENDER, pdfBase64=pdf64, dpi=300, wIn=4)                   # custom: 4 in wide at 300 dpi, height follows
    assert (r["widthPx"], r["heightPx"]) == (1200, 800)


def test_background_value_is_checked_and_transparent_always_rejected(monkeypatch):
    pdf64 = base64.b64encode(make_pdf(2, 1)).decode()
    assert client.post(RENDER, json={"pdfBase64": pdf64, "background": "red"}).status_code == 400
    # Transparent is always refused: pdftoppm draws on white; PyMuPDF has been removed
    r = post(RENDER, pdfBase64=pdf64, dpi=100, background="transparent")
    assert not r["ok"] and r["status"] == "render_failed" and r["preview"] is None
    assert "Transparent" in r["message"] or "transparent" in r["message"]
    assert post(RENDER, pdfBase64=pdf64, dpi=100, background="white")["ok"]


@pytest.mark.skipif(shutil.which("pdftoppm") is None, reason="pdftoppm not installed")
def test_white_background_renders_opaque_via_pdftoppm():
    """Transparent PNG was only available via PyMuPDF (now removed); white renders correctly via pdftoppm."""
    pdf64 = base64.b64encode(make_pdf(2, 1)).decode()
    assert not latex.alpha_supported()          # always False after PyMuPDF removal
    img = png_of(post(RENDER, pdfBase64=pdf64, dpi=100)["preview"])
    assert img.getpixel((0, 0)) == (255, 255, 255)   # white background


def test_latex_settings_new_fields_validate():
    from pydantic import ValidationError
    from backend.figures import models as fm
    s = fm.LatexSettings(native=True, lastCompile={"engine": "xelatex", "pages": 1, "passes": 2, "overfull": 0, "durationMs": 800, "at": 1, "pageWIn": 4.0, "pageHIn": 2.667},
                         assets=[{"name": "fig/a.png", "kind": "image"}])
    assert s.native and s.lastCompile.pageWIn == 4.0 and s.assets[0].kind == "image"
    assert fm.LatexSettings().native is False and fm.LatexSettings().assets == [] and fm.LatexSettings().lastCompile is None
    for bad in ({"assets": [{"name": "x", "kind": "exe"}]}, {"assets": [{"name": "", "kind": "tex"}]}, {"assets": [{"name": "a", "kind": "tex"}] * 51}, {"lastCompile": {"pages": 0}}, {"extra": 1}):
        with pytest.raises(ValidationError):
            fm.LatexSettings(**bad)


@needs_tex
def test_reopen_round_trip_recompiles_to_the_same_final_size():
    import json
    from backend.figures.models import FigureRecord, default_record
    c = post(COMPILE, source=DOC, mode="document", engine="pdflatex")
    assert c["ok"] and c["pdfBase64"]
    r = post(RENDER, pdfBase64=c["pdfBase64"], dpi=300, wIn=3)           # what Insert draws from the compiled PDF
    assert r["widthPx"] == 900
    rec = default_record("latex", name="Round trip").model_dump()
    rec.update(source=DOC, sourceMode="custom")
    rec["latex"] = {"mode": "document", "engine": "pdflatex", "native": False, "assets": [],
                    "lastCompile": {"engine": "pdflatex", "pages": c["pages"], "passes": c["passes"], "overfull": c["overfull"], "durationMs": c["durationMs"], "at": 1,
                                    "pageWIn": round(c["widthPx"] / c["dpi"], 3), "pageHIn": round(c["heightPx"] / c["dpi"], 3)}}
    rec["export"].update(wIn=3.0, hIn=round(r["heightPx"] / 300, 3), dpi=300, background="white")
    again = FigureRecord.model_validate(json.loads(json.dumps(rec))).model_dump()   # saved and reopened
    assert again["latex"] == rec["latex"] and again["export"]["dpi"] == 300
    res = client.post("/api/figures/export", json={"record": again, "format": "png"})
    assert res.status_code == 200 and Image.open(io.BytesIO(res.content)).size == (r["widthPx"], r["heightPx"])
