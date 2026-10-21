"""Size-aware layout of composite figures (pure Python, no matplotlib; docs/FIGURES_CONTRACT.md s4s).

Every panel keeps the size it has on its own (``record.export.wIn x hIn``, in inches): it is never scaled. The composite
canvas GROWS to hold them. Rows and columns are as large as their largest panel (a panel that spans several cells
takes the missing size from the tracks it spans), cells are separated by ``GAP_IN[spacing]`` and surrounded by
``MARGIN_IN``. A panel smaller than its cell is aligned inside it (``alignH`` / ``alignV``), never stretched, so every
aspect ratio is kept. ``export.wIn x hIn`` is only the MINIMUM canvas; a bigger canvas places the whole block with
the same alignment.

All coordinates are inches, origin top-left, y down.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Sequence, Tuple

GAP_IN = {"tight": 0.10, "normal": 0.25, "wide": 0.50}   # space between neighbouring panels
MARGIN_IN = 0.10                                          # space between the panels and the canvas edge
PANEL_PAD_IN = 0.05                                       # constrained-layout pad INSIDE each panel (its own whitespace)
DEFAULT_PANEL_IN = (3.5, 2.6)                             # size of a new composite panel / of empty slots when nothing is drawn
EPS = 1e-6

Rect = Tuple[float, float, float, float]                  # x, y, w, h


@dataclass
class Plan:
    canvas_w: float                                       # canvas without any shared-legend strip
    canvas_h: float
    content_w: float                                      # panels + gaps + margins
    content_h: float
    min_w: float                                          # the user's minimum canvas (export.wIn / hIn)
    min_h: float
    cells: Dict[int, Rect] = field(default_factory=dict)  # the grid cell of every slot
    rects: Dict[int, Rect] = field(default_factory=dict)  # the panel rectangle of every slot (its natural size)
    xs: List[float] = field(default_factory=list)         # track widths of the placement grid (sum = canvas_w)
    ys: List[float] = field(default_factory=list)         # track heights (sum = canvas_h)
    spans: Dict[int, Tuple[int, int, int, int]] = field(default_factory=dict)   # slot -> (row0, row1, col0, col1) in tracks

    @property
    def grown(self) -> bool:
        return self.canvas_w > self.min_w + EPS or self.canvas_h > self.min_h + EPS


def panel_sizes(comp: Dict[str, Any]) -> Dict[int, Optional[Tuple[float, float]]]:
    """slot -> (wIn, hIn) of the plot in it, None for an empty slot."""
    out: Dict[int, Optional[Tuple[float, float]]] = {}
    for p in comp["panels"]:
        rec = p["record"]
        out[p["slot"]] = (float(rec["export"]["wIn"]), float(rec["export"]["hIn"])) if rec else None
    return out


def _fallback(sizes: Sequence[Optional[Tuple[float, float]]]) -> Tuple[float, float]:
    """Size reserved for an empty slot: the median panel size (so empty slots do not distort the grid)."""
    drawn = [s for s in sizes if s]
    if not drawn:
        return DEFAULT_PANEL_IN
    ws, hs = sorted(s[0] for s in drawn), sorted(s[1] for s in drawn)
    return ws[len(ws) // 2], hs[len(hs) // 2]


def _tracks(count: int, spans: List[Tuple[int, int, float]], gap: float) -> List[float]:
    """Track sizes: the largest single-track need first, then spanning needs (the missing size is shared equally)."""
    size = [0.0] * count
    for a, b, need in sorted(spans, key=lambda s: s[1] - s[0]):
        have = sum(size[a:b]) + gap * (b - a - 1)
        if need > have + EPS:
            extra = (need - have) / (b - a)
            for i in range(a, b):
                size[i] += extra
    return size


def _offset(free: float, align: str) -> float:
    return {"left": 0.0, "top": 0.0, "center": free / 2, "middle": free / 2, "right": free, "bottom": free}.get(align, free / 2)


def plan(rows: int, cols: int, cells: Sequence[Tuple[int, int, int, int]], sizes: Dict[int, Optional[Tuple[float, float]]],
         spacing: str = "normal", align_h: str = "center", align_v: str = "top",
         min_w: float = 0.0, min_h: float = 0.0) -> Plan:
    gap = GAP_IN[spacing]
    fb = _fallback([sizes.get(s) for s in range(len(cells))])
    need = {s: (sizes.get(s) or fb) for s in range(len(cells))}
    col_w = _tracks(cols, [(c0, c1, need[s][0]) for s, (r0, r1, c0, c1) in enumerate(cells)], gap)
    row_h = _tracks(rows, [(r0, r1, need[s][1]) for s, (r0, r1, c0, c1) in enumerate(cells)], gap)
    content_w = sum(col_w) + gap * (cols - 1) + 2 * MARGIN_IN
    content_h = sum(row_h) + gap * (rows - 1) + 2 * MARGIN_IN
    canvas_w, canvas_h = max(content_w, min_w), max(content_h, min_h)
    ox = MARGIN_IN + _offset(canvas_w - content_w, align_h)
    oy = MARGIN_IN + _offset(canvas_h - content_h, align_v)
    col_x = [ox + sum(col_w[:c]) + gap * c for c in range(cols)]
    row_y = [oy + sum(row_h[:r]) + gap * r for r in range(rows)]

    out = Plan(canvas_w, canvas_h, content_w, content_h, min_w, min_h)
    for s, (r0, r1, c0, c1) in enumerate(cells):
        cx, cy = col_x[c0], row_y[r0]
        cw = col_x[c1 - 1] + col_w[c1 - 1] - cx
        ch = row_y[r1 - 1] + row_h[r1 - 1] - cy
        pw, ph = need[s]
        out.cells[s] = (cx, cy, cw, ch)
        out.rects[s] = (cx + _offset(cw - pw, align_h), cy + _offset(ch - ph, align_v), pw, ph)
    # placement grid: every distinct panel edge (and the canvas edges) cuts the canvas, so each panel covers whole tracks
    xe = _edges([0.0, canvas_w] + [v for x, y, w, h in out.rects.values() for v in (x, x + w)], canvas_w)
    ye = _edges([0.0, canvas_h] + [v for x, y, w, h in out.rects.values() for v in (y, y + h)], canvas_h)
    out.xs, out.ys = [b - a for a, b in zip(xe, xe[1:])], [b - a for a, b in zip(ye, ye[1:])]
    for s, (x, y, w, h) in out.rects.items():
        out.spans[s] = (_index(ye, y), _index(ye, y + h), _index(xe, x), _index(xe, x + w))
    return out


def _edges(values: List[float], limit: float) -> List[float]:
    edges: List[float] = []
    for v in sorted(min(max(v, 0.0), limit) for v in values):
        if not edges or v - edges[-1] > 1e-4:
            edges.append(v)
    edges[-1] = limit
    return edges


def _index(edges: List[float], value: float) -> int:
    return min(range(len(edges)), key=lambda i: abs(edges[i] - value))


def slot_fractions(p: Plan, canvas_w: Optional[float] = None, canvas_h: Optional[float] = None) -> List[Dict[str, float]]:
    """Panel rectangles as fractions of the canvas (y from the top); a bigger canvas (legend strip) keeps the origin."""
    w, h = canvas_w or p.canvas_w, canvas_h or p.canvas_h
    return [{"slot": s, "x": x / w, "y": y / h, "w": pw / w, "h": ph / h} for s, (x, y, pw, ph) in sorted(p.rects.items())]


def overlaps(rects: Sequence[Rect], tol: float = 1e-6) -> List[Tuple[int, int]]:
    """Index pairs of rectangles that overlap by more than ``tol`` inches in both directions."""
    bad = []
    for i, a in enumerate(rects):
        for j in range(i + 1, len(rects)):
            b = rects[j]
            if min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0]) > tol and min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]) > tol:
                bad.append((i, j))
    return bad
