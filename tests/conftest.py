"""Test clients behave like the app's own page: loopback Host and the session token (applied at import time, because
several test modules build their client at module level). tests/test_figures_security.py removes the token to test refusals."""
import pytest
from starlette.testclient import TestClient

from backend import security

_init = TestClient.__init__


def _local_init(self, app, *args, **kw):
    kw.setdefault("base_url", "http://127.0.0.1")
    _init(self, app, *args, **kw)
    self.headers.setdefault("X-RPE-Token", security.SESSION_TOKEN)


TestClient.__init__ = _local_init


@pytest.fixture(autouse=True)
def _fresh_rate_limit():
    security.reset_rate_limit()


def pytest_configure(config):
    config.addinivalue_line("markers", "slow: marks tests as slow (deselect with '-m \"not slow\"')")
