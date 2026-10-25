"""What this machine can do for figures: Python packages, TeX engines, limits (docs/FIGURES_CONTRACT.md s4b).

Package versions are read by the same interpreter, with the same flags and environment, that runs user
scripts (``python -I``), so the report matches what the runner can actually import. Nothing is imported or
executed beyond ``importlib`` lookups and ``<engine> --version`` / ``kpsewhich`` calls. The whole report is
cached for CACHE_TTL_S seconds; ``get_runtime(refresh=True)`` bypasses the cache.
"""
from __future__ import annotations

import copy
import json
import os
import platform
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from backend.figures.dataset import MAX_BYTES as MAX_CSV_BYTES
from backend.figures.models import (
    MAX_CELLS, MAX_COLUMNS, MAX_DPI, MAX_FIGURES_PER_DOC, MAX_MEGAPIXELS, MAX_PX_SIDE, MAX_ROWS, MAX_SIDE_IN,
    MAX_SOURCE_CHARS, MIN_DPI, MIN_SIDE_IN,
)
from backend.figures.runner import _ENV_KEEP, DEFAULT_TIMEOUT, MAX_STREAM_BYTES, MAX_TIMEOUT

CACHE_TTL_S = 60.0
PROBE_TIMEOUT_S = 10.0      # isolated interpreter start + importlib lookups
TOOL_TIMEOUT_S = 5.0        # each `<engine> --version` and `kpsewhich`
LATEX_TIMEOUT_S = 60        # compile limit, contract s7 (latex.py will use this value)
TEX_ENGINES = ("pdflatex", "xelatex", "lualatex")
PACKAGES = ("matplotlib", "numpy", "pandas", "scipy")
MAX_FONTS = 2000            # longest `fonts` list in the report

# Runs inside the child interpreter. Defines scan() so the same code can also run in-process as a fallback.
_PROBE_SRC = '''
import importlib.metadata as md, importlib.util as iu, platform
_PKGS = {"matplotlib": (("matplotlib",), "matplotlib"), "numpy": (("numpy",), "numpy"),
         "pandas": (("pandas",), "pandas"), "scipy": (("scipy",), "scipy")}
def _version(mods, dist):
    for m in mods:
        try:
            if iu.find_spec(m) is None:
                continue
        except (ImportError, ValueError):
            continue
        try:
            return md.version(dist)
        except md.PackageNotFoundError:
            return "unknown"
    return None
def scan():
    out = {"python": platform.python_version()}
    for key, (mods, dist) in _PKGS.items():
        out[key] = _version(mods, dist)
    return out
'''

_clock = time.monotonic      # indirection so tests can move time
_lock = threading.Lock()
_cache: Optional[Tuple[float, Dict[str, Any]]] = None


def _run(cmd: List[str], timeout: float, isolated_env: bool = False) -> Tuple[int, str]:
    """Run a short, fixed command; returns (returncode, stdout). Raises OSError / TimeoutExpired."""
    env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_KEEP} if isolated_env else None
    proc = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, errors="replace",
                          timeout=timeout, env=env)
    return proc.returncode, proc.stdout


def _scan_python(warnings: List[str]) -> Dict[str, Any]:
    """Python version and package versions as seen by `python -I` (what user scripts get)."""
    reason = "no interpreter path is available"
    if sys.executable:
        try:
            code, out = _run([sys.executable, "-I", "-c", _PROBE_SRC + "\nimport json; print(json.dumps(scan()))"],
                             PROBE_TIMEOUT_S, isolated_env=True)
            if code == 0:
                found = json.loads(out.strip().splitlines()[-1])
                if isinstance(found, dict) and isinstance(found.get("python"), str):
                    return found
            reason = f"it exited with code {code}"
        except subprocess.TimeoutExpired:
            reason = "it timed out"
        except (OSError, ValueError, IndexError) as exc:
            reason = f"it failed ({type(exc).__name__})"
    warnings.append(f"The isolated package check could not run ({reason}); versions were read from the server process.")
    ns: Dict[str, Any] = {}
    exec(_PROBE_SRC, ns)                      # fixed source above, no user input
    return ns["scan"]()


def _scan_engine(name: str, warnings: List[str]) -> Optional[Dict[str, Optional[str]]]:
    path = shutil.which(name)
    if not path:
        return None
    version: Optional[str] = None
    try:
        code, out = _run([path, "--version"], TOOL_TIMEOUT_S)
        first = out.strip().splitlines()[0].strip() if out.strip() else ""
        if code == 0 and first:
            version = first[:200]
    except (subprocess.TimeoutExpired, OSError):
        pass
    if version is None:
        warnings.append(f"{name} was found but did not report a version.")
    return {"path": path, "version": version}


def _scan_pgfplots(warnings: List[str]) -> Tuple[Optional[str], bool]:
    """(kpsewhich path, pgfplots.sty found). The sty is only 'found' if kpsewhich itself located it."""
    kpse = shutil.which("kpsewhich")
    if not kpse:
        return None, False
    try:
        code, out = _run([kpse, "pgfplots.sty"], TOOL_TIMEOUT_S)
        return kpse, code == 0 and bool(out.strip())
    except subprocess.TimeoutExpired:
        warnings.append("kpsewhich did not answer in time, so pgfplots could not be checked.")
    except OSError:
        warnings.append("kpsewhich could not be run, so pgfplots could not be checked.")
    return kpse, False


def _scan_fonts(warnings: List[str]) -> List[str]:
    """Family names Matplotlib can use for ``appearance.fontName`` (same source as the ``font_not_installed`` note)."""
    try:
        from matplotlib import font_manager
        names = {f.name.strip() for f in font_manager.fontManager.ttflist if f.name and f.name.strip()}
    except Exception:                          # matplotlib missing or its font cache unreadable: no list, never an error
        warnings.append("The installed fonts could not be listed.")
        return []
    return sorted(names, key=lambda n: (n.casefold(), n))[:MAX_FONTS]


def _limits() -> Dict[str, Any]:
    return {
        "sideIn": [MIN_SIDE_IN, MAX_SIDE_IN], "dpi": [MIN_DPI, MAX_DPI], "maxPxSide": MAX_PX_SIDE,
        "maxMegapixels": MAX_MEGAPIXELS, "pythonTimeoutS": DEFAULT_TIMEOUT, "maxPythonTimeoutS": MAX_TIMEOUT,
        "latexTimeoutS": LATEX_TIMEOUT_S, "maxOutputBytes": MAX_STREAM_BYTES, "maxSourceChars": MAX_SOURCE_CHARS,
        "maxCsvBytes": MAX_CSV_BYTES, "maxRows": MAX_ROWS, "maxColumns": MAX_COLUMNS, "maxCells": MAX_CELLS,
        "maxFiguresPerDoc": MAX_FIGURES_PER_DOC,
    }


def collect_runtime() -> Dict[str, Any]:
    """Probe the machine now (no cache). Slow tools run in parallel; every probe is time-limited."""
    warnings: List[str] = []
    with ThreadPoolExecutor(max_workers=len(TEX_ENGINES) + 3) as pool:
        py_f = pool.submit(_scan_python, warnings)
        eng_f = {n: pool.submit(_scan_engine, n, warnings) for n in TEX_ENGINES}
        pgf_f = pool.submit(_scan_pgfplots, warnings)
        font_f = pool.submit(_scan_fonts, warnings)
        py, (kpse, pgfplots), fonts = py_f.result(), pgf_f.result(), font_f.result()
        found = {n: f.result() for n, f in eng_f.items()}
    engines = {n: info for n, info in found.items() if info}
    if engines and not kpse:
        warnings.append("kpsewhich was not found, so pgfplots could not be checked.")
    report: Dict[str, Any] = {"python": py["python"]}
    report.update({p: py.get(p) for p in PACKAGES})
    report.update({
        "tex": {"engines": engines, "kpsewhich": kpse, "pgfplots": pgfplots},
        "rasterizer": "pdftoppm" if shutil.which("pdftoppm") else None,
        "fonts": fonts,
        "limits": _limits(),
        "platform": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "warnings": sorted(set(warnings)),
        "checkedAt": datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"),
    })
    return report


def get_runtime(*, refresh: bool = False) -> Dict[str, Any]:
    """The cached report (<= CACHE_TTL_S old), or a fresh one when `refresh` is true or the cache is stale."""
    global _cache
    with _lock:                                # concurrent callers wait for one probe instead of starting several
        now = _clock()
        if refresh or _cache is None or now - _cache[0] >= CACHE_TTL_S:
            _cache = (now, collect_runtime())
        return copy.deepcopy(_cache[1])


def clear_cache() -> None:
    global _cache
    with _lock:
        _cache = None
