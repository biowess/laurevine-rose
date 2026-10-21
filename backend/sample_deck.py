"""Representative Export Test Deck Generator.

Constructs a deterministic canonical presentation containing:
- Title and subtitle
- Paragraph that wraps across several lines
- Left-, centre-, and right-aligned text
- Bold and italic text
- Different font sizes (44pt, 24pt, 18pt, 14pt)
- Rectangle, rounded rectangle, ellipse, line connector
- Embedded real raster image (PNG)
- Multiple overlapping objects to test layer ordering
- At least two slides
- Objects aligned to slide centres and edges
"""

import base64
import struct
import zlib
from backend.models import PresentationDoc, SlideModel, SlideObject

def _generate_valid_png() -> str:
    """Generates a standard 64x64 RGBA PNG data URL."""
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr_data = struct.pack(">IIBBBBB", 64, 64, 8, 6, 0, 0, 0)
    ihdr = b"IHDR" + ihdr_data
    ihdr_chunk = struct.pack(">I", len(ihdr_data)) + ihdr + struct.pack(">I", zlib.crc32(ihdr))

    raw_data = bytearray()
    for y in range(64):
        raw_data.append(0)  # None filter
        for x in range(64):
            if (x // 8 + y // 8) % 2 == 0:
                raw_data.extend((112, 45, 59, 255))
            else:
                raw_data.extend((166, 92, 104, 255))

    compressed = zlib.compress(bytes(raw_data), 9)
    idat = b"IDAT" + compressed
    idat_chunk = struct.pack(">I", len(compressed)) + idat + struct.pack(">I", zlib.crc32(idat))

    iend = b"IEND"
    iend_chunk = struct.pack(">I", 0) + iend + struct.pack(">I", zlib.crc32(iend))

    png = sig + ihdr_chunk + idat_chunk + iend_chunk
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")

SAMPLE_PNG_DATA_URL = _generate_valid_png()


def create_representative_deck() -> PresentationDoc:
    """Builds a deterministic test deck exercising all required presentation features."""

    # Slide 1: Title, Subtitle, Text Alignment & Formatting, Multi-line paragraph, Centered / Edge alignments
    s1_objects = [
        # Slide Header / Title (aligned to slide edge / margins)
        SlideObject(
            id="s1_title",
            type="text",
            role="title",
            x=64,
            y=40,
            w=1152,
            h=90,
            html="<p><b>Representative Research Deck</b>: Export &amp; Fidelity Verification</p>",
            fontSize=38,
            align="left",
            vAlign="middle",
            color="title",
        ),
        # Subtitle
        SlideObject(
            id="s1_subtitle",
            type="text",
            role="subtitle",
            x=64,
            y=130,
            w=1152,
            h=40,
            html="<p>A rigorous benchmark for geometry, native shapes, rich text, and layering</p>",
            fontSize=18,
            align="left",
            vAlign="top",
            color="muted",
        ),
        # Multi-line wrapping paragraph with bold, italic, underline
        SlideObject(
            id="s1_body",
            type="text",
            role="body",
            x=64,
            y=180,
            w=540,
            h=240,
            html=(
                "<p>This paragraph exercises <b>multi-line text wrapping</b> across several lines "
                "within a bounded logical box. It contains <i>italic emphasis</i>, "
                "<u>underlined text</u>, and <span style=\"color:#702D3B\">accent-colored spans</span>.</p>"
                "<p>A second paragraph verifies line spacing, paragraph gaps, and consistent point-to-pixel sizing.</p>"
            ),
            fontSize=18,
            lineHeight=1.35,
            spaceAfter=6,
            align="left",
            vAlign="top",
        ),
        # Text alignment showcase: Left, Center, Right aligned text boxes
        SlideObject(
            id="s1_align_left",
            type="text",
            x=64,
            y=440,
            w=360,
            h=60,
            fill="#F4F2EF",
            stroke="#D9D5D0",
            strokeWidth=1,
            html="<p><b>Left-aligned text</b> (box aligned)</p>",
            fontSize=16,
            align="left",
            vAlign="middle",
        ),
        SlideObject(
            id="s1_align_center",
            type="text",
            x=460,
            y=440,
            w=360,
            h=60,
            fill="#F4F2EF",
            stroke="#D9D5D0",
            strokeWidth=1,
            html="<p><b>Centre-aligned text</b></p>",
            fontSize=16,
            align="center",
            vAlign="middle",
        ),
        SlideObject(
            id="s1_align_right",
            type="text",
            x=856,
            y=440,
            w=360,
            h=60,
            fill="#F4F2EF",
            stroke="#D9D5D0",
            strokeWidth=1,
            html="<p><b>Right-aligned text</b></p>",
            fontSize=16,
            align="right",
            vAlign="middle",
        ),
        # Slide Centre Snapped Indicator (x centered on slide: (1280 - 400) / 2 = 440)
        SlideObject(
            id="s1_center_box",
            type="text",
            x=440,
            y=540,
            w=400,
            h=60,
            fill="accent",
            stroke="accent2",
            strokeWidth=2,
            html="<p><b>Slide-Centre Aligned Object</b> (X=440, W=400)</p>",
            fontSize=16,
            color="#FFFFFF",
            align="center",
            vAlign="middle",
        ),
        # Embedded Image Object (PNG)
        SlideObject(
            id="s1_image",
            type="image",
            role="figure",
            x=660,
            y=180,
            w=240,
            h=240,
            name="Sample Diagram Figure",
            alt="Sample Scientific Diagram",
            src=SAMPLE_PNG_DATA_URL,
            aspect=1.0,
            stroke="#702D3B",
            strokeWidth=2,
        ),
    ]

    s1 = SlideModel(
        id="slide_1",
        layout="titleContent",
        bg="#FFFFFF",
        notes="Presenter notes for Slide 1: Review text wrapping, alignment boxes, and embedded PNG figure.",
        objects=s1_objects,
    )

    # Slide 2: Native Shapes, Lines, Overlapping Layer Order Test
    # Overlapping stack: Back rectangle -> Middle ellipse -> Top rounded rectangle with text
    s2_objects = [
        SlideObject(
            id="s2_title",
            type="text",
            role="title",
            x=64,
            y=40,
            w=1152,
            h=80,
            html="<p><b>Geometric Shapes, Connectors &amp; Layer Ordering</b></p>",
            fontSize=34,
            align="left",
            vAlign="middle",
            color="title",
        ),
        # 1. Straight Line Connector (X=64 to X=1216)
        SlideObject(
            id="s2_line",
            type="shape",
            shape="line",
            x=64,
            y=130,
            w=1152,
            h=20,
            stroke="accent",
            strokeWidth=3,
        ),
        # 2. Standalone Rectangle
        SlideObject(
            id="s2_rect",
            type="shape",
            shape="rect",
            x=64,
            y=180,
            w=260,
            h=160,
            fill="#2F6F8F",
            stroke="#1F3A4D",
            strokeWidth=2,
            html="<p><b>Rectangle</b></p><p>Solid fill &amp; outline</p>",
            fontSize=16,
            color="#FFFFFF",
            align="center",
            vAlign="middle",
        ),
        # 3. Standalone Ellipse / Oval
        SlideObject(
            id="s2_ellipse",
            type="shape",
            shape="ellipse",
            x=360,
            y=180,
            w=240,
            h=160,
            fill="#C28B3C",
            stroke="#8C5E1A",
            strokeWidth=2,
            html="<p><b>Ellipse</b></p>",
            fontSize=18,
            color="#FFFFFF",
            align="center",
            vAlign="middle",
        ),
        # 4. Standalone Rounded Rectangle
        SlideObject(
            id="s2_rounded",
            type="shape",
            shape="rounded",
            x=640,
            y=180,
            w=260,
            h=160,
            fill="#5E8C61",
            stroke="#3C613F",
            strokeWidth=2,
            html="<p><b>Rounded Rect</b></p><p>Corner radius</p>",
            fontSize=16,
            color="#FFFFFF",
            align="center",
            vAlign="middle",
        ),
        # 5. Overlapping Objects Testing Strict Layer Order (Back -> Middle -> Front)
        # Layer 1 (Bottom): Large Gray Base Rectangle
        SlideObject(
            id="s2_layer_bottom",
            type="shape",
            shape="rect",
            x=64,
            y=390,
            w=480,
            h=260,
            fill="#E0DCD6",
            stroke="#B5B0A8",
            strokeWidth=2,
            html="<p>Layer 1: Base (Bottom)</p>",
            fontSize=14,
            color="#555555",
            align="left",
            vAlign="top",
        ),
        # Layer 2 (Middle): Overlapping Burgundy Rounded Rectangle
        SlideObject(
            id="s2_layer_middle",
            type="shape",
            shape="rounded",
            x=160,
            y=430,
            w=360,
            h=180,
            fill="#702D3B",
            stroke="#A65C68",
            strokeWidth=2,
            html="<p><b>Layer 2: Middle Shape</b></p>",
            fontSize=16,
            color="#FFFFFF",
            align="center",
            vAlign="middle",
        ),
        # Layer 3 (Top): Overlapping Accent2 Ellipse
        SlideObject(
            id="s2_layer_top",
            type="shape",
            shape="ellipse",
            x=320,
            y=470,
            w=200,
            h=120,
            fill="#A65C68",
            stroke="#FFFFFF",
            strokeWidth=3,
            html="<p><b>Layer 3: Top</b></p>",
            fontSize=16,
            color="#FFFFFF",
            align="center",
            vAlign="middle",
        ),
        # 6. Structured Table Object (for comprehensive testing)
        SlideObject(
            id="s2_table",
            type="table",
            x=600,
            y=390,
            w=616,
            h=240,
            headerRow=True,
            banded=True,
            fontSize=15,
            cells=[
                ["Test Metric", "Baseline", "Target", "Status"],
                ["Export Fidelity", "85%", "100%", "Verified"],
                ["Geometry Precision", "96 DPI", "9525 EMU/px", "Exact"],
                ["Layer Ordering", "DOM order", "Back-to-Front", "Preserved"],
                ["Native Shapes", "SVG", "PowerPoint MSO", "Native"],
            ],
        ),
    ]

    s2 = SlideModel(
        id="slide_2",
        layout="titleOnly",
        bg="#FBFAF5",
        notes="Presenter notes for Slide 2: Verify layer order of overlapping items and native shape rendering.",
        objects=s2_objects,
    )

    deck = PresentationDoc(
        schemaVersion=1,
        id="deck_representative_test",
        title="Representative Export Test Presentation",
        themeId="journal",
        paletteId="burgundy",
        typeId="outfit",
        slides=[s1, s2],
    )

    return deck
