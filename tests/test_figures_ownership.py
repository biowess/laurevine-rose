"""Source ownership on the backend (docs/FIGURES_CONTRACT.md s6 / s4o): custom source runs verbatim, structured ignores a stale source."""
import copy

from backend.figures.codegen import emit_script
from tests.test_figures_render import post, structured

MARK = "import matplotlib.pyplot as plt\nplt.figure(figsize=(2, 1))\nplt.plot([1, 2])\nprint('custom-ran')\nplt.show()\n"
STALE = "raise RuntimeError('stale source must not run')\n"


def _custom_of(rec, source):
    out = copy.deepcopy(rec)
    out["sourceMode"], out["source"] = "custom", source
    return out


def test_custom_source_is_used_verbatim_and_settings_do_not_govern():
    rec = _custom_of(structured("line"), MARK)
    body = post(rec, dpi=100)
    assert body["ok"] and body["source"] == MARK and "custom-ran" in body["stdout"]
    assert (body["widthPx"], body["heightPx"]) == (200, 100)          # the script's 2 x 1 in, not export.wIn|hIn (3 x 2)
    other = copy.deepcopy(rec)
    other["config"]["appearance"]["title"] = "ignored"; other["export"].update(wIn=9, hIn=9)
    again = post(other, dpi=100)
    assert again["source"] == MARK and again["hash"] == body["hash"]  # settings neither change the script nor the cache key


def test_custom_edit_changes_result_hash_but_structured_config_is_kept():
    rec = _custom_of(structured("scatter"), MARK)
    kept = copy.deepcopy(rec["config"]), copy.deepcopy(rec["dataset"])
    edited = _custom_of(rec, MARK + "# edited\n")
    assert post(edited, dpi=100)["hash"] != post(rec, dpi=100)["hash"]
    assert (rec["config"], rec["dataset"]) == kept


def test_structured_ignores_a_stale_source():
    rec = structured("line")
    clean = post(rec, dpi=100)
    stale = copy.deepcopy(rec); stale["source"] = STALE               # leftover from an earlier custom session
    body = post(stale, dpi=100)
    assert clean["ok"] and body["ok"], body["diagnostics"]
    assert body["source"] == clean["source"] and "stale source" not in body["source"]
    assert body["hash"] == clean["hash"]


def test_returning_to_structured_regenerates_from_settings():
    rec = structured("bar")
    generated = emit_script(rec).source
    custom_rec = _custom_of(rec, MARK)
    assert post(custom_rec, dpi=100)["source"] == MARK
    back = copy.deepcopy(custom_rec); back["sourceMode"], back["source"] = "structured", ""
    body = post(back, dpi=100)
    assert body["ok"] and body["source"] == generated and "custom-ran" not in body["stdout"]


def test_custom_empty_source_is_refused_not_regenerated():
    body = post(_custom_of(structured("line"), "  \n"))
    assert body["status"] == "invalid" and any(d["code"] == "source_empty" for d in body["diagnostics"])
