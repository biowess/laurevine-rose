"""HTTP API for the figure studio, mounted from backend/server.py (docs/FIGURES_CONTRACT.md s4)."""
from __future__ import annotations

import asyncio
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Query, Request
from fastapi.responses import Response
from starlette.concurrency import run_in_threadpool
from starlette.datastructures import UploadFile

from backend.figures import export as export_core, jobs, latex as latex_core, pyrun, render as render_core, runner, samples, templates
from backend.figures.dataset import DELIMITERS, MAX_BYTES, column_notes, parse_csv
from backend.figures.models import Dataset, MAX_DPI, PLOT_TYPES, MAX_SIDE_IN, MIN_DPI, MIN_SIDE_IN
from backend.figures.runtime import get_runtime
from backend.security import MAX_SOURCE_BYTES

router = APIRouter(prefix="/api/figures", tags=["figures"])

MAX_REQUEST_BYTES = 3 * MAX_BYTES  # transport-level guard; the 5 MB file cap itself is enforced by parse_csv
MAX_RENDER_BYTES = 64 << 20        # a record can hold 2 M cells plus the original CSV


def _check_source(body: Any) -> Any:
    """413 when a script / TeX source is over 2 MB (docs/SECURITY.md); returns the body."""
    src = body.get("source") if isinstance(body, dict) else None
    if isinstance(src, str) and len(src) > MAX_SOURCE_BYTES // 4 and len(src.encode("utf-8", "ignore")) > MAX_SOURCE_BYTES:
        raise HTTPException(413, "The source is too large (limit 2 MB).")
    return body


def _delimiter_option(v: Any) -> Optional[str]:
    if v is None or (isinstance(v, str) and v.strip().lower() in ("", "auto")):
        return None
    if isinstance(v, str) and v.strip().lower() in ("tab", "\\t"):
        return "\t"
    if v in DELIMITERS:
        return v
    raise HTTPException(400, "delimiter must be one of: comma, semicolon, tab, pipe (or 'auto').")


def _header_option(v: Any) -> Optional[bool]:
    if v is None or isinstance(v, bool):
        return v
    if isinstance(v, str) and v.strip().lower() in ("", "auto"):
        return None
    if isinstance(v, str) and v.strip().lower() in ("true", "false"):
        return v.strip().lower() == "true"
    raise HTTPException(400, "hasHeader must be true, false or 'auto'.")


@router.get("/runtime")
async def runtime(refresh: bool = False):
    """Python packages, TeX engines, pgfplots, rasterizer, limits and platform (contract s4b). Cached 60 s;
    `?refresh=true` probes again. Always HTTP 200: missing tools are reported as null / empty, not as errors."""
    return await run_in_threadpool(get_runtime, refresh=refresh)


@router.post("/dataset/parse")
async def dataset_parse(request: Request):
    """Parse a CSV sent as multipart (field 'file') or JSON ({text, fileName?, delimiter?, hasHeader?}). An optional `plotType` adds `columnNotes` ({column: {role: why it is unusable}}).

    Always HTTP 200 with {ok, status, fileName, ...parse result} for readable requests, including files
    that turn out to be unusable (ok=false, errors listed). 4xx only for malformed requests.
    """
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_REQUEST_BYTES:
        raise HTTPException(413, "The request is too large; CSV files are limited to 5 MB.")
    ctype = request.headers.get("content-type", "").split(";")[0].strip().lower()
    file_name: Optional[str] = None
    if ctype == "multipart/form-data":
        form = await request.form()
        upload = form.get("file")
        if not isinstance(upload, UploadFile):
            raise HTTPException(400, "Send the CSV as a multipart field named 'file'.")
        data: Any = await upload.read(MAX_BYTES + 1)
        file_name, opts = upload.filename, dict(form)
    elif ctype == "application/json":
        try:
            body = await request.json()
        except ValueError:
            raise HTTPException(400, "The request body is not valid JSON.")
        if not isinstance(body, dict) or not isinstance(body.get("text"), str):
            raise HTTPException(400, "Send JSON like {\"text\": \"a,b\\n1,2\"}.")
        data, opts = body["text"], body
        fn = body.get("fileName")
        file_name = fn if isinstance(fn, str) else None
    else:
        raise HTTPException(415, "Send the CSV as multipart/form-data (field 'file') or application/json ({text}).")
    delimiter = _delimiter_option(opts.get("delimiter"))
    has_header = _header_option(opts.get("hasHeader"))
    result = await run_in_threadpool(parse_csv, data, delimiter=delimiter, has_header=has_header)
    ok = not result["errors"]
    plot_type = opts.get("plotType")
    if isinstance(plot_type, str) and plot_type in PLOT_TYPES and ok:
        result["columnNotes"] = await run_in_threadpool(column_notes, result["columns"], result["rows"], plot_type)
    return {"ok": ok, "status": "ok" if ok else "error", "fileName": file_name[:255] if file_name else None, **result}


@router.get("/samples/{plot_type}")
async def sample(plot_type: str):
    """Deterministic sample data for a plot type (contract s3d): {plotType, sampleId, label, description, dataset, mapping,
    options}. 404 for an unknown plot type."""
    out = samples.sample_for(plot_type)
    if out is None:
        raise HTTPException(404, "Unknown plot type; expected one of: " + ", ".join(samples.PLOT_TYPES) + ".")
    return out


@router.get("/layouts")
async def layouts():
    """Composite panel layouts (contract s4t): `{layouts:[{id, label, rows, cols, slots:[{slot, x, y, w, h, cell}]}]}`.
    The single table the composite codegen draws from; the composer positions its panel overlay with it."""
    from backend.figures.codegen.composite import layouts_table
    return {"layouts": layouts_table()}


@router.post("/python/data")
async def python_data(request: Request):
    """Run a data-only script (contract s3d). Body {source}. The script must define `data` (dict of equal-length lists);
    it runs in the runner's harness without a figure, 5 s timeout. Always HTTP 200 with {ok, status, message, columns, rows,
    literal, stdout, stderr, traceback, warnings, durationMs}; 4xx only for malformed requests."""
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send application/json: {source}.")
    try:
        body = _check_source(await request.json())
    except ValueError:
        raise HTTPException(400, "The request body is not valid JSON.")
    if not isinstance(body, dict) or not isinstance(body.get("source"), str):
        raise HTTPException(400, "Send JSON like {\"source\": \"data = {'x': [1, 2]}\"}.")
    source = body["source"]
    job = jobs.create(kind="python")

    def work():
        try:
            with jobs.slot(job):
                return runner.run_python_data(source, cancel=job.event)
        except jobs.Cancelled:
            return runner.RunResult(ok=False, status="cancelled", message="The run was cancelled.")
        finally:
            jobs.finish(job, cancelled=job.cancelled)
    try:
        res = await asyncio.to_thread(work)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    except asyncio.CancelledError:              # the client went away: stop the subprocess
        job.cancel()
        raise
    if res.status == "cancelled" and job.timed_out:
        res.status, res.message = "timeout", job.timeout_message()
    out = {"ok": res.ok, "status": res.status, "message": res.message, "columns": [], "rows": [],
           "literal": False, "stdout": res.stdout, "stderr": res.stderr, "traceback": res.traceback,
           "warnings": res.warnings, "durationMs": res.duration_ms}
    if res.ok and res.data:
        try:
            Dataset(columns=res.data["columns"], rows=res.data["rows"])        # same limits as any record
        except ValueError as exc:
            out.update(ok=False, status="error", message="The data is not usable: " + str(exc).splitlines()[-1][:300])
        else:
            out.update(columns=res.data["columns"], rows=res.data["rows"], literal=runner.is_literal_assignment(source))
    return out


@router.get("/python/templates")
async def python_templates():
    """Starter scripts for the Python Source tab (contract s4p): {templates: [{id, name, description, sizeIn, source}]}."""
    return templates.list_templates()


@router.post("/python/run")
async def python_run(request: Request):
    """Run a user script and answer like /render (contract s4p). Body {source, dpi?, purpose?, background?, sizeIn?, jobId?}.

    Adds figuresFound, warnings, traceback {line, column, message} and missingModule {name, package, message} to the render
    response. Always HTTP 200 for readable requests; 4xx only for malformed ones."""
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_RENDER_BYTES:
        raise HTTPException(413, "The request is too large to run.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send application/json: {source, dpi?, purpose?, background?, sizeIn?}.")
    try:
        body = _check_source(await request.json())
    except ValueError:
        raise HTTPException(400, "The request body is not valid JSON.")
    try:
        source, dpi, purpose, background, size, job_id = pyrun.parse_request(body)
        job = jobs.create(job_id, kind="python")
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    try:
        return await asyncio.to_thread(pyrun.run_job, job, source, dpi, purpose, background, size)
    except asyncio.CancelledError:              # the client went away: stop the subprocess
        job.cancel()
        raise


MAX_LATEX_REQUEST_BYTES = 40 << 20   # source, or a base64 PDF of up to latex.MAX_PDF_BYTES


async def _latex_body(request: Request) -> Any:
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_LATEX_REQUEST_BYTES:
        raise HTTPException(413, "The request is too large for LaTeX.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send application/json.")
    try:
        return _check_source(await request.json())
    except ValueError:
        raise HTTPException(400, "The request body is not valid JSON.")


async def _latex_job(body: Any, fn, *args):
    """Run a blocking LaTeX function as a `latex` job (queued behind other compiles). `jobId` in the body = client-chosen id."""
    try:
        job = jobs.create(body.get("jobId") if isinstance(body, dict) else None, kind="latex")
    except ValueError as exc:
        raise HTTPException(400, str(exc))

    def work():
        try:
            return fn(*args, job=job)
        finally:
            jobs.finish(job, cancelled=job.cancelled)
    try:
        return await asyncio.to_thread(work)
    except asyncio.CancelledError:              # the client went away: stop the TeX process
        job.cancel()
        raise


@router.get("/latex/templates")
async def latex_templates():
    """Starter documents for the LaTeX tab (contract s4u): {templates: [{id, name, description, mode, engine, source}]}."""
    return templates.list_latex_templates()


@router.post("/latex/compile")
async def latex_compile(request: Request):
    """Compile LaTeX and preview page 1 (contract s4u). Body {source, mode?: document|fragment, engine?, dpi?}.

    Always HTTP 200 for readable requests: {ok, status, message, pdfBase64, preview, log, errors:[{line, message}], missing, wrapped,
    wrapper, overfull, passes, pages, durationMs, ...}. Runs only when called; 4xx only for malformed requests."""
    body = await _latex_body(request)
    try:
        source, mode, engine, dpi = latex_core.parse_compile_request(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return await _latex_job(body, latex_core.compile_preview, source, mode, engine, dpi)


@router.post("/latex/wrapper")
async def latex_wrapper(request: Request):
    """The wrapper a fragment is compiled with (contract s4u): {ok, message, wrapper:{prefix,suffix,lineOffset}, tex}. Compiles nothing."""
    body = await _latex_body(request)
    if not isinstance(body, dict) or not isinstance(body.get("source"), str):
        raise HTTPException(400, "source must be a string.")
    return latex_core.preview_wrapper(body["source"])


@router.post("/latex/render")
async def latex_render(request: Request):
    """Final PNG of page 1 (contract s4u). Body {pdfBase64 | source, mode?, engine?, wIn?, dpi? (default 450)}."""
    body = await _latex_body(request)
    try:
        pdf, source, mode, engine, w_in, dpi, background = latex_core.parse_render_request(body)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    return await _latex_job(body, latex_core.render_final, pdf, source, mode, engine, dpi, w_in, background)


@router.post("/latex/equation")
async def latex_equation(request: Request):
    """Render a LaTeX equation into high-resolution transparent PNG."""
    body = await _latex_body(request)
    if not isinstance(body, dict):
        raise HTTPException(400, "The request body must be a JSON object.")
    source = body.get("source")
    if not isinstance(source, str):
        raise HTTPException(400, "source must be a string.")
    color = body.get("color", "#000000")
    if not isinstance(color, str):
        color = "#000000"
    dpi = body.get("dpi", 300)
    if not isinstance(dpi, int) or dpi < 50 or dpi > 1200:
        dpi = 300
    return await _latex_job(body, latex_core.render_equation, source, color, dpi)



@router.post("/render")
async def render(request: Request):
    """Render a figure record from generated (structured) or custom source (contract s4i).

    Body {record, purpose: 'preview'|'final', dpi?, jobId?}. Always HTTP 200 with {ok, status, ...} for readable requests,
    including invalid figures (status 'invalid', human messages in `diagnostics`); 4xx only for malformed requests.
    """
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_RENDER_BYTES:
        raise HTTPException(413, "The request is too large to render.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send application/json: {record, purpose, dpi?}.")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "The request body is not valid JSON.")
    try:
        record, purpose, dpi, job_id = render_core.parse_request(body)
        job = jobs.create(job_id)
    except ValueError as exc:
        raise HTTPException(400, str(exc))
    try:
        return await asyncio.to_thread(render_core.render_job, job, record, purpose, dpi)
    except asyncio.CancelledError:              # the client went away: stop the subprocess
        job.cancel()
        raise


@router.post("/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    """Kill the render with this id (queued or running). The /render request then answers with status 'cancelled'.
    {ok, jobId, status: 'cancelling'|'cancelled'|'finished'}; 404 for an id the server does not know."""
    status = jobs.cancel(job_id)
    if status is None:
        raise HTTPException(404, "No render with this id is known.")
    return {"ok": True, "jobId": job_id, "status": status}


@router.get("/jobs")
async def list_jobs():
    """Debug view of the job registry (contract s4y): {jobs:[{id, kind, state, queuePosition, elapsedMs, timeoutS, ...}], limits, running, queued}."""
    return jobs.snapshot()


@router.get("/jobs/{job_id}")
async def get_job(job_id: str):
    """One job (the UI polls this to show 'queued' / elapsed time): {job}; 404 for an id the server does not know."""
    row = jobs.describe(job_id)
    if row is None:
        raise HTTPException(404, "No job with this id is known.")
    return {"job": row}


@router.get("/pixels")
async def pixels(w: float = Query(..., ge=MIN_SIDE_IN, le=MAX_SIDE_IN), h: float = Query(..., ge=MIN_SIDE_IN, le=MAX_SIDE_IN),
                 dpi: int = Query(..., ge=MIN_DPI, le=MAX_DPI)):
    """Pixel math for the export panel (contract s4j): {wPx, hPx, megapixels, warning?}. w/h in inches, 422 out of range."""
    return export_core.pixels(w, h, dpi)


@router.post("/export")
async def export(request: Request):
    """Download a figure as png, pdf, py or bundle (zip with data.csv) (contract s4j). Body {record, format, dpi?, background?}.
    The file is rendered from the record sent, at its export size and dpi. 400 malformed / refused combination, 422 the figure
    cannot be rendered (message in `detail`), 413 too large."""
    length = request.headers.get("content-length", "")
    if length.isdigit() and int(length) > MAX_RENDER_BYTES:
        raise HTTPException(413, "The request is too large to export.")
    if request.headers.get("content-type", "").split(";")[0].strip().lower() != "application/json":
        raise HTTPException(415, "Send application/json: {record, format, dpi?, background?}.")
    try:
        body = await request.json()
    except ValueError:
        raise HTTPException(400, "The request body is not valid JSON.")
    try:
        record, fmt, dpi, background = export_core.parse_request(body)
        job = jobs.create(body.get("jobId") if isinstance(body, dict) else None)
    except (export_core.ExportError, ValueError) as exc:
        raise HTTPException(getattr(exc, "status", 400), getattr(exc, "message", str(exc)))
    try:
        out = await asyncio.to_thread(export_core.export_figure, record, fmt, dpi, background, job)
    except export_core.ExportError as exc:
        raise HTTPException(exc.status, exc.message)
    except asyncio.CancelledError:              # the client went away: stop the subprocess
        job.cancel()
        raise
    return Response(out.data, media_type=out.media_type, headers={
        "Content-Disposition": export_core.content_disposition(out.filename),
        "Access-Control-Expose-Headers": "Content-Disposition",
    })
