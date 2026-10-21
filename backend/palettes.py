"""Presentation-level colour palette (mirror of js/palettes.js, data side only).

``doc.palette`` is a resolved snapshot written by the editor: ``{"id", "roles": {bg, card, surface, border, text, title, muted,
onAccent, accent, accent2}, "chart": [hex...], "table": {...}, "dark": bool}``. The backend never needs the template definitions:
it only reads the snapshot. Documents without the field keep the old behaviour (colours of the theme in THEMES_CONFIG).
"""

import re
from typing import Any, Dict, Optional, Tuple

ROLES = ("bg", "card", "surface", "border", "text", "title", "muted", "onAccent", "accent", "accent2")
_HEX = re.compile(r"^#([0-9a-fA-F]{6})$")


def _hex(v: Any) -> Optional[str]:
    if isinstance(v, str):
        s = v.strip()
        m = re.match(r"^#([0-9a-fA-F]{3})$", s)
        if m:
            return "#" + "".join(c * 2 for c in m.group(1)).upper()
        if _HEX.match(s):
            return s.upper()
    return None


def _rgb(h: str) -> Tuple[int, int, int]:
    return int(h[1:3], 16), int(h[3:5], 16), int(h[5:7], 16)


def luminance(h: str) -> float:
    def ch(v: int) -> float:
        v /= 255.0
        return v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    r, g, b = (ch(x) for x in _rgb(h))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def contrast(a: str, b: str) -> float:
    x, y = luminance(a), luminance(b)
    return (max(x, y) + 0.05) / (min(x, y) + 0.05)


def _mix(a: str, b: str, f: float) -> str:
    x, y = _rgb(a), _rgb(b)
    return "#%02X%02X%02X" % tuple(round(x[i] + (y[i] - x[i]) * f) for i in range(3))


def _pick_on(on: str, cands) -> str:
    cands = [c for c in cands if c]
    return next((c for c in cands if contrast(c, on) >= 4.5), None) or max(cands, key=lambda c: contrast(c, on))


def sanitize(raw: Any) -> Optional[Dict[str, Any]]:
    """Clean snapshot or None. bg / text / accent / accent2 are mandatory; the other roles are derived when missing."""
    if not isinstance(raw, dict) or not isinstance(raw.get("roles"), dict):
        return None
    src = raw["roles"]
    r: Dict[str, str] = {}
    for k in ("bg", "text", "accent", "accent2"):
        v = _hex(src.get(k))
        if not v:
            return None
        r[k] = v
    r["card"] = _hex(src.get("card")) or r["bg"]
    r["title"] = _hex(src.get("title")) or r["text"]
    r["muted"] = _hex(src.get("muted")) or _mix(r["text"], r["bg"], 0.4)
    r["surface"] = _hex(src.get("surface")) or _mix(r["bg"], r["text"], 0.06)
    r["border"] = _hex(src.get("border")) or _mix(r["bg"], r["text"], 0.2)
    r["onAccent"] = _hex(src.get("onAccent")) or _pick_on(r["accent"], [r["card"], r["bg"], r["text"]])
    chart = [c for c in (_hex(x) for x in raw["chart"][:12]) if c] if isinstance(raw.get("chart"), list) else []
    rid = raw.get("id")
    dark = raw.get("dark")
    return {
        "id": rid[:80] if isinstance(rid, str) else "custom",
        "roles": {k: r[k] for k in ROLES},
        "chart": chart or [r["accent"], r["accent2"]],
        "table": {"headerFill": r["accent"], "headerText": r["onAccent"]},
        "dark": dark if isinstance(dark, bool) else luminance(r["bg"]) < 0.18,
    }


def theme_overrides(palette: Any) -> Dict[str, Any]:
    """Theme-dict entries a palette snapshot overrides ({} without a valid snapshot). Token keys are lower-case (resolve_color lower-cases)."""
    snap = sanitize(palette)
    if not snap:
        return {}
    r = snap["roles"]
    return {
        "bg": r["bg"], "text": r["text"], "title": r["title"], "muted": r["muted"], "accent": r["accent"], "accent2": r["accent2"],
        "surface": r["surface"], "border": r["border"], "card": r["card"], "onaccent": r["onAccent"], "dark": snap["dark"],
    }
