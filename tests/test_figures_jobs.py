"""Job registry: per-kind limits, FIFO queue, hard timeouts, cancel kills the process group, shutdown and orphan sweep
(docs/FIGURES_CONTRACT.md s4y)."""
import os
import subprocess
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend.figures import jobs, render as render_core
from backend.figures.models import default_record
from backend.server import app

client = TestClient(app)
POSIX = os.name == "posix"
SLEEP_SCRIPT = "import time\nimport matplotlib.pyplot as plt\nplt.plot([1, 2])\ntime.sleep(60)\n"


@pytest.fixture(autouse=True)
def fresh():
    jobs.reopen()
    render_core.clear_cache()
    jobs.reset()
    yield
    jobs.reopen()


def wait_for(cond, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def spawn(fn, *args):
    t = threading.Thread(target=fn, args=args, daemon=True)
    t.start()
    return t


def custom(source):
    rec = default_record("python").model_dump()
    rec["source"] = source
    return rec


# ------------------------------------------------------------------ concurrency caps and queue order
@pytest.mark.parametrize("kind,limit", [("render", 2), ("python", 2), ("latex", 1)])
def test_concurrency_cap_per_kind(kind, limit):
    assert jobs.LIMITS[kind] == limit
    lock, state = threading.Lock(), {"now": 0, "peak": 0}

    def work(job):
        with jobs.slot(job):
            with lock:
                state["now"] += 1
                state["peak"] = max(state["peak"], state["now"])
            time.sleep(0.15)
            with lock:
                state["now"] -= 1
        jobs.finish(job)

    threads = [spawn(work, jobs.create(kind=kind)) for _ in range(limit + 4)]
    for t in threads:
        t.join(10)
    assert state["peak"] == limit


def test_kinds_do_not_block_each_other():
    hold = threading.Event()
    a = jobs.create(kind="latex")

    def blocker():
        with jobs.slot(a):
            hold.wait(10)
        jobs.finish(a)
    t = spawn(blocker)
    assert wait_for(lambda: a.state == "running")
    b = jobs.create(kind="render")
    with jobs.slot(b):                                     # latex is full, render is free
        assert b.state == "running"
    jobs.finish(b)
    hold.set()
    t.join(5)


def test_queue_is_first_in_first_out_and_reports_state(monkeypatch):
    monkeypatch.setitem(jobs.LIMITS, "render", 1)
    hold, order = threading.Event(), []
    first = jobs.create("q-0")

    def work(job, gate=None):
        with jobs.slot(job):
            order.append(job.id)
            if gate:
                gate.wait(10)
        jobs.finish(job)
    t0 = spawn(work, first, hold)
    assert wait_for(lambda: first.state == "running")
    others = []
    for i in range(1, 5):                                  # queued strictly one after another
        job = jobs.create(f"q-{i}")
        others.append((job, spawn(work, job)))
        assert wait_for(lambda: job.state == "queued" and jobs.describe(job.id)["queuePosition"] == i)
    snap = jobs.snapshot()
    assert [r["queuePosition"] for r in snap["jobs"] if r["state"] == "queued"] == [1, 2, 3, 4]
    assert snap["running"]["render"] == 1 and snap["queued"]["render"] == 4
    hold.set()
    for _, t in others:
        t.join(10)
    t0.join(5)
    assert order == ["q-0", "q-1", "q-2", "q-3", "q-4"]


def test_cancel_while_queued_leaves_the_line_and_does_not_block_others(monkeypatch):
    monkeypatch.setitem(jobs.LIMITS, "render", 1)
    hold, started = threading.Event(), []
    a, b, c = jobs.create("a"), jobs.create("b"), jobs.create("c")

    def work(job, gate=None):
        try:
            with jobs.slot(job):
                started.append(job.id)
                if gate:
                    gate.wait(10)
        except jobs.Cancelled:
            jobs.finish(job, cancelled=True)
            return
        jobs.finish(job)
    ta = spawn(work, a, hold)
    assert wait_for(lambda: a.state == "running")
    tb = spawn(work, b)
    assert wait_for(lambda: jobs.describe("b")["queuePosition"] == 1)
    tc = spawn(work, c)
    assert wait_for(lambda: jobs.describe("c")["queuePosition"] == 2)
    assert jobs.cancel("b") == "cancelling"
    tb.join(5)
    assert b.state == "cancelled" and jobs.describe("c")["queuePosition"] == 1
    hold.set()
    tc.join(5)
    ta.join(5)
    assert started == ["a", "c"]


# ------------------------------------------------------------------ timeouts
def test_hard_timeout_stops_a_running_render(monkeypatch):
    monkeypatch.setitem(jobs.HARD_TIMEOUT_S, "render", 0.8)
    monkeypatch.setattr(jobs, "WATCHDOG_INTERVAL_S", 0.05)
    t0 = time.time()
    res = client.post("/api/figures/render", json={"record": custom(SLEEP_SCRIPT), "purpose": "preview", "jobId": "slow-timeout"}).json()
    assert time.time() - t0 < 15
    assert res["status"] == "timeout" and not res["ok"] and "0.8 s" in res["diagnostics"][0]["message"]
    assert jobs.get("slow-timeout").state == "timeout"
    assert client.post("/api/figures/jobs/slow-timeout/cancel").json()["status"] == "finished"


def test_queue_timeout_gives_up_waiting(monkeypatch):
    monkeypatch.setitem(jobs.LIMITS, "render", 1)
    monkeypatch.setattr(jobs, "QUEUE_TIMEOUT_S", 0.4)
    monkeypatch.setattr(jobs, "WATCHDOG_INTERVAL_S", 0.05)
    hold, holder = threading.Event(), jobs.create("holder")

    def hold_slot():
        with jobs.slot(holder):
            hold.wait(10)
        jobs.finish(holder)
    t = spawn(hold_slot)
    assert wait_for(lambda: holder.state == "running")
    waiter = jobs.create("waiter")
    with pytest.raises(jobs.Cancelled):
        with jobs.slot(waiter):
            pass
    jobs.finish(waiter, cancelled=True)
    assert waiter.timed_out and waiter.state == "timeout" and "free slot" in waiter.timeout_message()
    hold.set()
    t.join(5)


# ------------------------------------------------------------------ cancel kills the child process group
def _alive(pid):
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    return True


@pytest.mark.skipif(not POSIX, reason="process groups are POSIX only")
def test_cancel_kills_the_child_and_its_grandchildren():
    job = jobs.create("kill-me")
    pids = {}

    def work():
        with jobs.slot(job):
            proc = subprocess.Popen(["sh", "-c", "sleep 60 & echo $!; wait"], stdout=subprocess.PIPE, start_new_session=True, text=True)
            jobs.attach_current(proc)
            pids["child"], pids["grand"] = proc.pid, int(proc.stdout.readline())
            proc.wait()
            jobs.detach_current(proc)
        jobs.finish(job, cancelled=True)
    t = spawn(work)
    assert wait_for(lambda: "grand" in pids)
    t0 = time.time()
    assert jobs.cancel("kill-me") == "cancelling"
    t.join(5)
    assert not t.is_alive() and time.time() - t0 < 3
    assert wait_for(lambda: not _alive(pids["grand"]), 3), "grandchild survived the cancel"
    assert job.state == "cancelled"


@pytest.mark.skipif(not POSIX, reason="process groups are POSIX only")
def test_attach_after_cancel_kills_at_once():
    job = jobs.create("late")
    job.cancel()
    proc = subprocess.Popen(["sleep", "60"], start_new_session=True)
    job.attach(proc)
    assert wait_for(lambda: proc.poll() is not None, 3)
    jobs.finish(job, cancelled=True)


def test_cancel_a_running_render_kills_its_process_and_answers_cancelled():
    out = []
    t = spawn(lambda: out.append(client.post("/api/figures/render", json={"record": custom(SLEEP_SCRIPT), "jobId": "r-kill"}).json()))
    assert wait_for(lambda: jobs.get("r-kill") is not None and jobs.get("r-kill").state == "running")
    job = jobs.get("r-kill")
    assert wait_for(lambda: len(job._procs) == 1, 10)       # the harness process is registered with the job
    proc = next(iter(job._procs))
    assert client.post("/api/figures/jobs/r-kill/cancel").json()["status"] == "cancelling"
    t.join(10)
    assert out and out[0]["status"] == "cancelled" and proc.poll() is not None


# ------------------------------------------------------------------ shutdown and orphan sweep
@pytest.mark.skipif(not POSIX, reason="process groups are POSIX only")
def test_shutdown_cancels_jobs_kills_children_and_removes_tracked_dirs():
    job, path = jobs.create("busy"), jobs.mkdtemp("rpe-fig-")
    queued = jobs.create("waiting", kind="latex")
    other = jobs.create("latex-holder", kind="latex")
    info, release = {}, threading.Event()

    def run():
        with jobs.slot(job):
            proc = subprocess.Popen(["sleep", "60"], start_new_session=True)
            jobs.attach_current(proc)
            info["proc"] = proc
            proc.wait()
    def hold_latex():
        with jobs.slot(other):
            release.wait(10)
    def wait_in_line():
        try:
            with jobs.slot(queued):
                pass
        except jobs.Cancelled:
            info["queued_cancelled"] = True
    t1, t2 = spawn(run), spawn(hold_latex)
    assert wait_for(lambda: "proc" in info and other.state == "running")
    t3 = spawn(wait_in_line)
    assert wait_for(lambda: queued.state == "queued" and jobs.describe("waiting")["queuePosition"] == 1)
    assert os.path.isdir(path)
    jobs.shutdown(wait=2.0)
    assert info["proc"].poll() is not None, "child survived shutdown"
    assert not os.path.exists(path), "tracked temp dir survived shutdown"
    t3.join(5)
    assert info.get("queued_cancelled")
    with pytest.raises(ValueError, match="shutting down"):
        jobs.create()
    release.set()
    t1.join(5), t2.join(5)


def test_sweep_orphans_removes_old_rpe_folders_only(tmp_path):
    old = [tmp_path / n for n in ("rpe-fig-aaa", "rpe-data-bbb", "rpe_tex_ccc", "rpe_pdf_ddd")]
    young, foreign, a_file = tmp_path / "rpe-fig-young", tmp_path / "other-folder", tmp_path / "rpe-fig-file"
    for d in old + [young, foreign]:
        d.mkdir()
        (d / "x.txt").write_text("x")
    a_file.write_text("not a folder")
    past = time.time() - 3600
    for d in old + [foreign]:
        os.utime(d, (past, past))
    removed = jobs.sweep_orphans(str(tmp_path), older_than=60)
    assert sorted(removed) == sorted(d.name for d in old)
    assert young.exists() and foreign.exists() and a_file.exists()


def test_sweep_orphans_keeps_folders_this_process_still_uses(tmp_path, monkeypatch):
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))
    monkeypatch.setattr("tempfile.tempdir", str(tmp_path))
    live = jobs.mkdtemp("rpe-fig-")
    stale = tmp_path / "rpe-fig-stale"
    stale.mkdir()
    past = time.time() - 3600
    os.utime(live, (past, past))
    os.utime(stale, (past, past))
    assert jobs.sweep_orphans(older_than=60) == ["rpe-fig-stale"]
    assert os.path.isdir(live)
    jobs.untrack_dir(live)


def test_server_lifespan_sweeps_at_start_and_shuts_down(tmp_path, monkeypatch):
    stale = tmp_path / "rpe_tex_never"
    stale.mkdir()
    os.utime(stale, (time.time() - 3600, time.time() - 3600))
    monkeypatch.setattr("tempfile.gettempdir", lambda: str(tmp_path))
    with TestClient(app) as c:
        assert not stale.exists()
        assert c.get("/api/figures/jobs").status_code == 200
    with pytest.raises(ValueError):                        # shutdown ran on exit
        jobs.create()


# ------------------------------------------------------------------ debug endpoints and runner wiring
def test_jobs_endpoint_lists_active_then_finished_with_queue_info(monkeypatch):
    monkeypatch.setitem(jobs.LIMITS, "render", 1)
    out = []
    t1 = spawn(lambda: out.append(client.post("/api/figures/render", json={"record": custom(SLEEP_SCRIPT), "jobId": "l-run"}).json()))
    assert wait_for(lambda: jobs.get("l-run") is not None and jobs.get("l-run").state == "running")
    t2 = spawn(lambda: out.append(client.post("/api/figures/render", json={"record": custom(SLEEP_SCRIPT + "#2\n"), "jobId": "l-wait"}).json()))
    assert wait_for(lambda: jobs.get("l-wait") is not None and jobs.get("l-wait").state == "queued")
    body = client.get("/api/figures/jobs").json()
    rows = {r["id"]: r for r in body["jobs"]}
    assert rows["l-run"]["state"] == "running" and rows["l-run"]["kind"] == "render" and rows["l-run"]["queuePosition"] is None
    assert rows["l-wait"]["state"] == "queued" and rows["l-wait"]["queuePosition"] == 1
    assert body["limits"] == {"render": 1, "python": 2, "latex": 1} and body["running"]["render"] == 1 and body["queued"]["render"] == 1
    assert client.get("/api/figures/jobs/l-wait").json()["job"]["state"] == "queued"
    assert client.get("/api/figures/jobs/nope").status_code == 404
    for name in ("l-wait", "l-run"):
        client.post(f"/api/figures/jobs/{name}/cancel")
    t1.join(10), t2.join(10)
    done = {r["id"]: r["state"] for r in client.get("/api/figures/jobs").json()["jobs"]}
    assert done == {"l-run": "cancelled", "l-wait": "cancelled"}


def test_python_run_data_and_export_use_their_own_kinds():
    assert client.post("/api/figures/python/run", json={"source": "import matplotlib.pyplot as plt\nplt.plot([1])", "dpi": 72, "jobId": "k-py"}).json()["ok"]
    assert client.post("/api/figures/python/data", json={"source": "data = {'x': [1, 2]}"}).json()["ok"]
    assert client.post("/api/figures/render", json={"record": custom("import matplotlib.pyplot as plt\nplt.plot([1])"), "jobId": "k-r"}).json()["ok"]
    kinds = {r["id"]: r["kind"] for r in jobs.snapshot()["jobs"]}
    assert kinds["k-py"] == "python" and kinds["k-r"] == "render" and list(kinds.values()).count("python") == 2


def test_export_accepts_a_client_job_id_and_cancel_answers_499():
    out = []
    body = {"record": custom(SLEEP_SCRIPT), "format": "png", "jobId": "x-1"}
    t = spawn(lambda: out.append(client.post("/api/figures/export", json=body)))
    assert wait_for(lambda: jobs.get("x-1") is not None and jobs.get("x-1").state == "running")
    client.post("/api/figures/jobs/x-1/cancel")
    t.join(10)
    assert out and out[0].status_code == 499
    assert client.post("/api/figures/export", json={**body, "jobId": "bad id!"}).status_code == 400


def test_latex_jobs_share_one_slot_and_report_cancelled_without_engine_run(monkeypatch):
    from backend.figures import latex
    monkeypatch.setattr(latex, "find_engine", lambda e: sys.executable)       # an "engine" that exists
    hold = threading.Event()
    gate = jobs.create("tex-holder", kind="latex")

    def hold_slot():
        with jobs.slot(gate):
            hold.wait(10)
        jobs.finish(gate)
    t = spawn(hold_slot)
    assert wait_for(lambda: gate.state == "running")
    out = []
    t2 = spawn(lambda: out.append(client.post("/api/figures/latex/compile", json={"source": "\\documentclass{article}\\begin{document}x\\end{document}", "jobId": "tex-1"}).json()))
    assert wait_for(lambda: jobs.get("tex-1") is not None and jobs.get("tex-1").state == "queued")
    assert jobs.get("tex-1").kind == "latex"
    client.post("/api/figures/jobs/tex-1/cancel")
    t2.join(10)
    assert out and out[0]["status"] == "cancelled" and not out[0]["ok"]
    hold.set()
    t.join(5)
