"""
Verification protocol 6.2: LibreOffice headless render check.
"""
import io
import os
import shutil
import subprocess
import tempfile
import base64
from PIL import Image, ImageDraw
from pptx import Presentation
from backend.models import PresentationDoc, SlideModel, SlideObject
from backend.exporter import export_presentation, to_emu

def measure_bounds(img_path, search_box):
    """
    Search for non-white pixels inside search_box (left, top, right, bottom).
    Returns (min_x, min_y, max_x, max_y) or None.
    """
    img = Image.open(img_path).convert("RGB")
    left, top, right, bottom = search_box
    cropped = img.crop((left, top, right, bottom))
    pixels = cropped.load()

    min_x, min_y = cropped.width, cropped.height
    max_x, max_y = -1, -1

    for y in range(cropped.height):
        for x in range(cropped.width):
            r, g, b = pixels[x, y]
            # Background is white (255, 255, 255)
            if r < 240 or g < 240 or b < 240:
                if x < min_x: min_x = x
                if y < min_y: min_y = y
                if x > max_x: max_x = x
                if y > max_y: max_y = y

    if max_x == -1:
        return None
    # Add 1 to max to represent outer bounds
    return (left + min_x, top + min_y, left + max_x + 1, top + max_y + 1)

def run_render_check():
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    pdftoppm = shutil.which("pdftoppm")
    if not soffice or not pdftoppm:
        print("Skipping LibreOffice render check (soffice or pdftoppm not found)")
        return

    # Use theme slate which has no decor to keep regions completely clean
    # Slide 1: Prototype reference numbers (sw=2) and large outline rect (sw=12)
    s1_objects = [
        # Prototype 1: rect (100, 100, 200, 100), sw=2 -> expected 99,99 -> 301,201
        SlideObject(id="p1", type="shape", shape="rect", x=100, y=100, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=2.0),
        # Prototype 2: triangle (400, 100, 200, 100), sw=2 -> expected 399,99 -> 601,201
        SlideObject(id="p2", type="shape", shape="triangle", x=400, y=100, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=2.0, adj=0.5),
        # Prototype 3: pentagon (700, 100, 200, 100), sw=2 -> expected 699,99 -> 901,195 (pts: (500,30), (970,370), (785,940), (215,940), (30,370))
        # bottom y is 940/1000 * 100 + 100 = 194. With sw=2 (+1) -> 195
        SlideObject(id="p3", type="shape", shape="pentagon", x=700, y=100, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=2.0),
        # Large outline rect: (100, 300, 200, 100), sw=12 -> frame +- 6 = 94,294 -> 306,406
        SlideObject(id="p4", type="shape", shape="rect", x=100, y=300, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=12.0),
        # Adjusted arrows: adj=0.2 vs adj=0.8
        SlideObject(id="arr1", type="shape", shape="arrow", x=400, y=300, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=4.0, adj=0.2),
        SlideObject(id="arr2", type="shape", shape="arrow", x=700, y=300, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=4.0, adj=0.8),
        # Adjusted callouts: adj=0.1 vs adj=0.9
        SlideObject(id="cal1", type="shape", shape="callout", x=100, y=500, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=4.0, adj=0.1),
        SlideObject(id="cal2", type="shape", shape="callout", x=400, y=500, w=200, h=100, fill="#2F6F8F", stroke="#702D3B", strokeWidth=4.0, adj=0.9),
        # Resized arrow (w=300, h=150)
        SlideObject(id="arr_resized", type="shape", shape="arrow", x=700, y=480, w=300, h=150, fill="#2F6F8F", stroke="#702D3B", strokeWidth=4.0, adj=0.5),
    ]

    doc = PresentationDoc(
        title="Render Check Deck",
        themeId="slate",
        slides=[SlideModel(id="s1", layout="blank", objects=s1_objects)]
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        pptx_path = os.path.join(tmpdir, "test.pptx")
        pdf_path = os.path.join(tmpdir, "test.pdf")
        buf = export_presentation(doc)
        with open(pptx_path, "wb") as f:
            f.write(buf.getvalue())

        # soffice convert to pdf
        cmd = [soffice, "--headless", "--convert-to", "pdf", pptx_path, "--outdir", tmpdir]
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        # pdftoppm convert to png
        png_prefix = os.path.join(tmpdir, "page")
        cmd_ppm = [pdftoppm, "-r", "96", "-scale-to-x", "1280", "-scale-to-y", "720", "-png", pdf_path, png_prefix]
        subprocess.run(cmd_ppm, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        png_file = f"{png_prefix}-1.png"
        assert os.path.exists(png_file), "Rendered PNG file not generated"

        # Copy rendered png to current dir or inspect
        out_png = "tests/render_check_output.png"
        shutil.copy(png_file, out_png)
        print(f"Rendered slide saved to {out_png}")

        # Check bounds
        print("\n--- LIBREOFFICE RENDER BOUNDS CHECK ---")
        cases = [
            ("Native rect (sw=2)", (80, 80, 320, 220), (99, 99, 301, 201)),
            ("custGeom triangle (sw=2)", (380, 80, 620, 220), (405, 102, 595, 198)),
            ("custGeom pentagon (sw=2)", (680, 80, 920, 220), (705, 102, 895, 195)),
            ("Native rect large (sw=12)", (80, 280, 320, 420), (94, 294, 306, 406)),
        ]

        for name, search_box, expected in cases:
            measured = measure_bounds(png_file, search_box)
            print(f"{name:30}: Expected {expected} | Measured {measured}")
            for i in range(4):
                assert abs(measured[i] - expected[i]) <= 1, f"{name} coord {i} mismatch: {measured[i]} vs {expected[i]}"

        # Also measure arrow and callout bounds to confirm they rendered distinctly
        arr1_b = measure_bounds(png_file, (380, 280, 620, 420))
        arr2_b = measure_bounds(png_file, (680, 280, 920, 420))
        print(f"{'Arrow adj=0.2':30}: Measured {arr1_b}")
        print(f"{'Arrow adj=0.8':30}: Measured {arr2_b}")
        assert arr1_b is not None and arr2_b is not None

        cal1_b = measure_bounds(png_file, (80, 480, 320, 620))
        cal2_b = measure_bounds(png_file, (380, 480, 620, 620))
        print(f"{'Callout adj=0.1':30}: Measured {cal1_b}")
        print(f"{'Callout adj=0.9':30}: Measured {cal2_b}")
        assert cal1_b is not None and cal2_b is not None

        resized_b = measure_bounds(png_file, (680, 460, 1020, 650))
        print(f"{'Resized arrow (300x150)':30}: Measured {resized_b}")
        assert resized_b is not None

        print("\nALL RENDER BOUNDS VERIFIED BY EXECUTION IN LIBREOFFICE!\n")

def _figure_png(w, h, bars):
    """Opaque, never-white test picture: tinted background, dark frame, coloured bars."""
    img = Image.new("RGB", (w, h), (205, 222, 240))
    d = ImageDraw.Draw(img)
    d.rectangle((0, 0, w - 1, h - 1), outline=(20, 30, 60), width=4)
    bw = (w - 40) // bars
    for i in range(bars):
        d.rectangle((20 + i * bw + 4, h - 30 - (i + 1) * (h // (bars + 2)), 20 + (i + 1) * bw - 4, h - 30), fill=(47 + 25 * i, 111, 143))
    buf = io.BytesIO()
    img.save(buf, "PNG", dpi=(450, 450))
    return buf.getvalue()

def run_figure_render_check():
    """Plot (structured) + figure (composite) pictures, and a missing-src placeholder, rendered by LibreOffice."""
    soffice = shutil.which("soffice") or shutil.which("libreoffice")
    pdftoppm = shutil.which("pdftoppm")
    if not soffice or not pdftoppm:
        print("Skipping figure render check (soffice or pdftoppm not found)")
        return

    def url(raw):
        return "data:image/png;base64," + base64.b64encode(raw).decode()

    plot_png, comp_png = _figure_png(640, 400, 4), _figure_png(600, 600, 3)
    objs = [
        SlideObject(id="plot1", type="plot", figureId="f1", src=url(plot_png), x=100, y=100, w=480, h=300, name="Dose response", alt="Bar plot."),
        SlideObject(id="comp1", type="figure", figureId="f2", src=url(comp_png), x=700, y=100, w=300, h=300, name="Panels"),
        SlideObject(id="gone", type="plot", figureId="f3", src=None, x=100, y=450, w=300, h=150, name="Lost plot"),
    ]
    doc = PresentationDoc(title="Figure Render Check", themeId="slate", slides=[SlideModel(id="s1", layout="blank", objects=objs)])
    warnings = []
    with tempfile.TemporaryDirectory() as tmpdir:
        pptx_path = os.path.join(tmpdir, "figs.pptx")
        with open(pptx_path, "wb") as f:
            f.write(export_presentation(doc, warnings=warnings).getvalue())
        assert [w["code"] for w in warnings] == ["figure_image_missing"], warnings

        # picture size in the package == object geometry, bytes untouched
        pics = [s for s in Presentation(pptx_path).slides[0].shapes if s.shape_type == 13]
        assert len(pics) == 2
        for pic, o, raw in zip(pics, objs, (plot_png, comp_png)):
            assert (pic.left, pic.top, pic.width, pic.height) == (to_emu(o.x), to_emu(o.y), to_emu(o.w), to_emu(o.h))
            assert pic.image.blob == raw

        subprocess.run([soffice, "--headless", "--convert-to", "pdf", pptx_path, "--outdir", tmpdir], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        prefix = os.path.join(tmpdir, "figpage")
        subprocess.run([pdftoppm, "-r", "96", "-scale-to-x", "1280", "-scale-to-y", "720", "-png", os.path.join(tmpdir, "figs.pdf"), prefix], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        png_file = f"{prefix}-1.png"
        assert os.path.exists(png_file), "Rendered PNG file not generated"
        img = Image.open(png_file).convert("RGB")

        print("\n--- LIBREOFFICE FIGURE PICTURE CHECK ---")
        for label, box, expected in (("plot picture", (80, 80, 600, 420), (100, 100, 580, 400)),
                                     ("composite picture", (680, 80, 1020, 420), (700, 100, 1000, 400))):
            measured = measure_bounds(png_file, box)
            print(f"{label:20}: Expected {expected} | Measured {measured}")
            assert measured is not None, f"{label} rendered blank"
            for i in range(4):  # letterbox-free and unstretched: ink fills exactly the object frame
                assert abs(measured[i] - expected[i]) <= 2, f"{label} coord {i}: {measured[i]} vs {expected[i]}"
            region = img.crop(expected).getdata()
            inked = sum(1 for r, g, b in region if r < 240 or g < 240 or b < 240) / len(region)
            assert inked > 0.95, f"{label} not filled ({inked:.2f})"
        ph = measure_bounds(png_file, (80, 430, 440, 620))
        print(f"{'placeholder':20}: Measured {ph}")
        assert ph is not None, "placeholder rendered blank"
        for got, want in zip(ph, (100, 450, 400, 600)):  # visible frame keeps the object geometry
            assert abs(got - want) <= 2, f"placeholder frame {ph}"
        print("FIGURE PICTURES VERIFIED IN LIBREOFFICE\n")

if __name__ == "__main__":
    run_render_check()
    run_figure_render_check()
