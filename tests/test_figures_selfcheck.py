"""Tests for backend.figures.selfcheck runtime report."""
import json
import subprocess
import sys

from backend.figures.selfcheck import format_report_text, run_selfcheck, main


def test_run_selfcheck_structure():
    report, actionable = run_selfcheck()
    assert report["version"] == "1.0.0"
    assert "python" in report
    assert "dependencies" in report
    assert "runtime" in report
    assert "libreoffice" in report
    assert isinstance(actionable, list)

    text = format_report_text(report)
    assert "Laurevine Rose v1.0.0 — Runtime Self-Check" in text
    assert "Core Python Packages" in text
    assert "Presentation & PDF Export Engines" in text


def test_selfcheck_main(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["selfcheck"])
    code = main()
    assert code == 0


def test_selfcheck_cli():
    res = subprocess.run([sys.executable, "-m", "backend.figures.selfcheck"], capture_output=True, text=True)
    assert res.returncode == 0
    assert "Laurevine Rose v1.0.0" in res.stdout

    res_json = subprocess.run([sys.executable, "-m", "backend.figures.selfcheck", "--json"], capture_output=True, text=True)
    assert res_json.returncode == 0
    data = json.loads(res_json.stdout)
    assert data["version"] == "1.0.0"
    assert "dependencies" in data
