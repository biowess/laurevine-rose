"""FastAPI Server for Research Presentation Editor.

Serves the frontend static files on loopback and provides API endpoints for:
- /api/health: health check and connection status
- /api/presentation/export: native PPTX generation and file download
- /api/presentation/save: project persistence
"""

import io
import json
import os
import re
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from backend import security
from backend.exporter import export_presentation
from backend.figures import jobs as figure_jobs
from backend.figures.router import router as figures_router
from backend.models import ExportRequest, PresentationDoc, SaveRequest, upgrade_document



@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Startup: remove work folders a crashed server left behind. Shutdown: cancel running jobs, kill their processes, clean up."""
    figure_jobs.sweep_orphans()
    figure_jobs.reopen()
    try:
        yield
    finally:
        figure_jobs.shutdown()


app = FastAPI(title="Research Presentation Editor API", version="1.1.0", lifespan=lifespan)

# Same-origin only: the page is served by this app. Extra origins only through RPE_ALLOWED_ORIGINS (docs/SECURITY.md).
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(security.allowed_origins()),
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Accept", "X-RPE-Token"],
    expose_headers=["Content-Disposition", "X-Export-Warnings"],
)
app.add_middleware(security.SecurityMiddleware)   # added last = outermost: Host / Origin / token / size checks run first

app.include_router(figures_router)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    fav = os.path.join(BASE_DIR, "Assets", "favicon.svg")
    if os.path.exists(fav):
        return FileResponse(fav, media_type="image/svg+xml")
    return Response(status_code=204)


@app.get("/api/session")
async def session():
    """Per-process token for the X-RPE-Token header that figure POST endpoints require (docs/SECURITY.md)."""
    return JSONResponse({"token": security.SESSION_TOKEN, "header": "X-RPE-Token"}, headers={"Cache-Control": "no-store"})


@app.get("/security")
async def security_notes():
    """The trust model (docs/SECURITY.md) as plain text, linked from the Python and LaTeX windows."""
    path = os.path.join(BASE_DIR, "docs", "SECURITY.md")
    if not os.path.exists(path):
        raise HTTPException(status_code=404, detail="SECURITY.md not found")
    return FileResponse(path, media_type="text/plain; charset=utf-8")


@app.get("/api/health")
async def health_check():
    """Health check endpoint to indicate backend connectivity."""
    return {
        "status": "ok",
        "service": "Research Presentation Editor",
        "version": "1.1.0",
        "connected": True,
    }


def export_warning_headers(warnings: list) -> dict:
    """`X-Export-Warnings`: JSON list of export notes (ASCII-escaped, capped so the header stays small)."""
    if not warnings:
        return {}
    shown = warnings[:20]
    payload = {"count": len(warnings), "items": shown}
    text = json.dumps(payload, ensure_ascii=True, separators=(",", ":"))
    while len(text) > 6000 and len(shown) > 1:
        shown = shown[:-1]
        text = json.dumps({"count": len(warnings), "items": shown}, ensure_ascii=True, separators=(",", ":"))
    return {"X-Export-Warnings": text}


@app.post("/api/presentation/export")
async def export_presentation_endpoint(request: ExportRequest):
    """Export canonical presentation document to PPTX or PDF."""
    fmt = request.format.lower()
    if fmt not in ("pptx", "pdf"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported export format '{request.format}'. Currently PPTX and PDF exports are supported.",
        )

    try:
        doc = upgrade_document(request.doc)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    try:
        export_warnings: list = []
        buffer = export_presentation(doc, warnings=export_warnings)
        warn_headers = export_warning_headers(export_warnings)

        safe_title = re.sub(r"[^\w\-.]+", "_", doc.title or "presentation").strip("_")
        if not safe_title:
            safe_title = "presentation"

        if fmt == "pptx":
            filename = f"{safe_title}.pptx"
            return StreamingResponse(
                buffer,
                media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
                headers={
                    "Content-Disposition": f'attachment; filename="{filename}"',
                    "Access-Control-Expose-Headers": "Content-Disposition, X-Export-Warnings",
                    **warn_headers,
                },
            )

        # PDF format: convert presentation to PDF using bundled fonts
        from backend.exporter import export_presentation_to_pdf
        from backend.soffice import PdfConverterMissing

        try:
            pdf_buffer = export_presentation_to_pdf(doc, warnings=export_warnings)
        except PdfConverterMissing as e:
            raise HTTPException(
                status_code=503,
                detail={"code": e.code, "message": str(e)},
            )
        except RuntimeError as e:
            raise HTTPException(status_code=500, detail=str(e))

        warn_headers = export_warning_headers(export_warnings)
        filename = f"{safe_title}.pdf"
        return StreamingResponse(
            pdf_buffer,
            media_type="application/pdf",
            headers={
                "Content-Disposition": f'attachment; filename="{filename}"',
                "Access-Control-Expose-Headers": "Content-Disposition, X-Export-Warnings",
                **warn_headers,
            },
        )
    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Export failed: {str(e)}")


@app.post("/api/presentation/save")
async def save_presentation_endpoint(request: SaveRequest):
    """Save presentation document."""
    try:
        # Validate the doc (and upgrade older schema versions)
        doc = upgrade_document(request.doc)
        return {
            "status": "ok",
            "message": "Presentation validated and saved.",
            "docId": doc.id,
            "savedAt": int(time.time() * 1000),
        }
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Save validation failed: {str(e)}")


@app.middleware("http")

async def no_cache_static(request, call_next):
    resp = await call_next(request)
    p = request.url.path
    if p == "/" or p.startswith(("/js/", "/css/", "/fonts/")):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


# Mount static assets
css_dir = os.path.join(BASE_DIR, "css")
js_dir = os.path.join(BASE_DIR, "js")
fonts_dir = os.path.join(BASE_DIR, "fonts")
assets_dir = os.path.join(BASE_DIR, "Assets")

if os.path.isdir(fonts_dir):
    app.mount("/fonts", StaticFiles(directory=fonts_dir), name="fonts")
if os.path.isdir(css_dir):
    app.mount("/css", StaticFiles(directory=css_dir), name="css")
if os.path.isdir(js_dir):
    app.mount("/js", StaticFiles(directory=js_dir), name="js")
if os.path.isdir(assets_dir):
    app.mount("/Assets", StaticFiles(directory=assets_dir), name="assets")


@app.get("/")
async def serve_index():
    index_file = os.path.join(BASE_DIR, "index.html")
    if os.path.exists(index_file):
        return FileResponse(index_file)
    raise HTTPException(status_code=404, detail="index.html not found")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend.server:app", host="127.0.0.1", port=8000, reload=False)
