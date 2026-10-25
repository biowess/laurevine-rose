"""tests/test_window_closing.py

Audits and verifies window-closing behavior:
1. JS/Electron close events, dialog actions (save, discard, cancel), save failures,
   repeated close attempts, and reopening saved projects.
2. Backend presentation.save coordination and persistence.
"""

import subprocess
import pytest
from fastapi.testclient import TestClient
from backend.server import app
from backend.sample_deck import create_representative_deck

client = TestClient(app)


def test_window_closing_js_suite():
    """Run the comprehensive JavaScript window-closing test suite."""
    res = subprocess.run(["node", "tests/test_window_closing.js"], capture_output=True, text=True)
    assert res.returncode == 0, f"JS window-closing tests failed:\n{res.stdout}\n{res.stderr}"
    assert "All 10 window-closing test cases passed successfully!" in res.stdout


def test_backend_save_coordination_success():
    """Verify backend saves and validates documents correctly during save-on-close."""
    deck = create_representative_deck()
    deck_dict = deck.model_dump()
    deck_dict["title"] = "Persisted Before Window Close"

    response = client.post("/api/presentation/save", json={"doc": deck_dict})
    assert response.status_code == 200, f"Save failed: {response.text}"
    data = response.json()
    assert data["status"] == "ok"
    assert data["docId"] == deck.id
    assert "savedAt" in data


def test_backend_save_coordination_failure():
    """Verify backend rejects malformed documents, triggering save failure without data loss."""
    malformed_doc = {
        "id": "invalid-doc",
        "slides": "not-a-list"  # invalid schema
    }
    response = client.post("/api/presentation/save", json={"doc": malformed_doc})
    assert response.status_code in (400, 422)
