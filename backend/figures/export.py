"""POST /api/figures/export and GET /api/figures/pixels core (docs/FIGURES_CONTRACT.md s4j).

`export_figure` is blocking (the router calls it through asyncio.to_thread). It renders from the record it is given,
at the export size and dpi, never from a stored preview. Problems come back as ExportError(status, message).
"""
from __future__ import annotations

import io
import re
import unicodedata
import zipfile
from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple
from urllib.parse import quote

from pydantic import ValidationError

from backend.figures import jobs, latex as latex_core
from backend.figures.codegen import CodegenError, emit_script
from backend.figures.models import (MAX_DPI, MAX_MEGAPIXELS, MAX_PX_SIDE, MAX_SIDE_IN, MIN_DPI, MIN_SIDE_IN,
                                    FigureRecord)
from backend.figures.runner import run_python
from backend.figures.runtime import get_runtime

FORMATS = ("png", "pdf", "py", "bundle", "tex")
BACKGROUNDS = ("white", "transparent")
LARGE_MP = 50                    # above this the pixels endpoint warns that files get big
SCRIPT_NAME = "figure.py"
DATA_NAME = "data.csv"
MEDIA_TYPES = {"png": "image/png", "pdf": "application/pdf", "py": "text/x-python; charset=utf-8",
               "bundle": "application/zip", "tex": "application/x-tex; charset=utf-8"}
_SHOW_LINE = re.compile(r"(?:\r?\n)plt\.show\(\)\s*$")


class ExportError(Exception):
    """Export refused or failed. `status` is the HTTP status the router answers with."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status, self.message = status, message


@dataclass
class ExportFile:
    data: bytes
    media_type: str
    filename: str


# ------------------------------------------------------------------- pixels
def pixels(w_in: float, h_in: float, dpi: float) -> Dict[str, Any]:
    """Pixel size of an export: {wPx, hPx, megapixels, warning?}. `warning` appears when the export would be refused
    (per-side / megapixel cap) or is large; nothing is clamped, the numbers are always inches x dpi."""
    wpx, hpx = round(w_in * dpi), round(h_in * dpi)
    mp = round(wpx * hpx / 1e6, 2)
    out: Dict[str, Any] = {"wPx": wpx, "hPx": hpx, "megapixels": mp}
    if wpx > MAX_PX_SIDE or hpx > MAX_PX_SIDE:
        out["warning"] = (f"{wpx} x {hpx} px is more than the {MAX_PX_SIDE} px per-side limit; "
                          "export is refused. Lower the DPI or the size.")
    elif wpx * hpx > MAX_MEGAPIXELS * 1_000_000:
        out["warning"] = (f"{mp:g} megapixels is more than the {MAX_MEGAPIXELS} MP limit; "
                          "export is refused. Lower the DPI or the size.")
    elif wpx * hpx > LARGE_MP * 1_000_000:
        out["warning"] = f"{mp:g} megapixels makes a very large file that can take a while to render."
    return out


# ------------------------------------------------------------------ request
def parse_request(body: Any) -> Tuple[Dict[str, Any], str, Optional[int], Optional[str]]:
    """-> (record dict, format, dpi or None, background or None). Raises ExportError(400)."""
    if not isinstance(body, dict):
        raise ExportError(400, 'Send JSON like {"record": {...}, "format": "png"}.')
    record = body.get("record")
    if not isinstance(record, dict):
        raise ExportError(400, "'record' must be a figure record object.")
    fmt = body.get("format")
    if fmt not in FORMATS:
        raise ExportError(400, "'format' must be one of: png, pdf, py, bundle, tex.")
    dpi = body.get("dpi")
    if dpi is not None and (isinstance(dpi, bool) or not isinstance(dpi, int) or not MIN_DPI <= dpi <= MAX_DPI):
        raise ExportError(400, f"'dpi' must be a whole number from {MIN_DPI} to {MAX_DPI}.")
    background = body.get("background")
    if background is not None and background not in BACKGROUNDS:
        raise ExportError(400, "'background' must be 'white' or 'transparent'.")
    return record, fmt, dpi, background


def safe_stem(name: Any, fallback: str = "figure") -> str:
    stem = re.sub(r"[^\w\-.]+", "_", name if isinstance(name, str) else "").strip("_.")
    return stem[:80].strip("_.") or fallback


def content_disposition(filename: str) -> str:
    """ASCII `filename` plus an RFC 5987 `filename*` when the real name is not ASCII (headers are latin-1 only)."""
    ascii_name = unicodedata.normalize("NFKD", filename).encode("ascii", "ignore").decode("ascii")
    ascii_name = re.sub(r"[^\w\-.]+", "_", ascii_name).strip("_") or "figure"
    if ascii_name == filename:
        return f'attachment; filename="{filename}"'
    ext = filename.rsplit(".", 1)[-1] if "." in filename else ""
    if ext and not ascii_name.endswith("." + ext):
        ascii_name += "." + ext
    return f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{quote(filename, safe="")}'


# ------------------------------------------------------------------- script
def _py_header(rec: Dict[str, Any], dpi: int, w_in: Optional[float], h_in: Optional[float], has_data: bool,
               custom: bool) -> str:
    rt = get_runtime()
    versions = ", ".join(f"{k} {rt.get(k) or 'not installed'}" for k in ("python", "matplotlib", "numpy", "pandas", "scipy"))
    size = f"{w_in:g} x {h_in:g} in at {dpi} dpi" if w_in else f"the size set in the script, at {dpi} dpi"
    name = " ".join(str(rec["name"]).split()) or "Untitled figure"
    lines = [f"# Figure: {name}",
             "# Generated by Scientific Figure Studio (Laurevine Rose).",
             f"# Created with: {versions}.",
             f"# How to run: python {SCRIPT_NAME}   (needs matplotlib and numpy" + (", and pandas)" if has_data else ")"),
             f"# Output: the image is saved next to the script as {safe_stem(rec['name'])}.png ({size}).",
             ]
    if has_data:
        lines.append(f"# Data note: the values are in {DATA_NAME}; keep it in the same folder and run the script from there.")
    elif custom:
        lines.append("# Data note: this is your own script; any data it reads is not included unless it is in the script.")
    else:
        lines.append("# Data note: the data is written into this script; there is no separate data file.")
    return "\n".join(lines) + "\n\n"


def _save_block(rec: Dict[str, Any], dpi: int) -> str:
    out = safe_stem(rec["name"]) + ".png"
    return ("\n# --- Save at export resolution ---\n"
            f"OUTPUT_FILE = {out!r}\nDPI = {dpi}\n"
            "if plt.get_fignums():\n"
            "    plt.figure(min(plt.get_fignums()))\n"
            "    plt.savefig(OUTPUT_FILE, dpi=DPI, facecolor='white', bbox_inches=None)\n"
            "    print('Saved', OUTPUT_FILE)\n"
            "plt.show()\n")


def build_script(rec: Dict[str, Any], dpi: int) -> Tuple[str, Dict[str, bytes]]:
    """Self-contained script for a validated record: header + the figure code + a save step. -> (source, files)."""
    files: Dict[str, bytes] = {}
    if rec["sourceMode"] == "custom":
        if not rec["source"].strip():
            raise ExportError(422, "The Python script is empty.")
        body, w_in, h_in = rec["source"], None, None
    else:
        try:
            script = emit_script(rec)
        except CodegenError as exc:
            msg = "; ".join(i["message"] for i in exc.issues[:3])
            raise ExportError(422, f"The script could not be generated: {msg}")
        body, files = script.source, dict(script.files)
        w_in, h_in = rec["export"]["wIn"], rec["export"]["hIn"]
    if not body.endswith("\n"):
        body += "\n"
    stripped = _SHOW_LINE.sub("\n", body.rstrip("\n") + "\n") if rec["sourceMode"] != "custom" else body
    source = _py_header(rec, dpi, w_in, h_in, DATA_NAME in files, rec["sourceMode"] == "custom") + stripped \
        + _save_block(rec, dpi)
    return source, files


# ------------------------------------------------------------------- export
def _size_check(rec: Dict[str, Any], dpi: int) -> None:
    if rec["sourceMode"] == "custom":           # the script sets its own size; the runner checks the caps
        return
    w_in, h_in = rec["export"]["wIn"], rec["export"]["hIn"]
    if rec["kind"] == "composite":              # the canvas grows to hold the panels at their own size
        from backend.figures.codegen.composite import plan_for
        pl = plan_for(rec)
        w_in, h_in = pl.canvas_w, pl.canvas_h
    info = pixels(w_in, h_in, dpi)
    if "warning" in info and "refused" in info["warning"]:
        raise ExportError(422, info["warning"].replace("export is refused. ", ""))


def _export_latex(rec: Dict[str, Any], fmt: str, dpi: Optional[int], background: Optional[str]) -> ExportFile:
    """kind 'latex': tex = the complete compilable file, pdf = the compiled PDF, png = page 1 at the record's export dpi
    (width = export.wIn unless latex.native, aspect kept). Compiled NOW from the record's source."""
    if fmt in ("py", "bundle"):
        raise ExportError(400, "LaTeX figures export as PNG, PDF or .tex.")
    stem, src, lx = safe_stem(rec["name"]), rec["source"], rec["latex"]
    if not src.strip():
        raise ExportError(422, "The LaTeX source is empty.")
    if fmt == "tex":
        if lx["mode"] == "document":
            return ExportFile(src.replace("\r\n", "\n").encode("utf-8"), MEDIA_TYPES["tex"], f"{stem}.tex")
        wr = latex_core.preview_wrapper(src)
        if not wr["ok"]:
            raise ExportError(422, wr["message"])
        return ExportFile(wr["tex"].encode("utf-8"), MEDIA_TYPES["tex"], f"{stem}.tex")
    background = background or rec["export"]["background"]
    dpi = dpi or rec["export"]["dpi"]
    w_in = None if lx["native"] else rec["export"]["wIn"]
    if fmt == "png" and background == "transparent" and not latex_core.alpha_supported():
        raise ExportError(422, "Transparent PNG export is not available for LaTeX figures: "
                              "the rasterizer (pdftoppm) always renders on a white background. "
                              "Choose a white background, or export as PDF.")
    res = latex_core.compile_latex(src, lx["mode"], lx["engine"])
    if res.status != "ok":
        raise ExportError(422, res.message or "The LaTeX source could not be compiled.")
    if fmt == "pdf":
        return ExportFile(res.pdf, MEDIA_TYPES["pdf"], f"{stem}.pdf")
    try:
        ras = latex_core.rasterize_pdf(res.pdf, dpi, w_in, background == "transparent")
    except latex_core.RenderError as exc:
        raise ExportError(422, str(exc))
    return ExportFile(ras["png"], MEDIA_TYPES["png"], f"{stem}.png")


def export_figure(record: Dict[str, Any], fmt: str, dpi: Optional[int] = None,
                  background: Optional[str] = None, job: Optional[jobs.Job] = None) -> ExportFile:
    try:
        rec = FigureRecord.model_validate(record).model_dump()
    except ValidationError as exc:
        where = ".".join(str(p) for p in exc.errors()[0]["loc"]) or "record"
        raise ExportError(400, f"The figure settings are not valid at '{where}': "
                               f"{exc.errors()[0]['msg'].removeprefix('Value error, ')}.")
    if rec["kind"] == "latex":
        return _export_latex(rec, fmt, dpi, background)
    if fmt == "tex":
        raise ExportError(400, "'tex' is only available for LaTeX figures.")
    if rec["kind"] == "composite":
        if fmt in ("py", "bundle"):
            raise ExportError(422, "A multi-panel figure can be exported as PNG or PDF; Python export is not available for it.")
        if background == "transparent":
            raise ExportError(422, "A transparent background is not available for multi-panel figures.")
        if not any(p["record"] for p in rec["composite"]["panels"]):
            raise ExportError(422, "Add a plot to at least one panel first.")
    if background == "transparent" and fmt in ("py", "bundle"):
        raise ExportError(400, "A transparent background is only available for PNG and PDF; a script is saved with a "
                               "white background. Choose white or export PNG / PDF.")
    background = background or rec["export"]["background"]
    dpi = dpi or rec["export"]["dpi"]
    stem = safe_stem(rec["name"])

    if fmt in ("py", "bundle"):
        source, files = build_script(rec, dpi)
        data = files.get(DATA_NAME)
        if fmt == "py" and data is not None:
            raise ExportError(400, "This figure keeps its values in a data file; export 'bundle' to get the script "
                                   "and data.csv together.")
        if fmt == "py":
            return ExportFile(source.encode("utf-8"), MEDIA_TYPES["py"], f"{stem}.py")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr(SCRIPT_NAME, source)
            for name, content in files.items():
                zf.writestr(name, content)
        return ExportFile(buf.getvalue(), MEDIA_TYPES["bundle"], f"{stem}.zip")

    # png / pdf: render from the CURRENT record at its export size, never from a preview
    _size_check(rec, dpi)
    if rec["sourceMode"] == "custom":
        if not rec["source"].strip():
            raise ExportError(422, "The Python script is empty.")
        source, files = rec["source"], {}
    else:
        try:
            script = emit_script(rec)
        except CodegenError as exc:
            raise ExportError(422, "The figure could not be generated: " + "; ".join(i["message"] for i in exc.issues[:3]))
        source, files = script.source, script.files
    job = job or jobs.create()
    try:
        with jobs.slot(job):
            res = run_python(source, dpi=dpi, out_format=fmt, transparent=background == "transparent",
                             files=files, cancel=job.event)
    except jobs.Cancelled:
        raise ExportError(504 if job.timed_out else 499, job.timeout_message() if job.timed_out else "The export was cancelled.")
    except ValueError as exc:
        raise ExportError(400, str(exc))
    finally:
        jobs.finish(job, cancelled=job.cancelled)
    if res.status == "cancelled":
        raise ExportError(504 if job.timed_out else 499, job.timeout_message() if job.timed_out else "The export was cancelled.")
    if not res.ok:
        raise ExportError(422, res.message or "The figure could not be rendered.")
    payload = res.png_bytes if fmt == "png" else res.pdf_bytes
    if not payload:
        raise ExportError(500, "The renderer produced no output.")
    return ExportFile(payload, MEDIA_TYPES[fmt], f"{stem}.{fmt}")
