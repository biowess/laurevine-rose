"""FigureRecord data model (docs/FIGURES_CONTRACT.md, section 3).

Strict by design: every enum is a ``Literal`` and unknown keys are rejected
(``extra="forbid"``) everywhere except the free-form ``RenderState.diagnostics``
and ``RenderState.runtime`` payloads, which are opaque dicts/lists by contract.
Size limits are checked at validation time against the module constants below
so they hold for every entry point (render, export, save, load).

``default_record(kind, plotType)`` returns a valid record with an empty dataset.
"""

import math
import re
import uuid
from typing import Annotated, Any, Dict, List, Literal, Optional, Union

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictFloat,
    StrictInt,
    StrictStr,
    StringConstraints,
    field_validator,
    model_validator,
)

# ---------------------------------------------------------------- limits
MIN_SIDE_IN = 0.5          # contract section 5
MAX_SIDE_IN = 30.0
MIN_DPI = 72
MAX_DPI = 1200
MAX_PX_SIDE = 16384
MAX_MEGAPIXELS = 120

MAX_COLUMNS = 256          # dataset / record size limits
MAX_ROWS = 200_000
MAX_CELLS = 2_000_000
MAX_CSV_CHARS = 20_000_000
MAX_SOURCE_CHARS = 1_000_000
MAX_PREVIEW_CHARS = 30_000_000
MAX_NAME_CHARS = 200
MAX_FIGURES_PER_DOC = 500

# ----------------------------------------------------------------- enums
KINDS = ("structured", "python", "latex", "composite")
PLOT_TYPES = ("line", "scatter", "bar", "hist", "box", "heatmap")

Kind = Literal["structured", "python", "latex", "composite"]
PlotType = Literal["line", "scatter", "bar", "hist", "box", "heatmap"]
ColumnType = Literal["number", "text"]
OriginType = Literal["sample", "csv", "sheet", "python"]
SourceMode = Literal["structured", "custom"]
FontFamily = Literal["sans", "serif", "mono"]
LegendPos = Literal[
    "best", "upper right", "upper left", "lower left", "lower right",
    "center left", "center right", "lower center", "upper center", "center", "outside",
]
LineStyleName = Literal["solid", "dashed", "dotted", "dashdot"]
MarkerName = Literal["none", "circle", "square", "triangle_up", "triangle_down", "diamond", "plus", "cross", "star"]
ScatterMarkerName = Literal["circle", "square", "triangle_up", "triangle_down", "diamond", "plus", "cross", "star"]

HexColor = Annotated[str, StringConstraints(pattern=r"^#[0-9A-Fa-f]{6}$")]
FigureId = Annotated[str, StringConstraints(pattern=r"^[A-Za-z0-9_-]{1,64}$")]
Cell = Optional[Union[StrictInt, StrictFloat, StrictStr]]

_LAYOUT_RE = re.compile(r"^([1-6])x([1-6])$")
COMPOSITE_LAYOUTS = {"2x2": 4, "1x2": 2, "2x1": 2, "1x3": 3, "1+2": 3, "2x3": 6}   # = js/plots.js FIG_LAYOUTS (slot counts)


class _Model(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------- dataset
class Column(_Model):
    name: str = Field(min_length=1, max_length=MAX_NAME_CHARS)
    type: ColumnType = "number"


class DatasetOrigin(_Model):
    type: OriginType = "sheet"
    label: str = Field(default="", max_length=MAX_NAME_CHARS)
    sampleId: Optional[str] = Field(default=None, max_length=100)
    fileName: Optional[str] = Field(default=None, max_length=255)
    code: Optional[str] = Field(default=None, max_length=MAX_SOURCE_CHARS)   # origin "python": the data script (contract s3d)


class Dataset(_Model):
    columns: List[Column] = Field(default_factory=list)
    rows: List[List[Cell]] = Field(default_factory=list)
    origin: DatasetOrigin = Field(default_factory=DatasetOrigin)

    @model_validator(mode="after")
    def _check_shape_and_limits(self) -> "Dataset":
        ncols, nrows = len(self.columns), len(self.rows)
        if ncols > MAX_COLUMNS:
            raise ValueError(f"dataset has {ncols} columns; the limit is {MAX_COLUMNS}")
        if nrows > MAX_ROWS:
            raise ValueError(f"dataset has {nrows} rows; the limit is {MAX_ROWS}")
        if nrows * ncols > MAX_CELLS:
            raise ValueError(f"dataset has {nrows * ncols} cells; the limit is {MAX_CELLS}")
        names = [c.name for c in self.columns]
        if len(set(names)) != ncols:
            raise ValueError("column names must be unique")
        kinds = [c.type for c in self.columns]
        for r, row in enumerate(self.rows):
            if len(row) != ncols:
                raise ValueError(f"row {r} has {len(row)} cells; expected {ncols}")
            for c, v in enumerate(row):
                if v is None:
                    continue
                if kinds[c] == "number":
                    if isinstance(v, str) or (isinstance(v, float) and not math.isfinite(v)):
                        raise ValueError(f"row {r}, column '{names[c]}': expected a finite number")
                elif not isinstance(v, str):
                    raise ValueError(f"row {r}, column '{names[c]}': expected text")
        return self


# ------------------------------------------------------------ plot config
class Mapping(_Model):
    """Which dataset columns feed the plot (column names; empty = unset)."""
    x: Optional[str] = None
    y: List[str] = Field(default_factory=list, max_length=MAX_COLUMNS)
    group: Optional[str] = None
    yErr: Optional[str] = None


class LegendConfig(_Model):
    show: bool = True                  # False = never; True = only when more than one series is visible (line)
    pos: LegendPos = "best"            # "outside" = right of the axes
    force: bool = False                # show the legend even for a single visible series
    frame: Optional[bool] = None       # None = framed, except pos "outside" (no frame); True/False = always
    labels: Dict[StrictStr, Annotated[str, StringConstraints(max_length=200)]] = Field(default_factory=dict, max_length=MAX_COLUMNS)
                                       # display text per series label (column / group name); missing or blank = unchanged


class Appearance(_Model):
    title: str = Field(default="", max_length=500)
    subtitle: str = Field(default="", max_length=500)    # small line under the title; hidden together with it (showTitle)
    xLabel: str = Field(default="", max_length=500)
    yLabel: str = Field(default="", max_length=500)
    fontFamily: FontFamily = "sans"
    fontSize: float = Field(default=10.0, ge=4, le=48)
    lineWidth: float = Field(default=1.5, ge=0.1, le=20)
    markerSize: float = Field(default=5.0, ge=0, le=50)
    alpha: float = Field(default=1.0, ge=0, le=1)
    palette: Literal["default", "colorblind", "grayscale", "muted"] = "default"
    colors: List[HexColor] = Field(default_factory=list, max_length=32)
    cmap: Optional[Literal["viridis", "magma", "cividis", "plasma", "coolwarm", "gray", "RdBu_r", "Greys"]] = None  # heatmap; None = viridis (matrix) / RdBu_r (correlation)
    legend: LegendConfig = Field(default_factory=LegendConfig)
    grid: bool = True                  # major grid
    despine: bool = True               # open axes: no top/right spine
    fontName: Optional[str] = Field(default=None, max_length=MAX_NAME_CHARS)  # installed font; fontFamily is the fallback
    titleSize: Optional[float] = Field(default=None, ge=4, le=72)    # None = derived from fontSize
    labelSize: Optional[float] = Field(default=None, ge=4, le=72)
    tickSize: Optional[float] = Field(default=None, ge=4, le=72)
    legendSize: Optional[float] = Field(default=None, ge=4, le=72)
    gridMinor: bool = False
    gridStyle: LineStyleName = "solid"
    gridAlpha: float = Field(default=1.0, ge=0.1, le=1)   # grid opacity; lower = more subtle
    tickDirection: Literal["out", "in", "inout"] = "out"
    xTickRotation: float = Field(default=0.0, ge=-90, le=90)   # degrees, tick labels
    yTickRotation: float = Field(default=0.0, ge=-90, le=90)
    showTitle: bool = True
    showXLabel: bool = True
    showYLabel: bool = True
    layout: Literal["tight", "constrained"] = "tight"
    spineTop: Optional[bool] = None    # None = follow `despine`; True/False = show / hide the top line
    spineRight: Optional[bool] = None  # same for the right line
    axisLines: bool = True             # left and bottom axis lines
    showTicks: bool = True             # tick marks (tick labels stay)


AxisLimits = Annotated[List[float], Field(min_length=2, max_length=2)]


class SeriesStyle(_Model):
    """Per-series overrides for line plots; ``None`` = take the value from ``Appearance`` / the palette."""
    visible: bool = True
    line: bool = True
    color: Optional[HexColor] = None
    width: Optional[float] = Field(default=None, ge=0.1, le=20)
    style: LineStyleName = "solid"
    marker: MarkerName = "none"
    markerSize: Optional[float] = Field(default=None, ge=0, le=50)
    markerColor: Optional[HexColor] = None
    step: Literal["none", "pre", "mid", "post"] = "none"
    error: Literal["none", "symmetric", "asymmetric"] = "none"
    errorCol: Optional[str] = None         # symmetric: +/- this column
    errorLowCol: Optional[str] = None      # asymmetric: distance below / above the value (both >= 0)
    errorHighCol: Optional[str] = None
    capSize: float = Field(default=3.0, ge=0, le=20)   # points; 0 = no caps


class Options(_Model):
    xScale: Literal["linear", "log"] = "linear"
    yScale: Literal["linear", "log"] = "linear"
    xLim: Optional[AxisLimits] = None
    yLim: Optional[AxisLimits] = None
    errorBars: bool = False
    fit: Literal["none", "linear", "polynomial"] = "none"   # scatter; a fit is drawn only when chosen here
    fitDegree: int = Field(default=2, ge=2, le=5)           # scatter, polynomial fit
    fitBand: bool = False                                   # scatter, confidence band around the fitted line
    fitLevel: float = Field(default=0.95, ge=0.5, le=0.999)  # scatter, confidence level of that band
    fitEquation: bool = True                                # scatter, fit: write the equation in the legend (second line)
    fitR2: bool = True                                      # scatter, fit: write R² in the legend (second line)
    marker: ScatterMarkerName = "circle"                    # scatter
    markerEdgeColor: Optional[HexColor] = None              # scatter outline; None = same colour as the point
    markerEdgeWidth: float = Field(default=0.5, ge=0, le=5)  # scatter outline width in points; 0 = no outline
    bins: int = Field(default=20, ge=1, le=100000)        # hist: bin count (binMode 'count'); the generator refuses > 1000
    density: bool = False                                 # hist: legacy flag, used only while `stat` is None
    binMode: Literal["count", "width", "method"] = "count"  # hist: how the bins are chosen
    binWidth: Optional[float] = Field(default=None, gt=0, allow_inf_nan=False)  # hist: bin width (binMode 'width')
    binMethod: Literal["auto", "fd", "sturges", "scott", "sqrt"] = "auto"  # hist: numpy rule (binMode 'method')
    stat: Optional[Literal["count", "frequency", "density"]] = None  # hist: bar height; None = density if `density` else count
    cumulative: bool = False                              # hist: running total of the bars
    normalFit: bool = False                               # hist: overlay of a fitted normal distribution (scipy)
    barColor: Optional[HexColor] = None                   # hist: bar fill; None = first colour of the palette
    barEdgeColor: Optional[HexColor] = None               # hist: bar outline; None = dark grey
    barEdgeWidth: float = Field(default=0.5, ge=0, le=5)  # hist: outline width in points; 0 = no outline
    barMode: Literal["grouped", "stacked"] = "grouped"    # bar
    orient: Literal["vertical", "horizontal"] = "vertical"  # bar / box
    barWidth: float = Field(default=0.8, ge=0.05, le=1.0)  # bar: share of a category slot taken by the bars (1 = touching)
    valueLabels: bool = False                             # bar: write each bar's value next to it
    valueFormat: str = Field(default="{:g}", max_length=40)  # bar: str.format template with one {} field, e.g. {:.1f}
    axisNote: bool = False                                # bar: print "Axis truncated" on the figure when the axis hides zero
    showPoints: bool = False                              # box: jittered strip of the individual observations
    showOutliers: bool = True                             # box: draw the observations beyond the whiskers (never hidden unless False)
    showMean: bool = False                                # box: mean marker
    whisker: Literal["iqr", "minmax", "percentile"] = "iqr"  # box: 1.5 x IQR | minimum-maximum | 5th-95th percentile
    quartileMethod: Literal["linear", "midpoint"] = "linear"  # box: numpy percentile method for quartiles / percentiles
    notch: bool = False                                   # box: notches (refused when a group has fewer than 10 values)
    boxColor: Optional[HexColor] = None                   # box: one fill colour for every box; None = palette by group
    boxEdgeColor: Optional[HexColor] = None               # box: outline of boxes / caps / outliers; None = dark grey
    boxWidth: float = Field(default=0.5, ge=0.1, le=1.0)  # box: share of a category slot taken by the box
    medianColor: Optional[HexColor] = None                # box: median line; None = black or white, whichever contrasts
    medianWidth: Optional[float] = Field(default=None, ge=0.1, le=20)  # box: points; None = 2 x appearance.lineWidth
    whiskerColor: Optional[HexColor] = None               # box: whiskers; None = boxEdgeColor
    whiskerStyle: LineStyleName = "solid"                 # box: whisker line style (caps stay solid)
    meanColor: Optional[HexColor] = None                  # box: mean marker fill; None = white
    legendNote: bool = False                              # box: small key under the plot (box, whiskers, markers)
    annotate: bool = False                                # heatmap: write each cell's value (correlation: the coefficient)
    colorbar: bool = True                                 # heatmap
    heatmapMode: Literal["matrix", "correlation"] = "matrix"  # heatmap: the cells ARE the data | pairwise correlation of columns
    vmin: Optional[float] = Field(default=None, allow_inf_nan=False)  # heatmap: colour scale minimum; None = auto
    vmax: Optional[float] = Field(default=None, allow_inf_nan=False)  # heatmap: colour scale maximum; None = auto
    colorbarLabel: str = Field(default="", max_length=200)  # heatmap: colourbar title; empty = automatic
    annotatePrecision: int = Field(default=2, ge=0, le=6)  # heatmap: decimals in cell annotations
    annotateSize: Optional[float] = Field(default=None, ge=4, le=48)  # heatmap: annotation font size pt; None = 0.8 x fontSize
    cellBorders: bool = False                             # heatmap: lines between cells
    cellBorderColor: HexColor = "#FFFFFF"                 # heatmap
    cellBorderWidth: float = Field(default=0.5, ge=0, le=5)  # heatmap: points
    corrMethod: Literal["pearson", "spearman"] = "pearson"  # heatmap, correlation mode
    corrTriangle: Literal["full", "lower", "upper"] = "full"  # heatmap, correlation mode: the half that is drawn
    series: Dict[str, SeriesStyle] = Field(default_factory=dict, max_length=MAX_COLUMNS)  # line, keyed by y column

    @model_validator(mode="after")
    def _check_limits(self) -> "Options":
        for name in ("xLim", "yLim"):
            lim = getattr(self, name)
            if lim is not None and not (math.isfinite(lim[0]) and math.isfinite(lim[1]) and lim[0] < lim[1]):
                raise ValueError(f"{name} must be two finite numbers with min < max")
        return self


class PlotConfig(_Model):
    plotType: PlotType = "line"
    mapping: Mapping = Field(default_factory=Mapping)
    appearance: Appearance = Field(default_factory=Appearance)
    options: Options = Field(default_factory=Options)


# Per-plot-type starting points (only fields that differ from the model defaults).
_PLOT_DEFAULTS: Dict[str, Dict[str, Dict[str, Any]]] = {
    "line": {},
    "scatter": {"appearance": {"markerSize": 6.0}},
    "bar": {"options": {"errorBars": True}},
    "hist": {"appearance": {"alpha": 0.8}, "options": {"bins": 20}},
    "box": {"options": {"showPoints": True}},
    "heatmap": {"appearance": {"grid": False, "despine": False}, "options": {"colorbar": True}},
}


def default_config(plotType: str = "line") -> PlotConfig:
    """Valid PlotConfig with sane defaults for ``plotType``."""
    if plotType not in PLOT_TYPES:
        raise ValueError(f"unknown plotType '{plotType}'; expected one of {PLOT_TYPES}")
    ov = _PLOT_DEFAULTS[plotType]
    return PlotConfig(
        plotType=plotType,
        appearance=Appearance(**ov.get("appearance", {})),
        options=Options(**ov.get("options", {})),
    )


# -------------------------------------------------- export / render state
class ExportSettings(_Model):
    wIn: float = Field(default=6.0, ge=MIN_SIDE_IN, le=MAX_SIDE_IN)
    hIn: float = Field(default=4.0, ge=MIN_SIDE_IN, le=MAX_SIDE_IN)
    dpi: int = Field(default=450, ge=MIN_DPI, le=MAX_DPI)
    format: Literal["png", "pdf"] = "png"
    background: Literal["white", "transparent"] = "white"

    @model_validator(mode="after")
    def _check_pixels(self) -> "ExportSettings":
        wpx, hpx = round(self.wIn * self.dpi), round(self.hIn * self.dpi)
        if wpx > MAX_PX_SIDE or hpx > MAX_PX_SIDE:
            raise ValueError(f"{wpx}x{hpx} px exceeds the {MAX_PX_SIDE} px per-side limit")
        if wpx * hpx > MAX_MEGAPIXELS * 1_000_000:
            raise ValueError(f"{wpx * hpx / 1e6:.0f} megapixels exceeds the {MAX_MEGAPIXELS} MP limit")
        return self


class RenderState(_Model):
    status: Literal["none", "ok", "error", "stale"] = "none"
    hash: Optional[str] = Field(default=None, max_length=128)
    preview: Optional[str] = None                         # data URL (<=150 dpi), never final
    at: Optional[float] = Field(default=None, ge=0)       # epoch ms of last render attempt
    durationMs: Optional[float] = Field(default=None, ge=0)
    error: Optional[str] = Field(default=None, max_length=100_000)
    diagnostics: List[Any] = Field(default_factory=list)  # free-form, produced by the runner
    runtime: Optional[Dict[str, Any]] = None              # free-form, produced by the runner

    @model_validator(mode="after")
    def _check_preview(self) -> "RenderState":
        p = self.preview
        if p is not None:
            if not p.startswith("data:image/"):
                raise ValueError("preview must be an image data URL")
            if len(p) > MAX_PREVIEW_CHARS:
                raise ValueError(f"preview exceeds {MAX_PREVIEW_CHARS} characters")
        return self


# ------------------------------------------------------ latex / composite
class LatexCompileSummary(_Model):
    """What the last successful compile that produced the inserted image reported."""
    engine: Literal["pdflatex", "xelatex", "lualatex"] = "pdflatex"
    pages: Optional[int] = Field(default=None, ge=1, le=100000)
    passes: int = Field(default=0, ge=0, le=10)
    overfull: int = Field(default=0, ge=0, le=100000)
    durationMs: Optional[int] = Field(default=None, ge=0)
    at: Optional[int] = Field(default=None, ge=0)
    pageWIn: Optional[float] = Field(default=None, gt=0, le=1000)     # page 1 of the compiled PDF, inches
    pageHIn: Optional[float] = Field(default=None, gt=0, le=1000)


class LatexAsset(_Model):
    """A file the source refers to (\\includegraphics, \\input, \\addplot table, ...). Listed only: it is not stored."""
    name: str = Field(min_length=1, max_length=200)
    kind: Literal["image", "tex", "data"]


class LatexSettings(_Model):
    mode: Literal["document", "fragment"] = "document"
    engine: Literal["pdflatex", "xelatex", "lualatex"] = "pdflatex"
    native: bool = False                      # image size = the PDF page size (export.wIn / hIn then only record it)
    lastCompile: Optional[LatexCompileSummary] = None
    assets: List[LatexAsset] = Field(default_factory=list, max_length=50)


class LabelStyle(_Model):
    family: FontFamily = "sans"
    size: float = Field(default=12.0, ge=4, le=48)
    weight: Literal["normal", "bold"] = "bold"
    placement: Literal["top-left", "top-right", "bottom-left", "bottom-right"] = "top-left"
    offset: float = Field(default=0.0, ge=-100, le=100)


class CompositePanel(_Model):
    slot: int = Field(ge=0)
    record: Optional["FigureRecord"] = None

    @model_validator(mode="after")
    def _no_nesting(self) -> "CompositePanel":
        if self.record is not None and self.record.kind == "composite":
            raise ValueError("a composite panel cannot itself hold a composite figure")
        return self


class CompositeSettings(_Model):
    layout: str = "2x2"
    labels: Literal["none", "A", "a"] = "A"                  # panel letters; older records said "upper" / "lower"
    spacing: Literal["tight", "normal", "wide"] = "normal"
    legend: Literal["none", "bottom", "right"] = "none"
    fontSize: float = Field(default=10.0, ge=4, le=48)
    fontApplyAll: bool = False                               # True: fontSize also replaces the sizes panels set themselves
    alignH: Literal["left", "center", "right"] = "center"    # where a panel narrower than its column sits (never stretched)
    alignV: Literal["top", "middle", "bottom"] = "top"       # where a panel shorter than its row sits
    labelStyle: LabelStyle = Field(default_factory=LabelStyle)
    panels: List[CompositePanel] = Field(default_factory=list)

    @field_validator("labels", mode="before")
    @classmethod
    def _legacy_labels(cls, value: Any) -> Any:
        return {"upper": "A", "lower": "a"}.get(value, value)

    @model_validator(mode="after")
    def _check_layout(self) -> "CompositeSettings":
        m = _LAYOUT_RE.match(self.layout)
        if not m and self.layout not in COMPOSITE_LAYOUTS:
            raise ValueError("layout must look like '2x2' (rows x columns, 1-6 each) or be '1+2'")
        slots = COMPOSITE_LAYOUTS[self.layout] if self.layout in COMPOSITE_LAYOUTS else int(m.group(1)) * int(m.group(2))
        seen = set()
        for p in self.panels:
            if p.slot >= slots:
                raise ValueError(f"panel slot {p.slot} is outside layout {self.layout} ({slots} slots)")
            if p.slot in seen:
                raise ValueError(f"duplicate panel slot {p.slot}")
            seen.add(p.slot)
        return self


# ---------------------------------------------------------- FigureRecord
class FigureRecord(_Model):
    id: FigureId
    kind: Kind = "structured"
    name: str = Field(default="Untitled figure", max_length=MAX_NAME_CHARS)
    dataset: Dataset = Field(default_factory=Dataset)
    originalCsv: Optional[str] = None
    config: PlotConfig = Field(default_factory=PlotConfig)
    sourceMode: SourceMode = "structured"
    source: str = ""
    latex: Optional[LatexSettings] = None
    composite: Optional[CompositeSettings] = None
    export: ExportSettings = Field(default_factory=ExportSettings)
    render: RenderState = Field(default_factory=RenderState)

    @model_validator(mode="after")
    def _check_consistency(self) -> "FigureRecord":
        if self.originalCsv is not None and len(self.originalCsv) > MAX_CSV_CHARS:
            raise ValueError(f"originalCsv exceeds {MAX_CSV_CHARS} characters")
        if len(self.source) > MAX_SOURCE_CHARS:
            raise ValueError(f"source exceeds {MAX_SOURCE_CHARS} characters")
        if (self.kind == "composite") != (self.composite is not None):
            raise ValueError("'composite' settings are required for, and only allowed on, kind 'composite'")
        if (self.kind == "latex") != (self.latex is not None):
            raise ValueError("'latex' settings are required for, and only allowed on, kind 'latex'")
        return self


CompositePanel.model_rebuild()
CompositeSettings.model_rebuild()
FigureRecord.model_rebuild()


# ------------------------------------------------------------- factories
_DEFAULT_NAMES = {
    "structured": "Untitled plot",
    "python": "Python figure",
    "latex": "LaTeX figure",
    "composite": "Composite figure",
}


def new_figure_id() -> str:
    return f"fig_{uuid.uuid4().hex[:12]}"


def default_record(
    kind: str = "structured",
    plotType: str = "line",
    *,
    id: Optional[str] = None,
    name: Optional[str] = None,
) -> FigureRecord:
    """Valid FigureRecord of ``kind`` with an empty dataset and default config."""
    if kind not in KINDS:
        raise ValueError(f"unknown kind '{kind}'; expected one of {KINDS}")
    fields: Dict[str, Any] = {
        "id": id or new_figure_id(),
        "kind": kind,
        "name": name or _DEFAULT_NAMES[kind],
        "config": default_config(plotType),
        "sourceMode": "structured" if kind in ("structured", "composite") else "custom",
    }
    if kind == "latex":
        fields["latex"] = LatexSettings()
    if kind == "composite":
        fields["composite"] = CompositeSettings(panels=[CompositePanel(slot=i) for i in range(4)])
    return FigureRecord(**fields)
