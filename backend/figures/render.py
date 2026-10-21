"""POST /api/figures/render core (docs/FIGURES_CONTRACT.md s4i): validate -> codegen -> runner -> response, with an LRU cache.

`render_job` is blocking (the router calls it through asyncio.to_thread). It never raises for problems with the figure
or the script: those come back as {ok: False, status, diagnostics}. Only a malformed request raises RenderRequestError.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import tempfile
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from PIL import Image
from pydantic import ValidationError

from backend.figures import jobs
from backend.figures.codegen import CodegenError, emit_script
from backend.figures.codegen.composite import plan_for, script_diagnostics
from backend.figures.models import MAX_DPI, MAX_MEGAPIXELS, MAX_PX_SIDE, MIN_DPI, FigureRecord
from backend.figures.runner import run_python
from backend.figures.runtime import get_runtime

PURPOSES = ("preview", "final")
PREVIEW_MAX_DPI = 150                       # a preview is never rendered finer than this (contract s5)
CACHE_SIZE = 64
CACHE_MAX_BYTES = 200 * 1024 * 1024         # 200 MB disk cap
CACHE_MAX_ENTRY_CHARS = 8_000_000           # larger images are returned but not kept in memory
CACHE_DIR_NAME = "rpe-render-cache"
RENDERABLE_KINDS = ("structured", "python", "composite")
VERSION_KEYS = ("python", "matplotlib", "numpy", "pandas", "scipy")


def _cache_dir() -> Path:
    d = Path(tempfile.gettempdir()) / CACHE_DIR_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


_cache: "OrderedDict[str, Optional[Dict[str, Any]]]" = OrderedDict()
_cache_sizes: "Dict[str, int]" = {}
_cache_lock = threading.Lock()
_cache_loaded = False


def _ensure_cache_loaded() -> None:
    global _cache_loaded
    if _cache_loaded:
        return
    _cache_loaded = True
    cdir = _cache_dir()
    entries = []
    try:
        for p in cdir.glob("*.json"):
            try:
                st = p.stat()
                entries.append((st.st_mtime, st.st_size, p))
            except OSError:
                pass
    except OSError:
        return
    entries.sort(key=lambda x: x[0])
    for _, size, p in entries:
        key = p.stem
        _cache[key] = None
        _cache_sizes[key] = size
    _evict_overflow()


def _evict_overflow() -> None:
    total_bytes = sum(_cache_sizes.values())
    cdir = _cache_dir()
    while _cache and (total_bytes > CACHE_MAX_BYTES or len(_cache) > CACHE_SIZE):
        old_key, _ = _cache.popitem(last=False)
        old_size = _cache_sizes.pop(old_key, 0)
        total_bytes -= old_size
        file_path = cdir / f"{old_key}.json"
        try:
            if file_path.exists():
                file_path.unlink()
        except OSError:
            pass


class RenderRequestError(ValueError):
    """The request itself is malformed (the router answers HTTP 400)."""


def clear_cache() -> None:
    with _cache_lock:
        _cache.clear()
        _cache_sizes.clear()
        cdir = _cache_dir()
        try:
            for p in cdir.glob("*.json*"):
                try:
                    p.unlink()
                except OSError:
                    pass
        except OSError:
            pass


def cache_size() -> int:
    with _cache_lock:
        _ensure_cache_loaded()
        return len(_cache)


# ------------------------------------------------------------------ request
def parse_request(body: Any) -> Tuple[Dict[str, Any], str, Optional[int], Optional[str]]:
    """-> (record dict, purpose, dpi or None, jobId or None). Raises RenderRequestError."""
    if not isinstance(body, dict):
        raise RenderRequestError('Send JSON like {"record": {...}, "purpose": "preview"}.')
    record = body.get("record")
    if not isinstance(record, dict):
        raise RenderRequestError("'record' must be a figure record object.")
    purpose = body.get("purpose", "preview")
    if purpose not in PURPOSES:
        raise RenderRequestError("'purpose' must be 'preview' or 'final'.")
    dpi = body.get("dpi")
    if dpi is not None and (isinstance(dpi, bool) or not isinstance(dpi, int) or not MIN_DPI <= dpi <= MAX_DPI):
        raise RenderRequestError(f"'dpi' must be a whole number from {MIN_DPI} to {MAX_DPI}.")
    job_id = body.get("jobId")
    if job_id is not None and not (isinstance(job_id, str) and jobs.JOB_ID_RE.match(job_id)):
        raise RenderRequestError("'jobId' must be 1-64 characters: letters, digits, '_' or '-'.")
    return record, purpose, dpi, job_id


# ----------------------------------------------------------------- response
def _diag(level: str, code: str, message: str, **extra: Any) -> Dict[str, Any]:
    return {"level": level, "code": code, "message": message, **extra}


def _response(job: jobs.Job, purpose: str, dpi: Optional[int], status: str, *, preview: Optional[str] = None,
              size: Tuple[Optional[int], Optional[int]] = (None, None), digest: Optional[str] = None, source: str = "",
              diagnostics: Optional[List[Dict[str, Any]]] = None, stdout: str = "", stderr: str = "",
              duration_ms: int = 0, cached: bool = False) -> Dict[str, Any]:
    return {"ok": status == "ok", "status": status, "jobId": job.id, "purpose": purpose, "dpi": dpi,
            "preview": preview, "widthPx": size[0], "heightPx": size[1], "hash": digest, "source": source,
            "diagnostics": diagnostics or [], "stdout": stdout, "stderr": stderr, "durationMs": duration_ms,
            "cached": cached}


def _invalid(job, purpose, dpi, diagnostics, source: str = "") -> Dict[str, Any]:
    return _response(job, purpose, dpi, "invalid", diagnostics=diagnostics, source=source)


def _humanize(exc: ValidationError, limit: int = 5) -> List[Dict[str, Any]]:
    out = []
    for err in exc.errors()[:limit]:
        where = ".".join(str(p) for p in err["loc"]) or "record"
        msg = err["msg"].removeprefix("Value error, ")
        out.append(_diag("error", "invalid_record", f"The figure settings are not valid at '{where}': {msg}."))
    more = len(exc.errors()) - limit
    if more > 0:
        out.append(_diag("error", "invalid_record", f"{more} more problem{'s' if more > 1 else ''} in the figure settings."))
    return out


# -------------------------------------------------------------------- cache
def _cache_key(rec: Dict[str, Any], dpi: int, versions: Dict[str, Any], preview: bool = False) -> str:
    """sha256 of everything that can change the image or the returned source: for a custom script its text and the
    background, for a structured figure its name, dataset, config and size, for a composite its settings, the panels'
    plots (not their cached previews), size and the preview flag; always the effective dpi and the versions."""
    export = rec["export"]
    if rec["kind"] == "composite":
        panels = [{"slot": p["slot"], **({**{k: p["record"][k] for k in ("kind", "sourceMode", "dataset", "config")},
                                          "size": [p["record"]["export"]["wIn"], p["record"]["export"]["hIn"]]}
                                         if p["record"] else {"record": None})} for p in rec["composite"]["panels"]]
        basis: Dict[str, Any] = {"mode": "composite", "layout_engine": 2, "name": rec["name"], "composite": {**rec["composite"], "panels": panels},
                                 "wIn": export["wIn"], "hIn": export["hIn"], "background": export["background"],
                                 "preview": preview}
    elif rec["sourceMode"] == "custom":
        basis = {"mode": "custom", "source": rec["source"], "background": export["background"]}
    else:
        basis = {"mode": "structured", "kind": rec["kind"], "name": rec["name"], "dataset": rec["dataset"],
                 "config": rec["config"], "wIn": export["wIn"], "hIn": export["hIn"], "background": export["background"]}
    basis.update(dpi=dpi, versions=versions)
    text = json.dumps(basis, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> Optional[Dict[str, Any]]:
    with _cache_lock:
        _ensure_cache_loaded()
        if key not in _cache:
            return None
        _cache.move_to_end(key)
        entry = _cache[key]
        cdir = _cache_dir()
        p = cdir / f"{key}.json"
        if entry is None:
            try:
                entry = json.loads(p.read_text(encoding="utf-8"))
                _cache[key] = entry
            except (OSError, ValueError):
                _cache.pop(key, None)
                _cache_sizes.pop(key, None)
                return None
        try:
            os.utime(p, None)
        except OSError:
            pass
        return entry


def _cache_put(key: str, entry: Dict[str, Any]) -> None:
    prev = entry.get("preview", "")
    if isinstance(prev, str) and len(prev) > CACHE_MAX_ENTRY_CHARS:
        return
    with _cache_lock:
        _ensure_cache_loaded()
        cdir = _cache_dir()
        p = cdir / f"{key}.json"
        tmp = cdir / f"{key}.json.tmp"
        try:
            text = json.dumps(entry, ensure_ascii=False)
            tmp.write_text(text, encoding="utf-8")
            os.replace(tmp, p)
            size = p.stat().st_size
        except OSError:
            size = len(str(prev))
        _cache[key] = entry
        _cache_sizes[key] = size
        _cache.move_to_end(key)
        _evict_overflow()


def _from_cache(job, purpose, dpi, key, entry) -> Dict[str, Any]:
    return _response(job, purpose, dpi, "ok", preview=entry["preview"], size=(entry["w"], entry["h"]), digest=key,
                     source=entry["source"], diagnostics=[dict(d) for d in entry["diagnostics"]],
                     stdout=entry["stdout"], stderr=entry["stderr"], duration_ms=entry["durationMs"], cached=True)


# ------------------------------------------------------------------- render
def _size_problem(w_in: float, h_in: float, dpi: int) -> Optional[Dict[str, Any]]:
    wpx, hpx = round(w_in * dpi), round(h_in * dpi)
    if wpx > MAX_PX_SIDE or hpx > MAX_PX_SIDE:
        return _diag("error", "size_limit", f"{w_in:g} x {h_in:g} in at {dpi} dpi is {wpx} x {hpx} px, more than the "
                     f"{MAX_PX_SIDE} px per-side limit. Lower the DPI or the size.")
    if wpx * hpx > MAX_MEGAPIXELS * 1_000_000:
        return _diag("error", "size_limit", f"{w_in:g} x {h_in:g} in at {dpi} dpi is {wpx * hpx / 1e6:.0f} megapixels, "
                     f"more than the {MAX_MEGAPIXELS} MP limit. Lower the DPI or the size.")
    return None


def _render(job: jobs.Job, record: Dict[str, Any], purpose: str, req_dpi: Optional[int]) -> Dict[str, Any]:
    try:
        rec = FigureRecord.model_validate(record).model_dump()
    except ValidationError as exc:
        return _invalid(job, purpose, req_dpi, _humanize(exc))
    export = rec["export"]
    dpi = req_dpi or export["dpi"]
    size_in = (export["wIn"], export["hIn"])
    if rec["kind"] == "composite":              # the canvas grows to hold the panels at their own size (backend.figures.layout)
        pl = plan_for(rec)
        size_in = (pl.canvas_w, pl.canvas_h)
    if purpose == "preview":
        dpi = min(dpi, PREVIEW_MAX_DPI)
        w_in = size_in[0]
        if w_in and w_in > 0:
            max_dpi = int(1200 / w_in)
            if max_dpi < dpi:
                dpi = max(MIN_DPI, max_dpi)
    if rec["kind"] not in RENDERABLE_KINDS:
        return _invalid(job, purpose, dpi, [_diag("error", "unsupported_kind", f"Rendering of '{rec['kind']}' figures is "
                                                  "not supported by this endpoint.")])
    custom = rec["sourceMode"] == "custom" and rec["kind"] != "composite"
    if custom and not rec["source"].strip():
        return _invalid(job, purpose, dpi, [_diag("error", "source_empty", "The Python script is empty.")])
    if not custom:                              # a custom script sets its own size; the runner checks it
        problem = _size_problem(size_in[0], size_in[1], dpi)
        if problem:
            return _invalid(job, purpose, dpi, [problem])

    # Large data decimation for preview (>50k points)
    decimated_info = None
    if purpose == "preview" and not custom and rec.get("dataset") and isinstance(rec["dataset"].get("rows"), list):
        rows = rec["dataset"]["rows"]
        m = len(rows)
        if m > 50_000:
            step = math.ceil(m / 50_000)
            rec["dataset"]["rows"] = rows[::step]
            n = len(rec["dataset"]["rows"])
            decimated_info = (n, m)

    runtime = get_runtime()
    key = _cache_key(rec, dpi, {k: runtime.get(k) for k in VERSION_KEYS}, preview=purpose == "preview")
    hit = _cache_get(key)
    if hit:
        return _from_cache(job, purpose, dpi, key, hit)

    with jobs.slot(job):
        hit = _cache_get(key)                   # an identical render may have finished while this one waited
        if hit:
            return _from_cache(job, purpose, dpi, key, hit)
        notes: List[Dict[str, Any]] = []
        files: Dict[str, bytes] = {}
        if custom:
            source = rec["source"]
        else:
            # emit_script runs validate_dataset: its errors arrive as CodegenError.issues, its warnings / info as .warnings
            try:
                script = emit_script(rec, preview=purpose == "preview")
            except CodegenError as exc:
                return _invalid(job, purpose, dpi, exc.issues)
            except Exception as exc:            # a generator bug must not become an HTTP 500
                return _response(job, purpose, dpi, "error", diagnostics=[_diag(
                    "error", "codegen_failed", f"The script could not be generated: {exc}")])
            source, files, notes = script.source, script.files, list(script.warnings)
        if job.cancelled:
            raise jobs.Cancelled()
        try:
            warm_start = (not custom) and (rec.get("kind") == "structured")
            res = run_python(source, dpi=dpi, out_format="png", transparent=export["background"] == "transparent",
                             files=files, cancel=job.event, warm=warm_start)
        except ValueError as exc:
            return _invalid(job, purpose, dpi, [_diag("error", "invalid_request", str(exc))], source)

    if decimated_info:
        n, m = decimated_info
        notes.append(_diag("info", "preview_decimated", f"preview uses {n} of {m} points"))

    notes += [_diag("warning", "runner_warning", w) for w in res.warnings]
    if rec["kind"] == "composite":              # failed panels and an unshared legend are reported by the script itself
        notes += script_diagnostics(res.stdout)
    common = dict(source=source, stdout=res.stdout, stderr=res.stderr, duration_ms=res.duration_ms)
    if res.status == "cancelled":
        return _response(job, purpose, dpi, "cancelled", diagnostics=[_diag("info", "cancelled", "Rendering was cancelled.")],
                         **common)
    if not res.ok:
        extra: Dict[str, Any] = {}
        if res.traceback and res.traceback.get("line"):
            extra["line"] = res.traceback["line"]
        if res.missing_module:
            extra["module"] = res.missing_module
        notes.append(_diag("error", res.status, res.message, **extra))
        return _response(job, purpose, dpi, res.status, diagnostics=notes, **common)

    preview_bytes = res.png_bytes
    w_px, h_px = res.width_px, res.height_px
    if purpose == "preview" and w_px and w_px > 1200:
        try:
            img = Image.open(io.BytesIO(preview_bytes))
            new_w = 1200
            new_h = max(1, round(h_px * 1200 / w_px))
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
            buf = io.BytesIO()
            img.save(buf, format="PNG", optimize=True)
            preview_bytes = buf.getvalue()
            w_px, h_px = new_w, new_h
        except Exception:
            pass

    preview = "data:image/png;base64," + base64.b64encode(preview_bytes).decode("ascii")
    entry = {"preview": preview, "w": w_px, "h": h_px, "source": source, "diagnostics": notes,
             "stdout": res.stdout, "stderr": res.stderr, "durationMs": res.duration_ms}
    _cache_put(key, entry)                      # only successful runs: a timeout or crash may not repeat
    return _response(job, purpose, dpi, "ok", preview=preview, size=(w_px, h_px), digest=key,
                     diagnostics=notes, **common)


def render_job(job: jobs.Job, record: Dict[str, Any], purpose: str, dpi: Optional[int]) -> Dict[str, Any]:
    """Blocking entry point: always returns the response dict (cancellation included) and marks the job finished."""
    try:
        result = _render(job, record, purpose, dpi)
    except jobs.Cancelled:
        result = _response(job, purpose, dpi, "cancelled", diagnostics=[_diag("info", "cancelled", "Rendering was cancelled.")])
    if job.timed_out and result["status"] == "cancelled":
        result = _response(job, purpose, dpi, "timeout", diagnostics=[_diag("error", "timeout", job.timeout_message())])
    jobs.finish(job, cancelled=result["status"] == "cancelled")
    return result
