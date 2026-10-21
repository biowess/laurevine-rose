"""
Browser check (Protocol 6.3) using installed headless Chromium and Playwright.
Extended with scientific figure verification and optional Playwright skip-if-missing.
"""
from __future__ import annotations

import io
import os
import shutil
import socket
import sys
import threading
import time
from typing import Optional

import pytest

try:
    from playwright.sync_api import sync_playwright
except ImportError:
    sync_playwright = None

try:
    from pptx import Presentation
except ImportError:
    Presentation = None


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

def is_port_in_use(port: int = 8000, host: str = "127.0.0.1") -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) == 0


class ServerThread(threading.Thread):
    def __init__(self, host: str = "127.0.0.1", port: int = 8000):
        super().__init__(daemon=True)
        import uvicorn
        from backend.server import app
        config = uvicorn.Config(app, host=host, port=port, log_level="warning")
        self.server = uvicorn.Server(config)

    def run(self):
        self.server.run()

    def stop(self):
        self.server.should_exit = True


def get_chromium_executable() -> Optional[str]:
    for path in (
        "/usr/bin/chromium-browser",
        "/usr/bin/chromium",
        shutil.which("chromium-browser"),
        shutil.which("chromium"),
        shutil.which("google-chrome"),
    ):
        if path and os.path.exists(path) and os.access(path, os.X_OK):
            return path
    return None


def run_browser_check(base_url: str = "http://127.0.0.1:8000") -> bool:
    if sync_playwright is None:
        print("Playwright is not installed. Skipping browser verification.")
        return False

    chrome_exec = get_chromium_executable()
    server_thread: Optional[ServerThread] = None

    if not is_port_in_use(8000):
        print("Starting test server on http://127.0.0.1:8000...")
        server_thread = ServerThread()
        server_thread.start()
        time.sleep(1.0)

    try:
        with sync_playwright() as p:
            launch_args = {"headless": True}
            if chrome_exec:
                launch_args["executable_path"] = chrome_exec
            try:
                browser = p.chromium.launch(**launch_args)
            except Exception as exc:
                print(f"Chromium browser could not be launched ({exc}). Skipping browser check.")
                return False

            page = browser.new_page(viewport={"width": 1400, "height": 900})
            page.goto(base_url)
            page.wait_for_load_state("networkidle")

            # Verify RPE namespace loaded
            assert page.evaluate("() => typeof window.RPE !== 'undefined'"), "window.RPE not defined"
            assert page.evaluate("() => typeof window.RPE.figures !== 'undefined'"), "window.RPE.figures not defined"

            # ---------------------------------------------------------
            # 1. Clear existing objects and add an arrow
            # ---------------------------------------------------------
            page.evaluate("""() => {
                const S = window.RPE.store;
                S.mutate('Clear objects', () => {
                    S.activeSlide().objects = [];
                });
                const arrow = {
                    id: 'test_arrow', type: 'shape', shape: 'arrow',
                    x: 200, y: 150, w: 300, h: 150,
                    fill: 'accent', stroke: 'accent', strokeWidth: 4,
                    adj: 0.5
                };
                S.mutate('Add arrow', () => {
                    S.activeSlide().objects.push(arrow);
                });
                S.select(['test_arrow']);
            }""")

            time.sleep(0.5)

            # Find the yellow diamond handle in selection overlay
            handle = page.locator('.sel-layer .handle--adj')
            handle.wait_for(state="visible", timeout=5000)
            assert handle.is_visible(), "Adjust handle not visible on arrow"

            initial_box = handle.bounding_box()
            arrow_path = page.locator('.slide--edit [data-id="test_arrow"] .shape-gfx svg path')
            initial_d = arrow_path.get_attribute('d')
            print(f"Initial arrow d: {initial_d}")

            # Drag the diamond handle in 5 steps
            page.mouse.move(initial_box['x'] + initial_box['width'] / 2, initial_box['y'] + initial_box['height'] / 2)
            page.mouse.down()

            d_samples = [initial_d]
            for step in range(1, 6):
                cur_x = initial_box['x'] + initial_box['width'] / 2 - step * 15
                cur_y = initial_box['y'] + initial_box['height'] / 2
                page.mouse.move(cur_x, cur_y)
                time.sleep(0.05)
                cur_d = arrow_path.get_attribute('d')
                d_samples.append(cur_d)

            page.mouse.up()
            final_d = arrow_path.get_attribute('d')
            print(f"Final arrow d: {final_d}")

            # Verify d changed on every step
            for i in range(1, len(d_samples)):
                assert d_samples[i] != d_samples[i - 1], f"Step {i} d did not change: {d_samples[i]}"

            print("PASS: Arrow path d updated continuously on every pointermove step.")

            # Test Ctrl+Z restores previous geometry
            page.keyboard.press("Control+z")
            time.sleep(0.3)
            after_undo_d = arrow_path.get_attribute('d')
            assert after_undo_d == initial_d, f"Undo did not restore initial geometry: {after_undo_d} vs {initial_d}"
            print("PASS: Ctrl+Z restored initial geometry.")

            # Test Redo (Ctrl+y) restores modified geometry
            page.keyboard.press("Control+y")
            time.sleep(0.3)
            after_redo_d = arrow_path.get_attribute('d')
            assert after_redo_d == final_d, f"Redo did not restore final geometry: {after_redo_d} vs {final_d}"
            print("PASS: Ctrl+Y restored final geometry.")

            # ---------------------------------------------------------
            # 2. Outline thickness of a rect and polygon shape at zoom 50% and 100%
            # ---------------------------------------------------------
            page.evaluate("""() => {
                const S = window.RPE.store;
                S.mutate('Clear objects', () => {
                    S.activeSlide().objects = [];
                });
                const rect = {
                    id: 'test_rect', type: 'shape', shape: 'rect',
                    x: 100, y: 100, w: 200, h: 100,
                    fill: 'transparent', stroke: '#FF0000', strokeWidth: 10
                };
                const tri = {
                    id: 'test_tri', type: 'shape', shape: 'triangle',
                    x: 400, y: 100, w: 200, h: 100,
                    fill: 'transparent', stroke: '#FF0000', strokeWidth: 10,
                    adj: 0.5
                };
                S.mutate('Add test shapes', () => {
                    S.activeSlide().objects.push(rect, tri);
                });
                S.select([]);
            }""")

            time.sleep(0.3)

            # Check at zoom 100%
            rect_border_100 = page.evaluate("() => getComputedStyle(document.querySelector('.slide--edit [data-id=\"test_rect\"] .shape-gfx')).borderWidth")
            tri_stroke_100 = page.evaluate("() => document.querySelector('.slide--edit [data-id=\"test_tri\"] .shape-gfx svg path').getAttribute('stroke-width')")
            print(f"Zoom 100%: Rect border={rect_border_100}, Triangle stroke={tri_stroke_100}")
            assert rect_border_100 == "10px" and tri_stroke_100 == "10"

            # Change zoom to 50%
            page.evaluate("""() => {
                window.RPE.store.setUI({ zoomMode: 'manual', zoom: 50 });
                window.RPE.canvas.applyZoom();
            }""")
            time.sleep(0.2)

            # Check at zoom 50%
            rect_border_50 = page.evaluate("() => getComputedStyle(document.querySelector('.slide--edit [data-id=\"test_rect\"] .shape-gfx')).borderWidth")
            tri_stroke_50 = page.evaluate("() => document.querySelector('.slide--edit [data-id=\"test_tri\"] .shape-gfx svg path').getAttribute('stroke-width')")
            print(f"Zoom 50%: Rect border={rect_border_50}, Triangle stroke={tri_stroke_50}")
            assert rect_border_50 == "10px" and tri_stroke_50 == "10"

            # Restore zoom to 100%
            page.evaluate("""() => {
                window.RPE.store.setUI({ zoomMode: 'manual', zoom: 100 });
                window.RPE.canvas.applyZoom();
            }""")
            time.sleep(0.2)

            # ---------------------------------------------------------
            # 3. Scientific figure object rendering, selection & undo/redo
            # ---------------------------------------------------------
            # Transparent 1x1 test PNG
            test_png_data = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
            page.evaluate(f"""() => {{
                const S = window.RPE.store;
                S.mutate('Clear objects', () => {{
                    S.activeSlide().objects = [];
                }});
                const plotObj = {{
                    id: 'test_plot',
                    type: 'plot',
                    figureId: 'fig_e2e_1',
                    src: '{test_png_data}',
                    x: 150, y: 120, w: 420, h: 280,
                    name: 'E2E Browser Figure'
                }};
                S.mutate('Add test plot', () => {{
                    S.activeSlide().objects.push(plotObj);
                }});
                S.select(['test_plot']);
            }}""")
            time.sleep(0.3)

            # Verify plot element exists in slide DOM
            plot_el = page.locator('.slide--edit [data-id="test_plot"]')
            assert plot_el.is_visible(), "Plot element not visible in slide editor"
            assert page.evaluate("() => document.querySelector('.slide--edit [data-id=\"test_plot\"] .obj__plot img') !== null"), "Plot img tag not found inside obj__plot"

            # Check undo removes the figure object
            page.keyboard.press("Control+z")
            time.sleep(0.3)
            assert page.evaluate("() => document.querySelector('.slide--edit [data-id=\"test_plot\"]') === null"), "Undo failed to remove plot object"
            print("PASS: Figure undo works.")

            # Check redo restores the figure object
            page.keyboard.press("Control+y")
            time.sleep(0.3)
            assert page.evaluate("() => document.querySelector('.slide--edit [data-id=\"test_plot\"]') !== null"), "Redo failed to restore plot object"
            print("PASS: Figure redo works.")

            print("\nALL BROWSER INTERACTION CHECKS PASSED!\n")
            browser.close()
            return True
    finally:
        if server_thread is not None:
            server_thread.stop()


@pytest.mark.slow
def test_browser_check():
    """Pytest entrypoint for Playwright browser verification, with optional skip if missing."""
    if sync_playwright is None:
        pytest.skip("Playwright is not installed")
    if not get_chromium_executable():
        pytest.skip("Chromium browser executable not found")
    ok = run_browser_check()
    assert ok, "Browser checks failed"


if __name__ == "__main__":
    success = run_browser_check()
    sys.exit(0 if success else 1)
