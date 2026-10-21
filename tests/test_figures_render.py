"""POST /api/figures/render and POST /api/figures/jobs/{id}/cancel (docs/FIGURES_CONTRACT.md s4i)."""
import base64
import io
import threading
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.figures import jobs, render as render_core
from backend.figures.models import default_record
from backend.server import app

client = TestClient(app)

SLEEP_SCRIPT = "import time\nimport matplotlib.pyplot as plt\nplt.plot([1, 2])\ntime.sleep(60)\n"
PLAIN_SCRIPT = "import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\nprint('drawn')\nplt.show()\n"

DATA = {  # plotType -> (columns [(name, type)], rows, mapping)
    "line": ([("x", "number"), ("y", "number")], [[1, 2], [2, 4], [3, 3], [4, 6]], {"x": "x", "y": ["y"]}),
    "scatter": ([("x", "number"), ("y", "number")], [[1, 2], [2, 4], [3, 3], [4, 6]], {"x": "x", "y": ["y"]}),
    "bar": ([("g", "text"), ("v", "number")], [["a", 3], ["b", 5], ["c", 2]], {"x": "g", "y": ["v"]}),
    "hist": ([("v", "number")], [[float(i % 7)] for i in range(40)], {"y": ["v"]}),
    "box": ([("g", "text"), ("v", "number")], [[g, float(i + k)] for g in "ab" for i, k in enumerate(range(8))],
            {"y": ["v"], "group": "g"}),
    "heatmap": ([("a", "number"), ("b", "number"), ("c", "number")],
                [[1, 2, 5], [2, 1, 4], [3, 5, 1], [4, 3, 2]], {"y": ["a", "b", "c"]}),
}


def structured(plot_type, w=3.0, h=2.0, dpi=100, **export):
    cols, rows, mapping = DATA[plot_type]
    rec = default_record("structured", plot_type).model_dump()
    rec["dataset"] = {"columns": [{"name": n, "type": t} for n, t in cols], "rows": rows,
                      "origin": {"type": "sheet", "label": ""}}
    rec["config"]["mapping"] = {"x": None, "y": [], "group": None, "yErr": None, **mapping}
    rec["export"].update(wIn=w, hIn=h, dpi=dpi, **export)
    return rec


def custom(source=PLAIN_SCRIPT, **export):
    rec = default_record("python").model_dump()
    rec["source"] = source
    rec["export"].update(**export)
    return rec


def post(record, purpose="preview", **extra):
    res = client.post("/api/figures/render", json={"record": record, "purpose": purpose, **extra})
    assert res.status_code == 200, res.text
    return res.json()


def png(body):
    assert body["preview"].startswith("data:image/png;base64,")
    img = Image.open(io.BytesIO(base64.b64decode(body["preview"].split(",", 1)[1])))
    img.load()
    return img


@pytest.fixture(autouse=True)
def fresh():
    render_core.clear_cache()
    jobs.reset()
    yield


# ------------------------------------------------------------------ plot types
@pytest.mark.parametrize("plot_type", list(DATA))
def test_each_plot_type_renders(plot_type):
    body = post(structured(plot_type))
    assert body["ok"] is True and body["status"] == "ok" and body["cached"] is False
    img = png(body)
    assert (img.width, img.height) == (body["widthPx"], body["heightPx"]) == (300, 200)   # 3 x 2 in at 100 dpi
    assert len(img.convert("RGB").getcolors(maxcolors=100000)) > 3                          # not blank
    assert "import matplotlib" in body["source"] and body["source"].rstrip().endswith("plt.show()")
    assert len(body["hash"]) == 64 and body["jobId"] and body["durationMs"] > 0
    assert isinstance(body["diagnostics"], list) and body["stdout"] == "" and body["stderr"] == ""


def test_custom_source_runs_and_is_returned():
    body = post(custom(), dpi=100)
    assert body["ok"] and body["source"] == PLAIN_SCRIPT and "drawn" in body["stdout"]
    assert png(body).width == body["widthPx"] > 0


def test_custom_script_error_reports_line_and_keeps_source():
    src = "import matplotlib.pyplot as plt\nplt.plot([1])\nraise RuntimeError('boom')\n"
    body = post(custom(src))
    assert body["ok"] is False and body["status"] == "error" and body["preview"] is None and body["source"] == src
    err = [d for d in body["diagnostics"] if d["level"] == "error"][0]
    assert err["line"] == 3 and "boom" in body["stderr"]


# ----------------------------------------------------------------------- cache
def test_cache_hit_flag_and_independence_from_irrelevant_fields():
    rec = structured("line")
    first = post(rec)
    assert first["cached"] is False and render_core.cache_size() == 1
    again = post(rec)
    assert again["cached"] is True and again["hash"] == first["hash"] and again["preview"] == first["preview"]
    assert again["source"] == first["source"]
    rec2 = dict(rec, id="other-id", render={**rec["render"], "status": "stale"}, originalCsv="x,y\n1,2\n")
    assert post(rec2)["cached"] is True                       # id / render state / original CSV do not matter
    rec["dataset"]["rows"][0][1] = 9
    changed = post(rec)
    assert changed["cached"] is False and changed["hash"] != first["hash"]
    assert post(structured("line"), dpi=120)["cached"] is False   # dpi is part of the key


def test_cache_is_an_lru_of_64(monkeypatch):
    assert render_core.CACHE_SIZE == 64
    monkeypatch.setattr(render_core, "CACHE_SIZE", 3)
    for i in range(4):
        render_core._cache_put(f"k{i}", {"preview": "x"})
    assert render_core.cache_size() == 3 and render_core._cache_get("k0") is None
    render_core._cache_get("k1")                              # refresh k1 -> k2 is now the oldest
    render_core._cache_put("k4", {"preview": "x"})
    assert render_core._cache_get("k2") is None and render_core._cache_get("k1") is not None


def test_oversized_images_are_returned_but_not_cached(monkeypatch):
    monkeypatch.setattr(render_core, "CACHE_MAX_ENTRY_CHARS", 10)
    assert post(structured("line"))["ok"] and render_core.cache_size() == 0


def test_failures_are_not_cached():
    post(custom("raise SystemExit(3)"))
    assert render_core.cache_size() == 0


# ------------------------------------------------------------------ validation
def test_validation_errors_are_ok_false_with_human_messages():
    rec = structured("line")
    rec["config"]["mapping"]["y"] = ["nope"]
    body = post(rec)
    assert body["ok"] is False and body["status"] == "invalid" and body["preview"] is None and body["hash"] is None
    d = body["diagnostics"][0]
    assert d["level"] == "error" and d["code"] == "column_missing" and "nope" in d["message"]

    empty = default_record("structured", "bar").model_dump()   # no data at all
    body = post(empty)
    assert body["ok"] is False and body["status"] == "invalid" and all(d["message"] for d in body["diagnostics"])


def test_invalid_record_and_unsupported_kinds_and_empty_script():
    rec = structured("line")
    rec["config"]["plotType"] = "pie"
    body = post(rec)
    assert body["ok"] is False and body["diagnostics"][0]["code"] == "invalid_record" and "plotType" in body["diagnostics"][0]["message"]
    body = post(default_record("latex").model_dump())                 # composites render since s4s (tests/test_figures_composite.py)
    assert body["ok"] is False and body["status"] == "invalid" and body["diagnostics"][0]["code"] == "unsupported_kind"
    body = post(custom("   \n"))
    assert body["ok"] is False and body["diagnostics"][0]["code"] == "source_empty"


def test_codegen_warnings_are_returned_on_success():
    rec = structured("line")
    rec["dataset"]["rows"][1][1] = None
    body = post(rec)
    assert body["ok"] and any(d["code"] == "missing_values" for d in body["diagnostics"])
    again = post(rec)
    assert again["cached"] is True and again["diagnostics"] == body["diagnostics"]


@pytest.mark.parametrize("payload, status", [
    ({"record": "x"}, 400), ({"purpose": "preview"}, 400), ({"record": {}, "purpose": "draft"}, 400),
    ({"record": {}, "dpi": 20}, 400), ({"record": {}, "dpi": "150"}, 400), ({"record": {}, "dpi": True}, 400),
    ({"record": {}, "jobId": "a b"}, 400), ([1, 2], 400),
])
def test_malformed_requests_are_400(payload, status):
    assert client.post("/api/figures/render", json=payload).status_code == status


def test_malformed_transport():
    assert client.post("/api/figures/render", content=b"{nope", headers={"content-type": "application/json"}).status_code == 400
    assert client.post("/api/figures/render", content=b"x", headers={"content-type": "text/plain"}).status_code == 415


# --------------------------------------------------------------- purpose / dpi
def test_preview_caps_dpi_at_150():
    body = post(structured("line", dpi=450))                  # export dpi 450 -> preview 150
    assert body["dpi"] == 150 and (body["widthPx"], body["heightPx"]) == (450, 300)
    body = post(structured("line", dpi=450), dpi=1000)        # an explicit dpi is capped too
    assert body["dpi"] == 150 and body["widthPx"] == 450
    body = post(structured("line", dpi=450), dpi=90)          # lower values are honoured
    assert body["dpi"] == 90 and body["widthPx"] == 270


def test_final_honors_export_dpi_and_request_dpi():
    body = post(structured("scatter", dpi=300), "final")
    assert body["dpi"] == 300 and (body["widthPx"], body["heightPx"]) == (900, 600) and png(body).size == (900, 600)
    body = post(structured("scatter", dpi=300), "final", dpi=200)
    assert body["dpi"] == 200 and (body["widthPx"], body["heightPx"]) == (600, 400)
    assert post(structured("scatter", dpi=300), "final")["cached"] is True
    assert post(structured("scatter", dpi=300), "preview")["cached"] is False   # 150 dpi is a different image


def test_final_enforces_pixel_caps():
    rec = structured("line", w=20.0, h=20.0, dpi=72)
    body = post(rec, "final", dpi=1000)                       # 20000 px per side
    assert body["ok"] is False and body["status"] == "invalid" and body["preview"] is None
    assert body["diagnostics"][0]["code"] == "size_limit" and "16384" in body["diagnostics"][0]["message"]
    body = post(structured("line", w=16.0, h=16.0, dpi=72), "final", dpi=1000)   # 16000 px side, 256 MP
    assert body["ok"] is False and "120 MP" in body["diagnostics"][0]["message"]
    body = post(structured("line", w=30.0, h=30.0, dpi=600))  # the record itself breaks the limit (18000 px)
    assert body["ok"] is False and body["diagnostics"][0]["code"] == "invalid_record"


def test_custom_script_size_is_checked_by_the_runner():
    src = "import matplotlib.pyplot as plt\nplt.figure(figsize=(20, 20))\nplt.plot([1, 2])\n"
    body = post(custom(src), "final", dpi=1000)
    assert body["ok"] is False and body["status"] == "error" and body["preview"] is None
    assert "px" in body["diagnostics"][-1]["message"] or "megapixel" in body["diagnostics"][-1]["message"].lower()


def test_transparent_background_is_honoured():
    img = png(post(structured("line", background="transparent"))).convert("RGBA")
    assert img.getpixel((0, 0))[3] == 0


# ---------------------------------------------------------------------- cancel
def _render_in_thread(record, job_id, out):
    def work():
        out.append(client.post("/api/figures/render", json={"record": record, "purpose": "preview", "jobId": job_id}).json())
    t = threading.Thread(target=work)
    t.start()
    return t


def _wait_state(job_id, state, timeout=20):
    end = time.time() + timeout
    while time.time() < end:
        job = jobs.get(job_id)
        if job is not None and job.state == state:
            return
        time.sleep(0.05)
    raise AssertionError(f"job {job_id} never reached {state}")


def test_cancel_running_render_kills_the_subprocess():
    out = []
    t = _render_in_thread(custom(SLEEP_SCRIPT), "slow-1", out)
    _wait_state("slow-1", "running")
    time.sleep(0.5)                                           # let the child start
    started = time.time()
    res = client.post("/api/figures/jobs/slow-1/cancel")
    assert res.status_code == 200 and res.json() == {"ok": True, "jobId": "slow-1", "status": "cancelling"}
    t.join(15)
    assert not t.is_alive() and time.time() - started < 10    # the script sleeps 60 s
    body = out[0]
    assert body["ok"] is False and body["status"] == "cancelled" and body["jobId"] == "slow-1" and body["preview"] is None
    assert render_core.cache_size() == 0
    assert client.post("/api/figures/jobs/slow-1/cancel").json()["status"] == "cancelled"


def test_cancel_queued_job_and_concurrency_limit():
    outs, threads = {}, []
    for name in ("q1", "q2"):                                 # fill both slots
        outs[name] = []
        threads.append(_render_in_thread(custom(SLEEP_SCRIPT), name, outs[name]))
        _wait_state(name, "running")
    outs["q3"] = []
    threads.append(_render_in_thread(custom(SLEEP_SCRIPT + "# third\n"), "q3", outs["q3"]))
    time.sleep(1.0)
    assert jobs.get("q3").state == "queued"                   # only 2 run at once
    assert client.post("/api/figures/jobs/q3/cancel").json()["status"] == "cancelling"
    threads[2].join(10)
    assert outs["q3"][0]["status"] == "cancelled"
    for name in ("q1", "q2"):
        client.post(f"/api/figures/jobs/{name}/cancel")
    for t in threads:
        t.join(15)
    assert all(o[0]["status"] == "cancelled" for o in outs.values())
    assert jobs.MAX_CONCURRENT == 2


def test_cancel_finished_and_unknown_jobs():
    body = post(structured("line"), jobId="done-1")
    assert body["ok"] and body["jobId"] == "done-1"
    res = client.post("/api/figures/jobs/done-1/cancel")
    assert res.status_code == 200 and res.json()["status"] == "finished"
    assert client.post("/api/figures/jobs/never-seen/cancel").status_code == 404


def test_generated_job_id_is_returned_and_active_ids_are_not_reused():
    assert post(structured("line"))["jobId"]
    job = jobs.create("busy-1")
    res = client.post("/api/figures/render", json={"record": structured("line"), "jobId": "busy-1"})
    assert res.status_code == 400 and "already running" in res.json()["detail"]
    jobs.finish(job)
    assert post(structured("line"), jobId="busy-1")["ok"]


def test_runner_cancel_event_unit():
    from backend.figures.runner import run_python
    ev = threading.Event()
    threading.Timer(1.5, ev.set).start()
    started = time.time()
    res = run_python(SLEEP_SCRIPT, dpi=72, cancel=ev)
    assert res.status == "cancelled" and not res.ok and time.time() - started < 15
