"""Runtime environment and self-check diagnostics for Scientific Figure Studio.

Usage:
    python -m backend.figures.selfcheck [--json]

Probes the host machine for:
  - Python version & required packages (FastAPI, Uvicorn, python-pptx, Pydantic, Matplotlib, etc.)
  - TeX engines (pdflatex, xelatex, lualatex) and pgfplots.sty
  - LibreOffice / soffice for presentation PDF export
  - Figure canvas limits and available fonts
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import platform
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional, Tuple

from backend.figures.runtime import collect_runtime

REQUIRED_MODULES = [
    ("fastapi", "FastAPI web framework", "fastapi"),
    ("uvicorn", "ASGI server", "uvicorn"),
    ("pptx", "PowerPoint presentation exporter", "python-pptx"),
    ("pydantic", "Schema validation", "pydantic"),
    ("matplotlib", "Plot rendering & visualization", "matplotlib"),
    ("numpy", "Numerical computing", "numpy"),
    ("pandas", "Dataframe & CSV processing", "pandas"),
    ("scipy", "Statistical computations", "scipy"),
]

OPTIONAL_MODULES: list = []  # No optional Python packages in the current release


def check_libreoffice() -> Dict[str, Optional[str]]:
    """Check for LibreOffice / soffice binary and version."""
    from backend.soffice import find_soffice
    path = find_soffice()
    if not path:
        return {"path": None, "version": None}
    version: Optional[str] = None
    try:
        proc = subprocess.run([path, "--version"], capture_output=True, text=True, timeout=5.0)
        out = (proc.stdout or proc.stderr or "").strip()
        if out:
            version = out.splitlines()[0].strip()[:200]
    except Exception:
        pass
    return {"path": path, "version": version}


def check_dependencies() -> Dict[str, Any]:
    """Check required and optional Python module availability and versions."""
    deps: Dict[str, Any] = {}
    for mod_name, desc, pkg_name in REQUIRED_MODULES:
        try:
            mod = __import__(mod_name)
            ver = getattr(mod, "__version__", "installed")
            deps[mod_name] = {"found": True, "version": ver, "description": desc, "package": pkg_name, "required": True}
        except ImportError as exc:
            print(f"[SELF-CHECK DEBUG] {mod_name}: {exc!r}", file=sys.stderr)
            deps[mod_name] = {"found": False, "version": None, "description": desc, "package": pkg_name, "required": True}

    for mod_name, desc, pkg_name in OPTIONAL_MODULES:
        try:
            mod = __import__(mod_name)
            ver = getattr(mod, "__version__", "installed")
            deps[mod_name] = {"found": True, "version": ver, "description": desc, "package": pkg_name, "required": False}
        except ImportError:
            deps[mod_name] = {"found": False, "version": None, "description": desc, "package": pkg_name, "required": False}

    return deps


def run_selfcheck() -> Tuple[Dict[str, Any], List[str]]:
    """Run full system self-check and return (full_report, actionable_messages)."""
    rt = collect_runtime()
    lo = check_libreoffice()
    deps = check_dependencies()

    report: Dict[str, Any] = {
        "version": "1.0.0",
        "python": {
            "version": platform.python_version(),
            "executable": sys.executable,
            "version_info": list(sys.version_info[:3]),
        },
        "platform": rt.get("platform", {}),
        "dependencies": deps,
        "runtime": rt,
        "libreoffice": lo,
    }

    actionable: List[str] = []

    # Check python version
    if sys.version_info < (3, 10):
        actionable.append(
            f"Python {platform.python_version()} detected. Python 3.10 or newer is recommended for full feature support."
        )

    # Check missing required deps
    missing_req = [info["package"] for info in deps.values() if info["required"] and not info["found"]]
    if missing_req:
        actionable.append(
            f"Missing required Python package(s): {', '.join(missing_req)}. "
            "Install them via: pip install -r requirements.txt"
        )

    # Check TeX engines
    tex = rt.get("tex", {})
    engines = tex.get("engines", {})
    pgfplots = tex.get("pgfplots", False)
    if not engines or not pgfplots:
        msg = "LaTeX or PGFPlots not found on PATH. LaTeX / PGFPlots figure editing will be unavailable."
        if not engines:
            msg += " To enable, install TeX Live (e.g. 'sudo dnf install texlive-scheme-basic' or 'sudo apt install texlive-latex-base')."
        elif not pgfplots:
            msg += " 'pgfplots.sty' is missing; install it (e.g. 'sudo dnf install texlive-pgf' or 'sudo apt install texlive-pictures')."
        actionable.append(msg)

    # Check LibreOffice
    if not lo.get("path"):
        actionable.append(
            "LibreOffice ('soffice') not found on PATH. Direct presentation PDF export will be unavailable "
            "(PowerPoint .pptx export works normally). To enable PDF export, install LibreOffice "
            "(e.g. 'sudo dnf install libreoffice' or 'sudo apt install libreoffice')."
        )

    report["actionable"] = actionable
    return report, actionable


def format_report_text(report: Dict[str, Any]) -> str:
    lines: List[str] = [
        "=" * 64,
        " Laurevine Rose v1.0.0 — Runtime Self-Check",
        "=" * 64,
        f"Platform:      {report['platform'].get('system')} {report['platform'].get('release')} ({report['platform'].get('machine')})",
        f"Python:        {report['python']['version']} ({report['python']['executable']})",
        "",
        "--- Core Python Packages ---",
    ]

    deps = report.get("dependencies", {})
    for mod, info in sorted(deps.items()):
        status = f"✓ {info['version']}" if info["found"] else "✗ MISSING"
        req_tag = "(required)" if info["required"] else "(optional)"
        lines.append(f"  • {info['package']:<18} {status:<16} {req_tag}")

    lines.extend([
        "",
        "--- Presentation & PDF Export Engines ---",
    ])
    pptx_info = deps.get("pptx", {})
    p_status = f"✓ {pptx_info.get('version', 'installed')}" if pptx_info.get("found") else "✗ MISSING"
    lines.append(f"  • python-pptx:       {p_status} (Native PPTX generation)")

    lo = report.get("libreoffice", {})
    if lo.get("path"):
        lo_ver = lo.get("version") or "found"
        lines.append(f"  • LibreOffice:       ✓ {lo['path']} ({lo_ver})")
    else:
        lines.append("  • LibreOffice:       ✗ Not found (Presentation PDF export disabled)")

    lines.extend([
        "",
        "--- LaTeX / PGFPlots Environment ---",
    ])
    rt = report.get("runtime", {})
    tex = rt.get("tex", {})
    engines = tex.get("engines", {})
    for eng in ("pdflatex", "xelatex", "lualatex"):
        if eng in engines:
            ver = engines[eng].get("version") or "found"
            lines.append(f"  • {eng:<18} ✓ {engines[eng].get('path')} ({ver[:40]})")
        else:
            lines.append(f"  • {eng:<18} ✗ Not found")

    lines.append(f"  • kpsewhich:         {'✓ ' + tex.get('kpsewhich') if tex.get('kpsewhich') else '✗ Not found'}")
    lines.append(f"  • pgfplots.sty:      {'✓ Installed' if tex.get('pgfplots') else '✗ Not found'}")

    lines.extend([
        "",
        "--- System Resources & Limits ---",
        f"  • Available fonts:   {len(rt.get('fonts', []))} Matplotlib font families detected",
    ])
    lim = rt.get("limits", {})
    if lim:
        lines.append(f"  • Canvas side:       {lim.get('sideIn', [0.5, 30.0])[0]} to {lim.get('sideIn', [0.5, 30.0])[1]} in")
        lines.append(f"  • DPI range:         {lim.get('dpi', [72, 1200])[0]} to {lim.get('dpi', [72, 1200])[1]} DPI (max {lim.get('maxMegapixels', 120)} MP)")
        lines.append(f"  • Timeouts:          Python {lim.get('pythonTimeoutS', 30)}s (max {lim.get('maxPythonTimeoutS', 300)}s), LaTeX {lim.get('latexTimeoutS', 60)}s")
        lines.append(f"  • CSV upload limit:  {lim.get('maxCsvBytes', 5242880) // 1048576} MB ({lim.get('maxRows', 200000)} rows, {lim.get('maxColumns', 256)} cols)")

    actionable = report.get("actionable", [])
    lines.append("")
    if actionable:
        lines.append("--- Actionable Recommendations ---")
        for msg in actionable:
            lines.append(f"  ! {msg}")
    else:
        lines.append("--- Status ---")
        lines.append("  ✓ All required and optional features are fully ready.")

    lines.append("=" * 64)
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description="Laurevine Rose runtime self-check")
    parser.add_argument("--json", action="store_true", help="Print report as JSON")
    args = parser.parse_args()

    report, actionable = run_selfcheck()

    if args.json:
        print(json.dumps(report, indent=2))
    else:
        print(format_report_text(report))

    # Return 0 if all required modules are present, 1 otherwise
    deps = report.get("dependencies", {})
    has_missing_req = any(info["required"] and not info["found"] for info in deps.values())
    return 1 if has_missing_req else 0


if __name__ == "__main__":
    sys.exit(main())
