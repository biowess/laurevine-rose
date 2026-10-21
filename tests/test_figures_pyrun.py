"""GET /api/figures/python/templates and POST /api/figures/python/run (docs/FIGURES_CONTRACT.md s4p)."""
import base64
import io
import re
import sys
import threading
import time

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from backend.figures import jobs, pyrun, render as render_core
from backend.server import app

client = TestClient(app)
URL = "/api/figures/python/run"
TEMPLATES = client.get("/api/figures/python/templates").json()["templates"]


@pytest.fixture(autouse=True)
def fresh():
    render_core.clear_cache()
    jobs.reset()
    yield


def run(source, **kw):
    res = client.post(URL, json={"source": source, "dpi": 100, **kw})
    assert res.status_code == 200, res.text
    return res.json()


def image(body):
    return Image.open(io.BytesIO(base64.b64decode(body["preview"].split(",", 1)[1]))).convert("RGB")


# ------------------------------------------------------------------ templates
def test_template_list_shape_and_convention():
    assert [t["id"] for t in TEMPLATES] == ["line", "scatter", "bar", "hist", "heatmap", "two_panel"]
    for t in TEMPLATES:
        assert t["name"] and t["description"] and len(t["sizeIn"]) == 2
        assert t["source"].startswith("# Output convention")
        assert "lowest" in t["source"].splitlines()[2].lower() and "savefig" in t["source"].splitlines()[3]
        code = [ln for ln in t["source"].splitlines() if not ln.startswith("#")]
        assert any("plt.subplots(" in ln and "figsize=(" in ln for ln in code)
        assert not any(re.search(r"\bshow\(", ln) or "savefig(" in ln for ln in code)
        assert len(code) <= 30                                      # short


@pytest.mark.parametrize("tpl", TEMPLATES, ids=lambda t: t["id"])
def test_each_template_runs_and_is_not_blank(tpl):
    body = run(tpl["source"])
    assert body["ok"] and body["status"] == "ok", body["diagnostics"]
    assert body["figuresFound"] == 1 and body["warnings"] == [] and body["traceback"] is None
    w, h = tpl["sizeIn"]
    assert (body["widthPx"], body["heightPx"]) == (round(w * 100), round(h * 100))
    img = image(body)
    assert img.size == (body["widthPx"], body["heightPx"])
    assert len(img.getcolors(maxcolors=1_000_000)) > 5             # more than a flat background


# ----------------------------------------------------------------- error mapping
def test_runtime_error_maps_line_column_message():
    body = run("import matplotlib.pyplot as plt\nplt.plot([1])\nx = 1 / 0\n")
    assert not body["ok"] and body["status"] == "error" and body["preview"] is None
    tb = body["traceback"]
    assert tb["line"] == 3 and tb["message"] == "ZeroDivisionError: division by zero"
    err = body["diagnostics"][-1]
    assert err["level"] == "error" and err["code"] == "error" and err["line"] == 3
    if sys.version_info >= (3, 11):                                 # column comes from the interpreter's position table
        assert tb["column"] == 5 and err["column"] == 5


def test_syntax_error_maps_line_and_column():
    body = run("import matplotlib.pyplot as plt\nx = (1,\ny = 2\n")
    assert body["status"] == "error" and body["traceback"]["line"] in (2, 3)
    assert isinstance(body["traceback"]["column"], int) and body["traceback"]["message"].startswith("SyntaxError")


def test_missing_module_has_actionable_text():
    body = run("import sklearn_not_installed_xyz\nimport matplotlib.pyplot as plt\nplt.plot([1])\n")
    assert body["status"] == "missing_dependency" and not body["ok"]
    mm = body["missingModule"]
    assert mm["name"] == "sklearn_not_installed_xyz"
    assert "pip install sklearn_not_installed_xyz in the environment running this app" in mm["message"]
    assert "will not install packages" in mm["message"]
    assert body["diagnostics"][-1]["module"] == "sklearn_not_installed_xyz" and body["diagnostics"][-1]["message"] == mm["message"]


def test_missing_module_maps_import_name_to_package():
    assert pyrun._missing("sklearn.utils")["package"] == "scikit-learn"
    assert pyrun._missing("some_pkg")["message"].startswith("Module 'some_pkg' is not installed. Run: pip install some_pkg")


def test_no_figure_and_empty_source():
    body = run("x = 1\n")
    assert body["status"] == "no_figure" and body["figuresFound"] == 0 and body["missingModule"] is None
    body = run("   \n")
    assert body["status"] == "invalid" and body["diagnostics"][0]["code"] == "source_empty"


# ------------------------------------------------------------- size and figures
SCRIPT_6X4 = "import matplotlib.pyplot as plt\nfig, ax = plt.subplots(figsize=(6, 4))\nax.plot([1, 2, 3])\n"


def test_size_override_resizes_the_captured_figure():
    assert (run(SCRIPT_6X4)["widthPx"], run(SCRIPT_6X4)["heightPx"]) == (600, 400)
    body = run(SCRIPT_6X4, sizeIn=[3, 2])
    assert body["ok"] and (body["widthPx"], body["heightPx"]) == (300, 200)
    assert "set_size_inches" not in body["source"]                  # the script text is untouched


def test_size_override_is_validated_and_limits_pixels():
    for bad in ([3], [0.1, 2], [3, 31], ["a", 2], "3x2", [True, 2]):
        assert client.post(URL, json={"source": SCRIPT_6X4, "sizeIn": bad}).status_code == 400
    body = run(SCRIPT_6X4, dpi=1200, purpose="final", sizeIn=[30, 30])       # 36000 px
    assert body["status"] == "invalid" and body["diagnostics"][0]["code"] == "size_limit"


def test_two_figures_warning():
    src = ("import matplotlib.pyplot as plt\nplt.figure(); plt.plot([1, 2])\nplt.figure(); plt.plot([3, 1])\n")
    body = run(src)
    assert body["ok"] and body["figuresFound"] == 2
    assert body["warnings"] == ["2 figures created; showing figure #1"]
    assert any(d["code"] == "runner_warning" and "showing figure #1" in d["message"] for d in body["diagnostics"])


def test_transparent_background_and_savefig_not_required():
    body = run(SCRIPT_6X4 + "plt.show()\n", background="transparent")
    assert body["ok"]
    b = base64.b64decode(body["preview"].split(",", 1)[1])
    assert Image.open(io.BytesIO(b)).convert("RGBA").getpixel((0, 0))[3] == 0


# ----------------------------------------------------------- cache, purpose, 4xx
def test_cache_by_hash_and_purpose_dpi_cap():
    first = run(SCRIPT_6X4)
    again = run(SCRIPT_6X4)
    assert first["cached"] is False and again["cached"] is True and again["hash"] == first["hash"]
    assert again["figuresFound"] == 1 and again["warnings"] == []
    assert run(SCRIPT_6X4, sizeIn=[3, 2])["cached"] is False       # size is part of the key
    assert run(SCRIPT_6X4 + "# changed\n")["hash"] != first["hash"]
    big = run(SCRIPT_6X4, dpi=600, purpose="preview")
    assert big["dpi"] == 150 and big["widthPx"] == 900
    assert run(SCRIPT_6X4, dpi=200, purpose="final")["widthPx"] == 1200


def test_malformed_requests():
    for body in ({}, {"source": 3}, {"source": "x", "dpi": 10}, {"source": "x", "dpi": 100.5}, {"source": "x", "purpose": "z"},
                 {"source": "x", "background": "red"}, {"source": "x", "jobId": "bad id!"}, []):
        assert client.post(URL, json=body).status_code == 400, body
    assert client.post(URL, content="{", headers={"content-type": "application/json"}).status_code == 400
    assert client.post(URL, content="x", headers={"content-type": "text/plain"}).status_code == 415


def test_cancel_uses_the_render_job_infrastructure():
    out = []
    src = "import time\nimport matplotlib.pyplot as plt\nplt.plot([1])\ntime.sleep(60)\n"
    t = threading.Thread(target=lambda: out.append(client.post(URL, json={"source": src, "jobId": "py-slow"}).json()))
    t.start()
    end = time.time() + 20
    while time.time() < end and not (jobs.get("py-slow") and jobs.get("py-slow").state == "running"):
        time.sleep(0.05)
    time.sleep(0.5)
    assert client.post("/api/figures/jobs/py-slow/cancel").json()["status"] == "cancelling"
    t.join(15)
    assert not t.is_alive() and out[0]["status"] == "cancelled" and out[0]["jobId"] == "py-slow"
    assert out[0]["figuresFound"] == 0 and render_core.cache_size() == 0
