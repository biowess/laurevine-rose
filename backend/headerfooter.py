"""Header / footer / slide-number model helpers (mirror of js/headerfooter.js).

Storage: ``doc.hf`` = shared master {header?, footer?, number?: False, onTitle?: True};
``slide.hf`` = sparse per-slide override {header?, footer?, number?: bool}. Both are optional extras
(PresentationDoc / SlideModel allow extra fields), absent until something is set, never empty.
Geometry is derived from the slide size (region()), never stored.
"""

import re
from typing import Any, Dict, Optional

KEYS = ("header", "footer")
_BOOL = ("bold", "italic", "underline", "strike", "subscript", "superscript")
_ALIGNS = ("left", "center", "right", "justify")
DEFAULTS = {"fontSize": 12.0, "align": "left", "lineHeight": 1.0, "color": "muted"}
_MAX_HTML = 4000
_ALLOWED = re.compile(r"^(p|br|b|i|u|s|strong|em|span|font|sub|sup|a|div)$", re.I)
_COLOR = re.compile(r"^[#\w(),.%\s-]{1,40}$")


def _get(obj: Any, name: str) -> Any:
    if obj is None:
        return None
    if isinstance(obj, dict):
        return obj.get(name)
    return getattr(obj, name, None)


def plain(html: Any) -> str:
    s = re.sub(r"<br\s*/?>", " ", str(html or ""), flags=re.I)
    s = re.sub(r"<[^>]*>", "", s)
    return s.replace("&nbsp;", " ").replace("\u00a0", " ").strip()


def has_text(item: Any) -> bool:
    return isinstance(item, dict) and isinstance(item.get("html"), str) and bool(plain(item["html"]))


def safe_html(html: str) -> str:
    h = re.sub(r"<!--.*?-->", "", html[: _MAX_HTML * 4], flags=re.S)
    h = re.sub(r"<(script|style|iframe|object|embed)\b.*?(</\1>|$)", "", h, flags=re.S | re.I)

    def tag(m: "re.Match[str]") -> str:
        if not _ALLOWED.match(m.group(1)):
            return ""
        t = re.sub(r"""\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)""", "", m.group(0), flags=re.I)
        return re.sub(r"""(href|src)\s*=\s*("\s*javascript:[^"]*"|'\s*javascript:[^']*')""", "", t, flags=re.I)

    return re.sub(r"</?([a-z][a-z0-9-]*)\b[^>]*>", tag, h, flags=re.I)[:_MAX_HTML]


def clean_item(it: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(it, dict):
        return None
    o: Dict[str, Any] = {}
    if isinstance(it.get("html"), str):
        o["html"] = safe_html(it["html"])
    if isinstance(it.get("enabled"), bool):
        o["enabled"] = it["enabled"]
    f = it.get("font")
    if isinstance(f, str) and f and len(f) <= 120:
        o["font"] = f
    fs = it.get("fontSize")
    if isinstance(fs, (int, float)) and not isinstance(fs, bool) and 1 <= fs <= 400:
        o["fontSize"] = fs
    lh = it.get("lineHeight")
    if isinstance(lh, (int, float)) and not isinstance(lh, bool) and 0.5 <= lh <= 5:
        o["lineHeight"] = lh
    for k in _BOOL:
        if isinstance(it.get(k), bool):
            o[k] = it[k]
    c = it.get("color")
    if isinstance(c, str) and _COLOR.match(c):
        o["color"] = c
    if it.get("align") in _ALIGNS:
        o["align"] = it["align"]
    return o


def _num(v: Any, lo: float, hi: float) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and lo <= v <= hi


def clean_number_item(it: Any) -> Optional[Dict[str, Any]]:
    """Style / geometry of the slide number (doc.hf.numberItem); invalid keys are dropped, empty -> None."""
    if not isinstance(it, dict):
        return None
    o: Dict[str, Any] = {}
    f = it.get("font")
    if isinstance(f, str) and f and len(f) <= 120:
        o["font"] = f
    if _num(it.get("fontSize"), 1, 400):
        o["fontSize"] = it["fontSize"]
    for k in ("bold", "italic", "underline"):
        if isinstance(it.get(k), bool):
            o[k] = it[k]
    c = it.get("color")
    if isinstance(c, str) and _COLOR.match(c):
        o["color"] = c
    if it.get("align") in ("left", "center", "right"):
        o["align"] = it["align"]
    for k in ("x", "y"):
        if _num(it.get(k), -10000, 100000):
            o[k] = it[k]
    for k in ("w", "h"):
        if _num(it.get(k), 1, 100000):
            o[k] = it[k]
    return o or None


def clean_master(hf: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(hf, dict):
        return None
    out: Dict[str, Any] = {}
    for k in KEYS:
        it = clean_item(hf.get(k))
        if it is not None and (has_text(it) or it.get("enabled") is True):
            out[k] = it
    if hf.get("number") is False:
        out["number"] = False
    if hf.get("onTitle") is True:
        out["onTitle"] = True
    sa = hf.get("startAt")
    if isinstance(sa, int) and not isinstance(sa, bool) and 0 <= sa <= 9999 and sa != 1:
        out["startAt"] = sa
    ni = clean_number_item(hf.get("numberItem"))
    if ni:
        out["numberItem"] = ni
    return out or None


def clean_slide(hf: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(hf, dict):
        return None
    out: Dict[str, Any] = {}
    for k in KEYS:
        it = clean_item(hf.get(k))
        if it is not None and (has_text(it) or it.get("enabled") is False):
            out[k] = it
    if isinstance(hf.get("number"), bool):
        out["number"] = hf["number"]
    return out or None


def normalize_doc_dict(data: Dict[str, Any]) -> Dict[str, Any]:
    """Return a shallow copy of a raw document dict with ``hf`` / ``slide.hf`` repaired and empties removed (never created)."""
    out = dict(data)
    if "hf" in out:
        m = clean_master(out["hf"])
        if m:
            out["hf"] = m
        else:
            del out["hf"]
    slides = out.get("slides")
    if isinstance(slides, list):
        fixed = []
        for s in slides:
            if isinstance(s, dict) and "hf" in s:
                s = dict(s)
                o = clean_slide(s["hf"])
                if o:
                    s["hf"] = o
                else:
                    del s["hf"]
            fixed.append(s)
        out["slides"] = fixed
    return out


def region(key: str, size_w: float, size_h: float) -> Dict[str, float]:
    w, h = size_w or 1280, size_h or 720
    m = round(w * 0.05)
    if key == "header":
        return {"x": m, "y": round(h * 0.05), "w": w - 2 * m, "h": round(h * 0.036)}
    if key == "footer":
        return {"x": m, "y": h - round(h * 0.061), "w": w - 2 * m - 70, "h": round(h * 0.04)}
    return number_geom({"size": {"w": w, "h": h}})   # slide number


NUM_DEFAULTS = {"fontSize": 12, "align": "right", "color": "muted", "bold": False, "italic": False, "underline": False}


def number_start(doc: Any) -> int:
    v = (_get(doc, "hf") or {}).get("startAt")
    return v if isinstance(v, int) and not isinstance(v, bool) else 1


def number_value(doc: Any, index: int) -> int:
    """Number shown on the slide at 0-based position ``index`` (hidden slides still count, like PowerPoint)."""
    return number_start(doc) + index


def number_style(doc: Any) -> Dict[str, Any]:
    st = dict(NUM_DEFAULTS)
    st.update({k: v for k, v in ((_get(doc, "hf") or {}).get("numberItem") or {}).items() if k not in ("x", "y", "w", "h")})
    return st


def number_geom(doc: Any) -> Dict[str, float]:
    """Default bottom-right box unless doc.hf.numberItem carries x/y/w/h."""
    size = _get(doc, "size")
    w, h = _get(size, "w") or 1280, _get(size, "h") or 720
    g = {"x": w - 28 - 64, "y": h - 16 - 24, "w": 64, "h": 24}
    item = (_get(doc, "hf") or {}).get("numberItem") or {}
    for k in g:
        if isinstance(item.get(k), (int, float)) and not isinstance(item.get(k), bool):
            g[k] = item[k]
    return g


def _is_title(slide: Any) -> bool:
    return _get(slide, "layout") == "title"


def state(doc: Any, slide: Any, key: str) -> Dict[str, Any]:
    """-> {item, visible}. visible = drawn on this slide (has text, not hidden, shown on this layout)."""
    dhf, shf = _get(doc, "hf") or {}, _get(slide, "hf") or {}
    so, mo = shf.get(key), dhf.get(key)
    master_shown = (not _is_title(slide)) or bool(dhf.get("onTitle"))
    if so and so.get("enabled") is False:
        return {"item": None, "visible": False}
    if has_text(so):
        return {"item": so, "visible": True}
    if mo and mo.get("enabled") is False:
        return {"item": mo, "visible": False}
    if mo and master_shown and has_text(mo):
        return {"item": mo, "visible": True}
    return {"item": None, "visible": False}


def number_on(doc: Any, slide: Any) -> bool:
    s = (_get(slide, "hf") or {}).get("number")
    if isinstance(s, bool):
        return s
    if (_get(doc, "hf") or {}).get("number") is False:
        return False
    return not _is_title(slide)


def view(doc: Any, slide: Any, key: str) -> Optional[Dict[str, Any]]:
    """Render dict (SlideObject-shaped text object) for a visible region, else None."""
    st = state(doc, slide, key)
    if not st["visible"]:
        return None
    size = _get(doc, "size")
    g = region(key, _get(size, "w"), _get(size, "h"))
    d: Dict[str, Any] = {"id": "hf:" + key, "type": "text", "role": "hf-" + key, "vAlign": "middle", "html": ""}
    d.update(DEFAULTS)
    d.update({k: v for k, v in st["item"].items() if k != "enabled"})
    d.update(g)
    return d


def iter_items(doc: Any):
    """Every stored item (master + per-slide), for font collection."""
    for src in [_get(doc, "hf")] + [_get(s, "hf") for s in (_get(doc, "slides") or [])]:
        if isinstance(src, dict):
            for k in KEYS:
                if isinstance(src.get(k), dict):
                    yield src[k]
    ni = (_get(doc, "hf") or {}).get("numberItem")
    if isinstance(ni, dict):
        yield ni   # slide-number font (bundled-font collection)
