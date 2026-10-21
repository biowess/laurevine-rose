"""POST /api/figures/python/run core (docs/FIGURES_CONTRACT.md s4p): run a user script, answer in the render response shape.

Shares the render cache, job slots and cancellation with render.py. `run_job` is blocking (the router uses
asyncio.to_thread) and never raises for problems with the script; only a malformed request raises RenderRequestError.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
from typing import Any, Dict, Optional, Tuple

from PIL import Image

from backend.figures import jobs, render as rc
from backend.figures.models import MAX_DPI, MAX_SIDE_IN, MIN_DPI, MIN_SIDE_IN
from backend.figures.runner import MAX_SOURCE_CHARS, run_python
from backend.figures.runtime import get_runtime

# import name -> pip name, where they differ
PIP_NAMES = {"sklearn": "scikit-learn", "cv2": "opencv-python", "PIL": "pillow", "yaml": "pyyaml", "skimage": "scikit-image",
             "bs4": "beautifulsoup4", "dateutil": "python-dateutil", "Bio": "biopython"}
Size = Optional[Tuple[float, float]]


def parse_request(body: Any) -> Tuple[str, int, str, str, Size, Optional[str]]:
    """-> (source, dpi, purpose, background, size_in, job_id). Raises RenderRequestError."""
    if not isinstance(body, dict):
        raise rc.RenderRequestError('Send JSON like {"source": "...", "dpi": 150, "purpose": "preview"}.')
    source = body.get("source")
    if not isinstance(source, str):
        raise rc.RenderRequestError("'source' must be the script text.")
    if len(source) > MAX_SOURCE_CHARS:
        raise rc.RenderRequestError(f"'source' is {len(source)} characters; the limit is {MAX_SOURCE_CHARS}.")
    purpose = body.get("purpose", "preview")
    if purpose not in rc.PURPOSES:
        raise rc.RenderRequestError("'purpose' must be 'preview' or 'final'.")
    dpi = body.get("dpi", 450)
    if isinstance(dpi, bool) or not isinstance(dpi, int) or not MIN_DPI <= dpi <= MAX_DPI:
        raise rc.RenderRequestError(f"'dpi' must be a whole number from {MIN_DPI} to {MAX_DPI}.")
    background = body.get("background", "white")
    if background not in ("white", "transparent"):
        raise rc.RenderRequestError("'background' must be 'white' or 'transparent'.")
    size = body.get("sizeIn")
    if size is not None:
        if not (isinstance(size, list) and len(size) == 2 and all(
                isinstance(v, (int, float)) and not isinstance(v, bool) and MIN_SIDE_IN <= v <= MAX_SIDE_IN for v in size)):
            raise rc.RenderRequestError(f"'sizeIn' must be [width, height] in inches, each {MIN_SIDE_IN:g}-{MAX_SIDE_IN:g}.")
        size = (float(size[0]), float(size[1]))
    job_id = body.get("jobId")
    if job_id is not None and not (isinstance(job_id, str) and jobs.JOB_ID_RE.match(job_id)):
        raise rc.RenderRequestError("'jobId' must be 1-64 characters: letters, digits, '_' or '-'.")
    return source, dpi, purpose, background, size, job_id


def _key(source: str, dpi: int, background: str, size: Size, versions: Dict[str, Any]) -> str:
    basis = {"mode": "pyrun", "source": source, "dpi": dpi, "background": background, "sizeIn": size, "versions": versions}
    return hashlib.sha256(json.dumps(basis, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()).hexdigest()


def _missing(module: str) -> Dict[str, str]:
    package = PIP_NAMES.get(module.split(".")[0], module.split(".")[0])
    return {"name": module, "package": package,
            "message": f"Module '{module}' is not installed. Run: pip install {package} in the environment running this "
                       "app, then run again. The app will not install packages."}


def _extras(res=None, extra: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    if extra is not None:
        return dict(extra)
    tb = getattr(res, "traceback", None)
    return {"figuresFound": getattr(res, "figures_found", 0), "warnings": list(getattr(res, "warnings", None) or []),
            "traceback": {"line": tb.get("line"), "column": tb.get("column"), "message": tb.get("message")} if tb else None,
            "missingModule": _missing(res.missing_module) if getattr(res, "missing_module", None) else None}


def _run(job: jobs.Job, source: str, dpi: int, purpose: str, background: str, size: Size) -> Dict[str, Any]:
    if purpose == "preview":
        dpi = min(dpi, rc.PREVIEW_MAX_DPI)

    def out(status: str, extras: Dict[str, Any], **kw: Any) -> Dict[str, Any]:
        return {**rc._response(job, purpose, dpi, status, **kw), **extras}

    if not source.strip():
        return out("invalid", _extras(), diagnostics=[rc._diag("error", "source_empty", "The Python script is empty.")])
    if size:
        problem = rc._size_problem(size[0], size[1], dpi)
        if problem:
            return out("invalid", _extras(), diagnostics=[problem])
    runtime = get_runtime()
    key = _key(source, dpi, background, size, {k: runtime.get(k) for k in rc.VERSION_KEYS})
    hit = rc._cache_get(key)
    if hit:
        return {**rc._from_cache(job, purpose, dpi, key, hit), **_extras(extra=hit["extra"])}
    with jobs.slot(job):
        hit = rc._cache_get(key)
        if hit:
            return {**rc._from_cache(job, purpose, dpi, key, hit), **_extras(extra=hit["extra"])}
        if job.cancelled:
            raise jobs.Cancelled()
        try:
            res = run_python(source, dpi=dpi, out_format="png", transparent=background == "transparent",
                             cancel=job.event, size_in=size)
        except ValueError as exc:
            return out("invalid", _extras(), diagnostics=[rc._diag("error", "invalid_request", str(exc))], source=source)

    extras = _extras(res)
    notes = [rc._diag("warning", "runner_warning", w) for w in res.warnings]
    common = dict(source=source, stdout=res.stdout, stderr=res.stderr, duration_ms=res.duration_ms)
    if res.status == "cancelled":
        return out("cancelled", extras, diagnostics=[rc._diag("info", "cancelled", "Rendering was cancelled.")], **common)
    if not res.ok:
        detail: Dict[str, Any] = {}
        tb = res.traceback or {}
        for k in ("line", "column"):
            if tb.get(k):
                detail[k] = tb[k]
        if res.missing_module:
            detail["module"] = res.missing_module
        message = extras["missingModule"]["message"] if extras["missingModule"] else res.message
        notes.append(rc._diag("error", res.status, message, **detail))
        return out(res.status, extras, diagnostics=notes, **common)

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
    rc._cache_put(key, {"preview": preview, "w": w_px, "h": h_px, "source": source, "diagnostics": notes,
                        "stdout": res.stdout, "stderr": res.stderr, "durationMs": res.duration_ms, "extra": extras})
    return out("ok", extras, preview=preview, size=(w_px, h_px), digest=key, diagnostics=notes, **common)


def run_job(job: jobs.Job, source: str, dpi: int, purpose: str, background: str, size: Size) -> Dict[str, Any]:
    """Blocking entry point: always returns the response dict (cancellation included) and marks the job finished."""
    try:
        result = _run(job, source, dpi, purpose, background, size)
    except jobs.Cancelled:
        result = {**rc._response(job, purpose, dpi, "cancelled",
                                 diagnostics=[rc._diag("info", "cancelled", "Rendering was cancelled.")]), **_extras()}
    if job.timed_out and result["status"] == "cancelled":
        result = {**rc._response(job, purpose, dpi, "timeout", diagnostics=[rc._diag("error", "timeout", job.timeout_message())]),
                  **_extras()}
    jobs.finish(job, cancelled=result["status"] == "cancelled")
    return result
