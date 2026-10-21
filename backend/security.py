"""Local-server hardening (docs/SECURITY.md, docs/FIGURES_CONTRACT.md s7): Host allowlist, same-origin policy,
per-process session token, body limits, content types and a job-start rate limit. Pure ASGI, no dependencies."""
from __future__ import annotations

import hmac
import json
import os
import secrets
import time
from collections import deque
from typing import Deque, Set
from urllib.parse import urlsplit

TOKEN_HEADER = "x-rpe-token"
SESSION_TOKEN = secrets.token_urlsafe(32)            # new on every server start; handed out by GET /api/session
LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
FIGURES = "/api/figures/"
CSV_PATH = "/api/figures/dataset/parse"
MAX_FIGURE_BYTES = 10 << 20                          # figure / python / latex payloads
MAX_CSV_BYTES = (5 << 20) + (64 << 10)               # 5 MB file + multipart framing
MAX_SOURCE_BYTES = 2 << 20                           # one script / TeX source (checked by the router)
MAX_PRESENTATION_BYTES = 64 << 20                    # whole documents carry their images
JOB_PATHS = {FIGURES + p for p in ("render", "export", "python/run", "python/data", "latex/compile", "latex/render")}
_jobs: Deque[float] = deque()


def _env_set(name: str) -> Set[str]:
    return {v.strip().lower().rstrip("/") for v in os.environ.get(name, "").split(",") if v.strip()}


def allowed_hosts() -> Set[str]:
    return LOOPBACK_HOSTS | _env_set("RPE_ALLOWED_HOSTS")


def allowed_origins() -> Set[str]:
    """Origins besides the page's own that may call the API (env RPE_ALLOWED_ORIGINS, comma separated)."""
    return _env_set("RPE_ALLOWED_ORIGINS")


def jobs_per_minute() -> int:
    try:
        return max(1, int(os.environ.get("RPE_JOBS_PER_MIN", "60")))
    except ValueError:
        return 60


def reset_rate_limit() -> None:
    _jobs.clear()


def host_name(host_header: str) -> str:
    """Hostname of a Host header value without port ('[::1]:8000' -> '::1')."""
    h = host_header.strip().lower()
    if h.startswith("["):
        return h[1:].split("]", 1)[0]
    return h.rsplit(":", 1)[0] if h.count(":") == 1 else h


def _origin_ok(origin: str, host: str) -> bool:
    o = origin.strip().lower().rstrip("/")
    if o in allowed_origins():
        return True
    try:
        return urlsplit(o).netloc == host.strip().lower()   # same origin: scheme://<the Host the request was sent to>
    except ValueError:
        return False


class SecurityMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope["headers"]}
        method, path = scope["method"], scope["path"]
        host = headers.get("host", "")
        if host_name(host) not in allowed_hosts():
            return await self._deny(send, 403, "Request refused: the Host header is not a loopback address.")
        origin = headers.get("origin")
        api = path.startswith("/api/")
        if api and method != "OPTIONS" and origin is not None and not _origin_ok(origin, host):
            return await self._deny(send, 403, "Request refused: cross-origin requests are not allowed.")
        if path == "/api/session" and headers.get("sec-fetch-site", "same-origin") not in ("same-origin", "none"):
            if not (origin and _origin_ok(origin, host)):
                return await self._deny(send, 403, "Request refused: the session token is for the page served by this server.")
        if method == "POST" and path.startswith("/api/"):
            limit = MAX_FIGURE_BYTES
            if path == CSV_PATH:
                limit = MAX_CSV_BYTES
            elif not path.startswith(FIGURES):
                limit = MAX_PRESENTATION_BYTES
            if path.startswith(FIGURES):
                bad = self._body_error(headers, path)
                if bad:
                    return await self._deny(send, 415, bad)
                if not hmac.compare_digest(headers.get(TOKEN_HEADER, "").encode(), SESSION_TOKEN.encode()):
                    return await self._deny(send, 403, "Missing or invalid session token. Reload the page to start a new session.")
                if path in JOB_PATHS and not self._take_job_slot():
                    return await self._deny(send, 429, f"Too many jobs started: at most {jobs_per_minute()} per minute.", {"Retry-After": "10"})
            length = headers.get("content-length", "")
            if length.isdigit() and int(length) > limit:
                return await self._deny(send, 413, f"The request is too large (limit {limit >> 20} MB).")
            receive = self._counted(receive, limit)
            started = False

            async def tracked_send(msg):
                nonlocal started
                started = started or msg["type"] == "http.response.start"
                await send(msg)
            try:
                return await self.app(scope, receive, tracked_send)
            except _TooLarge:
                if not started:
                    await self._deny(send, 413, f"The request is too large (limit {limit >> 20} MB).")
                return None
        return await self.app(scope, receive, send)

    @staticmethod
    def _body_error(headers, path):
        has_body = headers.get("content-length", "0") not in ("", "0") or "transfer-encoding" in headers
        if not has_body:
            return None
        ctype = headers.get("content-type", "").split(";")[0].strip().lower()
        if ctype == "application/json" or (ctype == "multipart/form-data" and path == CSV_PATH):
            return None
        return "Send application/json" + (" or multipart/form-data." if path == CSV_PATH else ".")

    @staticmethod
    def _take_job_slot() -> bool:
        now = time.monotonic()
        while _jobs and now - _jobs[0] > 60:
            _jobs.popleft()
        if len(_jobs) >= jobs_per_minute():
            return False
        _jobs.append(now)
        return True

    @staticmethod
    def _counted(receive, limit):
        """Streamed bodies (no Content-Length) are cut off once they pass the limit."""
        seen = 0

        async def wrapped():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > limit:
                    raise _TooLarge()
            return msg
        return wrapped

    async def _deny(self, send, status, detail, extra=None):
        body = json.dumps({"detail": detail}).encode()
        hdrs = [(b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()), (b"cache-control", b"no-store")]
        hdrs += [(k.lower().encode(), v.encode()) for k, v in (extra or {}).items()]
        await send({"type": "http.response.start", "status": status, "headers": hdrs})
        await send({"type": "http.response.body", "body": body})


class _TooLarge(Exception):
    pass
