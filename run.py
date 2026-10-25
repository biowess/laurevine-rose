#!/usr/bin/env python3
"""Startup script for Laurevine Rose (v1.0.0).

Launches the local FastAPI server on 127.0.0.1:8000 (or next free port) serving both the frontend
and the PPTX export / project backend.
HOST must be a loopback address; any other value is refused unless ALLOW_REMOTE=1 (read docs/SECURITY.md first).
"""

import argparse
import ipaddress
import json
import os
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

import uvicorn

VERSION = "1.0.0"


def is_loopback(host: str) -> bool:
    if host.strip().lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def is_port_in_use(host: str, port: int) -> bool:
    clean = host.strip("[]")
    family = socket.AF_INET6 if ":" in clean else socket.AF_INET
    bind_host = "127.0.0.1" if host.strip().lower() == "localhost" else clean
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.bind((bind_host, port))
            return False
    except OSError:
        return True


def find_free_port(host: str, starting_port: int = 8000, max_attempts: int = 100) -> int:
    """Return starting_port if free, or the next available port."""
    clean = host.strip("[]")
    family = socket.AF_INET6 if ":" in clean else socket.AF_INET
    bind_host = "127.0.0.1" if host.strip().lower() == "localhost" else clean
    for p in range(starting_port, starting_port + max_attempts):
        try:
            with socket.socket(family, socket.SOCK_STREAM) as s:
                s.bind((bind_host, p))
                return p
        except OSError:
            continue
    try:
        with socket.socket(family, socket.SOCK_STREAM) as s:
            s.bind((bind_host, 0))
            return s.getsockname()[1]
    except OSError:
        return starting_port


def startup_self_check() -> None:
    """Check Python version, required dependencies, and optional TeX / LibreOffice tools."""
    # 1. Python version check
    if sys.version_info < (3, 10):
        print(f"[Notice] Python {sys.version.split()[0]} detected. Python 3.10+ is recommended.", file=sys.stderr)

    # 2. Dependency and runtime check
    try:
        from backend.figures.selfcheck import run_selfcheck
        report, actionable = run_selfcheck()
        deps = report.get("dependencies", {})
        missing_req = [info["package"] for info in deps.values() if info.get("required") and not info.get("found")]
        if missing_req:
            sys.exit(
                f"ERROR: Missing required Python dependencies: {', '.join(missing_req)}.\n"
                "Please install them with: pip install -r requirements.txt"
            )

        # Print actionable warnings for optional tools
        tex = report.get("runtime", {}).get("tex", {})
        engines = tex.get("engines", {})
        pgfplots = tex.get("pgfplots", False)
        if not engines or not pgfplots:
            print("[Notice] LaTeX or PGFPlots not found on PATH; TeX figure editing will be disabled.\n"
                  "         To enable, install TeX Live (e.g. 'sudo dnf install texlive-scheme-basic texlive-pgf' or 'sudo apt install texlive-latex-extra').", file=sys.stderr)

        lo = report.get("libreoffice", {})
        if not lo.get("path"):
            print("[Notice] LibreOffice ('soffice') not found on PATH; presentation PDF export will be disabled.\n"
                  "         (PowerPoint .pptx export works normally). To enable PDF export, install LibreOffice.", file=sys.stderr)
    except Exception as exc:
        print(f"[Warning] Startup self-check encountered an error ({exc}); continuing...", file=sys.stderr)


def selfcheck_json() -> int:
    """`--selfcheck-json`: print run_selfcheck()'s report as one JSON line, no server. Exit 0 = required packages present, 1 = not."""
    try:
        from backend.figures.selfcheck import run_selfcheck
        report, _actionable = run_selfcheck()
    except Exception as exc:
        print(json.dumps({"error": f"Self-check failed: {type(exc).__name__}: {exc}"}))
        return 1
    print(json.dumps(report, default=str))
    deps = report.get("dependencies", {})
    return 1 if any(i.get("required") and not i.get("found") for i in deps.values()) else 0


def detect_soffice_json() -> int:
    """`--detect-soffice-json`: print the LibreOffice detection result (backend.soffice.detect) as one JSON line, no server. Exit 0 = detection ran."""
    try:
        from backend.soffice import detect
        print(json.dumps(detect()))
        return 0
    except Exception as exc:
        print(json.dumps({"error": f"Detection failed: {type(exc).__name__}: {exc}"}))
        return 1


def run_as_interpreter() -> bool:
    """Frozen (PyInstaller) build only. The figure runner and runtime probe start `sys.executable -I [-u] harness.py ...` / `-c code`;
    in a frozen app sys.executable is this program, so emulate that call here instead of starting a second server."""
    if not getattr(sys, "frozen", False):
        return False
    args = sys.argv[1:]
    i = 0
    while i < len(args) and args[i] in ("-I", "-u", "-E", "-s", "-S", "-B"):
        i += 1
    if i >= len(args):
        return False
    if args[i] == "-c" and i + 1 < len(args):
        sys.argv = ["-c"] + args[i + 2:]
        exec(compile(args[i + 1], "<string>", "exec"), {"__name__": "__main__"})
        return True
    if args[i].replace("\\", "/").endswith("/harness.py"):
        import runpy
        sys.argv = args[i:]
        runpy.run_path(args[i], run_name="__main__")
        return True
    return False


def _open_browser_thread(url: str, check_url: str):
    for _ in range(60):
        try:
            req = urllib.request.Request(check_url, headers={"User-Agent": "RPE-Startup"})
            with urllib.request.urlopen(req, timeout=1.0) as resp:
                if resp.status == 200:
                    webbrowser.open(url)
                    return
        except Exception:
            pass
        time.sleep(0.1)


def main():
    parser = argparse.ArgumentParser(description=f"Laurevine Rose v{VERSION}")
    parser.add_argument("--open", "-o", action="store_true", help="Automatically open editor in default web browser")
    parser.add_argument("--port", "-p", type=int, default=None, help="Port to bind to (default: 8000 or next free port)")
    parser.add_argument("--host", type=str, default=None, help="Host to bind to (default: 127.0.0.1)")
    parser.add_argument("--selfcheck-json", action="store_true", help="Print the runtime self-check as JSON and exit (0 = ready, 1 = required package missing); no server")
    parser.add_argument("--detect-soffice-json", action="store_true", help="Print LibreOffice detection as JSON and exit; no server")
    args, unknown = parser.parse_known_args()

    if args.selfcheck_json:
        sys.exit(selfcheck_json())
    if args.detect_soffice_json:
        sys.exit(detect_soffice_json())

    host = args.host or os.environ.get("HOST", "127.0.0.1").strip() or "127.0.0.1"
    requested_port = args.port or int(os.environ.get("PORT", "8000"))

    if not is_loopback(host):
        if os.environ.get("ALLOW_REMOTE") != "1":
            sys.exit(f"Refusing to bind to {host!r}: this server runs user scripts and must stay on loopback.\n"
                     "Set ALLOW_REMOTE=1 only if you understand the risk (see docs/SECURITY.md).")
        print(f"WARNING: listening on {host}:{requested_port}. Anyone who can reach this port can run Python and TeX as you on this machine.\n"
              "         Only do this inside a container or VM on a network you trust (see docs/SECURITY.md).", file=sys.stderr)
        os.environ["RPE_ALLOWED_HOSTS"] = ",".join(filter(None, [os.environ.get("RPE_ALLOWED_HOSTS", ""), host]))

    # Startup self-check
    startup_self_check()

    # Free port selection
    if is_port_in_use(host, requested_port):
        port = find_free_port(host, requested_port)
        print(f"Port {requested_port} is busy. Selected next available port {port}.")
    else:
        port = requested_port

    url = f"http://{host}:{port}"
    print(f"Starting Laurevine Rose v{VERSION} on {url} ...")

    if args.open:
        check_url = f"http://127.0.0.1:{port}/api/health" if host in ("0.0.0.0", "::") else f"{url}/api/health"
        th = threading.Thread(target=_open_browser_thread, args=(url, check_url), daemon=True)
        th.start()

    try:
        uvicorn.run("backend.server:app", host=host, port=port, reload=False, log_level="info")
    finally:
        try:
            from backend.figures import jobs as figure_jobs
            figure_jobs.shutdown()
        except Exception:
            pass


if __name__ == "__main__":
    if not run_as_interpreter():
        main()
