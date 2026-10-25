"""GET /api/figures/runtime and backend/figures/runtime.py (docs/FIGURES_CONTRACT.md s4b)."""
import importlib.metadata as md
import json
import platform
import re
import shutil
import subprocess
import sys
import threading

import pytest
from fastapi.testclient import TestClient

from backend.figures import runtime
from backend.figures.models import MAX_DPI, MAX_PX_SIDE, MIN_DPI
from backend.server import app

client = TestClient(app)
KEYS = {"python", "matplotlib", "numpy", "pandas", "scipy", "tex", "rasterizer", "limits", "platform",
        "warnings", "checkedAt", "fonts"}
PROBE = {"python": "3.12.3", "matplotlib": "3.9.0", "numpy": "2.0.0", "pandas": "2.2.0", "scipy": "1.13.0"}
BANNERS = {"pdflatex": "pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023/Debian)\nkpathsea version 6.3.5\nCopyright",
           "xelatex": "XeTeX 3.141592653-2.6-0.999995 (TeX Live 2023/Debian)\nkpathsea version 6.3.5",
           "lualatex": "This is LuaTeX, Version 1.17.0 (TeX Live 2023/Debian)\nDevelopment id: 1"}


@pytest.fixture(autouse=True)
def _fresh_cache():
    runtime.clear_cache()
    yield
    runtime.clear_cache()


def install_fake(monkeypatch, *, probe=PROBE, engines=("pdflatex", "xelatex"), kpsewhich=True, kpse=None,
                 engine_error=None):
    """Replace shutil.which and the subprocess seam (runtime._run): no real processes. Returns the call log.

    `kpse`: stdout of `kpsewhich pgfplots.sty` (default: found), "" = not found, or an exception to raise.
    `probe`: JSON the isolated interpreter prints, or an exception to raise.
    """
    calls = []
    paths = {n: f"/tex/{n}" for n in engines}
    if kpsewhich:
        paths["kpsewhich"] = "/tex/kpsewhich"
    monkeypatch.setattr(shutil, "which", lambda name, *a, **k: paths.get(name))

    def fake_run(cmd, timeout, isolated_env=False):
        calls.append(list(cmd))
        if cmd[0] == sys.executable:
            if isinstance(probe, Exception):
                raise probe
            return 0, json.dumps(probe) + "\n"
        if cmd[0].endswith("kpsewhich"):
            out = "/tex/texmf/pgfplots.sty\n" if kpse is None else kpse
            if isinstance(out, Exception):
                raise out
            return (0, out) if out else (1, "")
        if engine_error:
            raise engine_error
        return 0, BANNERS[cmd[0].rsplit("/", 1)[1]]

    monkeypatch.setattr(runtime, "_run", fake_run)
    return calls


def probes(calls):
    return [c for c in calls if c[0] == sys.executable]


def test_endpoint_schema():
    r = client.get("/api/figures/runtime")
    assert r.status_code == 200
    j = r.json()
    assert set(j) == KEYS
    assert j["python"] == platform.python_version()
    for pkg in ("matplotlib", "numpy"):          # required by the runner, so present wherever these tests run
        assert j[pkg] == md.version(pkg)
    for pkg in ("pandas", "scipy"):
        assert j[pkg] is None or (isinstance(j[pkg], str) and j[pkg])
    assert set(j["tex"]) == {"engines", "kpsewhich", "pgfplots"}
    assert set(j["tex"]["engines"]) <= set(runtime.TEX_ENGINES)
    for info in j["tex"]["engines"].values():
        assert set(info) == {"path", "version"} and info["path"]
    assert isinstance(j["tex"]["pgfplots"], bool)
    assert j["rasterizer"] in ("pdftoppm", None)   # pdftoppm when poppler is installed, else None
    assert j["limits"]["dpi"] == [MIN_DPI, MAX_DPI] and j["limits"]["maxPxSide"] == MAX_PX_SIDE
    assert j["limits"]["pythonTimeoutS"] == 30 and j["limits"]["latexTimeoutS"] == 60
    assert set(j["platform"]) == {"system", "release", "machine"} and j["platform"]["system"] == platform.system()
    assert isinstance(j["warnings"], list)
    assert re.fullmatch(r"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ", j["checkedAt"])


def test_engine_versions_paths_and_pgfplots(monkeypatch):
    calls = install_fake(monkeypatch, engines=("pdflatex", "xelatex"))
    j = client.get("/api/figures/runtime").json()
    assert set(j["tex"]["engines"]) == {"pdflatex", "xelatex"}          # lualatex is absent, so not listed
    assert j["tex"]["engines"]["pdflatex"] == {"path": "/tex/pdflatex",
                                               "version": "pdfTeX 3.141592653-2.6-1.40.25 (TeX Live 2023/Debian)"}
    assert j["tex"]["engines"]["xelatex"]["version"].startswith("XeTeX 3.141592653")
    assert j["tex"]["kpsewhich"] == "/tex/kpsewhich" and j["tex"]["pgfplots"] is True
    assert j["warnings"] == []
    assert {"matplotlib": "3.9.0"}.items() <= j.items()
    assert j["rasterizer"] in (None, "pdftoppm")   # None in mock env; pdftoppm when system poppler is installed
    assert ["/tex/kpsewhich", "pgfplots.sty"] in calls


def test_missing_tex_tools(monkeypatch):
    """No TeX engine and no kpsewhich anywhere (shutil.which finds nothing): reported, not an error."""
    monkeypatch.setattr(shutil, "which", lambda *a, **k: None)
    r = client.get("/api/figures/runtime")
    assert r.status_code == 200
    j = r.json()
    assert j["tex"] == {"engines": {}, "kpsewhich": None, "pgfplots": False}
    assert j["warnings"] == []
    assert j["python"] == platform.python_version() and j["numpy"] == md.version("numpy")   # Python side unaffected


def test_engines_without_kpsewhich_cannot_confirm_pgfplots(monkeypatch):
    install_fake(monkeypatch, engines=("lualatex",), kpsewhich=False)
    j = runtime.get_runtime()
    assert list(j["tex"]["engines"]) == ["lualatex"] and j["tex"]["kpsewhich"] is None
    assert j["tex"]["pgfplots"] is False
    assert any("kpsewhich was not found" in w for w in j["warnings"])


@pytest.mark.parametrize("kpse, expected, warning", [
    (None, True, None),
    ("", False, None),
    (subprocess.TimeoutExpired("kpsewhich", 5), False, "did not answer in time"),
    (OSError("boom"), False, "could not be run"),
])
def test_pgfplots_check_outcomes(monkeypatch, kpse, expected, warning):
    install_fake(monkeypatch, kpse=kpse)
    j = runtime.get_runtime()
    assert j["tex"]["pgfplots"] is expected
    if warning is None:
        assert j["warnings"] == []
    else:
        assert any(warning in w for w in j["warnings"])


def test_engine_that_reports_no_version_is_listed_with_warning(monkeypatch):
    install_fake(monkeypatch, engines=("pdflatex",), engine_error=subprocess.TimeoutExpired("pdflatex", 5))
    j = runtime.get_runtime()
    assert j["tex"]["engines"] == {"pdflatex": {"path": "/tex/pdflatex", "version": None}}
    assert any("pdflatex was found but did not report a version" in w for w in j["warnings"])


def test_missing_python_packages_are_null(monkeypatch):
    install_fake(monkeypatch, probe={**PROBE, "scipy": None})
    j = runtime.get_runtime()
    assert j["scipy"] is None
    assert j["matplotlib"] == "3.9.0" and j["python"] == "3.12.3"
    # rasterizer now depends on pdftoppm (external tool), not on pymupdf; the fake does not mock shutil.which for it


def test_packages_are_probed_by_an_isolated_interpreter(monkeypatch):
    calls = install_fake(monkeypatch)
    runtime.get_runtime()
    (cmd,) = probes(calls)
    assert cmd[:2] == [sys.executable, "-I"]        # same flag the runner uses, so user-site packages are not reported


def test_probe_failure_falls_back_to_this_process_with_a_warning(monkeypatch):
    install_fake(monkeypatch, probe=subprocess.TimeoutExpired("python", 10))
    j = runtime.get_runtime()
    assert j["python"] == platform.python_version() and j["numpy"] == md.version("numpy")
    assert any("isolated package check could not run (it timed out)" in w for w in j["warnings"])


def test_cache_60_seconds_and_refresh(monkeypatch):
    calls = install_fake(monkeypatch)
    now = [1000.0]
    monkeypatch.setattr(runtime, "_clock", lambda: now[0])
    kpse_calls = lambda: sum(c[0] == "/tex/kpsewhich" for c in calls)
    first = runtime.get_runtime()
    now[0] += 59.9
    runtime.get_runtime()
    assert len(probes(calls)) == 1 and kpse_calls() == 1       # served from cache
    first["python"] = "tampered"
    assert runtime.get_runtime()["python"] == "3.12.3"          # callers cannot modify the cached report
    now[0] += 0.1
    runtime.get_runtime()
    assert len(probes(calls)) == 2 and kpse_calls() == 2        # expired at 60 s
    runtime.get_runtime(refresh=True)
    assert len(probes(calls)) == 3 and kpse_calls() == 3


def test_endpoint_refresh_parameter(monkeypatch):
    calls = install_fake(monkeypatch)
    client.get("/api/figures/runtime")
    client.get("/api/figures/runtime")
    assert len(probes(calls)) == 1
    assert client.get("/api/figures/runtime?refresh=true").status_code == 200
    assert len(probes(calls)) == 2
    assert client.get("/api/figures/runtime?refresh=maybe").status_code == 422     # malformed request -> 4xx


def test_concurrent_requests_share_one_probe(monkeypatch):
    calls = install_fake(monkeypatch)
    threads = [threading.Thread(target=runtime.get_runtime) for _ in range(6)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert len(probes(calls)) == 1


@pytest.mark.skipif(not shutil.which("pdflatex"), reason="no TeX installation")
def test_real_pdflatex_is_detected():
    j = runtime.get_runtime()
    info = j["tex"]["engines"]["pdflatex"]
    assert info["path"] and "TeX" in (info["version"] or "")
    if shutil.which("kpsewhich"):
        assert j["tex"]["kpsewhich"] and isinstance(j["tex"]["pgfplots"], bool)


def test_fonts_listed_sorted_unique(monkeypatch):
    from matplotlib import font_manager
    fake = [type("F", (), {"name": n})() for n in ("Zeta", "alpha", "Alpha", "Zeta", "  ", "", "Mono One")]
    monkeypatch.setattr(font_manager.fontManager, "ttflist", fake)
    install_fake(monkeypatch)
    fonts = client.get("/api/figures/runtime?refresh=true").json()["fonts"]
    assert fonts == ["Alpha", "alpha", "Mono One", "Zeta"]


def test_fonts_real_report_is_list_of_strings():
    fonts = client.get("/api/figures/runtime?refresh=true").json()["fonts"]
    assert isinstance(fonts, list) and fonts, "Matplotlib ships DejaVu, so the list is never empty here"
    assert all(isinstance(n, str) and n for n in fonts) and len(fonts) == len(set(fonts)) <= runtime.MAX_FONTS


def test_fonts_unreadable_gives_empty_list_and_warning(monkeypatch):
    from matplotlib import font_manager

    class Boom:
        @property
        def ttflist(self):
            raise RuntimeError("font cache unreadable")

    monkeypatch.setattr(font_manager, "fontManager", Boom())
    install_fake(monkeypatch)
    j = client.get("/api/figures/runtime?refresh=true").json()
    assert j["fonts"] == [] and "The installed fonts could not be listed." in j["warnings"]
