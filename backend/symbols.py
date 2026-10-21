"""Glyph-coverage fallback for symbols (symbol library, task 22).

A run whose font lacks a character (e.g. 'Outfit' has no U+21CC or U+2211 on some builds) would render as tofu in the PDF
(LibreOffice) and may in PowerPoint. This module reads the real cmap of the bundled font files and, for every uncovered
character, moves it into its own run set in the first bundled fallback family that covers it. Everything else on the run
(size, colour, bold, baseline, ...) is copied, so only the typeface of that one glyph changes.

Data-driven: FALLBACK_FAMILIES lists canonical family names in preference order; a family that is not bundled (no `fonts/<id>/`)
is skipped. Dropping `fonts/noto-sans-math/` and/or `fonts/noto-sans-symbols-2/` (OFL) into the project makes them win automatically.
Fonts that are not bundled (Calibri, Georgia, ...) are left untouched: their coverage is unknowable here.
"""

import copy
import logging
import os
import unicodedata
from functools import lru_cache
from typing import Any, FrozenSet, List, Optional, Sequence

logger = logging.getLogger(__name__)

DEFAULT_FONT = "Outfit"  # app default; assumed for runs that carry no explicit font
FALLBACK_FAMILIES = (
    "Noto Sans Math", "Noto Sans Symbols 2", "Inter", "Roboto", "Open Sans", "Source Sans 3",
    "Fira Sans", "Arimo", "PT Serif", "TeX Gyre Termes", "JetBrains Mono", "Fira Code",
)
_warned: set = set()


def needs_check(ch: str) -> bool:
    """ASCII, whitespace, zero-width/format characters and combining marks are never split off."""
    cp = ord(ch)
    if cp < 0x80 or ch.isspace() or unicodedata.combining(ch):
        return False
    return unicodedata.category(ch) not in ("Cf", "Cc", "Mn", "Me")


@lru_cache(maxsize=64)
def _cmap_of(path: str) -> FrozenSet[int]:
    from fontTools.ttLib import TTFont
    with TTFont(path, lazy=True, fontNumber=0) as tt:
        return frozenset((tt.getBestCmap() or {}).keys())


def family_cmap(name: Optional[str]) -> Optional[FrozenSet[int]]:
    """Code points covered by a bundled family (regular, upright file), or None when it is not bundled / unreadable."""
    from backend.fonts import get_font_catalog
    fam = get_font_catalog().resolve_family(name) if name else None
    if not fam or not fam.raw_files:
        return None
    path = next((p for p in fam.raw_files if "italic" not in os.path.basename(p).lower()), fam.raw_files[0])
    try:
        return _cmap_of(path)
    except Exception:  # corrupt / unsupported file: treat as unknown, never break an export
        return None


def available_fallbacks() -> List[str]:
    """Fallback families that are actually bundled, in preference order (canonical names)."""
    from backend.fonts import get_font_catalog
    cat = get_font_catalog()
    return [n for n in FALLBACK_FAMILIES if n in cat.families]


def pick_fallback(ch: str, avoid: Optional[str] = None) -> Optional[str]:
    for name in available_fallbacks():
        if avoid and name.lower() == avoid.lower():
            continue
        cm = family_cmap(name)
        if cm is not None and ord(ch) in cm:
            return name
    if ch not in _warned:
        _warned.add(ch)
        logger.warning("No bundled font covers U+%04X (%s); it may render as a missing glyph.", ord(ch), ch)
    return None


def split_runs(runs: Sequence[Any], default_font: Optional[str] = None) -> List[Any]:
    """Return runs where every character missing from the run's bundled font sits in its own run with a covering fallback font."""
    out: List[Any] = []
    for run in runs:
        text = getattr(run, "text", "") or ""
        font = getattr(run, "font", None) or default_font or DEFAULT_FONT
        if not text or not any(needs_check(c) for c in text):
            out.append(run)
            continue
        cmap = family_cmap(font)
        if cmap is None:
            out.append(run)
            continue
        pieces: List[List[Any]] = []  # [text, font-or-None]
        for ch in text:
            fb = pick_fallback(ch, avoid=font) if (needs_check(ch) and ord(ch) not in cmap) else None
            if pieces and pieces[-1][1] == fb:
                pieces[-1][0] += ch
            else:
                pieces.append([ch, fb])
        if len(pieces) == 1 and pieces[0][1] is None:
            out.append(run)
            continue
        for piece_text, fb in pieces:
            r = copy.copy(run)
            r.text = piece_text
            if fb:
                r.font = fb
            out.append(r)
    return out


def apply_fallback(paragraphs: Sequence[Any], default_font: Optional[str] = None) -> Sequence[Any]:
    """In-place over ParagraphData objects (exporter.parse_html_to_paragraphs output)."""
    for p in paragraphs:
        p.runs = split_runs(p.runs, default_font)
    return paragraphs
