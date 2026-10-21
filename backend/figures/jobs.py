"""Job registry for all long-running figure work (docs/FIGURES_CONTRACT.md s4i, s4y).

Every /render, /export, /python/run, /python/data and /latex/* request is a `Job` with a `kind`:
  render = structured / composite / custom figures and file exports, python = user scripts, latex = TeX compiles.
Each kind has its own run limit (`LIMITS`) and a FIFO queue: a job waits in state `queued` until it is first in line and a
slot is free. Running jobs have a hard wall-clock limit (`HARD_TIMEOUT_S`, a watchdog cancels them with `timed_out=True`),
queued jobs wait at most `QUEUE_TIMEOUT_S`. `cancel()` sets the event the runners poll AND kills every attached child
process group at once. `shutdown()` cancels everything and removes the temp dirs; `sweep_orphans()` removes the ones a
crashed server left behind.
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import threading
import time
import uuid
from collections import OrderedDict, deque
from contextlib import contextmanager
from typing import Any, Deque, Dict, Iterator, List, Optional

KINDS = ("render", "python", "latex")
LIMITS: Dict[str, int] = {"render": 2, "python": 2, "latex": 1}
HARD_TIMEOUT_S: Dict[str, float] = {"render": 90.0, "python": 90.0, "latex": 120.0}   # from the start of the run
QUEUE_TIMEOUT_S = 120.0                    # longest wait for a slot
WATCHDOG_INTERVAL_S = 0.25
MAX_CONCURRENT = LIMITS["render"]          # kept for older callers / tests
MAX_FINISHED_KEPT = 256                    # finished jobs stay known so a late cancel answers "finished", not "unknown"
MAX_LISTED_FINISHED = 50
JOB_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TEMP_PREFIXES = ("rpe-fig-", "rpe-data-", "rpe_tex_", "rpe_pdf_")

_lock = threading.Lock()
_cond = threading.Condition(_lock)
_jobs: "OrderedDict[str, Job]" = OrderedDict()
_queues: Dict[str, Deque["Job"]] = {k: deque() for k in KINDS}
_running: Dict[str, int] = {k: 0 for k in KINDS}
_dirs: set = set()
_tls = threading.local()
_closing = False
_watchdog: Optional[threading.Thread] = None


class Cancelled(Exception):
    """Raised inside a job when it was cancelled before or while waiting for a slot."""


def _kill(proc: Any) -> None:
    from backend.figures.runner import _kill_tree      # lazy: runner imports this module
    try:
        _kill_tree(proc)
    except Exception:                                  # noqa: BLE001 - killing must never raise into the caller
        pass


class Job:
    def __init__(self, job_id: str, kind: str = "render"):
        self.id, self.kind = job_id, kind
        self.state = "queued"                          # queued | running | done | cancelled | timeout
        self.event = threading.Event()
        self.created = time.time()
        self.created_mono = time.monotonic()
        self.started: Optional[float] = None
        self.ended: Optional[float] = None
        self.deadline: Optional[float] = None          # monotonic; set when the run starts
        self.timed_out = False
        self._procs: set = set()

    @property
    def cancelled(self) -> bool:
        return self.event.is_set()

    @property
    def active(self) -> bool:
        return self.state in ("queued", "running")

    def attach(self, proc: Any) -> None:
        """Register a child process; a cancel (now or later) kills its whole process group."""
        with _lock:
            self._procs.add(proc)
        if self.cancelled:
            _kill(proc)

    def detach(self, proc: Any) -> None:
        with _lock:
            self._procs.discard(proc)

    def cancel(self) -> None:
        self.event.set()
        with _lock:
            procs = list(self._procs)
        for p in procs:
            _kill(p)

    def expire(self) -> None:
        self.timed_out = True
        self.cancel()

    @property
    def timeout_s(self) -> float:
        return QUEUE_TIMEOUT_S if self.started is None else HARD_TIMEOUT_S.get(self.kind, 90.0)

    def timeout_message(self) -> str:
        if self.started is None:
            return f"The job waited {self.timeout_s:g} s for a free slot and was stopped."
        return f"The job ran longer than {self.timeout_s:g} s and was stopped."


def _ensure_watchdog() -> None:
    global _watchdog
    if _watchdog is not None and _watchdog.is_alive():
        return
    _watchdog = threading.Thread(target=_watch, name="rpe-job-watchdog", daemon=True)
    _watchdog.start()


def _watch() -> None:
    while True:
        time.sleep(WATCHDOG_INTERVAL_S)
        now = time.monotonic()
        with _lock:
            live = [j for j in _jobs.values() if j.active and not j.cancelled]
        for j in live:
            if j.state == "running" and j.deadline is not None and now > j.deadline:
                j.expire()
            elif j.state == "queued" and now - j.created_mono > QUEUE_TIMEOUT_S:
                j.expire()


def create(job_id: Optional[str] = None, kind: str = "render") -> Job:
    """Register a job. Without `job_id` one is generated; a client-chosen id lets the UI cancel before the response
    arrives. ValueError when the id is malformed or belongs to a job that is still active."""
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    if job_id is not None and not (isinstance(job_id, str) and JOB_ID_RE.match(job_id)):
        raise ValueError("jobId must be 1-64 characters: letters, digits, '_' or '-'.")
    with _lock:
        if _closing:
            raise ValueError("The service is shutting down.")
        if job_id is None:
            job_id = uuid.uuid4().hex[:16]
        old = _jobs.get(job_id)
        if old is not None and old.active:
            raise ValueError(f"A job with jobId '{job_id}' is already running.")
        job = Job(job_id, kind)
        _jobs.pop(job_id, None)
        _jobs[job_id] = job
        finished = [k for k, j in _jobs.items() if not j.active]
        for k in finished[:max(0, len(finished) - MAX_FINISHED_KEPT)]:
            del _jobs[k]
    _ensure_watchdog()
    return job


def get(job_id: str) -> Optional[Job]:
    with _lock:
        return _jobs.get(job_id)


def current() -> Optional[Job]:
    """The job whose slot the calling thread holds (set by `slot`), else None."""
    return getattr(_tls, "job", None)


def attach_current(proc: Any) -> None:
    job = current()
    if job is not None:
        job.attach(proc)


def detach_current(proc: Any) -> None:
    job = current()
    if job is not None:
        job.detach(proc)


def finish(job: Job, *, cancelled: bool = False) -> None:
    """Mark the job over (idempotent); `cancelled` = the work ended because of a cancel, not merely that one was requested late."""
    with _cond:
        if not job.active:
            return
        job.state = "timeout" if job.timed_out else "cancelled" if cancelled else "done"
        job.ended = time.time()
        q = _queues[job.kind]
        if job in q:
            q.remove(job)
        _cond.notify_all()


def cancel(job_id: str) -> Optional[str]:
    """Request cancellation. Returns 'cancelling' (job active), 'cancelled' / 'finished' (already over) or None (unknown id)."""
    job = get(job_id)
    if job is None:
        return None
    if job.active:
        job.cancel()
        return "cancelling"
    return "cancelled" if job.state == "cancelled" else "finished"


@contextmanager
def slot(job: Job) -> Iterator[None]:
    """Wait (FIFO per kind) for a run slot; a cancel while waiting raises Cancelled. While held, `current()` is `job`."""
    kind = job.kind
    with _cond:
        q = _queues[kind]
        q.append(job)
        try:
            while not (q[0] is job and _running[kind] < LIMITS[kind]):
                if job.cancelled:
                    raise Cancelled()
                _cond.wait(0.05)
            if job.cancelled:
                raise Cancelled()
        except BaseException:
            if job in q:
                q.remove(job)
            _cond.notify_all()
            raise
        q.popleft()
        _running[kind] += 1
        job.state = "running"
        job.started = time.time()
        job.deadline = time.monotonic() + HARD_TIMEOUT_S.get(kind, 90.0)
        _cond.notify_all()
    _tls.job = job
    try:
        yield
    finally:
        _tls.job = None
        with _cond:
            _running[kind] -= 1
            _cond.notify_all()


def snapshot() -> Dict[str, Any]:
    """Debug view for GET /api/figures/jobs: active jobs (oldest first) then the most recent finished ones."""
    now_m, now = time.monotonic(), time.time()
    with _lock:
        items = list(_jobs.values())
        pos = {j.id: i + 1 for q in _queues.values() for i, j in enumerate(q)}
        running, queued = dict(_running), {k: len(q) for k, q in _queues.items()}
    def row(j: Job) -> Dict[str, Any]:
        end = j.ended or now
        return {"id": j.id, "kind": j.kind, "state": j.state, "createdAt": round(j.created, 3),
                "startedAt": round(j.started, 3) if j.started else None, "endedAt": round(j.ended, 3) if j.ended else None,
                "elapsedMs": round((end - (j.started or j.created)) * 1000), "queuePosition": pos.get(j.id) if j.state == "queued" else None,
                "timeoutS": j.timeout_s, "cancelRequested": j.cancelled, "timedOut": j.timed_out}
    active = sorted((j for j in items if j.active), key=lambda j: j.created)
    done = sorted((j for j in items if not j.active), key=lambda j: j.ended or 0, reverse=True)[:MAX_LISTED_FINISHED]
    return {"jobs": [row(j) for j in active + done], "limits": dict(LIMITS), "running": running, "queued": queued,
            "hardTimeoutS": dict(HARD_TIMEOUT_S), "queueTimeoutS": QUEUE_TIMEOUT_S}


def describe(job_id: str) -> Optional[Dict[str, Any]]:
    return next((r for r in snapshot()["jobs"] if r["id"] == job_id), None)


# ------------------------------------------------------------------ temp dirs
def mkdtemp(prefix: str) -> str:
    """tempfile.mkdtemp that the registry knows about (removed by `shutdown`, never by the orphan sweep while tracked)."""
    path = tempfile.mkdtemp(prefix=prefix)
    with _lock:
        _dirs.add(path)
    return path


def untrack_dir(path: str) -> None:
    with _lock:
        _dirs.discard(path)


def sweep_orphans(tmp_root: Optional[str] = None, older_than: float = 60.0) -> List[str]:
    """Startup sweep: remove `rpe-*` work folders a previous (crashed) server left in the temp dir. Folders this process
    tracks and folders younger than `older_than` seconds are kept. Returns the removed folder names."""
    root = tmp_root or tempfile.gettempdir()
    removed: List[str] = []
    try:
        names = os.listdir(root)
    except OSError:
        return removed
    with _lock:
        tracked = set(_dirs)
    now = time.time()
    for name in names:
        path = os.path.join(root, name)
        if not name.startswith(TEMP_PREFIXES) or path in tracked or not os.path.isdir(path) or os.path.islink(path):
            continue
        try:
            if now - os.path.getmtime(path) < older_than:
                continue
        except OSError:
            continue
        shutil.rmtree(path, ignore_errors=True)
        if not os.path.exists(path):
            removed.append(name)
    return removed


def shutdown(wait: float = 3.0) -> None:
    """Server shutdown: refuse new jobs, cancel every active one (child process groups die at once), give the worker
    threads `wait` seconds to clean up, then remove whatever temp folders are still tracked."""
    global _closing
    with _lock:
        _closing = True
        active = [j for j in _jobs.values() if j.active]
    for j in active:
        j.cancel()
    end = time.monotonic() + wait
    while time.monotonic() < end and any(j.active for j in active):
        time.sleep(0.02)
    for j in active:                                   # a worker that never answered: kill what is left of it
        with _lock:
            procs = list(j._procs)
        for p in procs:
            _kill(p)
    with _lock:
        dirs = list(_dirs)
        _dirs.clear()
    for d in dirs:
        shutil.rmtree(d, ignore_errors=True)
    try:
        from backend.figures.runner import shutdown_warm_pool
        shutdown_warm_pool()
    except Exception:
        pass


def reopen() -> None:
    """Allow jobs again after `shutdown` (tests, reload)."""
    global _closing
    with _lock:
        _closing = False


def reset() -> None:
    """Forget all jobs (tests)."""
    with _lock:
        _jobs.clear()
        for q in _queues.values():
            q.clear()
    try:
        from backend.figures.runner import shutdown_warm_pool
        shutdown_warm_pool()
    except Exception:
        pass
