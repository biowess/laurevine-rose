"""Tests for run.py port picking, self-check, --open flag, and versioning."""
import os
import socket
import subprocess
import sys
import run
from unittest.mock import MagicMock, patch


def test_is_loopback():
    assert run.is_loopback("127.0.0.1") is True
    assert run.is_loopback("localhost") is True
    assert run.is_loopback("::1") is True
    assert run.is_loopback("[::1]") is True
    assert run.is_loopback("0.0.0.0") is False
    assert run.is_loopback("192.168.1.1") is False


def test_find_free_port_picks_next_when_busy():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        s.bind(("127.0.0.1", 8991))
        # Port 8991 is now in use
        assert run.is_port_in_use("127.0.0.1", 8991) is True
        free = run.find_free_port("127.0.0.1", starting_port=8991)
        assert free != 8991
        assert free >= 8992


def test_find_free_port_returns_requested_when_available():
    # Find a port not in use
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        target_port = s.getsockname()[1]
    # socket is closed, so target_port should be free
    free = run.find_free_port("127.0.0.1", starting_port=target_port)
    assert free == target_port


def test_startup_self_check_runs_without_crashing():
    run.startup_self_check()


def test_open_browser_thread():
    opened = []
    with patch("webbrowser.open", lambda url: opened.append(url)):
        with patch("urllib.request.urlopen") as mock_open:
            mock_resp = MagicMock()
            mock_resp.status = 200
            mock_resp.__enter__.return_value = mock_resp
            mock_open.return_value = mock_resp
            run._open_browser_thread("http://127.0.0.1:8000", "http://127.0.0.1:8000/api/health")
    assert len(opened) == 1
    assert opened[0] == "http://127.0.0.1:8000"


def test_selfcheck_json_prints_report_and_exit_code(capsys):
    import json
    ok = {"dependencies": {"fastapi": {"required": True, "found": True}}}
    bad = {"dependencies": {"scipy": {"required": True, "found": False}}}
    with patch("backend.figures.selfcheck.run_selfcheck", return_value=(ok, [])):
        assert run.selfcheck_json() == 0
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1]) == ok
    with patch("backend.figures.selfcheck.run_selfcheck", return_value=(bad, [])):
        assert run.selfcheck_json() == 1


def test_run_as_interpreter_only_when_frozen(monkeypatch):
    monkeypatch.setattr(sys, "argv", ["run", "-I", "-c", "pass"])
    assert run.run_as_interpreter() is False                      # not frozen: normal startup
    monkeypatch.setattr(sys, "frozen", True, raising=False)
    assert run.run_as_interpreter() is True                       # frozen: emulates `python -I -c ...`
    monkeypatch.setattr(sys, "argv", ["run", "--port", "8000"])
    assert run.run_as_interpreter() is False                      # normal server arguments
