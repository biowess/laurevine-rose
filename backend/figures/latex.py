"""LaTeX figures: .tex -> TeX engine -> PDF -> PNG preview (docs/FIGURES_CONTRACT.md s4u).

Only the engine command runs (``<engine> -interaction=nonstopmode -halt-on-error -no-shell-escape -file-line-error main.tex``),
in a fresh temp folder with a scrubbed environment. No package is ever downloaded and no other program (bibtex, makeindex,
latexmk, ...) is started; the only other executables are the rasterizer fallbacks ``pdftoppm`` / ``pdfinfo``.
Statuses: ``ok | compile_failed | render_failed | timeout | no_compiler | invalid``.
"""
from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from backend.figures import jobs
from backend.figures.models import MAX_DPI, MAX_MEGAPIXELS, MAX_PREVIEW_CHARS, MAX_PX_SIDE, MAX_SIDE_IN, MAX_SOURCE_CHARS, MIN_DPI, MIN_SIDE_IN
from backend.figures.runner import _ENV_KEEP, MAX_STREAM_BYTES, _Capture, _kill_tree, _png_size, _remove_tree
from backend.figures.runtime import LATEX_TIMEOUT_S, TEX_ENGINES

try:                                    # PyMuPDF is the rasterizer; pdftoppm is the fallback
    import pymupdf as _mu
except ImportError:                     # pragma: no cover - depends on the machine
    try:
        import fitz as _mu
    except ImportError:
        _mu = None

MODES = ("document", "fragment")
ENGINES = TEX_ENGINES
FLAGS = ("-interaction=nonstopmode", "-halt-on-error", "-no-shell-escape", "-file-line-error")
STATUSES = ("ok", "compile_failed", "render_failed", "timeout", "no_compiler", "invalid")
DEFAULT_TIMEOUT = LATEX_TIMEOUT_S
PREVIEW_DPI_CAP = 150
DEFAULT_PREVIEW_DPI = 150
MAX_PDF_BYTES = 25 << 20                # larger PDFs are refused (render_failed)
MAX_LOG_READ = 4 << 20
LOG_HEAD, LOG_TAIL = 40 * 1024, 160 * 1024      # what the response keeps of a long log
MAX_ASSETS, MAX_ASSET_BYTES = 50, 32 << 20
ASSET_EXTS = {".png", ".jpg", ".jpeg", ".pdf", ".tex", ".sty", ".cls", ".bib", ".csv", ".dat", ".txt", ".eps", ".svg"}
SOURCE_NAME = "main.tex"
TOOL_TIMEOUT = 30
_TEX_ENV_KEEP = {"TEXMFHOME", "TEXMFVAR", "TEXMFCONFIG", "TEXMFSYSVAR", "TEXMFSYSCONFIG", "TEXMFLOCAL"}

_PKG_EXTS = {".sty", ".cls", ".clo", ".def", ".cfg", ".fd", ".ldf"}
_FLE = re.compile(r"^(?:\./)?((?:[A-Za-z]:)?[^\s:][^:\n]*?\.[A-Za-z0-9]{1,5}):(\d+): (.*)$")
_BANG = re.compile(r"^! (?!==>)(.*)$")
_LNO = re.compile(r"^l\.(\d+) ?(.*)$")
_MISSING_FILE = re.compile(r"File [`'\u2018]([^`'\u2019\n]+)['\u2019] not found|I can't find file [`'\u2018]?([^`'\u2019\n]+?)['\u2019]?\.?$", re.M)
_MISSING_FONT = re.compile(r"The font \"([^\"\n]+)\" cannot be found")
_OVERFULL = re.compile(r"^Overfull \\[hv]box", re.M)
_RERUN = re.compile(r"Rerun to get|may have changed\. Rerun|Please \(re\)run|Please rerun|rerun LaTeX", re.I)
_USES_PGFPLOTS = re.compile(r"\\addplot|\\begin\{(?:semilog|loglog)?axis\}|pgfplots|\\pgfplotsset")
_USES_TIKZ = re.compile(r"tikz|\\pgf|\\draw\b|\\node\b|\\fill\b|\\path\b|\\coordinate\b")
_EXTERNAL_PATH_BRACE = re.compile(r"\\(?:input|include|subfile|import|subimport|includefrom|inputfrom|includegraphics|openin|read|lstinputlisting|verbatiminput|addbibresource|bibliography)\b\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
_EXTERNAL_PATH_RAW = re.compile(r"\\(?:input|include|openin)\s+([^\s%{}]+)")
_EXTERNAL_PATH_ASSIGN = re.compile(r"\\openin\s*(?:\\[A-Za-z]+|\d+)\s*=?\s*([^\s%{}]+)")


def _is_external_path(p: str) -> bool:
    norm = p.strip().replace("\\", "/")
    if not norm:
        return False
    parts = norm.split("/")
    return norm.startswith("/") or (len(norm) > 1 and norm[1] == ":") or ".." in parts or norm.startswith("~")


def _find_external_path(text: str) -> Optional[str]:
    clean_lines = [line.split("%", 1)[0] for line in text.splitlines()]
    clean_text = "\n".join(clean_lines)
    for m in _EXTERNAL_PATH_BRACE.finditer(clean_text):
        for p in m.group(1).split(","):
            if _is_external_path(p):
                return p.strip()
    for m in _EXTERNAL_PATH_RAW.finditer(clean_text):
        p = m.group(1)
        if _is_external_path(p):
            return p.strip()
    for m in _EXTERNAL_PATH_ASSIGN.finditer(clean_text):
        p = m.group(1)
        if _is_external_path(p):
            return p.strip()
    return None


class RenderError(Exception):
    """The PDF is fine as far as TeX is concerned, but cannot be shown (status render_failed)."""


@dataclass
class CompileResult:
    status: str
    message: str = ""
    pdf: Optional[bytes] = None
    pages: Optional[int] = None
    log: str = ""
    errors: List[Dict[str, Any]] = field(default_factory=list)
    missing: List[Dict[str, str]] = field(default_factory=list)
    overfull: int = 0
    passes: int = 0
    wrapped: bool = False
    wrapper: Optional[Dict[str, Any]] = None
    duration_ms: int = 0

    @property
    def ok(self) -> bool:
        return self.status == "ok"


# ------------------------------------------------------------------ wrapper
def build_wrapper(source: str) -> Dict[str, Any]:
    """The standalone document around a fragment. ``prefix + source + suffix`` is the exact main.tex."""
    pkgs = ["\\usepackage{amsmath,amssymb}", "\\usepackage{xcolor}", "\\usepackage{graphicx}"]
    if _USES_PGFPLOTS.search(source):
        pkgs += ["\\usepackage{pgfplots}", "\\pgfplotsset{compat=newest}"]
    elif _USES_TIKZ.search(source):
        pkgs.append("\\usepackage{tikz}")
    prefix = "\n".join(["\\documentclass[border=4pt]{standalone}", *pkgs, "\\begin{document}"]) + "\n"
    suffix = ("" if source.endswith("\n") else "\n") + "\\end{document}\n"
    return {"prefix": prefix, "suffix": suffix, "lineOffset": prefix.count("\n")}


def preview_wrapper(source: str) -> Dict[str, Any]:
    """POST latex/wrapper: the wrapper a fragment would be compiled with, without compiling anything."""
    text = (source or "").replace("\r\n", "\n").replace("\r", "\n")
    if not text.strip():
        return {"ok": False, "message": "The LaTeX source is empty.", "wrapper": None, "tex": None}
    if re.search(r"\\documentclass|\\begin\{document\}", text):
        return {"ok": False, "message": "This source is a complete document; there is nothing to wrap.", "wrapper": None, "tex": None}
    w = build_wrapper(text)
    return {"ok": True, "message": "", "wrapper": w, "tex": w["prefix"] + text + w["suffix"]}


# ------------------------------------------------------------------ log parsing
def parse_log(log: str, *, offset: int = 0, source_lines: Optional[int] = None) -> Dict[str, Any]:
    """Pure function over a TeX log -> {errors, missing, overfull, rerun}.

    ``offset`` = number of wrapper lines before the user's source (0 in document mode); errors in main.tex are reported
    as lines of the user's source, errors inside the wrapper get ``line: None, inWrapper: True``; errors in other files
    keep that file's own line number and carry ``file``."""
    lines = log.splitlines()
    raw: List[Dict[str, Any]] = []
    for i, text in enumerate(lines):                     # `file:line: msg` (file-line-error) and plain `! msg` + `l.N`
        m = _FLE.match(text)
        if m:
            raw.append({"file": m.group(1), "line": int(m.group(2)), "message": m.group(3).strip(), "at": i})
            continue
        m = _BANG.match(text)
        if m:
            n = next((_LNO.match(x) for x in lines[i + 1:i + 8] if _LNO.match(x)), None)
            raw.append({"file": SOURCE_NAME, "line": int(n.group(1)) if n else None, "message": m.group(1).strip(), "at": i})
    raw = [e for e in raw if e["message"] and not e["message"].startswith(("==>", "Emergency stop"))]
    errors: List[Dict[str, Any]] = []
    for e in raw:
        context = ""
        for nxt in lines[e["at"] + 1:e["at"] + 8]:
            n = _LNO.match(nxt)
            if n:
                context = n.group(2).strip()
                break
        item: Dict[str, Any] = {"line": e["line"], "message": e["message"]}
        if context:
            item["context"] = context
        if os.path.basename(e["file"]) == SOURCE_NAME:
            if offset and e["line"] is not None:
                n = e["line"] - offset
                if n < 1 or (source_lines is not None and n > source_lines):
                    item.update(line=None, inWrapper=True)
                else:
                    item["line"] = n
        else:
            item["file"] = e["file"]
        if item not in errors:
            errors.append(item)
    missing: List[Dict[str, str]] = []
    for m in _MISSING_FILE.finditer(log):
        name = (m.group(1) or m.group(2) or "").strip()
        if name and all(x["file"] != name for x in missing):
            if os.path.splitext(name)[1].lower() in _PKG_EXTS:
                msg = f"'{name}' is not installed. Install it via your TeX distribution; the app never downloads packages."
                missing.append({"file": name, "kind": "package", "message": msg})
            else:
                msg = f"File '{name}' was not found. Only your source is compiled; the app supplies no other files."
                missing.append({"file": name, "kind": "file", "message": msg})
    for m in _MISSING_FONT.finditer(log):
        if all(x["file"] != m.group(1) for x in missing):
            msg = f"Font '{m.group(1)}' is not installed on this system. Install it via your OS or TeX distribution; the app never downloads fonts."
            missing.append({"file": m.group(1), "kind": "font", "message": msg})
    return {"errors": errors, "missing": missing, "overfull": len(_OVERFULL.findall(log)), "rerun": bool(_RERUN.search(log))}


def _first_message(errors: List[Dict[str, Any]], missing: List[Dict[str, str]]) -> str:
    if missing:
        return missing[0]["message"]
    if errors:
        e = errors[0]
        where = f"Line {e['line']}: " if e.get("line") else ("Generated wrapper: " if e.get("inWrapper") else (f"{e['file']}: " if e.get("file") else ""))
        return where + e["message"]
    return "The TeX engine reported a failure; see the log."


def _trim_log(log: str) -> str:
    if len(log) <= LOG_HEAD + LOG_TAIL:
        return log
    return log[:LOG_HEAD] + f"\n[... {len(log) - LOG_HEAD - LOG_TAIL} characters of log omitted ...]\n" + log[-LOG_TAIL:]


# ------------------------------------------------------------------ running the engine
def find_engine(engine: str) -> Optional[str]:
    """Absolute path of a whitelisted engine, or None."""
    return shutil.which(engine) if engine in ENGINES else None


def _tex_env(root: Path, work: Path) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_KEEP | _TEX_ENV_KEEP}
    tmp = str(root / "tmp")
    env.update(TMPDIR=tmp, TEMP=tmp, TMP=tmp,
               TEXINPUTS=str(work) + os.pathsep,          # the work folder, then the distribution's own tree (no user dirs)
               openin_any="p", openout_any="p",           # paranoid: no reading/writing outside the work folder and the TeX trees
               max_print_line="1000", error_line="254", half_error_line="238")   # unwrapped log lines parse reliably
    return env


def _limit_child(pid: int, timeout: float) -> None:
    """Best effort (Linux): cap the file size and CPU time of the TeX process from outside."""
    try:
        import resource
        resource.prlimit(pid, resource.RLIMIT_FSIZE, (MAX_PDF_BYTES * 4, MAX_PDF_BYTES * 4))
        resource.prlimit(pid, resource.RLIMIT_CPU, (int(timeout) + 5, int(timeout) + 5))
    except (ImportError, AttributeError, OSError, ValueError):
        pass


def _run_engine(exe: str, root: Path, work: Path, remaining: float) -> Tuple[Optional[int], str, bool]:
    """One engine pass in `work`. -> (returncode, console text, timed_out)."""
    group = ({"start_new_session": True} if os.name == "posix"
             else {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)})
    proc = subprocess.Popen([exe, *FLAGS, SOURCE_NAME], cwd=work, env=_tex_env(root, work), stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, bufsize=0, close_fds=True, **group)
    jobs.attach_current(proc)                      # a cancel / hard timeout / shutdown kills the process group at once
    cap = _Capture(proc.stdout, MAX_STREAM_BYTES)
    cap.start()
    _limit_child(proc.pid, remaining)
    timed_out = False
    try:
        proc.wait(timeout=max(0.1, remaining))
    except subprocess.TimeoutExpired:
        timed_out = True
        _kill_tree(proc)
        proc.wait()
    finally:
        jobs.detach_current(proc)
    cap.join(2)
    return (None if timed_out else proc.returncode), cap.text()[0], timed_out


def _read_log(work: Path, console: str) -> str:
    try:
        with open(work / "main.log", "rb") as fh:
            return fh.read(MAX_LOG_READ).decode("utf-8", "replace")
    except OSError:
        return console


def _write_assets(work: Path, assets: Optional[Mapping[str, Any]]) -> None:
    total = 0
    if len(assets or {}) > MAX_ASSETS:
        raise ValueError(f"at most {MAX_ASSETS} assets are allowed")
    for name, data in (assets or {}).items():
        norm = str(name).replace("\\", "/")
        parts = norm.split("/")
        if (not norm or norm.startswith("/") or ":" in norm or any(p in ("", ".", "..") or p.startswith(".") for p in parts)
                or norm.lower() == SOURCE_NAME or os.path.splitext(norm)[1].lower() not in ASSET_EXTS):
            raise ValueError(f"asset name {name!r} is not allowed (relative path, one of {', '.join(sorted(ASSET_EXTS))}, not {SOURCE_NAME})")
        blob = data.encode("utf-8") if isinstance(data, str) else bytes(data)
        total += len(blob)
        if total > MAX_ASSET_BYTES:
            raise ValueError("assets are larger than 32 MB in total")
        target = work.joinpath(*parts)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(blob)


def pdf_pages(pdf: bytes) -> Optional[int]:
    """Page count (PyMuPDF, else pdfinfo); None when neither can tell. Raises RenderError for an unreadable PDF."""
    if _mu is not None:
        try:
            with _mu.open(stream=pdf, filetype="pdf") as doc:
                return doc.page_count
        except Exception as exc:  # noqa: BLE001 - any parser failure means an unusable PDF
            raise RenderError(f"The PDF could not be opened ({str(exc)[:120]}).")
    info = _poppler_info(pdf)
    return info[0] if info else None


def _check_pdf(pdf: Optional[bytes]) -> int:
    """exists, %PDF, size cap, pages >= 1 -> pages (0 when it cannot be counted). Raises RenderError."""
    if not pdf:
        raise RenderError("The compiler finished without writing a PDF (no pages of output).")
    if len(pdf) > MAX_PDF_BYTES:
        raise RenderError(f"The PDF is {len(pdf) / 1048576:.0f} MB; the limit is {MAX_PDF_BYTES >> 20} MB.")
    if not pdf.startswith(b"%PDF"):
        raise RenderError("The output file is not a PDF.")
    pages = pdf_pages(pdf)
    if pages is not None and pages < 1:
        raise RenderError("The PDF has no pages.")
    return pages or 0


def compile_latex(source: str, mode: str = "document", engine: str = "pdflatex", timeout: float = DEFAULT_TIMEOUT,
                  assets: Optional[Mapping[str, Any]] = None, job: Optional[jobs.Job] = None) -> CompileResult:
    """Runs through the `latex` job queue (one compile at a time, FIFO; `job` = the caller's job, else a private one);
    status `cancelled` / `timeout` when the job was cancelled or hit its hard limit. Compile `source` in a fresh temp folder. Document mode is compiled byte for byte as given (newlines normalised);
    fragment mode is wrapped by `build_wrapper` (returned in `.wrapper`). Never raises for TeX problems; ValueError only for
    programmer errors (unknown mode/engine, bad asset names)."""
    if mode not in MODES:
        raise ValueError(f"mode must be one of {MODES}")
    if engine not in ENGINES:
        raise ValueError(f"engine must be one of {ENGINES}")
    own = job is None
    job = job or jobs.create(kind="latex")
    try:
        return _compile_latex(job, source, mode, engine, timeout, assets)
    finally:
        if own:
            jobs.finish(job, cancelled=job.cancelled)


def _stopped(job: jobs.Job, res: "CompileResult") -> "CompileResult":
    res.pdf, res.pages = None, None
    res.status, res.message = ("timeout", job.timeout_message()) if job.timed_out else ("cancelled", "The compile was cancelled.")
    return res


def _compile_latex(job: jobs.Job, source: str, mode: str, engine: str, timeout: float, assets: Optional[Mapping[str, Any]]) -> CompileResult:
    started = time.monotonic()

    def done(res: CompileResult) -> CompileResult:
        res.duration_ms = int((time.monotonic() - started) * 1000)
        return res

    text = (source or "").replace("\r\n", "\n").replace("\r", "\n")
    wrapper = None
    if not text.strip():
        return done(CompileResult("invalid", "The LaTeX source is empty."))
    if len(text) > MAX_SOURCE_CHARS:
        return done(CompileResult("invalid", f"The source exceeds {MAX_SOURCE_CHARS} characters."))
    if mode == "fragment":
        if re.search(r"\\documentclass|\\begin\{document\}", text):
            return done(CompileResult("invalid", "This source is a complete document (it has \\documentclass or \\begin{document}); switch the mode to document."))
        wrapper = build_wrapper(text)
    exe = find_engine(engine)
    if exe is None:
        others = [e for e in ENGINES if e != engine and find_engine(e)]
        hint = f" Available here: {', '.join(others)}." if others else ""
        return done(CompileResult("no_compiler", f"The TeX engine '{engine}' was not found on this computer.{hint} "
                                  "Install a TeX distribution (TeX Live, MiKTeX or MacTeX) and make sure it is on PATH.", wrapped=wrapper is not None, wrapper=wrapper))
    bad_external = _find_external_path(text)
    if bad_external:
        return done(CompileResult("compile_failed", message=f"Reading external file '{bad_external}' is not allowed.",
                                  errors=[{"line": None, "message": f"Reading external file '{bad_external}' is not allowed."}],
                                  log=f"Error: Reading external file '{bad_external}' is not allowed.\n",
                                  wrapped=wrapper is not None, wrapper=wrapper))
    res = CompileResult("compile_failed", wrapped=wrapper is not None, wrapper=wrapper)
    full = text if wrapper is None else wrapper["prefix"] + text + wrapper["suffix"]
    root = Path(jobs.mkdtemp("rpe_tex_"))
    try:
        work = root / "work"
        (root / "tmp").mkdir()
        work.mkdir()
        _write_assets(work, assets)
        (work / SOURCE_NAME).write_text(full, encoding="utf-8", newline="\n")
        deadline = started + float(timeout)
        try:
            slot = jobs.slot(job)
            slot.__enter__()
        except jobs.Cancelled:
            return done(_stopped(job, res))
        try:
            deadline = time.monotonic() + float(timeout)       # waiting for a slot does not eat the budget
            while res.passes < 2:
                res.passes += 1
                rc, console, timed_out = _run_engine(exe, root, work, deadline - time.monotonic())
                if job.cancelled:
                    _stopped(job, res)
                    break
                res.log = _read_log(work, console)
                parsed = parse_log(res.log, offset=wrapper["lineOffset"] if wrapper else 0,
                                   source_lines=text.count("\n") + (0 if text.endswith("\n") else 1))
                res.errors, res.missing, res.overfull = parsed["errors"], parsed["missing"], parsed["overfull"]
                if timed_out:
                    res.status, res.message = "timeout", f"The TeX engine was stopped after {float(timeout):g} s."
                    break
                if rc != 0:
                    res.status, res.message = "compile_failed", _first_message(res.errors, res.missing)
                    break
                if parsed["rerun"] and res.passes < 2 and deadline - time.monotonic() > 1:
                    continue
                try:
                    pdf_file = work / "main.pdf"
                    res.pdf = pdf_file.read_bytes() if pdf_file.is_file() else None
                    res.pages = _check_pdf(res.pdf) or None
                except RenderError as exc:
                    res.status, res.message, res.pdf = "render_failed", str(exc), None
                    break
                res.status, res.message = "ok", ""
                break
        finally:
            slot.__exit__(None, None, None)
    finally:
        _remove_tree(str(root))
    res.log = _trim_log(res.log)
    return done(res)


# ------------------------------------------------------------------ rasterizing
def _target(w_pt: float, h_pt: float, dpi: int, w_in: Optional[float]) -> float:
    """Zoom (1 = 72 dpi) for the page; raises RenderError when the image would exceed the pixel caps."""
    if w_pt <= 0 or h_pt <= 0:
        raise RenderError("The first page has no size.")
    zoom = (w_in * dpi / w_pt) if w_in else dpi / 72.0
    wpx, hpx = round(w_pt * zoom), round(h_pt * zoom)
    if wpx > MAX_PX_SIDE or hpx > MAX_PX_SIDE:
        raise RenderError(f"{wpx} x {hpx} px exceeds the {MAX_PX_SIDE} px per-side limit; lower the dpi or the width.")
    if wpx * hpx > MAX_MEGAPIXELS * 1_000_000:
        raise RenderError(f"{wpx * hpx / 1e6:.0f} megapixels exceeds the {MAX_MEGAPIXELS} MP limit; lower the dpi or the width.")
    if wpx < 1 or hpx < 1:
        raise RenderError("The image would be empty at this size.")
    return zoom


def _poppler_run(cmd: List[str]) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_KEEP}
    return subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, timeout=TOOL_TIMEOUT, env=env)


def _poppler_info(pdf: bytes) -> Optional[Tuple[int, float, float]]:
    """(pages, first-page width pt, height pt) from `pdfinfo`, or None."""
    exe = shutil.which("pdfinfo")
    if not exe:
        return None
    with tempfile.TemporaryDirectory(prefix="rpe_pdf_") as tmp:
        path = Path(tmp) / "in.pdf"
        path.write_bytes(pdf)
        try:
            out = _poppler_run([exe, "-f", "1", "-l", "1", str(path)]).stdout.decode("utf-8", "replace")
        except (OSError, subprocess.TimeoutExpired):
            return None
    pages = re.search(r"^Pages:\s+(\d+)", out, re.M)
    size = re.search(r"^Page\s+1 size:\s+([\d.]+) x ([\d.]+)", out, re.M) or re.search(r"^Page size:\s+([\d.]+) x ([\d.]+)", out, re.M)
    if not pages or not size:
        return None
    return int(pages.group(1)), float(size.group(1)), float(size.group(2))


def alpha_supported() -> bool:
    """A transparent PNG needs PyMuPDF; the poppler fallback always draws on white."""
    return _mu is not None


def rasterize_pdf(pdf: bytes, dpi: int, w_in: Optional[float] = None, alpha: bool = False) -> Dict[str, Any]:
    """First page -> PNG. `w_in` scales the page to that width in inches (pixel width = w_in * dpi), else natural size at `dpi`.
    `alpha` leaves what the page does not paint transparent (PyMuPDF only). -> {png, widthPx, heightPx, pages, rasterizer}; raises RenderError."""
    if alpha and _mu is None:
        raise RenderError("A transparent background needs PyMuPDF (pip install pymupdf); the poppler fallback draws on white.")
    if _mu is not None:
        try:
            with _mu.open(stream=pdf, filetype="pdf") as doc:
                if doc.page_count < 1:
                    raise RenderError("The PDF has no pages.")
                page = doc[0]
                zoom = _target(page.rect.width, page.rect.height, dpi, w_in)
                pix = page.get_pixmap(matrix=_mu.Matrix(zoom, zoom), alpha=alpha)
                return {"png": pix.tobytes("png"), "widthPx": pix.width, "heightPx": pix.height, "pages": doc.page_count, "rasterizer": "pymupdf"}
        except RenderError:
            raise
        except Exception as exc:  # noqa: BLE001
            raise RenderError(f"PyMuPDF could not draw the first page ({str(exc)[:120]}).")
    exe = shutil.which("pdftoppm")
    if exe is None:
        raise RenderError("No rasterizer is available: install PyMuPDF (pip install pymupdf) or poppler's pdftoppm.")
    info = _poppler_info(pdf)
    if info:
        zoom = _target(info[1], info[2], dpi, w_in)
    with tempfile.TemporaryDirectory(prefix="rpe_pdf_") as tmp:
        src = Path(tmp) / "in.pdf"
        src.write_bytes(pdf)
        scale = ["-scale-to-x", str(round(w_in * dpi)), "-scale-to-y", "-1"] if w_in else ["-r", str(dpi)]
        try:
            proc = _poppler_run([exe, "-f", "1", "-l", "1", "-png", "-singlefile", *scale, str(src), str(Path(tmp) / "out")])
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise RenderError(f"pdftoppm failed ({exc}).")
        out = Path(tmp) / "out.png"
        if proc.returncode != 0 or not out.is_file():
            raise RenderError("pdftoppm could not draw the first page: " + proc.stderr.decode("utf-8", "replace").strip()[:160])
        png = out.read_bytes()
    size = _png_size(png)
    if not size:
        raise RenderError("pdftoppm wrote an unreadable image.")
    if not info and (size[0] > MAX_PX_SIDE or size[1] > MAX_PX_SIDE or size[0] * size[1] > MAX_MEGAPIXELS * 1_000_000):
        raise RenderError(f"{size[0]} x {size[1]} px exceeds the pixel limits; lower the dpi or the width.")
    return {"png": png, "widthPx": size[0], "heightPx": size[1], "pages": info[0] if info else None, "rasterizer": "pdftoppm"}


def _data_url(png: bytes) -> str:
    url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
    if len(url) > MAX_PREVIEW_CHARS:
        raise RenderError("The image is too large to send; lower the dpi or the width.")
    return url


# ------------------------------------------------------------------ endpoint-level jobs
def _diagnostics(res: CompileResult, engine: str) -> Dict[str, Any]:
    return {"engine": engine, "log": res.log, "errors": res.errors, "missing": res.missing, "overfull": res.overfull,
            "passes": res.passes, "wrapped": res.wrapped, "wrapper": res.wrapper, "pages": res.pages}


def compile_preview(source: str, mode: str, engine: str, dpi: int = DEFAULT_PREVIEW_DPI, job: Optional[jobs.Job] = None) -> Dict[str, Any]:
    """POST latex/compile: compile + first-page preview (dpi capped at 150). Always a dict, never raises for TeX problems."""
    dpi = min(dpi, PREVIEW_DPI_CAP)
    res = compile_latex(source, mode, engine, job=job)
    out: Dict[str, Any] = {"ok": False, "status": res.status, "message": res.message, "dpi": dpi, "pdfBase64": None, "preview": None,
                           "widthPx": None, "heightPx": None, "rasterizer": None, **_diagnostics(res, engine), "durationMs": res.duration_ms}
    if res.status != "ok":
        return out
    t0 = time.monotonic()
    try:
        ras = rasterize_pdf(res.pdf, dpi)
        out.update(preview=_data_url(ras["png"]), widthPx=ras["widthPx"], heightPx=ras["heightPx"], rasterizer=ras["rasterizer"],
                   pages=ras["pages"] or res.pages, ok=True)
    except RenderError as exc:
        out.update(status="render_failed", message=str(exc))
    out["pdfBase64"] = base64.b64encode(res.pdf).decode("ascii")      # a valid PDF is useful even when it cannot be previewed
    out["durationMs"] += int((time.monotonic() - t0) * 1000)
    return out


def render_final(pdf: Optional[bytes], source: Optional[str], mode: str, engine: str, dpi: int, w_in: Optional[float],
                 background: str = "white", job: Optional[jobs.Job] = None) -> Dict[str, Any]:
    """POST latex/render: final PNG from a PDF, or from source (compiled first). `w_in` -> width in inches of the image (aspect kept)."""
    started = time.monotonic()
    out: Dict[str, Any] = {"ok": False, "status": "ok", "message": "", "dpi": dpi, "preview": None, "widthPx": None, "heightPx": None,
                           "pages": None, "rasterizer": None, "background": background, "durationMs": 0}
    if w_in and round(w_in * dpi) > MAX_PX_SIDE:
        out.update(status="invalid", message=f"{round(w_in * dpi)} px wide exceeds the {MAX_PX_SIDE} px per-side limit; lower the dpi or the width.")
        return out
    if job is not None and pdf is not None:             # nothing to queue for: only the raster step runs
        job.state, job.started = "running", time.time()
    if pdf is None:
        res = compile_latex(source or "", mode, engine, job=job)
        out.update(_diagnostics(res, engine), status=res.status, message=res.message)
        if res.status != "ok":
            out["durationMs"] = int((time.monotonic() - started) * 1000)
            return out
        pdf = res.pdf
    try:
        _check_pdf(pdf)
        ras = rasterize_pdf(pdf, dpi, w_in, background == "transparent")
        out.update(preview=_data_url(ras["png"]), widthPx=ras["widthPx"], heightPx=ras["heightPx"], pages=ras["pages"],
                   rasterizer=ras["rasterizer"], ok=True, status="ok", message="")
    except RenderError as exc:
        out.update(status="render_failed", message=str(exc))
    out["durationMs"] = int((time.monotonic() - started) * 1000)
    return out


# ------------------------------------------------------------------ request parsing (ValueError -> HTTP 400)
def _whole(v: Any, lo: int, hi: int, name: str) -> int:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or v != int(v) or not lo <= v <= hi:
        raise ValueError(f"{name} must be a whole number from {lo} to {hi}.")
    return int(v)


def _choice(body: Dict[str, Any], key: str, allowed: Tuple[str, ...], default: str) -> str:
    v = body.get(key, default)
    if v is None:
        return default
    if v not in allowed:
        raise ValueError(f"{key} must be one of: {', '.join(allowed)}.")
    return v


def parse_compile_request(body: Any) -> Tuple[str, str, str, int]:
    """{source, mode?, engine?, dpi?} -> (source, mode, engine, dpi)."""
    if not isinstance(body, dict):
        raise ValueError("The request body must be a JSON object.")
    if not isinstance(body.get("source"), str):
        raise ValueError("source must be a string.")
    dpi = DEFAULT_PREVIEW_DPI if body.get("dpi") is None else _whole(body["dpi"], MIN_DPI, MAX_DPI, "dpi")
    return body["source"], _choice(body, "mode", MODES, "document"), _choice(body, "engine", ENGINES, "pdflatex"), dpi


def parse_render_request(body: Any) -> Tuple[Optional[bytes], Optional[str], str, str, Optional[float], int, str]:
    """{pdfBase64 | source, mode?, engine?, wIn?, dpi?, background?} -> (pdf, source, mode, engine, w_in, dpi, background); exactly one of pdfBase64 / source."""
    if not isinstance(body, dict):
        raise ValueError("The request body must be a JSON object.")
    has_pdf, has_src = body.get("pdfBase64") is not None, body.get("source") is not None
    if has_pdf == has_src:
        raise ValueError("Send exactly one of pdfBase64 or source.")
    pdf = None
    if has_pdf:
        if not isinstance(body["pdfBase64"], str):
            raise ValueError("pdfBase64 must be a base64 string.")
        try:
            pdf = base64.b64decode(re.sub(r"^data:[^,]*,", "", body["pdfBase64"]), validate=True)
        except ValueError:
            raise ValueError("pdfBase64 is not valid base64.")
    elif not isinstance(body["source"], str):
        raise ValueError("source must be a string.")
    w_in = body.get("wIn")
    if w_in is not None and (isinstance(w_in, bool) or not isinstance(w_in, (int, float)) or not MIN_SIDE_IN <= w_in <= MAX_SIDE_IN):
        raise ValueError(f"wIn must be a number from {MIN_SIDE_IN:g} to {MAX_SIDE_IN:g} (inches).")
    dpi = 450 if body.get("dpi") is None else _whole(body["dpi"], MIN_DPI, MAX_DPI, "dpi")
    return (pdf, body.get("source"), _choice(body, "mode", MODES, "document"), _choice(body, "engine", ENGINES, "pdflatex"),
            (float(w_in) if w_in else None), dpi, _choice(body, "background", ("white", "transparent"), "white"))
