"""Wiring checks for the Python Plot window (docs/FIGURES_CONTRACT.md s4r): module loaded, command wired, client paths match the router."""
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
read = lambda p: (ROOT / p).read_text(encoding="utf-8")


def test_module_loaded_after_its_dependencies():
    html = read("index.html")
    order = [html.index(f'js/figures/{n}.js"') for n in ("exportpanel", "codeeditor", "pysource", "pyfigure")]
    assert order == sorted(order)


def test_command_opens_window_and_contract_documents_it():
    assert "RPE.figures.pyfigure.open()" in read("js/commands.js")
    doc = read("docs/FIGURES_CONTRACT.md")
    assert "### 4r. Python Plot window" in doc and "figures.python.run" in doc


def test_client_paths_match_router_routes():
    js, router = read("js/backend.js"), read("backend/figures/router.py")
    for path in ("/api/figures/python/run", "/api/figures/python/templates"):
        assert path in js and path.replace("/api/figures", "") in router
    assert "/api/figures/jobs/" in js and '"/jobs/{job_id}/cancel"' in router
    assert re.search(r"'figures\.python\.run': \d+", js)


def test_no_placeholder_text_in_window():
    src = read("js/figures/pyfigure.js").lower()
    assert not any(w in src for w in ("coming soon", "todo", "pending", "placeholder"))


# ------------------------------------------------ reopen / save-open round trip (s4r)
def test_reopen_routing_and_apply_wired():
    cmds, py = read("js/commands.js"), read("js/figures/pyfigure.js")
    assert "pyfigure.open({ obj: o })" in cmds and "pyfigure.open({ obj: p })" in cmds      # plot.edit (ribbon + double-click) and fig.pythonSource
    assert "plot.edit" in read("js/canvas.js") and "pyw__alt" in read("css/components.css")
    assert "F.objectsOf(doc, rec0.id)" in py and "'Edit Python plot'" in py and "pywalt" in py


def _python_doc():
    """(document dict, record dict): a v2 deck with one python figure + plot object and one plain image."""
    import json

    from backend.figures.models import default_record
    from backend.models import upgrade_document
    from backend.sample_deck import create_representative_deck
    from tests.test_figures_models import PNG_1X1

    rec = default_record("python", id="fig_py")
    rec.source = "import matplotlib.pyplot as plt\nplt.figure(figsize=(3, 2))\nplt.plot([1, 2])\nprint('RAN')\n"
    data = json.loads(upgrade_document(create_representative_deck()).model_dump_json())
    data["figures"] = {"fig_py": json.loads(rec.model_dump_json())}
    data["figures"]["fig_py"]["render"].update({"status": "ok", "hash": "h", "runtime": {"dpi": 150, "widthPx": 450, "heightPx": 300}})
    data["slides"][0]["objects"] += [
        {"id": "o_py", "type": "plot", "figureId": "fig_py", "src": PNG_1X1, "aspect": 1.5, "x": 10, "y": 10, "w": 300, "h": 200, "alt": "A line.", "name": "Fig"},
        {"id": "o_img", "type": "image", "src": PNG_1X1, "x": 0, "y": 0, "w": 50, "h": 50},
    ]
    return data, rec


def test_save_open_keeps_python_source_and_runs_nothing(monkeypatch):
    import json

    from fastapi.testclient import TestClient

    from backend.figures import pyrun, render, runner
    from backend.models import PresentationDoc
    from backend.server import app

    calls = []
    for mod in (runner, render, pyrun):
        monkeypatch.setattr(mod, "run_python", lambda *a, **k: calls.append(1), raising=False)
    data, rec = _python_doc()
    client = TestClient(app)
    assert client.post("/api/presentation/save", json={"doc": data}).status_code == 200
    again = PresentationDoc.model_validate(json.loads(json.dumps(data)))               # what "open" does with the saved file
    assert again.figures["fig_py"].source == rec.source and again.figures["fig_py"].kind == "python"
    assert again.figures["fig_py"].render.runtime["widthPx"] == 450
    assert client.post("/api/presentation/export", json={"format": "pptx", "doc": data}).status_code == 200
    assert calls == [], "save, open and export never execute a script"


def test_image_without_figure_id_stays_plain_image():
    import json

    from backend.models import PresentationDoc

    data, _ = _python_doc()
    again = PresentationDoc.model_validate(json.loads(json.dumps(data)))
    img = next(o for s in again.slides for o in s.objects if o.id == "o_img")
    assert img.type == "image" and "figureId" not in (img.model_extra or {})
    assert set(again.figures) == {"fig_py"}, "no record is invented for a plain image"
