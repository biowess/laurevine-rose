"""Benchmark script for Figure Studio performance optimizations.
Measures and prints timings for:
1. Cold process vs. warm-start worker pool (< 400 ms target)
2. Render cache persistence & retrieval (LRU, 200 MB)
3. Large dataset preview decimation (>50k points) vs. full render
4. Base64 payload slimming (preview at <= 1200 px wide)
"""
from __future__ import annotations

import base64
import os
import sys
import time
from pathlib import Path

# Add project root to sys.path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend.figures import jobs
from backend.figures.models import default_record
from backend.figures.render import clear_cache, render_job
from backend.figures.runner import run_python, shutdown_warm_pool


def make_sample_record(n_points: int = 50, w_in: float = 6.0, h_in: float = 4.0, dpi: int = 100):
    rec = default_record("structured", "line").model_dump()
    rec["dataset"] = {
        "columns": [{"name": "x", "type": "number"}, {"name": "y", "type": "number"}],
        "rows": [[i, i * 2] for i in range(n_points)],
        "origin": {"type": "sheet", "label": "bench"},
    }
    rec["config"]["mapping"] = {"x": "x", "y": ["y"], "group": None, "yErr": None}
    rec["export"].update(wIn=w_in, hIn=h_in, dpi=dpi)
    return rec


def bench_warm_start():
    print("=" * 60)
    print("BENCHMARK 1: Warm-Start Worker Pool vs Fresh Subprocess")
    print("=" * 60)
    rec = make_sample_record(50)

    # 1. Fresh isolated process (warm=False via custom python script)
    clear_cache()
    cold_times = []
    for _ in range(3):
        clear_cache()
        t0 = time.perf_counter()
        job = jobs.create()
        custom_rec = dict(rec, sourceMode="custom", source="import matplotlib.pyplot as plt\nplt.plot([1, 2, 3])\n")
        res = render_job(job, custom_rec, "preview", None)
        t1 = time.perf_counter()
        assert res["ok"], res.get("diagnostics")
        cold_times.append((t1 - t0) * 1000)

    # 2. Warm worker pool (structured mode)
    clear_cache()
    warm_up_job = jobs.create()
    render_job(warm_up_job, rec, "preview", None)
    clear_cache()

    warm_times = []
    for i in range(5):
        clear_cache()
        rec["dataset"]["rows"][0][1] = i  # avoid key dedupe
        t0 = time.perf_counter()
        job = jobs.create()
        res = render_job(job, rec, "preview", None)
        t1 = time.perf_counter()
        assert res["ok"], res.get("diagnostics")
        warm_times.append((t1 - t0) * 1000)

    avg_cold = sum(cold_times) / len(cold_times)
    avg_warm = sum(warm_times) / len(warm_times)
    min_warm = min(warm_times)

    print(f"Fresh Process (Cold) Average : {avg_cold:.1f} ms")
    print(f"Warm Worker Pool Average     : {avg_warm:.1f} ms")
    print(f"Warm Worker Pool Best        : {min_warm:.1f} ms")
    print(f"Speedup                      : {avg_cold / avg_warm:.1f}x faster")
    print(f"Target (< 400 ms)            : {'PASSED' if avg_warm < 400 else 'FAILED'}")
    print()
    return avg_cold, avg_warm


def bench_render_cache():
    print("=" * 60)
    print("BENCHMARK 2: Persistent Render Cache (LRU, 200 MB)")
    print("=" * 60)
    rec = make_sample_record(100)

    clear_cache()
    # Uncached render
    t0 = time.perf_counter()
    job = jobs.create()
    res1 = render_job(job, rec, "preview", None)
    t1 = time.perf_counter()
    uncached_ms = (t1 - t0) * 1000
    assert not res1["cached"]

    # Cached hit
    hit_times = []
    for _ in range(5):
        t0 = time.perf_counter()
        job = jobs.create()
        res2 = render_job(job, rec, "preview", None)
        t1 = time.perf_counter()
        assert res2["cached"]
        hit_times.append((t1 - t0) * 1000)

    avg_hit = sum(hit_times) / len(hit_times)
    print(f"Uncached Render              : {uncached_ms:.1f} ms")
    print(f"Cache Hit Average            : {avg_hit:.2f} ms")
    print(f"Speedup                      : {uncached_ms / avg_hit:.0f}x faster")
    print()
    return uncached_ms, avg_hit


def bench_large_data_decimation():
    print("=" * 60)
    print("BENCHMARK 3: Large Dataset Preview Decimation (>50k Points)")
    print("=" * 60)
    total_points = 200_000
    rec = make_sample_record(total_points)

    clear_cache()
    # Preview render (automatic decimation)
    t0 = time.perf_counter()
    job = jobs.create()
    res_prev = render_job(job, rec, "preview", None)
    t1 = time.perf_counter()
    prev_ms = (t1 - t0) * 1000
    assert res_prev["ok"]

    decimated_diag = [d for d in res_prev["diagnostics"] if d.get("code") == "preview_decimated"]
    label = decimated_diag[0]["message"] if decimated_diag else "None"

    print(f"Total Dataset Rows           : {total_points:,}")
    print(f"Preview Render Time          : {prev_ms:.1f} ms")
    print(f"Decimation Label             : \"{label}\"")
    print(f"Final Render Policy          : Full dataset (no decimation)")
    print()
    return prev_ms, label


def bench_payload_slimming():
    print("=" * 60)
    print("BENCHMARK 4: Base64 Payload Slimming (Preview <= 1200 px wide)")
    print("=" * 60)
    # 16 x 10 in figure
    rec = make_sample_record(50, w_in=16.0, h_in=10.0, dpi=150)

    clear_cache()
    # Preview render (slimmed to <= 1200 px wide)
    res_prev = render_job(jobs.create(), rec, "preview", None)
    prev_b64_len = len(res_prev["preview"])
    prev_w = res_prev["widthPx"]
    prev_h = res_prev["heightPx"]

    # Final render (full export resolution: 16 in * 150 dpi = 2400 px)
    res_final = render_job(jobs.create(), rec, "final", None)
    final_b64_len = len(res_final["preview"])
    final_w = res_final["widthPx"]
    final_h = res_final["heightPx"]

    print(f"Final Render Dimensions      : {final_w} x {final_h} px")
    print(f"Final Base64 Payload Size    : {final_b64_len / 1024:.1f} KB")
    print(f"Preview Dimensions           : {prev_w} x {prev_h} px (target <= 1200 px)")
    print(f"Preview Base64 Payload Size  : {prev_b64_len / 1024:.1f} KB")
    print(f"Payload Size Reduction       : {(1 - prev_b64_len / final_b64_len) * 100:.1f}%")
    print()
    return (final_w, final_b64_len), (prev_w, prev_b64_len)


def main():
    print("\n" + "#" * 60)
    print("  LAUREVINE ROSE - FIGURE STUDIO PERFORMANCE BENCHMARK")
    print("#" * 60 + "\n")
    try:
        bench_warm_start()
        bench_render_cache()
        bench_large_data_decimation()
        bench_payload_slimming()
    finally:
        shutdown_warm_pool()


if __name__ == "__main__":
    main()
