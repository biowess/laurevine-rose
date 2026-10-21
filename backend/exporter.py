"""PowerPoint (.pptx) Exporter for Research Presentation Editor.

Transforms the canonical presentation document model into a native, fully editable
PowerPoint presentation using python-pptx.

Key architectural guarantees:
1. Exact coordinate conversion: 9,525 EMUs per logical pixel (1280x720 -> 13.333" x 7.5").
2. Native editable elements: text boxes, shapes, connectors, images, and tables.
3. Accurate rich-text parsing from HTML with paragraph and run styling (bold, italic,
   underline, colors, font sizes, alignments, line spacing, bullet lists).
4. Strict preservation of back-to-front layer ordering.
5. Independent testability (usable via Python API or command-line).
"""

import base64
import html
from html.parser import HTMLParser
import io
import math
import os
import re
from typing import Any, Dict, List, Optional, Tuple, Union

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml import parse_xml
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt
from lxml import etree

from backend import headerfooter as hfmod
from backend import shape_geometry
from backend import palettes as palettes_mod
from backend import typography as typography_mod
from backend import symbols as symbols_mod
from backend.models import PresentationDoc, SlideModel, SlideObject, migrate_v1_to_v2

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

# 1 logical pixel = 914,400 EMUs / 96 DPI = 9,525 EMUs
EMU_PER_PIXEL = 9525

# Theme definitions matching frontend themes.js
THEMES_CONFIG = {
    "journal": {
        "bg": "#FFFFFF",
        "title": "#702D3B",
        "text": "#292A2D",
        "muted": "#6F7075",
        "accent": "#702D3B",
        "accent2": "#A65C68",
        "decor": "rule",
        "headFont": "Outfit",
        "bodyFont": "Outfit",
        "dark": False,
    },
    "slate": {
        "bg": "#FFFFFF",
        "title": "#1F3A4D",
        "text": "#25303A",
        "muted": "#667582",
        "accent": "#2F6F8F",
        "accent2": "#8DB3C6",
        "decor": "topbar",
        "headFont": "Outfit",
        "bodyFont": "Outfit",
        "dark": False,
    },
    "field": {
        "bg": "#FBFAF5",
        "title": "#2C4A3B",
        "text": "#2B2F2C",
        "muted": "#6A7068",
        "accent": "#3F7A5C",
        "accent2": "#A5BFA8",
        "decor": "rule",
        "headFont": "Georgia",
        "bodyFont": "Outfit",
        "dark": False,
    },
    "midnight": {
        "bg": "#1E2128",
        "title": "#F4E6EA",
        "text": "#E7E8EB",
        "muted": "#A9ADB8",
        "accent": "#D58A99",
        "accent2": "#A65C68",
        "decor": "rule",
        "headFont": "Outfit",
        "bodyFont": "Outfit",
        "dark": True,
    },
    "mono": {
        "bg": "#FFFFFF",
        "title": "#111111",
        "text": "#222222",
        "muted": "#666666",
        "accent": "#333333",
        "accent2": "#999999",
        "decor": "footer",
        "headFont": "Georgia",
        "bodyFont": "Georgia",
        "dark": False,
    },
    "clinical-blue": {
        "bg": "#FFFFFF",
        "title": "#152A43",
        "text": "#152A43",
        "muted": "#5C728A",
        "accent": "#1D5FA7",
        "accent2": "#147481",
        "decor": "rule",
        "headFont": "Plus Jakarta Sans",
        "bodyFont": "Source Sans 3",
        "dark": False,
    },
    "editorial-review": {
        "bg": "#FDFCF7",
        "title": "#22201D",
        "text": "#22201D",
        "muted": "#6B6760",
        "accent": "#8B263E",
        "accent2": "#1E4D6B",
        "decor": "rule",
        "headFont": "EB Garamond",
        "bodyFont": "Lora",
        "dark": False,
    },
    "field-biology": {
        "bg": "#F8FAF6",
        "title": "#1B2E20",
        "text": "#1B2E20",
        "muted": "#556658",
        "accent": "#2D5A3A",
        "accent2": "#8A5A36",
        "decor": "rule",
        "headFont": "Fira Sans",
        "bodyFont": "Source Sans 3",
        "dark": False,
    },
    "molecular-translational": {
        "bg": "#FAFAFC",
        "title": "#182033",
        "text": "#182033",
        "muted": "#505C72",
        "accent": "#24588C",
        "accent2": "#0E7A68",
        "decor": "rule",
        "headFont": "Inter",
        "bodyFont": "Source Sans 3",
        "dark": False,
    },
    "hematology-oncology": {
        "bg": "#FCFAF7",
        "title": "#2B1F1D",
        "text": "#2B1F1D",
        "muted": "#6B5E59",
        "accent": "#852C2C",
        "accent2": "#3C5B74",
        "decor": "rule",
        "headFont": "Plus Jakarta Sans",
        "bodyFont": "Source Sans 3",
        "dark": False,
    },
    "data-methods": {
        "bg": "#FFFFFF",
        "title": "#1E252B",
        "text": "#1E252B",
        "muted": "#55606B",
        "accent": "#2B5B84",
        "accent2": "#D96B27",
        "decor": "rule",
        "headFont": "Space Grotesk",
        "bodyFont": "Inter",
        "dark": False,
    },
    "population-health": {
        "bg": "#F4F8F8",
        "title": "#1D3038",
        "text": "#1D3038",
        "muted": "#506973",
        "accent": "#00665E",
        "accent2": "#92520A",
        "decor": "rule",
        "headFont": "Lato",
        "bodyFont": "Open Sans",
        "dark": False,
    },
    "computational-biology": {
        "bg": "#F7F8FC",
        "title": "#1D2345",
        "text": "#1D2345",
        "muted": "#535B82",
        "accent": "#6258A4",
        "accent2": "#007C91",
        "decor": "rule",
        "headFont": "Space Grotesk",
        "bodyFont": "Inter",
        "dark": False,
    },
    "dark-auditorium": {
        "bg": "#142033",
        "title": "#F5F7FA",
        "text": "#F5F7FA",
        "muted": "#A2B3C7",
        "accent": "#72D5C9",
        "accent2": "#9BB9FF",
        "decor": "rule",
        "headFont": "Outfit",
        "bodyFont": "Source Sans 3",
        "dark": True,
    },
    "swiss-minimal": {
        "bg": "#FFFFFF",
        "title": "#171C22",
        "text": "#171C22",
        "muted": "#5A6472",
        "accent": "#B33D2E",
        "accent2": "#1D5FA7",
        "decor": "rule",
        "headFont": "Spline Sans",
        "bodyFont": "Arimo",
        "dark": False,
    },
}

PALETTES_CONFIG = {
    "burgundy": ["#702D3B", "#2F6F8F", "#C28B3C", "#5E8C61", "#A65C68", "#6B5B95"],
    "okabe": ["#0072B2", "#E69F00", "#009E73", "#D55E00", "#56B4E9", "#CC79A7"],
    "viridis": ["#440154", "#3B528B", "#21918C", "#5EC962", "#C8D92B"],
    "grayscale": ["#1A1A1A", "#5A5A5A", "#8C8C8C", "#B5B5B5"],
}


def to_emu(pixels: float) -> int:
    """Convert logical pixels to EMUs."""
    return int(round(pixels * EMU_PER_PIXEL))


NAMED_COLORS: Dict[str, Tuple[int, int, int]] = {
    "black": (0, 0, 0),
    "white": (255, 255, 255),
    "red": (255, 0, 0),
    "green": (0, 128, 0),
    "blue": (0, 0, 255),
    "yellow": (255, 255, 0),
    "orange": (255, 165, 0),
    "purple": (128, 0, 128),
    "cyan": (0, 255, 255),
    "magenta": (255, 0, 255),
    "gray": (128, 128, 128),
    "grey": (128, 128, 128),
    "pink": (255, 192, 203),
    "lime": (0, 255, 0),
    "teal": (0, 128, 128),
    "navy": (0, 0, 128),
    "maroon": (128, 0, 0),
    "gold": (255, 215, 0),
}


def parse_any_color(
    color_val: Optional[str], resolver: Optional[Any] = None
) -> Optional[RGBColor]:
    """Parse any color representation (hex, rgb, rgba, named, theme token) to RGBColor."""
    if not color_val or not isinstance(color_val, str):
        return None
    s = color_val.strip().lower()
    if s in ("transparent", "none", ""):
        return None

    if resolver and hasattr(resolver, "resolve_color"):
        resolved = resolver.resolve_color(s)
        if resolved:
            return resolved

    if s in NAMED_COLORS:
        r, g, b = NAMED_COLORS[s]
        return RGBColor(r, g, b)

    # rgb / rgba
    m_rgb = re.match(r"rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", s)
    if m_rgb:
        return RGBColor(int(m_rgb.group(1)), int(m_rgb.group(2)), int(m_rgb.group(3)))

    # hex (#RGB, #RRGGBB)
    cleaned = s.lstrip("#")
    if len(cleaned) == 3:
        cleaned = "".join(c * 2 for c in cleaned)
    if len(cleaned) >= 6:
        try:
            r = int(cleaned[0:2], 16)
            g = int(cleaned[2:4], 16)
            b = int(cleaned[4:6], 16)
            return RGBColor(r, g, b)
        except ValueError:
            return None
    return None


def color_to_hex_str(
    color_val: Optional[str], resolver: Optional[Any] = None
) -> Optional[str]:
    """Convert any color representation to 6-digit hex string (e.g. 'FFFF00') or None."""
    c = parse_any_color(color_val, resolver=resolver)
    if not c:
        return None
    return f"{c[0]:02X}{c[1]:02X}{c[2]:02X}"


def parse_hex_color(hex_str: Optional[str]) -> Optional[RGBColor]:
    """Parse a color string into an RGBColor object (backward-compatible)."""
    return parse_any_color(hex_str)


CURATED_FONTS = {
    "outfit": "Outfit",
    "spline sans": "Spline Sans",
    "arimo": "Arimo",
    "source sans 3": "Source Sans 3",
    "source sans": "Source Sans 3",
    "source sans pro": "Source Sans 3",
    "opendyslexic": "OpenDyslexic",
    "open dyslexic": "OpenDyslexic",
    "tex gyre termes": "TeX Gyre Termes",
    "texgyretermes": "TeX Gyre Termes",
    "cormorant garamond": "Cormorant Garamond",
    "cormorant": "Cormorant Garamond",
    "amiri": "Amiri",
    "cairo": "Cairo",
    "noto sans arabic": "Noto Sans Arabic",
    "tajawal": "Tajawal",
    "scheherazade new": "Scheherazade New",
    "scheherazade": "Scheherazade New",
    "inter": "Inter",
    "roboto": "Roboto",
    "open sans": "Open Sans",
    "lato": "Lato",
    "montserrat": "Montserrat",
    "poppins": "Poppins",
    "raleway": "Raleway",
    "oswald": "Oswald",
    "fira sans": "Fira Sans",
    "plus jakarta sans": "Plus Jakarta Sans",
    "merriweather": "Merriweather",
    "playfair display": "Playfair Display",
    "lora": "Lora",
    "pt serif": "PT Serif",
    "bitter": "Bitter",
    "cinzel": "Cinzel",
    "libre baskerville": "Libre Baskerville",
    "eb garamond": "EB Garamond",
    "jetbrains mono": "JetBrains Mono",
    "fira code": "Fira Code",
    "inconsolata": "Inconsolata",
    "source code pro": "Source Code Pro",
    "space mono": "Space Mono",
    "caveat": "Caveat",
    "pacifico": "Pacifico",
    "space grotesk": "Space Grotesk",
}


def normalize_font_name(font_name: Optional[str]) -> Optional[str]:
    """Normalize font family name to standard presentation typeface."""
    if not font_name or not isinstance(font_name, str):
        return None
    f = font_name.strip().strip("'\"")
    if "," in f:
        f = f.split(",")[0].strip().strip("'\"")
    low = f.lower()
    if low in CURATED_FONTS:
        return CURATED_FONTS[low]
    if low in ("sans", "sans-serif"):
        return "Outfit"
    if low in ("calibri", "carlito"):
        return "Calibri"
    if low in ("arial", "helvetica", "helvetica neue", "liberation sans"):
        return "Arial"
    if low in ("times", "times new roman", "liberation serif", "tinos"):
        return "Times New Roman"
    if low in ("georgia", "serif"):
        return "Georgia"
    if low in ("cambria",):
        return "Cambria"
    if low in ("garamond", "garamond libre"):
        return "Garamond"
    if low in ("trebuchet", "trebuchet ms"):
        return "Trebuchet MS"
    if low in ("verdana", "geneva"):
        return "Verdana"
    if low in ("mono", "monospace", "courier", "courier new", "liberation mono", "cousine"):
        return "Courier New"
    return f


class ThemeResolver:
    """Resolves semantic color tokens and fonts for a presentation document."""

    def __init__(self, doc: PresentationDoc):
        self.doc = doc
        self.typography = getattr(doc, "typography", None)   # resolved preset snapshot; None for old documents
        theme_id = doc.themeId if doc.themeId in THEMES_CONFIG else "journal"
        self.theme = THEMES_CONFIG[theme_id]
        overrides = palettes_mod.theme_overrides(getattr(doc, "palette", None))   # persisted palette: same colours as the editor
        if overrides:
            self.theme = {**self.theme, **overrides}
        palette_id = doc.paletteId if doc.paletteId in PALETTES_CONFIG else "burgundy"
        self.palette = PALETTES_CONFIG[palette_id]

    def resolve_color(self, color_val: Optional[str], fallback: Optional[str] = None) -> Optional[RGBColor]:
        """Resolves semantic tokens like 'accent', 'muted', or hex/rgb strings to RGBColor."""
        if not color_val and fallback:
            color_val = fallback
        if not color_val:
            return None

        val = color_val.strip().lower()
        if val in ("transparent", "none"):
            return None
        if val in self.theme:
            return parse_hex_color(self.theme[val])
        if val == "accent":
            return parse_hex_color(self.theme["accent"])
        if val == "accent2":
            return parse_hex_color(self.theme["accent2"])
        if val == "text":
            return parse_hex_color(self.theme["text"])
        if val == "muted":
            return parse_hex_color(self.theme["muted"])
        if val == "title":
            return parse_hex_color(self.theme["title"])
        if val == "bg":
            return parse_hex_color(self.theme["bg"])

        if val in NAMED_COLORS:
            r, g, b = NAMED_COLORS[val]
            return RGBColor(r, g, b)

        m_rgb = re.match(r"rgba?\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)", val)
        if m_rgb:
            return RGBColor(int(m_rgb.group(1)), int(m_rgb.group(2)), int(m_rgb.group(3)))

        return parse_hex_color(color_val)

    def role_style(self, role: Optional[str]) -> dict:
        """Typography-preset defaults {font, bold?, italic?} for a text role ({} without a snapshot)."""
        return typography_mod.role_spec(self.typography, role)

    def resolve_font(self, font_name: Optional[str], role: Optional[str] = None) -> str:
        """Resolve font name with fallbacks based on role and theme."""
        norm = normalize_font_name(font_name)
        if norm:
            return norm
        spec_font = normalize_font_name(typography_mod.role_spec(self.typography, role).get("font"))
        if spec_font:   # active typography preset: the font of this text role
            return spec_font
        if role == "title":
            return self.theme.get("headFont", "Outfit")
        return self.theme.get("bodyFont", "Outfit")


class TextRunData:
    """Intermediate representation of a text run."""

    def __init__(
        self,
        text: str,
        bold: Optional[bool] = None,
        italic: Optional[bool] = None,
        underline: Optional[bool] = None,
        strike: Optional[bool] = None,
        color: Optional[RGBColor] = None,
        highlight: Optional[str] = None,
        size: Optional[float] = None,
        font: Optional[str] = None,
        baseline: Optional[int] = None,
    ):
        self.text = text
        self.bold = bold
        self.italic = italic
        self.underline = underline
        self.strike = strike
        self.color = color
        self.highlight = highlight
        self.size = size
        self.font = font
        self.baseline = baseline


class ParagraphData:
    """Intermediate representation of a paragraph containing runs."""

    def __init__(
        self,
        runs: Optional[List[TextRunData]] = None,
        is_bullet: bool = False,
        list_type: Optional[str] = None,
        alignment: Optional[str] = None,
        size: Optional[float] = None,
    ):
        self.runs = runs or []
        self.is_bullet = is_bullet
        self.list_type = list_type
        self.alignment = alignment
        self.size = size


class HTMLToTextRunsParser(HTMLParser):
    """Parses HTML into paragraphs and styled runs for python-pptx."""

    def __init__(
        self,
        default_bold: bool = False,
        default_italic: bool = False,
        default_underline: bool = False,
        default_strike: bool = False,
        default_color: Optional[RGBColor] = None,
        default_highlight: Optional[str] = None,
        default_size: Optional[float] = None,
        default_font: Optional[str] = None,
        default_alignment: Optional[str] = None,
        default_baseline: Optional[int] = None,
        is_bullet: bool = False,
        default_list: Optional[str] = None,
        resolver: Optional[ThemeResolver] = None,
    ):
        super().__init__()
        self.paragraphs: List[ParagraphData] = []
        self.current_runs: List[TextRunData] = []
        self.is_bullet = is_bullet
        self.default_list = default_list or ("bullet" if is_bullet else None)
        self.current_para_list = self.default_list
        self.default_alignment = default_alignment
        self.current_para_align = default_alignment
        self.default_size = default_size
        self.current_para_size = default_size
        self.default_baseline = default_baseline
        self.in_para = False
        self.list_stack: List[str] = []
        self.resolver = resolver
        self.style_stack: List[Dict[str, Any]] = [
            {
                "bold": default_bold,
                "italic": default_italic,
                "underline": default_underline,
                "strike": default_strike,
                "color": default_color,
                "highlight": default_highlight,
                "size": default_size,
                "font": default_font,
                "baseline": default_baseline,
            }
        ]

    def _flush_paragraph(self):
        if not self.in_para and not self.current_runs:
            return
        runs = self.current_runs
        if len(runs) == 1 and runs[0].text in ("\n", ""):
            runs = []
        elif all(r.text in ("\n", "") for r in runs) and runs:
            runs = []

        self.paragraphs.append(
            ParagraphData(
                runs=runs,
                is_bullet=bool(self.current_para_list == "bullet" or self.is_bullet),
                list_type=self.current_para_list,
                alignment=self.current_para_align,
                size=self.current_para_size,
            )
        )
        self.current_runs = []
        self.current_para_size = self.default_size
        self.in_para = False

    def handle_starttag(self, tag: str, attrs: List[Tuple[str, Optional[str]]]):
        tag = tag.lower()
        cur = dict(self.style_stack[-1])
        attr_dict = {k.lower(): v for k, v in attrs if v is not None}

        if tag in ("ul", "ol"):
            self.list_stack.append("bullet" if tag == "ul" else "number")
        elif tag == "li":
            self._flush_paragraph()
            self.current_para_list = self.list_stack[-1] if self.list_stack else "bullet"
            self.is_bullet = True
        elif tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush_paragraph()
            self.in_para = True
            self.current_para_size = self.default_size
            if not self.list_stack:
                self.current_para_list = self.default_list
                self.is_bullet = bool(self.default_list == "bullet")
            else:
                self.current_para_list = self.list_stack[-1]
                self.is_bullet = True
            self.current_para_align = self.default_alignment

            align_attr = attr_dict.get("align", "").strip().lower()
            if align_attr in ("left", "center", "right", "justify"):
                self.current_para_align = align_attr
        elif tag == "br":
            cur_style = self.style_stack[-1]
            self.current_runs.append(
                TextRunData(
                    text="\n",
                    bold=cur_style.get("bold"),
                    italic=cur_style.get("italic"),
                    underline=cur_style.get("underline"),
                    strike=cur_style.get("strike"),
                    color=cur_style.get("color"),
                    highlight=cur_style.get("highlight"),
                    size=cur_style.get("size"),
                    font=cur_style.get("font"),
                    baseline=cur_style.get("baseline"),
                )
            )
            return

        if tag in ("b", "strong"):
            cur["bold"] = True
        elif tag in ("i", "em"):
            cur["italic"] = True
        elif tag == "u":
            cur["underline"] = True
        elif tag in ("s", "strike", "del"):
            cur["strike"] = True
        elif tag == "sub":
            cur["baseline"] = -25000
        elif tag in ("sup", "super"):
            cur["baseline"] = 30000
        elif tag == "mark":
            cur["highlight"] = "FFFF00"
        elif tag == "font":
            if "color" in attr_dict:
                c = parse_any_color(attr_dict["color"], resolver=self.resolver)
                if c is not None:
                    cur["color"] = c
            if "face" in attr_dict:
                f = attr_dict["face"].strip("'\"")
                cur["font"] = self.resolver.resolve_font(f) if self.resolver else normalize_font_name(f)
            if "size" in attr_dict:
                try:
                    cur["size"] = float(attr_dict["size"])
                except ValueError:
                    pass

        # Parse style attribute
        style_val = attr_dict.get("style", "")
        if style_val:
            for item in style_val.split(";"):
                if ":" in item:
                    k, v = item.split(":", 1)
                    k = k.strip().lower()
                    v = v.strip().lower()
                    if k == "font-weight":
                        if any(w in v for w in ("bold", "700", "800", "900")):
                            cur["bold"] = True
                        elif "normal" in v or "400" in v:
                            cur["bold"] = False
                    elif k == "font-style":
                        if "italic" in v or "oblique" in v:
                            cur["italic"] = True
                        elif "normal" in v:
                            cur["italic"] = False
                    elif k == "text-decoration":
                        if "underline" in v:
                            cur["underline"] = True
                        if "line-through" in v:
                            cur["strike"] = True
                    elif k == "vertical-align":
                        if "sub" in v:
                            cur["baseline"] = -25000
                        elif any(w in v for w in ("super", "sup")):
                            cur["baseline"] = 30000
                        elif any(w in v for w in ("baseline", "normal")):
                            cur["baseline"] = 0
                    elif k == "color":
                        c = parse_any_color(v, resolver=self.resolver)
                        if c is not None:
                            cur["color"] = c
                    elif k in ("background-color", "background", "highlight"):
                        if v in ("transparent", "none"):
                            cur["highlight"] = None
                        else:
                            hl = color_to_hex_str(v, resolver=self.resolver)
                            if hl:
                                cur["highlight"] = hl
                    elif k == "font-family":
                        f = v.strip("'\"")
                        cur["font"] = self.resolver.resolve_font(f) if self.resolver else normalize_font_name(f)
                    elif k == "font-size":
                        m = re.search(r"([\d\.]+)\s*(pt|px)?", v)
                        if m:
                            val = float(m.group(1))
                            unit = m.group(2)
                            if unit == "px":
                                val = val * 0.75
                            cur["size"] = val
                            if tag in ("p", "div", "h1", "h2", "h3", "h4", "h5", "h6"):
                                self.current_para_size = val
                    elif k == "text-align":
                        if tag in ("p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
                            if v in ("left", "center", "right", "justify"):
                                self.current_para_align = v

        self.style_stack.append(cur)

    def handle_endtag(self, tag: str):
        tag = tag.lower()
        if tag in ("ul", "ol"):
            if self.list_stack:
                self.list_stack.pop()
        elif tag in ("p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"):
            self._flush_paragraph()
        if len(self.style_stack) > 1:
            self.style_stack.pop()

    def handle_data(self, data: str):
        if not data:
            return
        data = data.replace("\xa0", " ")
        style = self.style_stack[-1]
        self.current_runs.append(
            TextRunData(
                text=data,
                bold=style.get("bold"),
                italic=style.get("italic"),
                underline=style.get("underline"),
                strike=style.get("strike"),
                color=style.get("color"),
                highlight=style.get("highlight"),
                size=style.get("size"),
                font=style.get("font"),
                baseline=style.get("baseline"),
            )
        )

    def finish(self) -> List[ParagraphData]:
        self._flush_paragraph()
        return self.paragraphs


def parse_html_to_paragraphs(
    html_content: str,
    default_bold: bool = False,
    default_italic: bool = False,
    default_underline: bool = False,
    default_strike: bool = False,
    default_color: Optional[RGBColor] = None,
    default_highlight: Optional[str] = None,
    default_size: Optional[float] = None,
    default_font: Optional[str] = None,
    default_alignment: Optional[str] = None,
    default_baseline: Optional[int] = None,
    is_bullet: bool = False,
    default_list: Optional[str] = None,
    resolver: Optional[ThemeResolver] = None,
) -> List[ParagraphData]:
    """Convert HTML or plain string into structured paragraphs and runs."""
    if not html_content:
        return []

    # If it has no HTML tags, treat as plain text
    if "<" not in html_content and ">" not in html_content:
        lines = html_content.splitlines()
        paras = []
        for line in lines:
            if line:
                paras.append(
                    ParagraphData(
                        runs=[
                            TextRunData(
                                text=line,
                                bold=default_bold,
                                italic=default_italic,
                                underline=default_underline,
                                strike=default_strike,
                                color=default_color,
                                highlight=default_highlight,
                                size=default_size,
                                font=default_font,
                                baseline=default_baseline,
                            )
                        ],
                        is_bullet=is_bullet,
                        list_type=default_list or ("bullet" if is_bullet else None),
                        alignment=default_alignment,
                    )
                )
        return symbols_mod.apply_fallback(paras, default_font)

    parser = HTMLToTextRunsParser(
        default_bold=default_bold,
        default_italic=default_italic,
        default_underline=default_underline,
        default_strike=default_strike,
        default_color=default_color,
        default_highlight=default_highlight,
        default_size=default_size,
        default_font=default_font,
        default_alignment=default_alignment,
        default_baseline=default_baseline,
        is_bullet=is_bullet,
        default_list=default_list,
        resolver=resolver,
    )
    try:
        parser.feed(html_content)
        return symbols_mod.apply_fallback(parser.finish(), default_font)   # glyphs missing from the run's bundled font -> covering fallback font
    except Exception:
        # Fallback to simple unescaped text if HTML parsing encounters issues
        clean_text = re.sub(r"<[^>]+>", "", html_content)
        return [
            ParagraphData(
                runs=[
                    TextRunData(
                        text=clean_text,
                        bold=default_bold,
                        italic=default_italic,
                        underline=default_underline,
                        strike=default_strike,
                        color=default_color,
                        highlight=default_highlight,
                        size=default_size,
                        font=default_font,
                        baseline=default_baseline,
                    )
                ],
                is_bullet=is_bullet,
                list_type=default_list or ("bullet" if is_bullet else None),
                alignment=default_alignment,
            )
        ]


def populate_text_frame(
    text_frame: Any,
    obj: SlideObject,
    resolver: ThemeResolver,
    is_shape: bool = False,
):
    """Fills a python-pptx text frame with runs, formatting, alignments, margins, and bullets."""
    text_frame.word_wrap = True
    text_frame.auto_size = MSO_AUTO_SIZE.NONE

    # Padding / margins (standard 6px V, 10px H in CSS border-box)
    stroke_w = float(obj.strokeWidth or 1.0) if (obj.stroke and not is_shape) else 0.0
    indent_offset = to_emu((obj.indent or 0) * 48)
    text_frame.margin_top = Pt(4.5) + to_emu(stroke_w)
    text_frame.margin_bottom = Pt(4.5) + to_emu(stroke_w)
    text_frame.margin_left = Pt(7.5) + to_emu(stroke_w) + indent_offset
    text_frame.margin_right = Pt(7.5) + to_emu(stroke_w)

    # Vertical alignment
    valign = (obj.vAlign or ("middle" if is_shape else "top")).lower()
    if valign in ("middle", "center"):
        text_frame.vertical_anchor = MSO_ANCHOR.MIDDLE
    elif valign == "bottom":
        text_frame.vertical_anchor = MSO_ANCHOR.BOTTOM
    else:
        text_frame.vertical_anchor = MSO_ANCHOR.TOP

    # Horizontal alignment mapping
    ALIGN_MAP = {
        "left": PP_ALIGN.LEFT,
        "center": PP_ALIGN.CENTER,
        "right": PP_ALIGN.RIGHT,
        "justify": PP_ALIGN.JUSTIFY,
    }
    align_val = (obj.align or ("center" if is_shape else "left")).lower()
    default_pp_align = ALIGN_MAP.get(align_val, PP_ALIGN.LEFT)

    # Object-level default styles
    role_style = resolver.role_style(obj.role)
    spec_bold = role_style.get("bold")
    default_bold = (
        True if obj.bold is True or (obj.bold is None and (spec_bold if spec_bold is not None else obj.role == "title")) else False
    )
    default_italic = True if obj.italic is True or (obj.italic is None and role_style.get("italic") is True) else False
    default_underline = bool(obj.underline)
    default_strike = bool(obj.strike)

    default_color_str = obj.color
    if not default_color_str:
        if obj.role == "title":
            default_color_str = "title"
        elif obj.role in ("subtitle", "caption", "footnote"):
            default_color_str = "muted"
        elif is_shape:
            default_color_str = "#FFFFFF" if obj.fill else "text"
        else:
            default_color_str = "text"

    default_color = resolver.resolve_color(default_color_str)
    default_font = resolver.resolve_font(obj.font, obj.role)
    default_size = float(obj.fontSize) if obj.fontSize else 18.0

    is_bullet = bool(obj.list == "bullet")

    default_baseline = None
    if getattr(obj, "subscript", False):
        default_baseline = -25000
    elif getattr(obj, "superscript", False):
        default_baseline = 30000

    content = obj.html or obj.text or ""
    paragraphs_data = parse_html_to_paragraphs(
        content,
        default_bold=default_bold,
        default_italic=default_italic,
        default_underline=default_underline,
        default_strike=default_strike,
        default_color=default_color,
        default_size=default_size,
        default_font=default_font,
        default_alignment=obj.align,
        default_baseline=default_baseline,
        is_bullet=is_bullet,
        default_list=obj.list or ("bullet" if is_bullet else None),
        resolver=resolver,
    )

    if not paragraphs_data:
        text_frame.text = ""
        return

    for i, p_data in enumerate(paragraphs_data):
        if i == 0:
            p = text_frame.paragraphs[0]
        else:
            p = text_frame.add_paragraph()

        # Paragraph alignment (reflects paragraph justifying or object alignment)
        p_align_str = (p_data.alignment or obj.align or ("center" if is_shape else "left")).lower()
        p.alignment = ALIGN_MAP.get(p_align_str, default_pp_align)

        # Determine list kind first so spaceAfter is applied correctly below.
        list_kind = p_data.list_type or obj.list
        if not list_kind and p_data.is_bullet:
            list_kind = "bullet"

        if obj.lineHeight:
            p.line_spacing = float(obj.lineHeight)
        # For non-list paragraphs apply spaceAfter via python-pptx API.
        # List paragraphs emit an explicit <a:spcAft> element in pPr (below) so
        # we must not also write it here or it will appear twice in the XML.
        if obj.spaceAfter and list_kind not in ("bullet", "number"):
            p.space_after = Pt(float(obj.spaceAfter))

        p_pr = p._p.get_or_add_pPr()
        if list_kind in ("bullet", "number"):
            first_run = next((r for r in p_data.runs if r.text and r.text.strip()), None)
            if first_run is None and p_data.runs:
                first_run = p_data.runs[0]
            p_size = (first_run.size if first_run and first_run.size else None) or p_data.size or default_size or 18.0
            mar_l = int(round(p_size * 1.35 * 12700))
            indent = -mar_l
            p_pr.set("marL", str(mar_l))
            p_pr.set("indent", str(indent))
            # Suppress the inherited bodyStyle spcBef (20% of font-size) that the
            # slide master applies to all bullet levels.  Without explicit zeros,
            # PowerPoint adds ~0.2× line-height of blank space before every list
            # paragraph even though the browser preview looks fine.
            # We only do this for list items so prose spacing is unaffected.
            # Honour obj.spaceAfter if the author explicitly requested it.
            _spc_bef_val = "0"
            _spc_aft_val = str(int(round(float(obj.spaceAfter or 0) * 100))) if obj.spaceAfter else "0"
            p_pr.append(parse_xml(
                f'<a:spcBef xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                f'<a:spcPts val="{_spc_bef_val}"/></a:spcBef>'
            ))
            p_pr.append(parse_xml(
                f'<a:spcAft xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                f'<a:spcPts val="{_spc_aft_val}"/></a:spcAft>'
            ))
            p_pr.append(parse_xml('<a:buClrTx xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'))
            p_pr.append(parse_xml('<a:buSzTx xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'))
            p_pr.append(parse_xml('<a:buFontTx xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'))
            if list_kind == "bullet":
                p_pr.append(parse_xml('<a:buChar xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" char="•"/>'))
            else:
                p_pr.append(parse_xml('<a:buAutoNum xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" type="arabicPeriod"/>'))
        else:
            p_pr.append(parse_xml('<a:buNone xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'))

        if not p_data.runs:
            p_size = p_data.size or default_size
            end_rpr = p._p.find("{http://schemas.openxmlformats.org/drawingml/2006/main}endParaRPr")
            if end_rpr is None:
                p._p.append(parse_xml(f'<a:endParaRPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" sz="{int(round(p_size * 100))}"/>'))
            else:
                end_rpr.set("sz", str(int(round(p_size * 100))))
        else:
            for run_data in p_data.runs:
                if not run_data.text:
                    continue
                run = p.add_run()
                run.text = run_data.text
                if run_data.font:
                    run.font.name = run_data.font
                    rpr = run._r.get_or_add_rPr()
                    for tag_name in ("ea", "cs"):
                        el = rpr.find(f"{{http://schemas.openxmlformats.org/drawingml/2006/main}}{tag_name}")
                        if el is None:
                            el = parse_xml(f'<a:{tag_name} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="{run_data.font}"/>')
                            rpr.append(el)
                        else:
                            el.set("typeface", run_data.font)
                if run_data.size:
                    run.font.size = Pt(run_data.size)
                if run_data.bold is not None:
                    run.font.bold = run_data.bold
                if run_data.italic is not None:
                    run.font.italic = run_data.italic
                if run_data.underline is not None:
                    run.font.underline = run_data.underline
                if run_data.strike:
                    rpr = run._r.get_or_add_rPr()
                    rpr.set("strike", "sngStrike")
                if run_data.baseline is not None and run_data.baseline != 0:
                    rpr = run._r.get_or_add_rPr()
                    rpr.set("baseline", str(int(run_data.baseline)))
                if run_data.color:
                    run.font.color.rgb = run_data.color
                if run_data.highlight:
                    rpr = run._r.get_or_add_rPr()
                    hl = parse_xml(
                        f'<a:highlight xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
                        f'<a:srgbClr val="{run_data.highlight}"/>'
                        f'</a:highlight>'
                    )
                    # In ECMA-376 DrawingML, <a:highlight> strictly precedes <a:latin>, <a:ea>, <a:cs>, etc.
                    after_tags = {
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}uLnTx",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}uLn",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}uFillTx",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}uFill",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}latin",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}ea",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}cs",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}sym",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}hlinkClick",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}hlinkMouseOver",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}rtl",
                        "{http://schemas.openxmlformats.org/drawingml/2006/main}extLst",
                    }
                    inserted = False
                    for child in rpr:
                        if child.tag in after_tags:
                            child.addprevious(hl)
                            inserted = True
                            break
                    if not inserted:
                        rpr.append(hl)

            last_sz = p_data.runs[-1].size or p_data.size or default_size
            end_rpr = p._p.find("{http://schemas.openxmlformats.org/drawingml/2006/main}endParaRPr")
            if end_rpr is None:
                p._p.append(parse_xml(f'<a:endParaRPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" sz="{int(round(last_sz * 100))}"/>'))
            else:
                end_rpr.set("sz", str(int(round(last_sz * 100))))


def stroke_px(obj: Any, stroke_only: bool = False) -> float:
    sw = 2.0 if obj.strokeWidth is None else float(obj.strokeWidth)
    return max(sw, 2.0) if stroke_only else sw


def strip_style(shape: Any) -> None:
    """RC-2: Remove <p:style> to prevent inheriting theme drop shadow, fill, or outline."""
    st = shape._element.find(qn("p:style"))
    if st is not None:
        shape._element.remove(st)


def style_line(shape: Any, color: Any, width_px: float, round_ends: bool = True) -> None:
    """Apply stroke color, width in EMUs (RC-1), round join (RC-7), and round cap."""
    if color is not None:
        shape.line.color.rgb = color
    shape.line.width = Emu(to_emu(width_px))
    ln = shape.line._get_or_add_ln()
    for t in ("round", "bevel", "miter"):
        for e in ln.findall(qn(f"a:{t}")):
            ln.remove(e)
    round_el = etree.Element(qn("a:round"))
    inserted = False
    for child in list(ln):
        if child.tag in (qn("a:headEnd"), qn("a:tailEnd"), qn("a:extLst")):
            idx = list(ln).index(child)
            ln.insert(idx, round_el)
            inserted = True
            break
    if not inserted:
        ln.append(round_el)
    if round_ends:
        ln.set("cap", "rnd")


def set_custgeom(sp: Any, cmds: List[Tuple[Any, ...]], filled: bool = True) -> None:
    """Replace <a:prstGeom> with <a:custGeom> scaled to 1000x1000 path box."""
    spPr = sp._element.spPr
    prst = spPr.find(qn("a:prstGeom"))
    idx = list(spPr).index(prst)
    spPr.remove(prst)

    def pt(x: float, y: float) -> str:
        return f'<a:pt x="{int(x)}" y="{int(y)}"/>'

    body = ""
    for c in cmds:
        if c[0] == "M":
            body += f"<a:moveTo>{pt(c[1], c[2])}</a:moveTo>"
        elif c[0] == "L":
            body += f"<a:lnTo>{pt(c[1], c[2])}</a:lnTo>"
        elif c[0] == "C":
            body += f"<a:cubicBezTo>{pt(c[1], c[2])}{pt(c[3], c[4])}{pt(c[5], c[6])}</a:cubicBezTo>"
        elif c[0] == "Q":
            body += f"<a:quadBezTo>{pt(c[1], c[2])}{pt(c[3], c[4])}</a:quadBezTo>"
        elif c[0] == "Z":
            body += "<a:close/>"
    fill_attr = "" if filled else ' fill="none"'
    xml = (
        f'<a:custGeom xmlns:a="{A_NS}"><a:avLst/><a:gdLst/><a:ahLst/><a:cxnLst/>'
        f'<a:rect l="0" t="0" r="r" b="b"/><a:pathLst><a:path w="1000" h="1000"{fill_attr}>{body}</a:path></a:pathLst></a:custGeom>'
    )
    spPr.insert(idx, etree.fromstring(xml))


def export_line(slide: Any, obj: SlideObject, resolver: ThemeResolver):
    """Exports a native PowerPoint line or straight connector shape."""
    x1, y1, x2, y2 = shape_geometry.line_geometry(obj)
    begin_x = to_emu(x1)
    begin_y = to_emu(y1)
    end_x = to_emu(x2)
    end_y = to_emu(y2)

    conn = slide.shapes.add_connector(
        MSO_CONNECTOR.STRAIGHT, begin_x, begin_y, end_x, end_y
    )
    strip_style(conn)
    stroke_color = resolver.resolve_color(obj.stroke or "accent")
    sw = stroke_px(obj, stroke_only=True)
    style_line(conn, stroke_color, sw)

    # Connector text overlay if text exists
    if obj.html or obj.text:
        left = to_emu(min(x1, x2))
        top = to_emu(min(y1, y2))
        width = to_emu(max(abs(x2 - x1), 1.0))
        height = to_emu(max(abs(y2 - y1), 1.0))
        tb = slide.shapes.add_textbox(left, top, width, height)
        tb.fill.background()
        tb.line.fill.background()
        populate_text_frame(tb.text_frame, obj, resolver, is_shape=True)
    return conn


def export_shape(slide: Any, obj: SlideObject, resolver: ThemeResolver):
    """Exports a shape or connector to the PowerPoint slide, supporting all frontend catalogue shapes."""
    if shape_geometry.is_line(obj):
        return export_line(slide, obj, resolver)

    left = to_emu(obj.x)
    top = to_emu(obj.y)
    width = to_emu(obj.w)
    height = to_emu(obj.h)

    shape_kind = (obj.shape or "rect").lower()
    stroke_only = shape_kind in shape_geometry.STROKE_ONLY

    # Standard CSS-box shapes (rect, rounded, ellipse)
    if shape_kind in ("rect", "rounded", "ellipse"):
        if shape_kind == "rounded":
            mso_type = MSO_SHAPE.ROUNDED_RECTANGLE
        elif shape_kind == "ellipse":
            mso_type = MSO_SHAPE.OVAL
        else:
            mso_type = MSO_SHAPE.RECTANGLE

        sp = slide.shapes.add_shape(mso_type, left, top, width, height)
        strip_style(sp)

        if shape_kind == "rounded":
            min_dim = min(obj.w, obj.h)
            if min_dim > 0:
                sp.adjustments[0] = min(0.5, (obj.cornerRadius or 16.0) / min_dim)

        fill_color = resolver.resolve_color(obj.fill)
        if fill_color:
            sp.fill.solid()
            sp.fill.fore_color.rgb = fill_color
        else:
            sp.fill.background()

        stroke_color = resolver.resolve_color(obj.stroke)
        if stroke_color and (obj.strokeWidth is None or obj.strokeWidth > 0):
            style_line(sp, stroke_color, stroke_px(obj))
        else:
            sp.line.fill.background()

        if obj.html or obj.text:
            populate_text_frame(sp.text_frame, obj, resolver, is_shape=True)
        return

    # All custom shapes (including stroke_only shapes brace and scalebar)
    sp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    strip_style(sp)
    cmds = shape_geometry.commands(shape_kind, obj.adj)
    set_custgeom(sp, cmds, filled=not stroke_only)

    if stroke_only:
        sp.fill.background()
        stroke_color = resolver.resolve_color(obj.stroke or "accent")
        sw = stroke_px(obj, stroke_only=True)
        style_line(sp, stroke_color, sw)
    else:
        fill_color = resolver.resolve_color(obj.fill)
        if fill_color:
            sp.fill.solid()
            sp.fill.fore_color.rgb = fill_color
        else:
            sp.fill.background()

        stroke_color = resolver.resolve_color(obj.stroke)
        if stroke_color and (obj.strokeWidth is None or obj.strokeWidth > 0):
            style_line(sp, stroke_color, stroke_px(obj))
        else:
            sp.line.fill.background()

    if obj.html or obj.text:
        populate_text_frame(sp.text_frame, obj, resolver, is_shape=True)


def export_textbox(slide: Any, obj: SlideObject, resolver: ThemeResolver):
    """Exports a native text box to the PowerPoint slide."""
    left = to_emu(obj.x)
    top = to_emu(obj.y)
    width = to_emu(obj.w)
    height = to_emu(obj.h)

    tb = slide.shapes.add_textbox(left, top, width, height)

    # Optional background fill & outline for textbox
    if obj.fill:
        fc = resolver.resolve_color(obj.fill)
        if fc:
            tb.fill.solid()
            tb.fill.fore_color.rgb = fc
    if obj.stroke and obj.strokeWidth:
        sc = resolver.resolve_color(obj.stroke)
        if sc:
            style_line(tb, sc, float(obj.strokeWidth))

    populate_text_frame(tb.text_frame, obj, resolver, is_shape=False)
    return tb



# ---------------------------------------------------------------------------
# Image-adjustment helpers
# ---------------------------------------------------------------------------

def _get_img_adj(obj: SlideObject) -> dict:
    """Return the imgAdj dict (or {}) from an image object's extra fields."""
    raw = getattr(obj, "imgAdj", None)
    if isinstance(raw, dict):
        return raw
    extra = getattr(obj, "__pydantic_extra__", None) or {}
    v = extra.get("imgAdj") or {}
    return v if isinstance(v, dict) else {}


def _decode_image_bytes(src: Optional[str]) -> Optional[bytes]:
    """Decode a data-URL or file path to raw bytes."""
    if not src:
        return None
    if src.startswith("data:"):
        try:
            _, encoded = src.split(",", 1)
            return base64.b64decode(encoded)
        except Exception:
            return None
    if os.path.isfile(src):
        try:
            with open(src, "rb") as fh:
                return fh.read()
        except Exception:
            return None
    return None


def _apply_pptx_image_effects(pic: Any, adj: dict) -> None:
    """Apply native PPTX picture colour effects (lum, sat, grayscale).

    Maps accurately for brightness/contrast/saturation/grayscale.
    Tint has no native equivalent and is baked by Pillow before export.
    """
    from lxml import etree as _et

    brightness = float(adj.get("brightness") or 0)
    contrast   = float(adj.get("contrast") or 0)
    saturation = float(adj.get("saturation") or 0)
    grayscale  = float(adj.get("grayscale") or 0)

    if brightness == 0 and contrast == 0 and saturation == 0 and grayscale == 0:
        return

    try:
        pic_el = pic._element
        A_NS_L = "http://schemas.openxmlformats.org/drawingml/2006/main"
        blip = pic_el.find(f".//{{{A_NS_L}}}blip")
        if blip is None:
            return

        # Clear previous transforms
        for tag in ("lum", "grayscl", "satMod"):
            for el in blip.findall(f"{{{A_NS_L}}}{tag}"):
                blip.remove(el)

        # Full grayscale
        if grayscale >= 99:
            _et.SubElement(blip, f"{{{A_NS_L}}}grayscl")
            return

        # Luminance (brightness + contrast)
        if brightness != 0 or contrast != 0:
            lum_el = _et.SubElement(blip, f"{{{A_NS_L}}}lum")
            # OOXML: bright and contrast are in 1/1000 of a percent (range -100000..100000)
            lum_el.set("bright", str(int(round(brightness * 1000))))
            lum_el.set("contrast", str(int(round(contrast * 1000))))

        # Saturation (including partial grayscale via sat reduction)
        eff_sat = saturation
        if 0 < grayscale < 100:
            # Reduce saturation proportional to grayscale fraction
            eff_sat = eff_sat - grayscale * (1 + eff_sat / 100)
        if eff_sat != 0:
            sat_mod = max(0, int(round((1 + eff_sat / 100) * 100000)))
            sat_el = _et.SubElement(blip, f"{{{A_NS_L}}}satMod")
            sat_el.set("val", str(sat_mod))

    except Exception as exc:
        print(f"[exporter] Warning: could not apply native picture effects: {exc}")


def _apply_pptx_crop(pic: Any, adj: dict) -> None:
    """Apply crop framing via python-pptx native crop properties (writes a:srcRect).

    cropL/cropR/cropT/cropB are 0..1 fractions of the image to exclude from each edge.
    """
    crop_l = float(adj.get("cropL") or 0)
    crop_r = float(adj.get("cropR") or 0)
    crop_t = float(adj.get("cropT") or 0)
    crop_b = float(adj.get("cropB") or 0)
    if not (crop_l or crop_r or crop_t or crop_b):
        return
    try:
        if crop_l:
            pic.crop_left = max(0.0, min(0.99, crop_l))
        if crop_r:
            pic.crop_right = max(0.0, min(0.99, crop_r))
        if crop_t:
            pic.crop_top = max(0.0, min(0.99, crop_t))
        if crop_b:
            pic.crop_bottom = max(0.0, min(0.99, crop_b))
    except Exception as exc:
        print(f"[exporter] Warning: could not apply PPTX crop: {exc}")


def bake_image_adjustments(image_bytes: bytes, adj: dict, resolver: ThemeResolver) -> bytes:
    """Apply imgAdj parameters to raw image bytes using Pillow, returning PNG bytes.

    Called when the adjustments include a colour tint (no native PPTX equivalent)
    or when native PPTX effects are insufficient.  The original document src is
    never modified; only the exported copy is baked.
    """
    try:
        from PIL import Image as PILImage, ImageEnhance, ImageOps
    except ImportError:
        print("[exporter] Warning: Pillow not available; image adjustments skipped.")
        return image_bytes

    try:
        img = PILImage.open(io.BytesIO(image_bytes)).convert("RGBA")

        # 1. Crop (fractions 0-1 from each edge)
        crop_l = float(adj.get("cropL") or 0)
        crop_r = float(adj.get("cropR") or 0)
        crop_t = float(adj.get("cropT") or 0)
        crop_b = float(adj.get("cropB") or 0)
        if crop_l or crop_r or crop_t or crop_b:
            w, h = img.size
            left_px   = int(round(crop_l * w))
            right_px  = max(left_px + 1, w - int(round(crop_r * w)))
            top_px    = int(round(crop_t * h))
            bottom_px = max(top_px + 1, h - int(round(crop_b * h)))
            img = img.crop((left_px, top_px, right_px, bottom_px))

        alpha = img.split()[3] if img.mode == "RGBA" else None
        rgb = img.convert("RGB")

        # 2. Brightness  (-100..+100 → Pillow factor 0..2)
        brightness = float(adj.get("brightness") or 0)
        if brightness != 0:
            rgb = ImageEnhance.Brightness(rgb).enhance(max(0.0, 1.0 + brightness / 100.0))

        # 3. Contrast  (-100..+100 → Pillow factor 0..2)
        contrast = float(adj.get("contrast") or 0)
        if contrast != 0:
            rgb = ImageEnhance.Contrast(rgb).enhance(max(0.0, 1.0 + contrast / 100.0))

        # 4. Saturation  (-100 = full desaturate, +100 = double)
        saturation = float(adj.get("saturation") or 0)
        if saturation != 0:
            rgb = ImageEnhance.Color(rgb).enhance(max(0.0, 1.0 + saturation / 100.0))

        # 5. Grayscale (0..100 percent)
        grayscale = float(adj.get("grayscale") or 0)
        if grayscale >= 99:
            rgb = ImageOps.grayscale(rgb).convert("RGB")
        elif grayscale > 0:
            gray_img = ImageOps.grayscale(rgb).convert("RGB")
            rgb = PILImage.blend(rgb, gray_img, grayscale / 100.0)

        # 6. Tint overlay
        tint_color_str = (adj.get("tintColor") or "").strip()
        tint_amount = float(adj.get("tintAmount") or 0)
        if tint_color_str and tint_amount > 0:
            tint_rgb_obj = resolver.resolve_color(tint_color_str)
            if tint_rgb_obj:
                tint_layer = PILImage.new("RGB", rgb.size, (tint_rgb_obj[0], tint_rgb_obj[1], tint_rgb_obj[2]))
                rgb = PILImage.blend(rgb, tint_layer, min(1.0, tint_amount))

        # Reattach alpha
        if alpha is not None:
            if alpha.size != rgb.size:
                alpha = alpha.resize(rgb.size, PILImage.LANCZOS)
            out = rgb.convert("RGBA")
            out.putalpha(alpha)
        else:
            out = rgb

        buf = io.BytesIO()
        out.save(buf, format="PNG")
        return buf.getvalue()
    except Exception as exc:
        print(f"[exporter] Warning: image adjustment baking failed: {exc}")
        return image_bytes


def export_image(slide: Any, obj: SlideObject, resolver: ThemeResolver):
    """Exports an embedded picture to the PowerPoint slide.

    When the image object carries imgAdj (brightness, contrast, saturation,
    grayscale, tintColor/Amount, cropL/R/T/B):
    - Pure tone adjustments (no tint) use native PPTX blip effects + srcRect crop.
    - Tint (no native PPTX equivalent): Pillow bakes a raster copy at export time;
      the original src in the document is never modified.
    """
    left = to_emu(obj.x)
    top = to_emu(obj.y)
    width = to_emu(obj.w)
    height = to_emu(obj.h)

    src = obj.src
    image_bytes = _decode_image_bytes(src)

    if image_bytes:
        adj = _get_img_adj(obj)
        has_adj = bool(adj)

        tint_color = (adj.get("tintColor") or "").strip()
        tint_amount = float(adj.get("tintAmount") or 0)
        has_tint = bool(tint_color) and tint_amount > 0
        has_crop = any(float(adj.get(k) or 0) for k in ("cropL", "cropR", "cropT", "cropB"))

        export_bytes = image_bytes
        baked_adj: dict = {}

        if has_adj and has_tint:
            # Bake everything (crop + tone + tint) into a single raster
            export_bytes = bake_image_adjustments(image_bytes, adj, resolver)
            baked_adj = {}  # effects already embedded; don't double-apply
        elif has_adj:
            # Use native PPTX effects; no baking needed
            baked_adj = adj

        img_stream = io.BytesIO(export_bytes)
        try:
            pic = slide.shapes.add_picture(img_stream, left, top, width, height)

            if baked_adj:
                _apply_pptx_image_effects(pic, baked_adj)
                if has_crop:
                    _apply_pptx_crop(pic, baked_adj)

            if obj.stroke and obj.strokeWidth:
                sc = resolver.resolve_color(obj.stroke)
                if sc:
                    style_line(pic, sc, float(obj.strokeWidth))
            return
        except Exception as e:
            print(f"[exporter] Warning: Failed to add picture to slide: {e}")

    # Fallback placeholder shape
    ph = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, left, top, width, height)
    strip_style(ph)
    ph.fill.solid()
    ph.fill.fore_color.rgb = RGBColor(244, 242, 239)
    style_line(ph, RGBColor(217, 213, 208), 1.5)
    tf = ph.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = obj.name or "Image Placeholder"
    r.font.size = Pt(14)
    r.font.color.rgb = RGBColor(94, 91, 98)


FIGURE_PLACEHOLDER_NOTE = "Figure image not available in this file"


def _figure_name(obj: SlideObject) -> str:
    return (obj.name or "").strip() or str(getattr(obj, "figureId", None) or obj.id or "Figure")


def _warn(warnings: Optional[list], slide_no: int, obj: SlideObject, code: str, message: str) -> None:
    if warnings is not None:
        warnings.append({"code": code, "slide": slide_no, "objectId": obj.id,
                         "name": _figure_name(obj), "message": message})


def _decode_figure_png(src: Optional[str]) -> Optional[Tuple[bytes, int, int]]:
    """Return (bytes, width_px, height_px) of an embedded image data URL, else None. Bytes are never re-encoded."""
    if not src or not src.startswith("data:image/"):
        return None
    try:
        data = base64.b64decode(src.split(",", 1)[1], validate=False)
        from PIL import Image  # python-pptx dependency
        with Image.open(io.BytesIO(data)) as im:
            w, h = im.size
        return (data, w, h) if w > 0 and h > 0 else None
    except Exception:
        return None


def export_figure_picture(
    slide: Any, obj: SlideObject, resolver: ThemeResolver, warnings: Optional[list] = None, slide_no: int = 0
) -> None:
    """Plot/figure object -> ordinary picture (original bytes, no crop, aspect kept) or a visible placeholder."""
    name = _figure_name(obj)
    decoded = _decode_figure_png(obj.src)
    if decoded is None:
        missing = not obj.src
        _warn(warnings, slide_no, obj, "figure_image_missing" if missing else "figure_image_unreadable",
              f'Figure "{name}" has no picture to export; a placeholder was written instead.' if missing
              else f'Figure "{name}" has an unreadable picture; a placeholder was written instead.')
        left, top, width, height = to_emu(obj.x), to_emu(obj.y), to_emu(obj.w), to_emu(obj.h)
        tb = slide.shapes.add_textbox(left, top, width, height)
        tb.name = f"Figure \u2013 {name} (image missing)"
        tb.fill.solid()
        tb.fill.fore_color.rgb = RGBColor(244, 242, 239)
        style_line(tb, RGBColor(217, 213, 208), 1.5)
        tf = tb.text_frame
        tf.word_wrap = True
        tf.auto_size = MSO_AUTO_SIZE.NONE  # keep the frame at the object geometry
        tf.vertical_anchor = MSO_ANCHOR.MIDDLE
        for i, (text, size, bold) in enumerate(((name, 14, True), (FIGURE_PLACEHOLDER_NOTE, 11, False))):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
            p.alignment = PP_ALIGN.CENTER
            r = p.add_run()
            r.text = text
            r.font.size = Pt(size)
            r.font.bold = bold
            r.font.color.rgb = RGBColor(94, 91, 98)
        if obj.alt:
            tb._element.nvSpPr.cNvPr.set("descr", obj.alt)
        return

    data, px_w, px_h = decoded
    left, top, width, height = to_emu(obj.x), to_emu(obj.y), to_emu(obj.w), to_emu(obj.h)
    want_h = int(round(width * px_h / px_w))
    if abs(height - want_h) > EMU_PER_PIXEL:  # frame disagrees with the picture: keep the width, never stretch
        _warn(warnings, slide_no, obj, "figure_aspect_adjusted",
              f'Figure "{name}" frame did not match its picture; the height was set to keep the picture\'s proportions.')
        height = want_h
    pic = slide.shapes.add_picture(io.BytesIO(data), left, top, width, height)
    pic.name = f"Figure \u2013 {name}"
    pic._element.nvPicPr.cNvPr.set("descr", obj.alt or "")  # alt text only from object.alt (not python-pptx's file name)
    if obj.stroke and obj.strokeWidth:
        sc = resolver.resolve_color(obj.stroke)
        if sc:
            style_line(pic, sc, float(obj.strokeWidth))


def blend_channel(fg: int, a: float, bg: int) -> int:
    return math.floor(fg * a + bg * (1.0 - a) + 0.5)


def blend_rgb(fg: Tuple[int, int, int], a: float, bg: Tuple[int, int, int]) -> Tuple[int, int, int]:
    return (
        blend_channel(fg[0], a, bg[0]),
        blend_channel(fg[1], a, bg[1]),
        blend_channel(fg[2], a, bg[2]),
    )


def compute_table_tints(slide_bg: Optional[str], is_dark: bool, resolver: ThemeResolver) -> Tuple[str, str]:
    bg_color = parse_any_color(slide_bg, resolver) or (
        RGBColor(30, 33, 40) if is_dark else RGBColor(255, 255, 255)
    )
    bg_tuple = (bg_color[0], bg_color[1], bg_color[2])
    fg_band = (255, 255, 255) if is_dark else (112, 45, 59)
    a_band = 0.05
    fg_line = (255, 255, 255) if is_dark else (0, 0, 0)
    a_line = 0.18 if is_dark else 0.14

    band_rgb = blend_rgb(fg_band, a_band, bg_tuple)
    line_rgb = blend_rgb(fg_line, a_line, bg_tuple)

    band_hex = f"#{band_rgb[0]:02X}{band_rgb[1]:02X}{band_rgb[2]:02X}"
    line_hex = f"#{line_rgb[0]:02X}{line_rgb[1]:02X}{line_rgb[2]:02X}"
    return band_hex, line_hex


def compute_table_geometry(obj: SlideObject) -> Dict[str, Any]:
    cells = obj.cells or []
    rows = len(cells)
    cols = max(len(r) for r in cells) if rows else 0
    if rows == 0 or cols == 0:
        return {"rows": 0, "cols": 0, "colW": [], "rowH": []}

    ow = float(obj.w) if obj.w and obj.w > 0 else float(cols * 100)
    oh = float(obj.h) if obj.h and obj.h > 0 else float(rows * 40)

    if obj.colW and len(obj.colW) == cols and all(isinstance(v, (int, float)) and v > 0 for v in obj.colW):
        col_w = [float(v) for v in obj.colW]
    else:
        col_w = [ow / cols] * cols
    sum_w = sum(col_w)
    if sum_w > 0 and abs(sum_w - ow) > 1e-4:
        col_w = [(w * ow) / sum_w for w in col_w]

    if obj.rowH and len(obj.rowH) == rows and all(isinstance(v, (int, float)) and v > 0 for v in obj.rowH):
        row_h = [float(v) for v in obj.rowH]
    else:
        row_h = [oh / rows] * rows
    sum_h = sum(row_h)
    if sum_h > 0 and abs(sum_h - oh) > 1e-4:
        row_h = [(h * oh) / sum_h for h in row_h]

    return {"rows": rows, "cols": cols, "colW": col_w, "rowH": row_h}


def compute_edges_emu(pixel_lengths: List[float], total_pixel: float) -> List[int]:
    """Cumulative-edge rounding so sum(col_k) == to_emu(total_pixel) exactly."""
    if not pixel_lengths:
        return []
    total_emu = to_emu(total_pixel)
    cum_px = 0.0
    prev_edge = 0
    emus = []
    n = len(pixel_lengths)
    for i in range(n - 1):
        cum_px += pixel_lengths[i]
        edge = to_emu(cum_px)
        emus.append(edge - prev_edge)
        prev_edge = edge
    emus.append(total_emu - prev_edge)
    return emus


def resolve_table_border(
    obj: SlideObject, slide_bg: Optional[str], is_dark: bool, resolver: ThemeResolver
) -> Tuple[float, Optional[str]]:
    band_tint_hex, line_color_hex = compute_table_tints(slide_bg, is_dark, resolver)
    tb = obj.tableBorder
    if tb is None:
        return 1.0, line_color_hex

    width = tb.width if tb.width is not None else 1.0
    if width == 0 or tb.color is None or (isinstance(tb.color, str) and tb.color.lower() in ("none", "transparent")):
        return 0.0, None

    col_rgb = parse_any_color(tb.color, resolver)
    if col_rgb:
        color_hex = f"#{col_rgb[0]:02X}{col_rgb[1]:02X}{col_rgb[2]:02X}"
    else:
        color_hex = line_color_hex
    return float(width), color_hex


def resolve_cell(
    obj: SlideObject,
    r: int,
    c: int,
    slide_bg: Optional[str],
    is_dark: bool,
    resolver: ThemeResolver,
) -> Dict[str, Any]:
    key = f"{r},{c}"
    fmt = None
    if obj.cellFmt:
        if isinstance(obj.cellFmt, dict):
            fmt = obj.cellFmt.get(key)
    if fmt is not None and not isinstance(fmt, dict):
        fmt = fmt.model_dump(exclude_unset=True)
    fmt = fmt or {}

    is_header = bool(obj.headerRow and r == 0)
    is_band = bool(obj.banded and r > 0 and r % 2 == 0)
    band_tint_hex, line_color_hex = compute_table_tints(slide_bg, is_dark, resolver)

    accent_rgb = resolver.resolve_color("accent") or RGBColor(112, 45, 59)
    accent_hex = f"#{accent_rgb[0]:02X}{accent_rgb[1]:02X}{accent_rgb[2]:02X}"
    text_rgb = resolver.resolve_color("text") or RGBColor(41, 42, 45)
    text_hex = f"#{text_rgb[0]:02X}{text_rgb[1]:02X}{text_rgb[2]:02X}"
    body_font = resolver.resolve_font(None)

    # 1. Fill: cellFmt > header default > band default > None
    if "fill" in fmt and fmt["fill"] is not None:
        f_val = str(fmt["fill"]).strip().lower()
        if f_val in ("none", "transparent"):
            fill = None
        else:
            col_rgb = parse_any_color(fmt["fill"], resolver)
            fill = f"#{col_rgb[0]:02X}{col_rgb[1]:02X}{col_rgb[2]:02X}" if col_rgb else None
    elif "fill" in fmt and fmt["fill"] is None:
        fill = None
    elif is_header:
        fill = accent_hex
    elif is_band:
        fill = band_tint_hex
    else:
        fill = None

    # 2. Color: cellFmt > header default > obj.color > theme.text
    if fmt.get("color") is not None:
        col_rgb = parse_any_color(fmt["color"], resolver)
        color = f"#{col_rgb[0]:02X}{col_rgb[1]:02X}{col_rgb[2]:02X}" if col_rgb else text_hex
    elif is_header:
        color = resolver.theme.get("onAccent") or resolver.theme.get("onaccent") or "#FFFFFF"   # palette on-accent text
    elif obj.color:
        col_rgb = parse_any_color(obj.color, resolver)
        color = f"#{col_rgb[0]:02X}{col_rgb[1]:02X}{col_rgb[2]:02X}" if col_rgb else text_hex
    else:
        color = text_hex

    # 3. Font: cellFmt > obj.font > theme body font
    if fmt.get("font"):
        font = resolver.resolve_font(fmt["font"])
    elif obj.font:
        font = resolver.resolve_font(obj.font)
    else:
        font = body_font

    # 4. FontSize: cellFmt > obj.fontSize > 16
    if fmt.get("fontSize") is not None and fmt["fontSize"] > 0:
        fontSize = float(fmt["fontSize"])
    elif obj.fontSize is not None and obj.fontSize > 0:
        fontSize = float(obj.fontSize)
    else:
        fontSize = 16.0

    # 5. Bold: cellFmt > header default (True) > obj.bold > False
    if fmt.get("bold") is not None:
        bold = bool(fmt["bold"])
    elif is_header:
        bold = True
    elif obj.bold is not None:
        bold = bool(obj.bold)
    else:
        bold = False

    # 6. Italic: cellFmt > obj.italic > False
    if fmt.get("italic") is not None:
        italic = bool(fmt["italic"])
    elif obj.italic is not None:
        italic = bool(obj.italic)
    else:
        italic = False

    # 7. Underline: cellFmt > obj.underline > False
    if fmt.get("underline") is not None:
        underline = bool(fmt["underline"])
    elif obj.underline is not None:
        underline = bool(obj.underline)
    else:
        underline = False

    # 8. Strike: cellFmt > obj.strike > False
    if fmt.get("strike") is not None:
        strike = bool(fmt["strike"])
    elif obj.strike is not None:
        strike = bool(obj.strike)
    else:
        strike = False

    # 9. Align: cellFmt > obj.align > 'left'
    if fmt.get("align"):
        align = str(fmt["align"]).lower()
    elif obj.align:
        align = str(obj.align).lower()
    else:
        align = "left"

    # 10. vAlign: cellFmt > 'middle' (GOTCHA: never read obj.vAlign)
    if fmt.get("vAlign"):
        vAlign = str(fmt["vAlign"]).lower()
    else:
        vAlign = "middle"

    # 11. Subscript & Superscript: cellFmt > obj-level > False; mutually exclusive
    if fmt.get("subscript") is not None:
        subscript = bool(fmt["subscript"])
    elif obj.subscript is not None:
        subscript = bool(obj.subscript)
    else:
        subscript = False

    if fmt.get("superscript") is not None:
        superscript = bool(fmt["superscript"])
    elif obj.superscript is not None:
        superscript = bool(obj.superscript)
    else:
        superscript = False

    # Enforce mutual exclusivity: cell-level fmt wins; fallback prefers subscript
    if subscript and superscript:
        if fmt.get("subscript"):
            superscript = False
        else:
            subscript = False

    # Derive baseline integer (thousandths of a percent of font size)
    if subscript:
        baseline = -25000
    elif superscript:
        baseline = 30000
    else:
        baseline = 0

    return {
        "fill": fill,
        "color": color,
        "font": font,
        "fontSize": fontSize,
        "bold": bold,
        "italic": italic,
        "underline": underline,
        "strike": strike,
        "align": align,
        "vAlign": vAlign,
        "subscript": subscript,
        "superscript": superscript,
        "baseline": baseline,
    }


def export_table(
    slide: Any,
    obj: SlideObject,
    resolver: ThemeResolver,
    slide_model: Optional[SlideModel] = None,
):
    """Exports an editable table to the PowerPoint slide with exact fidelity."""
    geom = compute_table_geometry(obj)
    rows = geom["rows"]
    cols = geom["cols"]
    if rows == 0 or cols == 0:
        return

    slide_bg = slide_model.bg if slide_model else None
    is_dark = bool(resolver.theme.get("dark", False))

    col_emus = compute_edges_emu(geom["colW"], obj.w)
    row_emus = compute_edges_emu(geom["rowH"], obj.h)
    total_w_emu = sum(col_emus)
    total_h_emu = sum(row_emus)

    left = to_emu(obj.x)
    top = to_emu(obj.y)

    table_shape = slide.shapes.add_table(rows, cols, left, top, total_w_emu, total_h_emu)
    table = table_shape.table
    tbl = table._tbl

    # Set exact frame and column / row dimensions
    table_shape.width = total_w_emu
    table_shape.height = total_h_emu
    for c_idx in range(cols):
        table.columns[c_idx].width = col_emus[c_idx]
    for r_idx in range(rows):
        table.rows[r_idx].height = row_emus[r_idx]

    # Section 7: tblPr configuration
    tblPr = tbl.tblPr
    tblPr.set("firstRow", "1" if obj.headerRow else "0")
    tblPr.set("bandRow", "0")
    tbl_style_id = tblPr.find("{http://schemas.openxmlformats.org/drawingml/2006/main}tableStyleId")
    if tbl_style_id is not None:
        tbl_style_id.text = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}"
    else:
        tblPr.append(parse_xml('<a:tableStyleId xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">{2D5ABB26-0587-4C30-8999-92F81FD0307C}</a:tableStyleId>'))

    # Border configuration
    border_w, border_color_hex = resolve_table_border(obj, slide_bg, is_dark, resolver)
    border_emu = round(border_w * 9525) if border_w > 0 else 0
    border_color_clean = border_color_hex.lstrip("#") if border_color_hex else None

    ALIGN_MAP = {
        "left": PP_ALIGN.LEFT,
        "center": PP_ALIGN.CENTER,
        "right": PP_ALIGN.RIGHT,
        "justify": PP_ALIGN.JUSTIFY,
    }
    ANCHOR_MAP = {
        "top": "t",
        "middle": "ctr",
        "center": "ctr",
        "bottom": "b",
    }

    cells_data = obj.cells or []
    for r_idx in range(rows):
        row_data = cells_data[r_idx] if r_idx < len(cells_data) else []
        for c_idx in range(cols):
            cell = table.cell(r_idx, c_idx)
            val = row_data[c_idx] if c_idx < len(row_data) else ""
            res = resolve_cell(obj, r_idx, c_idx, slide_bg, is_dark, resolver)

            # Section 7: tcPr schema ordering:
            # Attributes: marL=95250, marR=95250, marT=38100, marB=38100, anchor=t|ctr|b
            # Children in schema order: lnL, lnR, lnT, lnB, THEN fill (solidFill or noFill)
            tcPr = cell._tc.get_or_add_tcPr()
            tcPr.clear()
            tcPr.set("marL", "95250")
            tcPr.set("marR", "95250")
            tcPr.set("marT", "38100")
            tcPr.set("marB", "38100")
            tcPr.set("anchor", ANCHOR_MAP.get(res["vAlign"], "ctr"))

            # Borders on all four sides: lnL, lnR, lnT, lnB
            for side in ("lnL", "lnR", "lnT", "lnB"):
                if border_emu > 0 and border_color_clean:
                    ln_xml = f'<a:{side} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" w="{border_emu}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="{border_color_clean}"/></a:solidFill><a:prstDash val="solid"/></a:{side}>'
                else:
                    ln_xml = f'<a:{side} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" w="0"><a:noFill/></a:{side}>'
                tcPr.append(parse_xml(ln_xml))

            # Fill (strictly after ln*)
            if res["fill"]:
                fill_clean = res["fill"].lstrip("#")
                tcPr.append(parse_xml(f'<a:solidFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:srgbClr val="{fill_clean}"/></a:solidFill>'))
            else:
                tcPr.append(parse_xml('<a:noFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"/>'))

            # Paragraph and text
            tf = cell.text_frame
            tf.word_wrap = True
            p = tf.paragraphs[0]
            p.text = ""
            p.alignment = ALIGN_MAP.get(res["align"], PP_ALIGN.LEFT)
            # Use exact-point line spacing (spcPts = fontSize * 1.2 * 100) instead of
            # spcPct so PowerPoint does NOT add half-leading above the first line,
            # which would push text ~2-3px lower than the canvas preview.
            # spcBef/spcAft are zeroed to suppress any inherited table-style spacing.
            _lnspc_pts = int(round(res["fontSize"] * 1.2 * 100))  # e.g. 16pt -> 1920
            p_pr = p._p.get_or_add_pPr()
            p_pr.append(parse_xml(f'<a:lnSpc xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:spcPts val="{_lnspc_pts}"/></a:lnSpc>'))
            p_pr.append(parse_xml('<a:spcBef xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:spcPts val="0"/></a:spcBef>'))
            p_pr.append(parse_xml('<a:spcAft xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:spcPts val="0"/></a:spcAft>'))

            cell_str = str(val) if val is not None else ""

            # Detect rich HTML cell (contains sub/sup tags or vertical-align style)
            _is_rich_cell = cell_str and ("<sub" in cell_str or "<sup" in cell_str or "vertical-align" in cell_str)

            if _is_rich_cell:
                # Parse through the HTML parser so <sub>/<sup> become proper
                # DrawingML baseline runs within the cell.
                _html_paras = parse_html_to_paragraphs(
                    cell_str,
                    default_bold=res["bold"],
                    default_italic=res["italic"],
                    default_underline=res["underline"],
                    default_strike=res["strike"],
                    default_color=parse_hex_color(res["color"]),
                    default_size=res["fontSize"],
                    default_font=res["font"],
                    default_baseline=res["baseline"] if res["baseline"] != 0 else None,
                    resolver=resolver,
                )
                # Write all parsed runs into the existing paragraph (ignore
                # paragraph breaks inside a cell — collapse to flat runs)
                for _p_data in _html_paras:
                    for _run_data in _p_data.runs:
                        if not _run_data.text:
                            continue
                        _run = p.add_run()
                        _run.text = _run_data.text
                        _rpr = _run._r.get_or_add_rPr()
                        _sz = _run_data.size or res["fontSize"]
                        _rpr.set("sz", str(int(round(_sz * 100))))
                        _rpr.set("b", "1" if (_run_data.bold if _run_data.bold is not None else res["bold"]) else "0")
                        _rpr.set("i", "1" if (_run_data.italic if _run_data.italic is not None else res["italic"]) else "0")
                        _rpr.set("u", "sng" if (_run_data.underline if _run_data.underline is not None else res["underline"]) else "none")
                        _rpr.set("strike", "sngStrike" if (_run_data.strike if _run_data.strike is not None else res["strike"]) else "noStrike")
                        _bl = _run_data.baseline if _run_data.baseline is not None else res["baseline"]
                        if _bl and _bl != 0:
                            _rpr.set("baseline", str(int(_bl)))
                        _run.font.color.rgb = _run_data.color or parse_hex_color(res["color"])
                        _fn = _run_data.font or res["font"]
                        _run.font.name = _fn
                        for _tag_name in ("ea", "cs"):
                            _el = _rpr.find(f"{{http://schemas.openxmlformats.org/drawingml/2006/main}}{_tag_name}")
                            if _el is None:
                                _rpr.append(parse_xml(f'<a:{_tag_name} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="{_fn}"/>'))
                            else:
                                _el.set("typeface", _fn)
                if not any(rd.text for pd in _html_paras for rd in pd.runs):
                    # Fallback: empty parsed result → plain endParaRPr
                    _ep = p._p.find("{http://schemas.openxmlformats.org/drawingml/2006/main}endParaRPr")
                    if _ep is not None:
                        p._p.remove(_ep)
                    p._p.append(parse_xml(
                        f'<a:endParaRPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" sz="{int(round(res["fontSize"] * 100))}">'
                        f'<a:latin typeface="{res["font"]}"/>'
                        f'<a:ea typeface="{res["font"]}"/>'
                        f'<a:cs typeface="{res["font"]}"/>'
                        f'</a:endParaRPr>'
                    ))
            elif cell_str:
                run = p.add_run()
                run.text = cell_str
                rpr = run._r.get_or_add_rPr()
                rpr.set("sz", str(int(round(res["fontSize"] * 100))))
                if res["bold"]:
                    rpr.set("b", "1")
                else:
                    rpr.set("b", "0")
                if res["italic"]:
                    rpr.set("i", "1")
                else:
                    rpr.set("i", "0")
                if res["underline"]:
                    rpr.set("u", "sng")
                else:
                    rpr.set("u", "none")
                if res["strike"]:
                    rpr.set("strike", "sngStrike")
                else:
                    rpr.set("strike", "noStrike")
                # Subscript / superscript baseline on plain-text cell
                if res["baseline"] != 0:
                    rpr.set("baseline", str(int(res["baseline"])))

                run.font.color.rgb = parse_hex_color(res["color"])
                run.font.name = res["font"]

                for tag_name in ("ea", "cs"):
                    el = rpr.find(f"{{http://schemas.openxmlformats.org/drawingml/2006/main}}{tag_name}")
                    if el is None:
                        el = parse_xml(f'<a:{tag_name} xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" typeface="{res["font"]}"/>')
                        rpr.append(el)
                    else:
                        el.set("typeface", res["font"])
            else:
                # Empty cell: add endParaRPr
                end_rpr = p._p.find("{http://schemas.openxmlformats.org/drawingml/2006/main}endParaRPr")
                if end_rpr is not None:
                    p._p.remove(end_rpr)
                p._p.append(parse_xml(
                    f'<a:endParaRPr xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" sz="{int(round(res["fontSize"] * 100))}">'
                    f'<a:latin typeface="{res["font"]}"/>'
                    f'<a:ea typeface="{res["font"]}"/>'
                    f'<a:cs typeface="{res["font"]}"/>'
                    f'</a:endParaRPr>'
                ))


def export_theme_decor(slide: Any, slide_model: SlideModel, doc: PresentationDoc, resolver: ThemeResolver):
    """Adds theme decorative lines matching frontend decor renderer."""
    theme = resolver.theme
    decor = theme.get("decor")
    if not decor:
        return

    is_title = slide_model.layout in ("title", "section")
    size_w = doc.size.w
    size_h = doc.size.h

    if decor == "rule":
        if is_title:
            # 30px accent + 6px accent2 vertical bar on the left
            sp1 = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, to_emu(30), to_emu(size_h))
            strip_style(sp1)
            sp1.fill.solid()
            sp1.fill.fore_color.rgb = resolver.resolve_color("accent")
            sp1.line.fill.background()

            sp2 = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, to_emu(30), 0, to_emu(6), to_emu(size_h))
            strip_style(sp2)
            sp2.fill.solid()
            sp2.fill.fore_color.rgb = resolver.resolve_color("accent2")
            sp2.line.fill.background()
        else:
            # Short accent horizontal bar near top
            x = to_emu(round(size_w * 0.05))
            y = to_emu(30)
            sp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, x, y, to_emu(56), to_emu(4))
            strip_style(sp)
            sp.fill.solid()
            sp.fill.fore_color.rgb = resolver.resolve_color("accent")
            sp.line.fill.background()
    elif decor == "topbar":
        h = 36 if is_title else 12
        sp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, 0, to_emu(size_w), to_emu(h))
        strip_style(sp)
        sp.fill.solid()
        sp.fill.fore_color.rgb = resolver.resolve_color("accent")
        sp.line.fill.background()
        if is_title:
            sp_bot = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, to_emu(size_h - 4), to_emu(size_w), to_emu(4))
            strip_style(sp_bot)
            sp_bot.fill.solid()
            sp_bot.fill.fore_color.rgb = resolver.resolve_color("accent2")
            sp_bot.line.fill.background()
    elif decor == "footer":
        if is_title:
            sp = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, 0, to_emu(size_h - 10), to_emu(size_w), to_emu(10))
            strip_style(sp)
            sp.fill.solid()
            sp.fill.fore_color.rgb = resolver.resolve_color("accent")
            sp.line.fill.background()


def _make_placeholder(shape: Any, ph_type: str, idx: int, name: str) -> None:
    """Turns a freshly exported text box into a native footer / slide-number placeholder that points at the layout's placeholder."""
    sp = shape._element
    c_nv_sp_pr = sp.nvSpPr.cNvSpPr
    c_nv_sp_pr.attrib.pop("txBox", None)
    etree.SubElement(c_nv_sp_pr, qn("a:spLocks")).set("noGrp", "1")
    ph = etree.SubElement(sp.nvSpPr.nvPr, qn("p:ph"))
    ph.set("type", ph_type)
    ph.set("sz", "quarter")
    ph.set("idx", str(idx))
    shape.name = name


def export_header_footer(slide: Any, slide_model: SlideModel, doc: PresentationDoc, resolver: ThemeResolver) -> None:
    """Header and footer of one slide, behind the slide objects (same z-order as the editor).

    Footer: native footer placeholder (``<p:ph type="ftr" idx="11">``, bound to the layout's footer placeholder).
    Header: PowerPoint slides have no header placeholder (headers exist only on notes/handouts), so it is a plain text box
    named "Header" at the header region. Nothing is emitted for a region without text (no empty placeholders).
    """
    for key in hfmod.KEYS:
        d = hfmod.view(doc, slide_model, key)
        if not d:
            continue
        shape = export_textbox(slide, SlideObject(**d), resolver)
        if key == "footer":
            _make_placeholder(shape, "ftr", 11, "Footer Placeholder")
        else:
            shape.name = "Header"


def _slidenum_paragraph(p: Any, doc: PresentationDoc, resolver: ThemeResolver, text: str, static: bool) -> None:
    """Fills paragraph ``p`` with the slide-number text: a native ``slidenum`` field (cached value ``text``), or a plain run when
    ``static`` (PDF path: LibreOffice ignores ``firstSlideNum``, so the computed value is baked in). Style comes from doc.hf.numberItem
    (defaults: body font, 12pt, muted, right aligned) and is identical on slides, layout and master placeholders."""
    st = hfmod.number_style(doc)
    for child in list(p):
        p.remove(child)
    algn = {"left": "l", "center": "ctr", "right": "r"}.get(st["align"], "r")
    p.append(parse_xml(f'<a:pPr xmlns:a="{A_NS}" algn="{algn}"/>'))
    color = resolver.resolve_color(st["color"], fallback="muted")
    font = resolver.resolve_font(st.get("font"))
    attrs = (
        f'lang="en-US" sz="{int(round(float(st["fontSize"]) * 100))}" b="{int(bool(st["bold"]))}" i="{int(bool(st["italic"]))}"'
        + (' u="sng"' if st["underline"] else "")
        + ' dirty="0"'
    )
    rpr = (
        f'<a:rPr {attrs}>'
        + (f'<a:solidFill><a:srgbClr val="{color}"/></a:solidFill>' if color is not None else "")
        + f'<a:latin typeface="{html.escape(font, quote=True)}"/></a:rPr>'
    )
    if static:
        p.append(parse_xml(f'<a:r xmlns:a="{A_NS}">{rpr}<a:t>{html.escape(text)}</a:t></a:r>'))
    else:
        p.append(parse_xml(
            f'<a:fld xmlns:a="{A_NS}" id="{{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}}" type="slidenum">{rpr}<a:t>{html.escape(text)}</a:t></a:fld>'
        ))


def _slide_has_number(slide: Any) -> bool:
    """True when the slide already carries a slide-number placeholder or a slidenum field (never add a second one)."""
    return bool(slide._element.xpath('.//p:ph[@type="sldNum"] | .//a:fld[@type="slidenum"]'))


def export_slide_number(
    slide: Any, slide_model: SlideModel, doc: PresentationDoc, resolver: ThemeResolver, number: int, static: bool = False
) -> None:
    """Native slide-number placeholder (``<p:ph type="sldNum" idx="12">``) with a live slidenum field, on top of the slide.

    Honors doc.hf (``number: false`` = off, hidden on layout "title", per-slide ``hf.number`` override, ``startAt`` via ``number``,
    ``numberItem`` style + position). No-op when the slide already has a number placeholder / field.
    """
    if not hfmod.number_on(doc, slide_model) or _slide_has_number(slide):
        return
    g = hfmod.number_geom(doc)
    shape = slide.shapes.add_textbox(to_emu(g["x"]), to_emu(g["y"]), to_emu(g["w"]), to_emu(g["h"]))
    tf = shape.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.vertical_anchor = MSO_ANCHOR.BOTTOM
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    _slidenum_paragraph(tf._txBody.p_lst[0], doc, resolver, str(number), static)
    _make_placeholder(shape, "sldNum", 12, "Slide Number Placeholder")


def align_footer_placeholders(prs: Any, doc: PresentationDoc, resolver: Optional[ThemeResolver] = None) -> None:
    """Moves the footer / slide-number placeholders of the master and the blank layout to the editor's regions (and gives the
    slide-number ones the same field + typography), so a slide placeholder that is reset in PowerPoint lands where the editor draws it."""
    from pptx.enum.shapes import PP_PLACEHOLDER

    targets = {PP_PLACEHOLDER.FOOTER: "footer", PP_PLACEHOLDER.SLIDE_NUMBER: "number"}
    for owner in (prs.slide_master, prs.slide_layouts[6]):
        for ph in owner.placeholders:
            key = targets.get(ph.placeholder_format.type)
            if key:
                g = hfmod.number_geom(doc) if key == "number" else hfmod.region(key, doc.size.w, doc.size.h)
                ph.left, ph.top, ph.width, ph.height = to_emu(g["x"]), to_emu(g["y"]), to_emu(g["w"]), to_emu(g["h"])
                if key == "number" and resolver is not None:
                    tf = ph.text_frame
                    tf.vertical_anchor = MSO_ANCHOR.BOTTOM
                    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
                    _slidenum_paragraph(tf._txBody.p_lst[0], doc, resolver, "\u2039#\u203a", False)


def set_theme_fonts(prs: Any, major: str, minor: str) -> None:
    """Write the presentation's theme fonts (a:majorFont = headings, a:minorFont = body) into the theme part, so PowerPoint's
    theme-font pickers and any text that inherits the theme use the active typography preset."""
    from pptx.opc.constants import RELATIONSHIP_TYPE as RT

    try:
        part = prs.slide_master.part.part_related_by(RT.THEME)
    except KeyError:
        return
    xml = part.blob.decode("utf-8")
    for tag, face in (("majorFont", major), ("minorFont", minor)):
        xml, n = re.subn(
            r'(<a:%s>\s*<a:latin typeface=")[^"]*(")' % tag,
            lambda m, f=html.escape(face, quote=True): m.group(1) + f + m.group(2),
            xml,
            count=1,
        )
    part._blob = xml.encode("utf-8")


def export_presentation(
    doc_or_data: Union[PresentationDoc, dict],
    output: Optional[Union[str, io.BytesIO]] = None,
    warnings: Optional[list] = None,
    static_numbers: bool = False,
) -> io.BytesIO:
    """Exports a presentation document to a PowerPoint (.pptx) file or buffer.

    Args:
        doc_or_data: PresentationDoc instance or raw dictionary conforming to schema.
        output: Optional file path or BytesIO buffer to write to. If None, returns a new BytesIO.
        warnings: Optional list; export notes ({code, slide, objectId, name, message}) are appended to it.
        static_numbers: bake slide numbers as plain text instead of native slidenum fields (used for the PDF conversion).

    Returns:
        io.BytesIO containing the generated .pptx binary package.
    """
    if isinstance(doc_or_data, dict):
        raw_doc = doc_or_data["doc"] if "doc" in doc_or_data and isinstance(doc_or_data["doc"], dict) else doc_or_data
        doc = PresentationDoc.model_validate(migrate_v1_to_v2(raw_doc))
    else:
        doc = doc_or_data

    resolver = ThemeResolver(doc)
    prs = Presentation()
    if resolver.typography:   # theme fonts follow the typography preset (headings = title role, body = body role)
        set_theme_fonts(prs, resolver.resolve_font(None, "title"), resolver.resolve_font(None, "body"))

    # Set slide dimensions accurately
    prs.slide_width = to_emu(doc.size.w)
    prs.slide_height = to_emu(doc.size.h)

    # Blank layout for custom slide design
    blank_layout = prs.slide_layouts[6]
    align_footer_placeholders(prs, doc, resolver)
    start_at = hfmod.number_start(doc)
    if start_at != 1:
        prs._element.set("firstSlideNum", str(start_at))   # PowerPoint "Number slides from"

    for slide_idx, slide_model in enumerate(doc.slides):
        slide = prs.slides.add_slide(blank_layout)

        # Set slide background
        bg_color = resolver.resolve_color(slide_model.bg, fallback=resolver.theme["bg"])
        if bg_color:
            bg_fill = slide.background.fill
            bg_fill.solid()
            bg_fill.fore_color.rgb = bg_color

        # Export theme decoration if enabled
        export_theme_decor(slide, slide_model, doc, resolver)

        # Header / footer / slide number sit behind the slide objects (matches the editor)
        export_header_footer(slide, slide_model, doc, resolver)
        export_slide_number(slide, slide_model, doc, resolver, hfmod.number_value(doc, slide_idx), static_numbers)

        # Export speaker notes if present
        if slide_model.notes and slide_model.notes.strip():
            slide.notes_slide.notes_text_frame.text = slide_model.notes.strip()

        # Export objects in strict back-to-front array order
        for obj in slide_model.objects:
            obj_type = (obj.type or "").lower()
            if obj_type == "text":
                export_textbox(slide, obj, resolver)
            elif obj_type in ("shape", "line"):
                export_shape(slide, obj, resolver)
            elif obj_type == "image":
                export_image(slide, obj, resolver)
            elif obj_type == "table":
                export_table(slide, obj, resolver, slide_model=slide_model)
            elif obj_type in ("plot", "figure"):
                export_figure_picture(slide, obj, resolver, warnings, slide_idx + 1)

    target_stream = output if isinstance(output, io.BytesIO) else io.BytesIO()
    prs.save(target_stream)

    if isinstance(output, str):
        with open(output, "wb") as f:
            f.write(target_stream.getvalue())

    target_stream.seek(0)
    return target_stream


def export_presentation_to_pdf(
    doc_or_data: Union[PresentationDoc, dict],
    output: Optional[Union[str, io.BytesIO]] = None,
    warnings: Optional[list] = None,
) -> io.BytesIO:
    """Exports a presentation document to a PDF file using headless LibreOffice.

    Resolves and uses bundled application fonts from `fonts/`, generating an isolated
    fontconfig and LibreOffice user profile so that bundled fonts are properly embedded
    without installing them globally on the host operating system.

    Args:
        doc_or_data: PresentationDoc instance or raw dictionary conforming to schema.
        output: Optional file path or BytesIO buffer to write to. If None, returns a new BytesIO.
        warnings: Optional list; export notes ({code, slide, objectId, name, message}) are appended to it.

    Returns:
        io.BytesIO containing the generated PDF binary data.
    """
    import subprocess
    import tempfile
    from backend.fonts import extract_document_fonts, prepare_export_font_environment
    from backend.soffice import PdfConverterMissing, find_soffice, path_to_uri

    soffice_path = find_soffice()
    if not soffice_path:
        raise PdfConverterMissing()  # RuntimeError subclass, .code == "PDF_CONVERTER_MISSING"

    # 1. Generate PPTX buffer
    pptx_buf = export_presentation(doc_or_data, warnings=warnings, static_numbers=True)

    # 2. Extract referenced fonts from presentation
    if isinstance(doc_or_data, dict):
        raw_doc = doc_or_data["doc"] if "doc" in doc_or_data and isinstance(doc_or_data["doc"], dict) else doc_or_data
        doc = PresentationDoc.model_validate(migrate_v1_to_v2(raw_doc))
    else:
        doc = doc_or_data
    doc_fonts = extract_document_fonts(doc)

    with tempfile.TemporaryDirectory() as tmpdir:
        temp_pptx = os.path.join(tmpdir, "deck.pptx")
        with open(temp_pptx, "wb") as f:
            f.write(pptx_buf.getvalue())

        user_dir = os.path.join(tmpdir, "lo_profile")
        fonts_conf, user_fonts, env_vars = prepare_export_font_environment(
            user_dir,
            font_names=doc_fonts,
            warnings=warnings,
        )

        env = os.environ.copy()
        env.update(env_vars)

        cmd = [
            soffice_path,
            f"-env:UserInstallation={path_to_uri(user_dir)}",
            "--headless",
            "--convert-to",
            "pdf",
            temp_pptx,
            "--outdir",
            tmpdir,
        ]

        proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env, timeout=120)  # 120 s: cold start (first profile creation)
        if proc.returncode != 0:
            err_msg = proc.stderr.decode(errors="replace")
            raise RuntimeError(f"LibreOffice PDF export failed: {err_msg}")

        temp_pdf = os.path.join(tmpdir, "deck.pdf")
        if not os.path.exists(temp_pdf):
            raise RuntimeError("Converted PDF file was not generated.")

        with open(temp_pdf, "rb") as f:
            pdf_bytes = f.read()

    target_stream = output if isinstance(output, io.BytesIO) else io.BytesIO()
    target_stream.write(pdf_bytes)

    if isinstance(output, str):
        with open(output, "wb") as f:
            f.write(pdf_bytes)

    target_stream.seek(0)
    return target_stream


if __name__ == "__main__":
    import json
    import sys

    if len(sys.argv) < 2:
        print("Usage: python -m backend.exporter <presentation.json> [output.pptx|output.pdf]")
        sys.exit(1)

    json_path = sys.argv[1]
    out_path = sys.argv[2] if len(sys.argv) > 2 else "output.pptx"

    with open(json_path, "r", encoding="utf-8") as f:
        data = json.load(f)
        if "doc" in data:
            data = data["doc"]

    if out_path.lower().endswith(".pdf"):
        export_presentation_to_pdf(data, out_path)
    else:
        export_presentation(data, out_path)
    print(f"Successfully exported {json_path} to {out_path}")

