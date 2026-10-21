"""Export tab (js/figures/exportpanel.js): the client's pixel math must use the backend's limits, and the module must be loaded."""
import re
from pathlib import Path

from backend.figures import export as ex
from backend.figures.codegen import common

ROOT = Path(__file__).resolve().parent.parent
JS = (ROOT / "js" / "figures" / "exportpanel.js").read_text(encoding="utf-8")


def _const(name):
    m = re.search(r"\b%s = (\d+(?:\.\d+)?)" % name, JS)
    assert m, name
    return float(m.group(1))


def test_js_limits_match_backend():
    assert _const("MAX_SIDE") == ex.MAX_PX_SIDE
    assert _const("MAX_MP") == ex.MAX_MEGAPIXELS
    assert _const("LARGE_MP") == ex.LARGE_MP
    assert _const("INLINE_ROWS") == common.INLINE_LIMIT
    assert (_const("MIN_DPI"), _const("MAX_DPI")) == (72, 1200)


def test_js_warning_wording_matches_backend():
    side, mp, big = (ex.pixels(*a)["warning"] for a in [(30, 4, 600), (30, 30, 400), (20, 13, 450)])
    assert side.endswith("per-side limit; export is refused. Lower the DPI or the size.")
    assert mp.endswith("MP limit; export is refused. Lower the DPI or the size.")
    assert big.endswith("makes a very large file that can take a while to render.")
    for tail in ("px per-side limit; export is refused. Lower the DPI or the size.", "MP limit; export is refused. Lower the DPI or the size.",
                 "makes a very large file that can take a while to render."):
        assert tail in JS


def test_module_is_loaded_and_registers_the_export_tab():
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    assert html.index("js/figures/exportpanel.js") < html.index("js/dialogs.js")
    assert "F.tabs.export" in JS and "pending" not in JS.lower() and "coming soon" not in JS.lower()
