"""Run a user's Matplotlib script in a child process (docs/FIGURES_CONTRACT.md s4a, s7).

A subprocess is NOT a sandbox: the script still has the server user's file and network access. What this module
contains is accidents and runaway code: fresh temp cwd, scrubbed environment, wall-clock timeout that kills the whole
process group, rlimits (POSIX; applied by the harness), capped stdout/stderr and capped image size. Packages are
never installed. The child runs ``python -I``, so it sees the interpreter's own and the venv's site-packages but not
per-user (``pip install --user``) packages.
"""
from __future__ import annotations

import ast
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
import queue
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple, Union

from backend.figures import jobs
from backend.figures.models import (
    MAX_DPI, MAX_MEGAPIXELS, MAX_PX_SIDE, MAX_SIDE_IN, MAX_SOURCE_CHARS, MIN_DPI, MIN_SIDE_IN,
)

DEFAULT_TIMEOUT = 30                  # seconds (contract s7)
MAX_TIMEOUT = 300
MAX_STREAM_BYTES = 200 * 1024         # stdout / stderr kept per run (marker included)
MEMORY_LIMIT_BYTES = 4 << 30          # RLIMIT_AS
MAX_FILE_BYTES = 256 << 20            # RLIMIT_FSIZE: largest single file the script (or our image) may write
MAX_INPUT_FILES = 100
MAX_INPUT_BYTES = 64 << 20            # all `files` together
SCRIPT_NAME = "script.py"
STATUSES = ("ok", "error", "timeout", "no_figure", "missing_dependency")

HARNESS = Path(__file__).with_name("harness.py")
_COLOR_RE = re.compile(r"^(#[0-9A-Fa-f]{3,8}|[A-Za-z][A-Za-z0-9:_ -]{0,40})$")
# Allowlist, not denylist: tokens, credentials and proxy settings never reach the script whatever they are called.
_ENV_KEEP = {
    "PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "COMSPEC",
    "PATHEXT", "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH", "MPLCONFIGDIR",
    "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "FONTCONFIG_PATH", "FONTCONFIG_FILE",
}


@dataclass
class RunResult:
    ok: bool
    status: str                                   # one of STATUSES
    message: str = ""                             # one readable sentence for the UI when not ok
    png_bytes: Optional[bytes] = None             # always set when ok
    pdf_bytes: Optional[bytes] = None             # only when out_format == 'pdf'
    stdout: str = ""
    stderr: str = ""
    traceback: Optional[Dict[str, Any]] = None    # {line: int|None (line in the user's script), message, text}
    missing_module: Optional[str] = None          # status == 'missing_dependency'
    figures_found: int = 0
    warnings: List[str] = field(default_factory=list)
    duration_ms: int = 0
    width_px: Optional[int] = None
    height_px: Optional[int] = None
    data: Optional[Dict[str, Any]] = None         # run_python_data only: {columns:[{name,type}], rows}


class _Capture(threading.Thread):
    """Drain a pipe to its end, keeping only the first `limit` bytes (the child must never block on a full pipe)."""

    def __init__(self, pipe, limit: int):
        super().__init__(daemon=True)
        self.pipe, self.limit, self.buf, self.total = pipe, limit, bytearray(), 0

    def run(self):
        try:
            while True:
                chunk = self.pipe.read(65536)
                if not chunk:
                    return
                self.total += len(chunk)
                room = self.limit - len(self.buf)
                if room > 0:
                    self.buf += chunk[:room]
        except (OSError, ValueError):
            return

    def text(self) -> Tuple[str, bool]:
        data, total = bytes(self.buf), self.total
        if total <= self.limit:
            return data.decode("utf-8", "replace"), False
        marker = f"\n[... output truncated at {self.limit // 1024} KB; {total} bytes were written ...]\n"
        return data[: self.limit - len(marker.encode())].decode("utf-8", "ignore") + marker, True


def _validate(source, dpi, out_format, facecolor, transparent, timeout, files) -> Dict[str, bytes]:
    """Malformed arguments raise ValueError (the API maps that to HTTP 400); script problems never do."""
    if not isinstance(source, str):
        raise ValueError("source must be a string")
    if len(source) > MAX_SOURCE_CHARS:
        raise ValueError(f"source is {len(source)} characters; the limit is {MAX_SOURCE_CHARS}")
    if isinstance(dpi, bool) or not isinstance(dpi, int) or not MIN_DPI <= dpi <= MAX_DPI:
        raise ValueError(f"dpi must be an integer from {MIN_DPI} to {MAX_DPI}")
    if out_format not in ("png", "pdf"):
        raise ValueError("out_format must be 'png' or 'pdf'")
    if not isinstance(facecolor, str) or not _COLOR_RE.match(facecolor):
        raise ValueError("facecolor must be a colour name or a #hex value")
    if not isinstance(transparent, bool):
        raise ValueError("transparent must be a boolean")
    if isinstance(timeout, bool) or not isinstance(timeout, (int, float)) or not 0 < timeout <= MAX_TIMEOUT:
        raise ValueError(f"timeout must be greater than 0 and at most {MAX_TIMEOUT} seconds")
    clean: Dict[str, bytes] = {}
    for name, data in (files or {}).items():
        parts = PurePosixPath(name).parts if isinstance(name, str) else ()
        if (not parts or len(name) > 255 or PurePosixPath(name).is_absolute() or ".." in parts or "." in parts
                or any(c in name for c in "\\:\x00") or name == SCRIPT_NAME):
            raise ValueError(f"invalid file name {name!r}")
        if isinstance(data, str):
            data = data.encode("utf-8")
        elif not isinstance(data, (bytes, bytearray)):
            raise ValueError(f"file {name!r} must be str or bytes")
        clean[name] = bytes(data)
    if len(clean) > MAX_INPUT_FILES or sum(map(len, clean.values())) > MAX_INPUT_BYTES:
        raise ValueError(f"too many input files (max {MAX_INPUT_FILES} files, {MAX_INPUT_BYTES >> 20} MB total)")
    return clean


def _child_env(root: Path) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_KEEP}
    tmp = str(root / "tmp")
    env.update(MPLBACKEND="Agg", TMPDIR=tmp, TEMP=tmp, TMP=tmp,
               OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")   # keeps RLIMIT_AS predictable
    return env


def _kill_tree(proc: Any) -> None:
    """Kill the child and everything it started (POSIX: its process group; Windows: taskkill /T)."""
    pid = getattr(proc, "pid", None)
    if pid is None:
        return
    if os.name == "posix":
        try:
            os.killpg(pid, signal.SIGKILL)
        except (ProcessLookupError, PermissionError):
            pass
    elif getattr(proc, "poll", None) is not None and proc.poll() is None:
        subprocess.run(["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True)
    try:
        if hasattr(proc, "kill"):
            proc.kill()
    except OSError:
        pass


def _remove_tree(root: str) -> None:
    jobs.untrack_dir(str(root))
    for attempt in range(5):                       # Windows may still hold a handle for a moment after a kill
        shutil.rmtree(root, ignore_errors=True)
        if not os.path.exists(root):
            return
        time.sleep(0.1 * (attempt + 1))


def _png_size(data: bytes) -> Optional[Tuple[int, int]]:
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


def _crash_message(returncode: Optional[int]) -> Tuple[str, str]:
    """(status, message) for a child that died without writing a result."""
    if returncode is not None and returncode < 0:
        sig = -returncode
        try:
            name = signal.Signals(sig).name
        except ValueError:
            name = f"signal {sig}"
        if sig == getattr(signal, "SIGXCPU", None):
            return "timeout", "The script used up its CPU time limit and was stopped."
        if sig == signal.SIGKILL:
            return "error", "The script process was killed (most likely it ran out of memory)."
        return "error", f"The script process crashed ({name})."
    return "error", f"The script process exited with status {returncode} without producing a result."


def _execute(root: Path, source: str, files: Dict[str, bytes], dpi: int, out_format: str, facecolor: str,
             transparent: bool, timeout: float, started: float,
             cancel: Optional[threading.Event] = None, data_mode: bool = False,
             size_in: Optional[Tuple[float, float]] = None) -> RunResult:
    work, ctl = root / "work", root / "ctl"
    for d in (work, ctl, root / "tmp"):
        d.mkdir()
    (work / SCRIPT_NAME).write_bytes(source.encode("utf-8"))
    for name, data in files.items():
        target = work / PurePosixPath(name)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
    spec = {
        "dpi": dpi, "format": out_format, "facecolor": facecolor, "transparent": transparent,
        "mode": "data" if data_mode else "figure", "size_in": list(size_in) if size_in else None,
        "png": str(ctl / "out.png"), "pdf": str(ctl / "out.pdf"), "result": str(ctl / "result.json"),
        "limits": {
            "cpu_seconds": math.ceil(timeout) + 2, "address_space": MEMORY_LIMIT_BYTES, "file_size": MAX_FILE_BYTES,
            "min_side_in": MIN_SIDE_IN, "max_side_in": MAX_SIDE_IN, "max_px_side": MAX_PX_SIDE,
            "max_megapixels": MAX_MEGAPIXELS,
        },
    }
    (ctl / "spec.json").write_text(json.dumps(spec), encoding="utf-8")

    group = ({"start_new_session": True} if os.name == "posix"
             else {"creationflags": getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)})
    proc = subprocess.Popen(
        [sys.executable, "-I", "-u", str(HARNESS), str(ctl / "spec.json")], cwd=work, env=_child_env(root),
        stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, bufsize=0, close_fds=True, **group)
    jobs.attach_current(proc)                      # a job cancel / timeout / shutdown kills the process group at once
    caps = (_Capture(proc.stdout, MAX_STREAM_BYTES), _Capture(proc.stderr, MAX_STREAM_BYTES))
    for cap in caps:
        cap.start()
    timed_out = cancelled = False
    try:
        if cancel is None:
            proc.wait(timeout=timeout)
        else:                                      # poll so that `cancel.set()` kills the process tree within ~50 ms
            deadline = time.monotonic() + timeout
            while True:
                try:
                    proc.wait(timeout=max(0.0, min(0.05, deadline - time.monotonic())))
                    break
                except subprocess.TimeoutExpired:
                    if cancel.is_set():
                        cancelled = True
                        break
                    if time.monotonic() >= deadline:
                        raise
    except subprocess.TimeoutExpired:
        timed_out = True
    finally:
        _kill_tree(proc)                           # also stops stragglers a finished script left behind
        proc.wait()
        jobs.detach_current(proc)
        for cap in caps:
            cap.join(2.0)
        for pipe in (proc.stdout, proc.stderr):
            try:
                pipe.close()
            except OSError:
                pass

    if cancel is not None and cancel.is_set() and not timed_out:
        cancelled = True                           # job.cancel() may have killed the process before the poll saw the event
    (out, out_cut), (err, err_cut) = caps[0].text(), caps[1].text()
    res = RunResult(ok=False, status="error", stdout=out, stderr=err)
    notes = [f"{n} truncated to {MAX_STREAM_BYTES // 1024} KB" for n, cut in (("stdout", out_cut), ("stderr", err_cut))
             if cut]
    res.duration_ms = round((time.monotonic() - started) * 1000)
    if cancelled:
        res.status, res.message = "cancelled", "The run was cancelled."
        res.warnings = notes
        return res
    if timed_out:
        res.status, res.message = "timeout", f"The script did not finish within {timeout:g} s and was stopped."
        res.warnings = notes
        return res

    try:
        data = json.loads((ctl / "result.json").read_text(encoding="utf-8"))
        if data.get("status") not in STATUSES:
            raise ValueError("bad status")
    except (OSError, ValueError):
        res.status, res.message = _crash_message(proc.returncode)
        res.warnings = notes
        return res

    res.status, res.message = data["status"], data.get("message") or ""
    res.traceback, res.missing_module = data.get("traceback"), data.get("missing_module")
    res.figures_found, res.warnings = int(data.get("figures_found") or 0), list(data.get("warnings") or []) + notes
    if res.status != "ok":
        return res
    if data_mode:
        res.ok, res.data = True, data.get("data")
        return res
    try:
        png = (ctl / "out.png").read_bytes()
        size = _png_size(png)
        pdf = (ctl / "out.pdf").read_bytes() if out_format == "pdf" else None
    except OSError:
        size = None
    if size is None:
        res.status, res.message = "error", "The script finished but no image could be produced from its figure."
        return res
    res.ok, res.png_bytes, res.pdf_bytes = True, png, pdf
    res.width_px, res.height_px = size
    return res


class _ForkedProc:
    def __init__(self, pid: int):
        self.pid = pid
        self.returncode: Optional[int] = None

    def poll(self) -> Optional[int]:
        return self.returncode


class ForkServerWorker:
    def __init__(self):
        self.proc: Optional[subprocess.Popen] = None
        self.lock = threading.Lock()

    def is_alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def start(self) -> bool:
        if self.is_alive():
            return True
        self.close()
        try:
            root_env = {k: v for k, v in os.environ.items() if k.upper() in _ENV_KEEP}
            root_env.update(MPLBACKEND="Agg", OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1")
            self.proc = subprocess.Popen(
                [sys.executable, "-I", "-u", str(HARNESS), "--fork-server"],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                close_fds=True,
                start_new_session=True,
                env=root_env,
            )
            ready_line = self.proc.stdout.readline()
            if "READY" not in ready_line:
                self.close()
                return False
            return True
        except Exception:
            self.close()
            return False

    def close(self):
        if self.proc is not None:
            try:
                self.proc.stdin.close()
            except Exception:
                pass
            _kill_tree(self.proc)
            try:
                self.proc.wait(timeout=1.0)
            except Exception:
                pass
            self.proc = None

    def run(self, root: Path, source: str, files: Dict[str, bytes], dpi: int, out_format: str, facecolor: str,
            transparent: bool, timeout: float, started: float,
            cancel: Optional[threading.Event] = None,
            size_in: Optional[Tuple[float, float]] = None) -> RunResult:
        with self.lock:
            if not self.start():
                raise RuntimeError("Failed to start fork-server worker")
            work, ctl = root / "work", root / "ctl"
            for d in (work, ctl, root / "tmp"):
                d.mkdir(parents=True, exist_ok=True)
            (work / SCRIPT_NAME).write_bytes(source.encode("utf-8"))
            for name, data in files.items():
                target = work / PurePosixPath(name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)
            spec = {
                "dpi": dpi, "format": out_format, "facecolor": facecolor, "transparent": transparent,
                "mode": "figure", "size_in": list(size_in) if size_in else None,
                "png": str(ctl / "out.png"), "pdf": str(ctl / "out.pdf"), "result": str(ctl / "result.json"),
                "limits": {
                    "cpu_seconds": math.ceil(timeout) + 2, "address_space": MEMORY_LIMIT_BYTES, "file_size": MAX_FILE_BYTES,
                    "min_side_in": MIN_SIDE_IN, "max_side_in": MAX_SIDE_IN, "max_px_side": MAX_PX_SIDE,
                    "max_megapixels": MAX_MEGAPIXELS,
                },
            }
            (ctl / "spec.json").write_text(json.dumps(spec), encoding="utf-8")
            stdout_path = str(ctl / "stdout.log")
            stderr_path = str(ctl / "stderr.log")

            req = {
                "spec": str(ctl / "spec.json"),
                "work": str(work),
                "stdout": stdout_path,
                "stderr": stderr_path,
            }
            try:
                self.proc.stdin.write(json.dumps(req) + "\n")
                self.proc.stdin.flush()
                pid_line = self.proc.stdout.readline()
                pid_info = json.loads(pid_line)
                child_pid = pid_info.get("pid")
                if not child_pid:
                    raise RuntimeError(f"Fork server did not return child pid: {pid_line}")
            except Exception as exc:
                self.close()
                raise RuntimeError(f"Fork server communication failure: {exc}") from exc

            forked_proc = _ForkedProc(child_pid)
            jobs.attach_current(forked_proc)

            status_holder: Dict[str, Any] = {}
            def _reader():
                try:
                    s_line = self.proc.stdout.readline()
                    status_holder["line"] = s_line
                except Exception as e:
                    status_holder["error"] = e

            reader_th = threading.Thread(target=_reader, daemon=True)
            reader_th.start()

            timed_out = cancelled = False
            deadline = time.monotonic() + timeout
            while reader_th.is_alive():
                reader_th.join(timeout=0.05)
                if cancel is not None and cancel.is_set():
                    cancelled = True
                    break
                if time.monotonic() >= deadline:
                    timed_out = True
                    break

            if cancelled or timed_out:
                _kill_tree(forked_proc)
                reader_th.join(timeout=1.0)
                if reader_th.is_alive():
                    self.close()

            jobs.detach_current(forked_proc)

            out = err = ""
            out_cut = err_cut = False
            if os.path.exists(stdout_path):
                out_b = Path(stdout_path).read_bytes()
                if len(out_b) > MAX_STREAM_BYTES:
                    out = out_b[:MAX_STREAM_BYTES].decode("utf-8", "ignore")
                    out_cut = True
                else:
                    out = out_b.decode("utf-8", "replace")
            if os.path.exists(stderr_path):
                err_b = Path(stderr_path).read_bytes()
                if len(err_b) > MAX_STREAM_BYTES:
                    err = err_b[:MAX_STREAM_BYTES].decode("utf-8", "ignore")
                    err_cut = True
                else:
                    err = err_b.decode("utf-8", "replace")

            res = RunResult(ok=False, status="error", stdout=out, stderr=err)
            notes = [f"{n} truncated to {MAX_STREAM_BYTES // 1024} KB" for n, cut in (("stdout", out_cut), ("stderr", err_cut)) if cut]
            res.duration_ms = round((time.monotonic() - started) * 1000)

            if cancelled:
                res.status, res.message = "cancelled", "The run was cancelled."
                res.warnings = notes
                return res
            if timed_out:
                res.status, res.message = "timeout", f"The script did not finish within {timeout:g} s and was stopped."
                res.warnings = notes
                return res

            try:
                data = json.loads((ctl / "result.json").read_text(encoding="utf-8"))
                if data.get("status") not in STATUSES:
                    raise ValueError("bad status")
            except (OSError, ValueError):
                res.status, res.message = _crash_message(forked_proc.returncode)
                res.warnings = notes
                return res

            res.status, res.message = data["status"], data.get("message") or ""
            res.traceback, res.missing_module = data.get("traceback"), data.get("missing_module")
            res.figures_found, res.warnings = int(data.get("figures_found") or 0), list(data.get("warnings") or []) + notes
            if res.status != "ok":
                return res

            try:
                png = (ctl / "out.png").read_bytes()
                size = _png_size(png)
                pdf = (ctl / "out.pdf").read_bytes() if out_format == "pdf" else None
            except OSError:
                size = None
            if size is None:
                res.status, res.message = "error", "The script finished but no image could be produced from its figure."
                return res
            res.ok, res.png_bytes, res.pdf_bytes = True, png, pdf
            res.width_px, res.height_px = size
            return res


class ForkServerPool:
    def __init__(self, size: int = 2):
        self.size = size
        self.pool: queue.Queue[ForkServerWorker] = queue.Queue()
        self._all_workers: List[ForkServerWorker] = []
        self._lock = threading.Lock()
        self._started = False

    def is_supported(self) -> bool:
        return os.name == "posix" and hasattr(os, "fork")

    def _ensure_started(self):
        if not self.is_supported():
            return
        with self._lock:
            if self._started:
                return
            for _ in range(self.size):
                w = ForkServerWorker()
                self._all_workers.append(w)
                self.pool.put(w)
            self._started = True

    def shutdown(self):
        with self._lock:
            self._started = False
            for w in self._all_workers:
                w.close()
            self._all_workers.clear()
            while not self.pool.empty():
                try:
                    self.pool.get_nowait()
                except queue.Empty:
                    break

    @contextmanager
    def acquire(self, timeout: float = 2.0) -> Iterator[Optional[ForkServerWorker]]:
        if not self.is_supported():
            yield None
            return
        self._ensure_started()
        worker = None
        try:
            worker = self.pool.get(timeout=timeout)
        except queue.Empty:
            yield None
            return
        try:
            yield worker
        finally:
            if worker is not None:
                if worker.is_alive():
                    self.pool.put(worker)
                else:
                    with self._lock:
                        if worker in self._all_workers:
                            self._all_workers.remove(worker)
                        new_w = ForkServerWorker()
                        self._all_workers.append(new_w)
                        self.pool.put(new_w)


_warm_pool = ForkServerPool(size=2)


def shutdown_warm_pool() -> None:
    _warm_pool.shutdown()


def run_python(source: str, *, dpi: int = 450, out_format: str = "png", facecolor: str = "white",
               transparent: bool = False, timeout: float = DEFAULT_TIMEOUT,
               files: Optional[Mapping[str, Union[str, bytes]]] = None,
               cancel: Optional[threading.Event] = None,
               size_in: Optional[Tuple[float, float]] = None,
               warm: bool = False) -> RunResult:
    """Run `source` as ``__main__`` and return the lowest-numbered pyplot figure (an extra figure adds a warning).

    ``files`` ({relative name: str|bytes}) are written next to the script (cwd, and importable). ``png_bytes`` is set
    on success; ``pdf_bytes`` too when ``out_format == 'pdf'``. ``transparent`` overrides ``facecolor``.
    ``cancel`` (a threading.Event): once set, the process tree is killed and the result has ``status='cancelled'``.
    ``size_in`` (w, h) inches: the harness calls ``fig.set_size_inches`` on the captured figure before the size checks.
    ``warm``: if True and on a supported platform, uses the fork-server pool for pre-imported matplotlib/numpy.
    Raises ValueError for malformed arguments; every problem with the script itself comes back as a RunResult.
    """
    clean = _validate(source, dpi, out_format, facecolor, transparent, timeout, files)
    if size_in is not None:
        ok = (isinstance(size_in, (tuple, list)) and len(size_in) == 2 and all(
            isinstance(v, (int, float)) and not isinstance(v, bool) and MIN_SIDE_IN <= v <= MAX_SIDE_IN for v in size_in))
        if not ok:
            raise ValueError(f"size_in must be (width, height) in inches, each {MIN_SIDE_IN:g}-{MAX_SIDE_IN:g}")
        size_in = (float(size_in[0]), float(size_in[1]))
    started = time.monotonic()
    root = jobs.mkdtemp("rpe-fig-")
    try:
        if warm and _warm_pool.is_supported():
            try:
                with _warm_pool.acquire(timeout=2.0) as worker:
                    if worker is not None:
                        return worker.run(Path(root), source, clean, dpi, out_format, facecolor, transparent, timeout,
                                          started, cancel, size_in=size_in)
            except Exception:
                pass  # Fall back cleanly to fresh subprocess if warm worker fails
        return _execute(Path(root), source, clean, dpi, out_format, facecolor, transparent, timeout, started, cancel,
                        size_in=size_in)
    finally:
        _remove_tree(root)


DATA_TIMEOUT = 5                      # seconds for the data-only run (contract s3d)


def run_python_data(source: str, *, timeout: float = DATA_TIMEOUT,
                    cancel: Optional[threading.Event] = None) -> RunResult:
    """Run `source` in the data-only harness (same limits and process rules as `run_python`, no figure, no image) and
    return the variable ``data`` as ``result.data = {columns, rows}``. Script problems come back as a RunResult."""
    _validate(source, 72, "png", "white", False, timeout, None)
    started = time.monotonic()
    root = jobs.mkdtemp("rpe-data-")
    try:
        return _execute(Path(root), source, {}, 72, "png", "white", False, timeout, started, cancel, data_mode=True)
    finally:
        _remove_tree(root)


def is_literal_assignment(source: str) -> bool:
    """True when the script is nothing but ``data = <literal dict>`` (comments / a docstring allowed), so it can be
    turned into spreadsheet data without keeping the code."""
    try:
        body = [n for n in ast.parse(source).body
                if not (isinstance(n, ast.Expr) and isinstance(n.value, ast.Constant) and isinstance(n.value.value, str))]
        if len(body) != 1 or not isinstance(body[0], ast.Assign) or len(body[0].targets) != 1:
            return False
        target = body[0].targets[0]
        if not (isinstance(target, ast.Name) and target.id == "data"):
            return False
        return isinstance(ast.literal_eval(body[0].value), dict)
    except (SyntaxError, ValueError, TypeError, MemoryError, RecursionError):
        return False
