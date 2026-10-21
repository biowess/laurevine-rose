"""Local-server hardening (docs/SECURITY.md): Host check, same-origin CORS, session token, content types, size limits, rate limit, run.py."""
import os
import subprocess
import sys

import pytest
from starlette.testclient import TestClient

from backend import security
from backend.server import app

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = {"X-RPE-Token": security.SESSION_TOKEN}
EVIL = "https://evil.example"
client = TestClient(app)
anon = TestClient(app)
anon.headers.pop("X-RPE-Token")          # the conftest adds the token to every client; this one is a drive-by caller


def test_session_token_is_served_and_unguessable():
    r = anon.get("/api/session")
    assert r.status_code == 200 and r.json()["token"] == security.SESSION_TOKEN and r.json()["header"] == "X-RPE-Token"
    assert r.headers["cache-control"] == "no-store" and len(security.SESSION_TOKEN) >= 40
    assert "access-control-allow-origin" not in r.headers


@pytest.mark.parametrize("host", ["evil.example", "evil.example:8000", "192.168.1.5:8000", "127.0.0.1.evil.example"])
def test_non_loopback_host_is_refused(host):
    for r in (client.get("/api/health", headers={"host": host}), client.get("/", headers={"host": host}),
              client.post("/api/figures/python/data", json={"source": "data={'a':[1]}"}, headers={"host": host})):
        assert r.status_code == 403 and "Host" in r.json()["detail"]


@pytest.mark.parametrize("host", ["127.0.0.1:8000", "localhost:8000", "localhost", "[::1]:8000"])
def test_loopback_hosts_are_accepted(host):
    assert client.get("/api/health", headers={"host": host}).status_code == 200


@pytest.mark.parametrize("path", ["/api/figures/python/run", "/api/figures/python/data", "/api/figures/latex/compile",
                                  "/api/figures/latex/render", "/api/figures/render", "/api/figures/export", "/api/figures/jobs/x/cancel"])
def test_figure_posts_need_the_token(path):
    assert anon.post(path, json={}).status_code == 403
    assert anon.post(path, json={}, headers={"X-RPE-Token": "wrong"}).status_code == 403
    assert client.post(path, json={}).status_code != 403            # token from conftest: reaches the endpoint (400 / 404, not 403)


def test_token_not_needed_for_reads():
    assert anon.get("/api/figures/runtime").status_code == 200
    assert anon.get("/api/figures/samples/line").status_code == 200


def test_foreign_origin_is_refused_even_with_the_token():
    for r in (client.post("/api/figures/python/data", json={}, headers={"Origin": EVIL}),
              client.get("/api/figures/runtime", headers={"Origin": EVIL}),
              client.get("/api/session", headers={"Origin": EVIL}),
              client.get("/api/session", headers={"Sec-Fetch-Site": "cross-site"}),
              client.get("/api/session", headers={"Sec-Fetch-Site": "same-site"})):    # another port on localhost is another site
        assert r.status_code == 403 and "access-control-allow-origin" not in r.headers
    assert client.get("/api/session", headers={"Origin": "http://127.0.0.1", "Sec-Fetch-Site": "same-origin"}).status_code == 200
    assert client.post("/api/figures/python/data", json={}, headers={"Origin": "http://127.0.0.1"}).status_code == 400   # same origin, reaches the endpoint


def test_cors_preflight_from_foreign_origin_is_refused():
    r = client.options("/api/figures/python/run", headers={"Origin": EVIL, "Access-Control-Request-Method": "POST",
                                                           "Access-Control-Request-Headers": "content-type,x-rpe-token"})
    assert r.status_code in (400, 403) and "access-control-allow-origin" not in r.headers   # no Allow-Origin = the browser refuses the real request
    r = client.options("/api/health", headers={"Origin": EVIL, "Access-Control-Request-Method": "GET"})
    assert r.status_code in (400, 403) and "access-control-allow-origin" not in r.headers


def test_no_wildcard_cors_header_anywhere():
    for path in ("/api/health", "/api/figures/runtime", "/api/session", "/"):
        assert client.get(path, headers={"Origin": EVIL}).headers.get("access-control-allow-origin") is None


@pytest.mark.parametrize("ctype", ["text/plain", "application/x-www-form-urlencoded", "text/csv", "application/octet-stream"])
def test_figure_posts_reject_non_json_bodies(ctype):
    for path in ("/api/figures/python/run", "/api/figures/latex/compile", "/api/figures/render", "/api/figures/dataset/parse"):
        r = client.post(path, content=b'{"source": "x"}', headers={"content-type": ctype})
        assert r.status_code == 415, path


def test_multipart_only_on_csv_import():
    files = {"file": ("d.csv", b"a,b\n1,2\n")}
    assert client.post("/api/figures/dataset/parse", files=files).status_code == 200
    assert client.post("/api/figures/python/run", files=files).status_code == 415
    assert client.post("/api/figures/latex/compile", files=files).status_code == 415


def test_oversize_bodies_are_refused():
    big = {"content-type": "application/json"}
    assert client.post("/api/figures/python/run", content=b"{}", headers={**big, "content-length": str(11 << 20)}).status_code == 413
    assert client.post("/api/figures/latex/compile", content=b"{}", headers={**big, "content-length": str(11 << 20)}).status_code == 413
    assert client.post("/api/figures/dataset/parse", content=b"{}", headers={**big, "content-length": str(6 << 20)}).status_code == 413
    # no Content-Length (chunked): cut off while reading
    def chunks(n):
        for _ in range(n):
            yield b" " * (1 << 20)
    assert client.post("/api/figures/render", content=chunks(12), headers=big).status_code == 413
    assert client.post("/api/figures/dataset/parse", content=chunks(7), headers=big).status_code == 413


def test_csv_just_under_the_limit_still_parses():
    text = "a,b\n" + "1,2\n" * 1000
    assert client.post("/api/figures/dataset/parse", json={"text": text}).json()["ok"] is True


def test_source_over_2mb_is_refused():
    huge = "x = 1\n" * (400 * 1024)                      # ~2.4 MB
    assert client.post("/api/figures/python/run", json={"source": huge}).status_code == 413
    assert client.post("/api/figures/python/data", json={"source": huge}).status_code == 413
    assert client.post("/api/figures/latex/compile", json={"source": huge}).status_code == 413
    assert client.post("/api/figures/python/data", json={"source": "data = {'a': [1, 2]}"}).status_code == 200


def test_job_starts_are_rate_limited(monkeypatch):
    monkeypatch.setenv("RPE_JOBS_PER_MIN", "3")
    security.reset_rate_limit()
    codes = [client.post("/api/figures/python/data", json={}).status_code for _ in range(5)]
    assert codes == [400, 400, 400, 429, 429]
    r = client.post("/api/figures/render", json={})
    assert r.status_code == 429 and r.headers["retry-after"] and "per minute" in r.json()["detail"]
    assert client.get("/api/figures/runtime").status_code == 200             # reads and cancels are not job starts
    assert client.post("/api/figures/jobs/nope/cancel").status_code == 404
    security.reset_rate_limit()
    assert client.post("/api/figures/python/data", json={}).status_code == 400


def test_security_notes_are_served_and_say_what_they_cannot_do():
    r = client.get("/security")
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/plain")
    assert "not a sandbox" in r.text.lower() and "ALLOW_REMOTE" in r.text


# ---- run.py -----------------------------------------------------------------------------------------------------------------------

def run_py(**env):
    e = {k: v for k, v in os.environ.items() if k not in ("HOST", "ALLOW_REMOTE")}
    e.update(env)
    code = "import runpy, uvicorn; uvicorn.run = lambda *a, **k: print('BIND', k['host']); runpy.run_path('run.py', run_name='__main__')"
    return subprocess.run([sys.executable, "-c", code], cwd=ROOT, env=e, capture_output=True, text=True, timeout=60)


def test_run_py_binds_loopback_by_default():
    p = run_py()
    assert p.returncode == 0 and "BIND 127.0.0.1" in p.stdout


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.1.20", "example.com"])
def test_run_py_refuses_non_loopback_host(host):
    p = run_py(HOST=host)
    assert p.returncode != 0 and "BIND" not in p.stdout and "ALLOW_REMOTE" in p.stderr


def test_run_py_allows_remote_only_explicitly_and_warns():
    p = run_py(HOST="0.0.0.0", ALLOW_REMOTE="1")
    assert p.returncode == 0 and "BIND 0.0.0.0" in p.stdout and "WARNING" in p.stderr
    assert run_py(HOST="localhost").returncode == 0 and run_py(HOST="::1").returncode == 0
