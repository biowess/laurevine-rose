"""Wiring checks for the Scientific Figures ribbon (docs/FIGURES_CONTRACT.md s4w). Behaviour is covered by test 29 in tests/test_js_checks.js."""
import re
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
read = lambda p: (ROOT / p).read_text(encoding="utf-8")


def test_contract_documents_the_ribbon():
    doc = read("docs/FIGURES_CONTRACT.md")
    assert "### 4w. Ribbon entry points" in doc and "LaTeX / PGFPlots" in doc and "`reason(args)`" in doc


def test_no_legacy_or_unsupported_ribbon_entries():
    cfg = read("js/ribbon-config.js")
    for bad in ("fig.statistical", "'Python Plot'", "'SVG'", "'EPS'", "TikZ", "format: 'svg'", "Scientific Objects"):
        assert bad not in cfg, bad
    assert len(re.findall(r"sciFigures\(\)", cfg)) == 2  # Insert and Figures


def test_ribbon_figure_commands_are_registered():
    cfg, cmds = read("js/ribbon-config.js"), read("js/commands.js")
    registered = set(re.findall(r"register\('([a-z]+\.[A-Za-z]+)'", cmds))
    need = {"fig.create", "insert.figure", "insert.pythonPlot", "insert.pgfplots", "fig.export", "plot.edit", "plot.changeType"}
    assert need <= registered and all(f"'{c}'" in cfg for c in need) and "fig.statistical" not in registered


def test_ribbon_explains_disabled_commands():
    rib, css = read("js/ribbon.js"), read("css/styles.css")
    assert "C2.reason(" in rib and "aria-disabled" in rib and "backend:status" in rib and "data-gate" in rib.replace("dataset.gate", "data-gate")
    assert ".rbtn.is-disabled" in css


def test_js_ribbon_test_runs():
    node = shutil.which("node")
    if not node:
        return
    out = subprocess.run([node, "tests/test_js_checks.js"], cwd=ROOT, capture_output=True, text=True, timeout=300).stdout
    assert "PASS: 29. Scientific Figures ribbon" in out
