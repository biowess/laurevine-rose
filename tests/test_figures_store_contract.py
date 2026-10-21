"""The client store (js/figures/store.js) must create records the backend accepts and that equal
backend.figures.models.default_record, so the two defaults never drift (contract section 4k)."""
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from backend.figures.models import FigureRecord, PLOT_TYPES, default_record

ROOT = Path(__file__).resolve().parent.parent
pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")

SCRIPT = """
global.window = global;
window.RPE = {};
require(process.argv[1] + '/js/figures/store.js');
const F = window.RPE.figures, out = [];
for (const kind of ['structured', 'python', 'latex', 'composite'])
  for (const plot of %s) out.push({ kind, plot, rec: F.blank(kind, plot) });
console.log(JSON.stringify(out));
""" % json.dumps(list(PLOT_TYPES))


@pytest.fixture(scope="module")
def blanks():
    run = subprocess.run(["node", "-e", SCRIPT, str(ROOT)], capture_output=True, text=True, timeout=30)
    assert run.returncode == 0, run.stderr
    return json.loads(run.stdout)


def test_blank_records_validate(blanks):
    assert len(blanks) == 4 * len(PLOT_TYPES)
    for item in blanks:
        FigureRecord(**item["rec"])          # strict model: unknown keys / bad enums raise


def test_blank_records_equal_backend_defaults(blanks):
    for item in blanks:
        mine = FigureRecord(**item["rec"]).model_dump(mode="json")
        theirs = default_record(item["kind"], item["plot"], id=mine["id"]).model_dump(mode="json")
        assert mine == theirs, (item["kind"], item["plot"])
