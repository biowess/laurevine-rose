"""Visual regression fixtures generator for Scientific Figure Studio.

Generates reference perceptual fingerprints (downscaled grayscale arrays) for the 6 structured plot types.
Can be run directly:
    python -m tests.fixtures.figures.regenerate_fixtures
or
    python tests/fixtures/figures/regenerate_fixtures.py
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
from pathlib import Path
from typing import Any, Dict, List, Tuple

import numpy as np
from PIL import Image

from backend.figures import jobs, render as render_core, samples
from backend.figures.models import default_record

FIXTURES_DIR = Path(__file__).resolve().parent
FINGERPRINTS_FILE = FIXTURES_DIR / "reference_fingerprints.json"
FINGERPRINT_SIZE: Tuple[int, int] = (24, 24)


def compute_fingerprint(img: Image.Image, size: Tuple[int, int] = FINGERPRINT_SIZE) -> List[int]:
    """Compute downscaled grayscale perceptual fingerprint array (0-255 values)."""
    gray = img.convert("L").resize(size, Image.Resampling.BILINEAR)
    arr = np.asarray(gray, dtype=np.uint8)
    return arr.flatten().tolist()


def fingerprint_hash(values: List[int]) -> str:
    """Hex digest of the raw fingerprint bytes for fast exact checks."""
    return hashlib.sha256(bytes(values)).hexdigest()[:16]


def compare_fingerprints(actual: List[int], expected: List[int]) -> Dict[str, float]:
    """Compare two fingerprints and return difference metrics."""
    act_arr = np.array(actual, dtype=np.float64)
    exp_arr = np.array(expected, dtype=np.float64)
    diff = np.abs(act_arr - exp_arr)
    return {
        "max_diff": float(np.max(diff)),
        "mean_diff": float(np.mean(diff)),
        "rmse": float(np.sqrt(np.mean(diff ** 2))),
    }


def make_sample_record(plot_type: str, w: float = 4.0, h: float = 3.0, dpi: int = 100) -> Dict[str, Any]:
    """Build a valid FigureRecord dict from default_record + sample_for."""
    s = samples.sample_for(plot_type)
    if s is None:
        raise ValueError(f"Unknown plot type: {plot_type}")
    rec = default_record("structured", plot_type).model_dump()
    rec["dataset"] = s["dataset"]
    rec["config"]["mapping"].update(s["mapping"])
    rec["config"]["options"].update(s["options"])
    rec["export"].update(wIn=w, hIn=h, dpi=dpi)
    return rec


def generate_fixtures() -> Dict[str, Any]:
    """Render all 6 plot types and compute reference fingerprints."""
    fixtures: Dict[str, Any] = {
        "version": 1,
        "grid_size": list(FINGERPRINT_SIZE),
        "plots": {},
    }
    for pt in samples.PLOT_TYPES:
        rec = make_sample_record(pt)
        job = jobs.create()
        res = render_core.render_job(job, rec, purpose="preview", dpi=100)
        if not res.get("ok"):
            raise RuntimeError(f"Failed to render preview for {pt}: {res.get('diagnostics')}")
        img_bytes = base64.b64decode(res["preview"].split(",", 1)[1])
        img = Image.open(io.BytesIO(img_bytes))
        fp = compute_fingerprint(img)
        fixtures["plots"][pt] = {
            "plotType": pt,
            "dimensions": [img.width, img.height],
            "hash": fingerprint_hash(fp),
            "mean_brightness": round(float(np.mean(fp)), 2),
            "fingerprint": fp,
        }
    return fixtures


def save_fixtures(fixtures: Dict[str, Any], filepath: Path = FINGERPRINTS_FILE) -> None:
    filepath.parent.mkdir(parents=True, exist_ok=True)
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(fixtures, f, indent=2)


def load_fixtures(filepath: Path = FINGERPRINTS_FILE) -> Dict[str, Any]:
    if not filepath.exists():
        raise FileNotFoundError(f"Reference fingerprints fixture not found at {filepath}. Run regenerate_fixtures.py.")
    with open(filepath, "r", encoding="utf-8") as f:
        return json.load(f)


if __name__ == "__main__":
    print(f"Generating reference fingerprints for {samples.PLOT_TYPES}...")
    data = generate_fixtures()
    save_fixtures(data)
    print(f"Saved {len(data['plots'])} reference fingerprints to {FINGERPRINTS_FILE}")
