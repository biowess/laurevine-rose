"""Canonical Slide Document Model and Validation.

Defines the versioned schema for presentation documents, slides, and slide objects.
Ensures clean serialization, deserialization, and structural validation between the
HTML frontend and the Python PPTX exporter.
"""

import copy
from typing import Any, Dict, List, Optional
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from backend import palettes as palettes_mod
from backend import typography as typography_mod
from backend.assets import resolve_assets
from backend.headerfooter import clean_slide, normalize_doc_dict
from backend.figures.models import MAX_FIGURES_PER_DOC, FigureRecord

SCHEMA_VERSION = 2


class CellFmt(BaseModel):
    fill: Optional[str] = None
    color: Optional[str] = None
    font: Optional[str] = None
    fontSize: Optional[float] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    underline: Optional[bool] = None
    strike: Optional[bool] = None
    subscript: Optional[bool] = None
    superscript: Optional[bool] = None
    align: Optional[str] = None
    vAlign: Optional[str] = None

    model_config = ConfigDict(extra="allow")


class TableBorder(BaseModel):
    color: Optional[str] = None
    width: Optional[float] = None

    model_config = ConfigDict(extra="allow")


class SlideSize(BaseModel):
    w: float = Field(default=1280.0, description="Slide width in logical pixels")
    h: float = Field(default=720.0, description="Slide height in logical pixels")

    model_config = ConfigDict(extra="ignore")


class SlideObject(BaseModel):
    id: str
    type: str = Field(description="Object type: text, shape, image, table, plot, figure")
    x: float = 0.0
    y: float = 0.0
    w: float = 100.0
    h: float = 100.0

    # Common text & styling properties
    role: Optional[str] = None
    html: Optional[str] = ""
    text: Optional[str] = None
    fontSize: Optional[float] = None  # in points (pt)
    font: Optional[str] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    underline: Optional[bool] = None
    strike: Optional[bool] = None
    subscript: Optional[bool] = None
    superscript: Optional[bool] = None
    color: Optional[str] = None
    align: Optional[str] = "left"  # left, center, right, justify
    vAlign: Optional[str] = "top"  # top, middle, bottom
    lineHeight: Optional[float] = 1.2
    list: Optional[str] = None  # bullet, number, or None
    indent: Optional[int] = 0
    spaceAfter: Optional[float] = 0.0

    # Shape specific
    shape: Optional[str] = "rect"  # rect, rounded, ellipse, line, triangle, diamond, arrow, etc.
    fill: Optional[str] = None
    stroke: Optional[str] = None
    strokeWidth: Optional[float] = None
    adj: Optional[float] = 0.5
    cornerRadius: Optional[float] = None
    rotation: Optional[float] = None
    opacity: Optional[float] = None

    # Line specific endpoints
    x1: Optional[float] = None
    y1: Optional[float] = None
    x2: Optional[float] = None
    y2: Optional[float] = None

    # Image specific
    src: Optional[str] = None  # data URL (base64) or file path
    name: Optional[str] = None
    alt: Optional[str] = None
    aspect: Optional[float] = None

    # Table specific
    headerRow: Optional[bool] = True
    banded: Optional[bool] = True
    cells: Optional[List[List[str]]] = None
    colW: Optional[List[float]] = None
    rowH: Optional[List[float]] = None
    cellFmt: Optional[Dict[str, CellFmt]] = None
    tableBorder: Optional[TableBorder] = None

    # Grouping
    groupId: Optional[str] = None

    # Allow extra fields for plots, figures, scientific metadata
    model_config = ConfigDict(extra="allow")


class SlideModel(BaseModel):
    id: str
    layout: str = "titleContent"
    bg: Optional[str] = None
    notes: str = ""
    objects: List[SlideObject] = Field(default_factory=list)

    model_config = ConfigDict(extra="allow")

    @model_validator(mode="before")
    @classmethod
    def _normalize_hf(cls, data: Any) -> Any:
        if isinstance(data, dict) and "hf" in data:
            data = dict(data)
            cleaned = clean_slide(data["hf"])
            if cleaned:
                data["hf"] = cleaned
            else:
                del data["hf"]
        return data


class CommentModel(BaseModel):
    id: str
    slideId: str
    author: str = ""
    text: str = ""
    ts: Optional[float] = None
    resolved: bool = False

    model_config = ConfigDict(extra="allow")


class PresentationDoc(BaseModel):
    schemaVersion: int = Field(default=SCHEMA_VERSION, ge=1)
    id: Optional[str] = None
    title: str = "Untitled Presentation"
    size: SlideSize = Field(default_factory=SlideSize)
    themeId: str = "journal"
    paletteId: str = "burgundy"
    typeId: str = "outfit"
    typography: Optional[Dict[str, Any]] = None   # resolved typography preset snapshot (backend/typography.py); absent in old documents
    palette: Optional[Dict[str, Any]] = None   # resolved colour palette snapshot (backend/palettes.py); absent in old documents
    slides: List[SlideModel] = Field(default_factory=list)
    comments: List[CommentModel] = Field(default_factory=list)
    figures: Dict[str, FigureRecord] = Field(default_factory=dict)

    model_config = ConfigDict(extra="allow")

    @model_validator(mode="before")
    @classmethod
    def _resolve_assets(cls, data: Any) -> Any:
        # Persisted documents keep pictures in ``assets`` and refer to them as ``asset:<id>`` (backend/assets.py);
        # the models and the exporter only ever see the inline data URLs.
        # Optional header/footer data (doc.hf / slide.hf) is repaired here; empty objects are removed, never created.
        return normalize_doc_dict(resolve_assets(data)) if isinstance(data, dict) else data

    @field_validator("typography", mode="before")
    @classmethod
    def _clean_typography(cls, v: Any) -> Any:
        return typography_mod.sanitize(v)

    @field_validator("palette", mode="before")
    @classmethod
    def _clean_palette(cls, v: Any) -> Any:
        return palettes_mod.sanitize(v)

    @model_validator(mode="after")
    def _check_figures(self) -> "PresentationDoc":
        if len(self.figures) > MAX_FIGURES_PER_DOC:
            raise ValueError(f"document has {len(self.figures)} figures; the limit is {MAX_FIGURES_PER_DOC}")
        for key, rec in self.figures.items():
            if key != rec.id:
                raise ValueError(f"figures key '{key}' does not match record id '{rec.id}'")
        return self


def migrate_v1_to_v2(data: Dict[str, Any]) -> Dict[str, Any]:
    """Return a v2 copy of a raw document dict (the input is not modified).

    v1 -> v2 only adds ``figures`` ({}) and bumps ``schemaVersion``; slide objects,
    including plot/figure objects without a ``figureId``, are carried over unchanged.
    Documents already at v2 pass through; anything newer or malformed raises ValueError.
    """
    if not isinstance(data, dict):
        raise ValueError("document must be an object")
    out = copy.deepcopy(data)
    version = out.get("schemaVersion", 1)
    if version is None:
        version = 1
    if isinstance(version, bool) or not isinstance(version, int) or version < 1:
        raise ValueError(f"invalid schemaVersion {version!r}")
    if version > SCHEMA_VERSION:
        raise ValueError(f"unsupported schemaVersion {version}; this build reads up to {SCHEMA_VERSION}")
    out["schemaVersion"] = SCHEMA_VERSION
    figures = out.get("figures")
    if figures is None:
        out["figures"] = {}
    elif not isinstance(figures, dict):
        raise ValueError("'figures' must be an object keyed by figure id")
    return out


def upgrade_document(doc: PresentationDoc) -> PresentationDoc:
    """Model-level equivalent of migrate_v1_to_v2 (used by the server on save/export)."""
    if doc.schemaVersion > SCHEMA_VERSION:
        raise ValueError(f"unsupported schemaVersion {doc.schemaVersion}; this build reads up to {SCHEMA_VERSION}")
    if doc.schemaVersion == SCHEMA_VERSION:
        return doc
    return doc.model_copy(update={"schemaVersion": SCHEMA_VERSION})


class ExportRequest(BaseModel):
    format: str = "pptx"
    doc: PresentationDoc

    model_config = ConfigDict(extra="allow")


class SaveRequest(BaseModel):
    doc: PresentationDoc

    model_config = ConfigDict(extra="allow")


