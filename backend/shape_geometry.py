"""
Single source of truth in Python for shape geometries, mirroring js/shapes.js.
All coordinates operate in a 1000x1000 reference box.
"""
import math
from typing import List, Tuple, Any

STROKE_ONLY = {"line", "brace", "scalebar"}
ADJUSTABLE = {
    "arrow", "arrow2", "callout", "callout2", "chevron",
    "cross", "star4", "star5", "star6", "triangle",
    "parallelogram", "trapezoid"
}


def js_round(x: float) -> int:
    """Matches JavaScript Math.round (round half up)."""
    return math.floor(x + 0.5)


def _star_commands(n: int, outer_r: float, inner_r: float) -> List[Tuple[Any, ...]]:
    cx, cy = 500.0, 500.0
    pts = []
    for i in range(n * 2):
        angle = (i * math.pi / n) - math.pi / 2
        r = outer_r if i % 2 == 0 else inner_r
        pts.append((js_round(cx + r * math.cos(angle)), js_round(cy + r * math.sin(angle))))
    cmds: List[Tuple[Any, ...]] = [("M", pts[0][0], pts[0][1])]
    for x, y in pts[1:]:
        cmds.append(("L", x, y))
    cmds.append(("Z",))
    return cmds


def commands(kind: str, adj: Any = None) -> List[Tuple[Any, ...]]:
    """Return path drawing commands for the given shape kind and adjustment factor (0..1)."""
    k = (kind or "rect").lower()
    a = 0.5 if adj is None else min(1.0, max(0.0, float(adj)))

    if k == "triangle":
        apex_x = js_round(150 + a * 700)
        return [("M", apex_x, 30), ("L", 970, 970), ("L", 30, 970), ("Z",)]
    if k == "rtriangle":
        return [("M", 30, 30), ("L", 970, 970), ("L", 30, 970), ("Z",)]
    if k == "diamond":
        return [("M", 500, 30), ("L", 970, 500), ("L", 500, 970), ("L", 30, 500), ("Z",)]
    if k == "pentagon":
        return [("M", 500, 30), ("L", 970, 370), ("L", 785, 940), ("L", 215, 940), ("L", 30, 370), ("Z",)]
    if k == "hexagon":
        return [("M", 250, 30), ("L", 750, 30), ("L", 970, 500), ("L", 750, 970), ("L", 250, 970), ("L", 30, 500), ("Z",)]
    if k == "octagon":
        return [
            ("M", 295, 30), ("L", 705, 30), ("L", 970, 295), ("L", 970, 705),
            ("L", 705, 970), ("L", 295, 970), ("L", 30, 705), ("L", 30, 295), ("Z",)
        ]
    if k == "parallelogram":
        slant = js_round(30 + a * 270)
        return [("M", slant, 30), ("L", 970, 30), ("L", 1000 - slant, 970), ("L", 30, 970), ("Z",)]
    if k == "trapezoid":
        inset = js_round(30 + a * 370)
        return [("M", inset, 30), ("L", 1000 - inset, 30), ("L", 970, 970), ("L", 30, 970), ("Z",)]
    if k == "arrow":
        hw = js_round(250 + a * 320)
        hx = js_round(1000 - hw * 1.45)
        sy = js_round(500 - 200 + a * 120)
        sby = js_round(500 + 200 - a * 120)
        return [
            ("M", 30, sy), ("L", hx, sy), ("L", hx, 500 - hw), ("L", 970, 500),
            ("L", hx, 500 + hw), ("L", hx, sby), ("L", 30, sby), ("Z",)
        ]
    if k == "arrow2":
        hw = js_round(270 + a * 180)
        hx = js_round(hw * 1.3)
        sy = js_round(500 - 190 + a * 100)
        sby = js_round(500 + 190 - a * 100)
        return [
            ("M", 30, 500), ("L", hx, 500 - hw), ("L", hx, sy), ("L", 1000 - hx, sy),
            ("L", 1000 - hx, 500 - hw), ("L", 970, 500), ("L", 1000 - hx, 500 + hw),
            ("L", 1000 - hx, sby), ("L", hx, sby), ("L", hx, 500 + hw), ("Z",)
        ]
    if k == "callout":
        tail_x = js_round(80 + a * 840)
        tx1 = max(30, tail_x - 55)
        tx2 = min(970, tail_x + 55)
        return [
            ("M", 30, 30), ("L", 970, 30), ("L", 970, 730), ("L", tx2, 730),
            ("L", tail_x, 970), ("L", tx1, 730), ("L", 30, 730), ("Z",)
        ]
    if k == "callout2":
        tail_x = js_round(100 + a * 800)
        return [
            ("M", 500, 30),
            ("C", 790, 30, 970, 200, 970, 400),
            ("C", 970, 600, 790, 720, 500, 720),
            ("C", 390, 720, 288, 690, 210, 640),
            ("L", tail_x, 970),
            ("L", 255, 680),
            ("C", 100, 630, 30, 530, 30, 400),
            ("C", 30, 200, 210, 30, 500, 30),
            ("Z",)
        ]
    if k == "star4":
        return _star_commands(4, 470, js_round(180 + a * 120))
    if k == "star5":
        return _star_commands(5, 470, js_round(190 + a * 100))
    if k == "star6":
        return _star_commands(6, 470, js_round(250 + a * 100))
    if k == "chevron":
        notch = js_round(160 + a * 300)
        return [
            ("M", 30, 30), ("L", 1000 - notch, 30), ("L", 970, 500),
            ("L", 1000 - notch, 970), ("L", 30, 970), ("L", notch, 500), ("Z",)
        ]
    if k == "ribbon":
        return [
            ("M", 30, 200), ("L", 200, 200), ("L", 200, 30), ("L", 800, 30), ("L", 800, 200),
            ("L", 970, 200), ("L", 830, 500), ("L", 970, 800), ("L", 800, 800), ("L", 800, 970),
            ("L", 200, 970), ("L", 200, 800), ("L", 30, 800), ("L", 170, 500), ("Z",)
        ]
    if k == "cross":
        t = js_round(200 + a * 100)
        return [
            ("M", t, 30), ("L", 1000 - t, 30), ("L", 1000 - t, t), ("L", 970, t),
            ("L", 970, 1000 - t), ("L", 1000 - t, 1000 - t), ("L", 1000 - t, 970),
            ("L", t, 970), ("L", t, 1000 - t), ("L", 30, 1000 - t), ("L", 30, t), ("L", t, t), ("Z",)
        ]
    if k == "line":
        return [("M", 30, 500), ("L", 970, 500)]
    if k == "brace":
        return [
            ("M", 700, 30),
            ("Q", 500, 30, 500, 200),
            ("L", 500, 380),
            ("Q", 500, 500, 300, 500),
            ("Q", 500, 500, 500, 620),
            ("L", 500, 800),
            ("Q", 500, 970, 700, 970)
        ]
    if k == "scalebar":
        return [
            ("M", 30, 500), ("L", 970, 500),
            ("M", 30, 250), ("L", 30, 750),
            ("M", 970, 250), ("L", 970, 750)
        ]
    return []


def is_line(obj: Any) -> bool:
    """Check whether a slide object represents a line shape."""
    if obj is None:
        return False
    if isinstance(obj, dict):
        t = obj.get("type")
        s = obj.get("shape")
    else:
        t = getattr(obj, "type", None)
        s = getattr(obj, "shape", None)
    return t == "line" or s == "line" or (t == "shape" and s == "line")


def line_geometry(obj: Any) -> Tuple[float, float, float, float]:
    """
    Extract (x1, y1, x2, y2) endpoints for a line object.
    Falls back gracefully to bounding box (x, y, w, h) for backward compatibility with legacy documents.
    """
    if isinstance(obj, dict):
        x1 = obj.get("x1")
        y1 = obj.get("y1")
        x2 = obj.get("x2")
        y2 = obj.get("y2")
        x = float(obj.get("x", 0.0) or 0.0)
        y = float(obj.get("y", 0.0) or 0.0)
        w = float(obj.get("w", 0.0) or 0.0)
        h = float(obj.get("h", 0.0) or 0.0)
    else:
        x1 = getattr(obj, "x1", None)
        y1 = getattr(obj, "y1", None)
        x2 = getattr(obj, "x2", None)
        y2 = getattr(obj, "y2", None)
        x = float(getattr(obj, "x", 0.0) or 0.0)
        y = float(getattr(obj, "y", 0.0) or 0.0)
        w = float(getattr(obj, "w", 0.0) or 0.0)
        h = float(getattr(obj, "h", 0.0) or 0.0)

    if x1 is not None and y1 is not None and x2 is not None and y2 is not None:
        return float(x1), float(y1), float(x2), float(y2)

    # Legacy fallback: horizontal line across bounding box
    mid_y = y + (h / 2.0 if h > 0 else 0.0)
    return x, mid_y, x + w, mid_y


def line_bounds(x1: float, y1: float, x2: float, y2: float) -> Tuple[float, float, float, float]:
    """Compute (x, y, w, h) bounding box from endpoints."""
    return min(x1, x2), min(y1, y2), abs(x2 - x1), abs(y2 - y1)

