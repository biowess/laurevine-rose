"""Tests for backend.soffice (LibreOffice discovery). Uses fake executables; POSIX shell scripts, so skipped on Windows."""
import os
import stat
import sys

import pytest

from backend import soffice

pytestmark = pytest.mark.skipif(sys.platform == "win32", reason="fake executables are shell scripts")


def _fake(path, version_line="LibreOffice 7.6.4.1 60(Build:1)", exit_code=0, mode=0o755):
    path.write_text(f"#!/bin/sh\necho '{version_line}'\nexit {exit_code}\n")
    path.chmod(mode)
    return str(path)


@pytest.fixture
def isolated(tmp_path, monkeypatch):
    """No env override, empty PATH dir, no platform defaults, user data in tmp: only what a test adds is visible."""
    bindir = tmp_path / "bin"
    bindir.mkdir()
    monkeypatch.delenv(soffice.ENV_VAR, raising=False)
    monkeypatch.setenv("PATH", str(bindir))
    monkeypatch.setenv(soffice.USER_DATA_ENV, str(tmp_path / "userdata"))
    monkeypatch.setattr(soffice, "_platform_defaults", lambda: [])
    return bindir


def test_found_on_path(isolated):
    exe = _fake(isolated / "soffice")
    assert soffice.find_soffice() == exe
    det = soffice.detect()
    assert det["status"] == "found" and det["source"] == "path"
    assert det["path"] == exe and det["version"] == "7.6.4.1" and det["reason"] is None


def test_missing(isolated):
    assert soffice.find_soffice() is None
    det = soffice.detect()
    assert det["status"] == "missing" and det["path"] is None and det["version"] is None


def test_too_old(isolated):
    _fake(isolated / "soffice", version_line="LibreOffice 4.2.8.2 420m0(Build:2)")
    det = soffice.detect()
    assert det["status"] == "incompatible"
    assert det["version"] == "4.2.8.2" and "older" in det["reason"]


def test_non_executable(isolated, tmp_path):
    exe = _fake(tmp_path / "soffice-noexec", mode=0o644)
    assert soffice.probe(exe)["compatible"] is False
    assert "not executable" in soffice.probe(exe)["reason"]
    os.environ[soffice.ENV_VAR] = exe
    try:
        assert soffice.find_soffice() is None  # skipped, nothing else available
    finally:
        del os.environ[soffice.ENV_VAR]


def test_env_override_wins_over_path(isolated, tmp_path, monkeypatch):
    _fake(isolated / "soffice", version_line="LibreOffice 7.0.0.0 00(Build:1)")
    custom = _fake(tmp_path / "custom-soffice", version_line="LibreOffice 24.2.1.2 420(Build:2)")
    monkeypatch.setenv(soffice.ENV_VAR, custom)
    det = soffice.detect()
    assert det["source"] == "env" and det["path"] == custom and det["version"] == "24.2.1.2"


def test_managed_copy_beats_path(isolated, tmp_path):
    managed_dir = tmp_path / "userdata" / "components" / "libreoffice" / "program"
    managed_dir.mkdir(parents=True)
    managed = _fake(managed_dir / "soffice")
    _fake(isolated / "soffice")
    if sys.platform == "darwin":
        pytest.skip("managed layout differs on macOS")
    assert soffice.locate() == ("managed", managed)


def test_version_command_failure_is_incompatible(isolated):
    _fake(isolated / "soffice", exit_code=3)
    det = soffice.detect()
    assert det["status"] == "incompatible" and "exit code 3" in det["reason"]


def test_parse_version():
    assert soffice.parse_version("LibreOffice 7.6.4.1 60(Build:1)") == (7, 6, 4, 1)
    assert soffice.parse_version("LibreOffice 24.2.1") == (24, 2, 1)
    assert soffice.parse_version("garbage") is None


def test_path_to_uri_posix(tmp_path):
    assert soffice.path_to_uri(str(tmp_path / "a b")).startswith("file:///")
    assert "%20" in soffice.path_to_uri(str(tmp_path / "a b"))


def test_missing_error_carries_code():
    err = soffice.PdfConverterMissing()
    assert isinstance(err, RuntimeError) and err.code == "PDF_CONVERTER_MISSING"
    assert str(err) == "LibreOffice is required on the server for PDF conversion but was not found."


def test_state_file_discovery_and_reread(isolated, tmp_path, monkeypatch):
    import json
    state_file = tmp_path / "setup-state.json"
    monkeypatch.setenv(soffice.STATE_FILE_ENV, str(state_file))

    # Initially missing
    assert soffice.find_soffice() is None

    # Wizard installs converter: writes to setup-state.json
    custom_dir = tmp_path / "managed_custom"
    custom_dir.mkdir()
    exe = _fake(custom_dir / "soffice", version_line="LibreOffice 26.2.6.0 (Build:1)")
    state_file.write_text(json.dumps({
        "components": {
            "libreoffice": {
                "status": "installed",
                "source": "managed",
                "path": exe,
                "version": "26.2.6.0"
            }
        }
    }))

    # Re-read on export finds the newly installed converter without backend restart
    assert soffice.find_soffice() == exe
    det = soffice.detect()
    assert det["status"] == "found" and det["source"] == "managed"
    assert det["path"] == exe

    # Wizard removes converter: updates setup-state.json to missing
    state_file.write_text(json.dumps({
        "components": {
            "libreoffice": {
                "status": "missing",
                "source": None,
                "path": None
            }
        }
    }))
    assert soffice.find_soffice() is None

