"""LibreOffice (soffice) discovery for presentation PDF export.

Resolution order (first existing executable wins; versions are NOT probed during export):
  1. env LAUREVINE_SOFFICE (path to the executable)
  2. managed copy under the user-data folder (<user data>/components/libreoffice/...)
  3. PATH (`soffice`, then `libreoffice`)
  4. platform defaults (Windows Program Files, macOS /Applications, Linux /usr/bin and /opt/libreoffice*)

Nothing here downloads or installs anything. `detect()` is what `run.py --detect-soffice-json` prints.
"""
from __future__ import annotations

import glob
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

ENV_VAR = "LAUREVINE_SOFFICE"
USER_DATA_ENV = "LAUREVINE_USER_DATA"
STATE_FILE_ENV = "LAUREVINE_STATE_FILE"
PROBE_TIMEOUT_S = 20

# Minimum LibreOffice version. exporter.export_presentation_to_pdf runs
#   soffice -env:UserInstallation=<uri> --headless --convert-to pdf <pptx> --outdir <dir>
# plus `--version` for probing. All of those flags are long-standing (to my knowledge LibreOffice 3.x era or older;
# not verified in this repo), so the arguments themselves impose no meaningful floor. 5.0 is a deliberately
# conservative choice: it keeps very old installs out, where PPTX import quality is the real risk. Raise it if
# verify_libreoffice_render.py shows a regression on an older build.
MIN_VERSION: Tuple[int, int] = (5, 0)

PDF_CONVERTER_MISSING = "PDF_CONVERTER_MISSING"


class PdfConverterMissing(RuntimeError):
    """Raised when no LibreOffice executable can be found. Carries `.code == 'PDF_CONVERTER_MISSING'`."""

    code = PDF_CONVERTER_MISSING

    def __init__(self, message: str = "LibreOffice is required on the server for PDF conversion but was not found."):
        super().__init__(message)


def _is_executable(path: Optional[str]) -> bool:
    return bool(path) and os.path.isfile(path) and os.access(path, os.X_OK)


def user_data_dir() -> str:
    """Electron's userData folder (passed in by main.js as LAUREVINE_USER_DATA), else a best guess for the same folder."""
    env = os.environ.get(USER_DATA_ENV, "").strip()
    if env:
        return env
    name = "laurevine-rose"  # package.json "name"; Electron uses it for userData when there is no productName
    if sys.platform == "win32":
        return os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~\\AppData\\Roaming"), name)
    if sys.platform == "darwin":
        return os.path.join(os.path.expanduser("~/Library/Application Support"), name)
    return os.path.join(os.environ.get("XDG_CONFIG_HOME") or os.path.expanduser("~/.config"), name)


def _managed_candidates() -> List[str]:
    base = os.path.join(user_data_dir(), "components", "libreoffice")
    if sys.platform == "win32":
        return [os.path.join(base, "program", "soffice.exe")]
    if sys.platform == "darwin":
        return [os.path.join(base, "LibreOffice.app", "Contents", "MacOS", "soffice")]
    return [os.path.join(base, "program", "soffice")]


def _platform_defaults() -> List[str]:
    if sys.platform == "win32":
        roots = [os.environ.get("ProgramFiles"), os.environ.get("ProgramFiles(x86)"), r"C:\Program Files"]
        out = [os.path.join(r, "LibreOffice", "program", "soffice.exe") for r in roots if r]
        return list(dict.fromkeys(out))
    if sys.platform == "darwin":
        return ["/Applications/LibreOffice.app/Contents/MacOS/soffice"]
    out = ["/usr/bin/soffice", "/usr/bin/libreoffice"]
    out += sorted(glob.glob("/opt/libreoffice*/program/soffice"), reverse=True)
    return out


def state_file_path() -> Optional[str]:
    """Path to setup-state.json from env LAUREVINE_STATE_FILE or userData folder."""
    env = os.environ.get(STATE_FILE_ENV, "").strip()
    if env:
        return env
    default_path = os.path.join(user_data_dir(), "setup-state.json")
    if os.path.isfile(default_path):
        return default_path
    return None


def read_setup_state() -> Optional[Dict[str, Any]]:
    """Re-reads setup-state.json from disk on demand."""
    path = state_file_path()
    if not path or not os.path.isfile(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _candidates() -> List[Tuple[str, str]]:
    cands: List[Tuple[str, str]] = []
    env = os.environ.get(ENV_VAR, "").strip().strip('"')
    if env:
        cands.append(("env", env))

    # Re-read setup-state.json on each export to reflect installed/removed/re-detected converters without backend restart
    st = read_setup_state()
    if st:
        lo = (st.get("components") or {}).get("libreoffice")
        if isinstance(lo, dict):
            status = lo.get("status")
            p = lo.get("path")
            src = lo.get("source") or "managed"
            if p and status in ("installed", "found"):
                cands.append((src, p))

    cands += [("managed", p) for p in _managed_candidates()]
    for exe in ("soffice", "libreoffice"):
        found = shutil.which(exe)
        if found:
            cands.append(("path", found))
    cands += [("platform", p) for p in _platform_defaults()]
    return cands


def locate() -> Optional[Tuple[str, str]]:
    """-> (source, path) of the first existing executable in resolution order, else None. source: env|managed|path|platform."""
    seen = set()
    for source, path in _candidates():
        key = os.path.normcase(os.path.abspath(path))
        if key in seen:
            continue
        seen.add(key)
        if _is_executable(path):
            return source, path
    return None


def find_soffice() -> Optional[str]:
    """Path of the soffice executable to use, or None."""
    hit = locate()
    return hit[1] if hit else None


def parse_version(text: str) -> Optional[Tuple[int, ...]]:
    """'LibreOffice 7.6.4.1 60(Build:1)' -> (7, 6, 4, 1). None when no version number is present."""
    m = re.search(r"(\d+)\.(\d+)(?:\.(\d+))?(?:\.(\d+))?", text or "")
    return tuple(int(g) for g in m.groups() if g is not None) if m else None


def probe(path: str) -> Dict[str, Any]:
    """Run `<path> --version` (20 s timeout). -> {path, compatible, version, reason}.
    `compatible` is True when a parsed version meets MIN_VERSION, False when a parsed version
    is genuinely below it, and None when compatibility could not be established at all (e.g.
    the command errored, timed out, or produced no readable version text) -- a failed command
    is not by itself evidence of incompatibility, especially if it still printed a version."""
    res: Dict[str, Any] = {"path": path, "compatible": None, "version": None, "reason": None}
    if not _is_executable(path):
        res["reason"] = "The file does not exist or is not executable."
        return res
    try:
        proc = subprocess.run([path, "--version"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=PROBE_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        res["reason"] = f"It did not answer `--version` within {PROBE_TIMEOUT_S} seconds."
        return res
    except OSError as exc:
        res["reason"] = f"It could not be started ({exc.__class__.__name__})."
        return res
    out = (proc.stdout or b"").decode(errors="replace").strip() or (proc.stderr or b"").decode(errors="replace").strip()
    ver = parse_version(out)
    if not ver:
        # Parse first: a nonzero exit code alone doesn't mean incompatible, only that we
        # couldn't confirm either way -- so it's reported as unknown, not incompatible.
        if proc.returncode != 0:
            res["reason"] = f"`--version` failed (exit code {proc.returncode}) and no version number could be read from its output."
        else:
            res["reason"] = "Its version could not be read, so it cannot be confirmed as LibreOffice."
        return res
    res["version"] = ".".join(str(n) for n in ver)
    if ver[:2] < MIN_VERSION:
        res["compatible"] = False
        res["reason"] = f"Version {res['version']} is older than the minimum supported version {MIN_VERSION[0]}.{MIN_VERSION[1]}."
        return res
    res["compatible"] = True
    return res


def detect() -> Dict[str, Any]:
    """Locate and probe. -> {status: found|incompatible|unknown|missing, source, path, version, reason, minVersion, checkedAt}.
    status is 'unknown' when an executable was located but its compatibility could not be
    established (distinct from 'incompatible', which means a version was read and it is too old)."""
    out: Dict[str, Any] = {
        "status": "missing", "source": None, "path": None, "version": None, "reason": None,
        "minVersion": f"{MIN_VERSION[0]}.{MIN_VERSION[1]}",
        "checkedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    hit = locate()
    if not hit:
        return out
    source, path = hit
    p = probe(path)
    status = "found" if p["compatible"] is True else "incompatible" if p["compatible"] is False else "unknown"
    out.update(source=source, path=path, version=p["version"], reason=p["reason"], status=status)
    return out


def path_to_uri(path: str) -> str:
    """file:// URI for -env:UserInstallation (correct on Windows: file:///C:/...)."""
    return Path(os.path.abspath(path)).as_uri()