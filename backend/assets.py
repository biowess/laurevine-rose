"""Image assets of a persisted document (contract 3e).

A saved / exported document keeps every picture once in ``doc["assets"]`` ({assetId: image data URL}) and refers to it
as ``"asset:<id>"`` from a slide object's ``src`` and from a figure record's ``render.preview``. ``resolve_assets`` turns
such a document back into the inline form the models and the exporter read. Pure Python, no third-party imports.
"""

import re
from typing import Any, Dict

ASSET_ID = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
ASSET_REF = re.compile(r"^asset:([A-Za-z0-9_-]{1,80})$")
MAX_ASSETS = 4000


def _check_assets(assets: Any) -> Dict[str, str]:
    if not isinstance(assets, dict):
        raise ValueError("'assets' must be an object keyed by asset id")
    if len(assets) > MAX_ASSETS:
        raise ValueError(f"document has {len(assets)} assets; the limit is {MAX_ASSETS}")
    for key, value in assets.items():
        if not isinstance(key, str) or not ASSET_ID.match(key):
            raise ValueError(f"invalid asset id {key!r}")
        if not isinstance(value, str) or not value.startswith("data:image/"):
            raise ValueError(f"asset '{key}' must be an image data URL")
    return assets


def resolve_assets(data: Dict[str, Any]) -> Dict[str, Any]:
    """Return a copy of the document dict with ``asset:<id>`` references replaced by the data URLs of ``assets``.

    The result has no ``assets`` key. A reference without a matching asset becomes ``None`` (the object stays, without
    a picture; the exporter then draws its placeholder). Only dicts are visited, so model instances pass through.
    The input is not modified; unchanged parts are shared, not copied.
    """
    if not isinstance(data, dict) or ("assets" not in data and not _has_refs(data)):
        return data
    assets = _check_assets(data["assets"]) if data.get("assets") is not None else {}

    def sub(value: Any) -> Any:
        if isinstance(value, str):
            match = ASSET_REF.match(value)
            if match:
                return assets.get(match.group(1))
        return value

    out = {k: v for k, v in data.items() if k != "assets"}
    slides = out.get("slides")
    if isinstance(slides, list):
        new_slides = []
        for slide in slides:
            if isinstance(slide, dict) and isinstance(slide.get("objects"), list):
                objects = [
                    {**o, "src": sub(o["src"])} if isinstance(o, dict) and isinstance(o.get("src"), str) else o
                    for o in slide["objects"]
                ]
                slide = {**slide, "objects": objects}
            new_slides.append(slide)
        out["slides"] = new_slides
    figures = out.get("figures")
    if isinstance(figures, dict):
        new_figs = {}
        for fid, rec in figures.items():
            render = rec.get("render") if isinstance(rec, dict) else None
            if isinstance(render, dict) and isinstance(render.get("preview"), str):
                rec = {**rec, "render": {**render, "preview": sub(render["preview"])}}
            new_figs[fid] = rec
        out["figures"] = new_figs
    return out


def _has_refs(data: Dict[str, Any]) -> bool:
    """True when a slide object ``src`` or a figure preview still holds an ``asset:`` reference (document without assets)."""
    for slide in data.get("slides") or []:
        for obj in (slide.get("objects") or []) if isinstance(slide, dict) else []:
            if isinstance(obj, dict) and isinstance(obj.get("src"), str) and obj["src"].startswith("asset:"):
                return True
    for rec in (data.get("figures") or {}).values() if isinstance(data.get("figures"), dict) else []:
        render = rec.get("render") if isinstance(rec, dict) else None
        if isinstance(render, dict) and isinstance(render.get("preview"), str) and render["preview"].startswith("asset:"):
            return True
    return False
