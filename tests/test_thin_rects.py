import pytest
from playwright.sync_api import sync_playwright

PT_TO_PX = 4.0 / 3.0  # 96 DPI / 72 pt = 4/3

REPRESENTATIVE_POINTS = [0.25, 0.5, 0.75, 1.0, 2.0]

def test_thin_rectangles_preview_rendering():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 720})
        page.goto("file:///home/flower/Projects/Laurevine_Rose_prefinal/Laurevine_Rose/index.html")
        page.wait_for_selector("#wsMain")
        page.wait_for_timeout(500)

        test_objs = []
        # Horizontal thin rectangles
        for i, pt in enumerate(REPRESENTATIVE_POINTS):
            test_objs.append({
                "id": f"hr_{pt}pt",
                "type": "shape",
                "shape": "rect",
                "x": 60,
                "y": 40 + i * 30,
                "w": 400,
                "h": pt * PT_TO_PX,
                "fill": "#171C22",
                "stroke": None,
                "strokeWidth": 0,
            })

        # Vertical thin rectangles
        for i, pt in enumerate(REPRESENTATIVE_POINTS):
            test_objs.append({
                "id": f"vr_{pt}pt",
                "type": "shape",
                "shape": "rect",
                "x": 500 + i * 40,
                "y": 40,
                "w": pt * PT_TO_PX,
                "h": 150,
                "fill": "#171C22",
                "stroke": None,
                "strokeWidth": 0,
            })

        page.evaluate(
            """(objs) => {
                const S = RPE.store;
                S.mutate('Add thin test rects', () => {
                    S.doc.slides[0].objects = objs;
                });
            }""",
            test_objs,
        )

        # Test at multiple zoom levels
        for zoom in [50, 100, 200]:
            results = page.evaluate(
                """(zoom) => {
                    const S = RPE.store;
                    S.setUI({ zoomMode: 'manual', zoom: zoom });
                    RPE.canvas.applyZoom();
                    const scale = RPE.canvas.getScale();
                    const slide = document.querySelector('.slide--edit');
                    const objs = S.activeSlide().objects;
                    return objs.map(o => {
                        const el = slide.querySelector(`[data-id="${o.id}"]`);
                        const gfx = el ? el.querySelector('.shape-gfx') : null;
                        const elBox = el ? el.getBoundingClientRect() : null;
                        const gfxBox = gfx ? gfx.getBoundingClientRect() : null;
                        return {
                            id: o.id,
                            w: o.w,
                            h: o.h,
                            el_w: elBox ? elBox.width / scale : null,
                            el_h: elBox ? elBox.height / scale : null,
                            gfx_w: gfxBox ? gfxBox.width / scale : null,
                            gfx_h: gfxBox ? gfxBox.height / scale : null,
                        };
                    });
                }""",
                zoom,
            )

            for item in results:
                target_w = item["w"]
                target_h = item["h"]
                gfx_w = item["gfx_w"]
                gfx_h = item["gfx_h"]
                el_w = item["el_w"]
                el_h = item["el_h"]

                # Check width and height match expected within subpixel precision (0.05px)
                assert abs(gfx_w - target_w) < 0.05, f"Zoom {zoom}%: {item['id']} gfx_w mismatch: {gfx_w} vs expected {target_w}"
                assert abs(gfx_h - target_h) < 0.05, f"Zoom {zoom}%: {item['id']} gfx_h mismatch: {gfx_h} vs expected {target_h}"
                assert abs(el_w - target_w) < 0.05, f"Zoom {zoom}%: {item['id']} el_w mismatch: {el_w} vs expected {target_w}"
                assert abs(el_h - target_h) < 0.05, f"Zoom {zoom}%: {item['id']} el_h mismatch: {el_h} vs expected {target_h}"

        browser.close()
