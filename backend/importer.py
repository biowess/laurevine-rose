"""PowerPoint (.pptx) Importer for Laurevine Rose / Laurevine Rose.

Parses native PowerPoint presentations using python-pptx into canonical PresentationDoc models.
Converts slides, shapes, text boxes, rich formatting, tables, lines, connectors, and pictures.
Tracks reliably identifiable unsupported elements (charts, SmartArt, media, OLE objects, 3D models).
"""

from __future__ import annotations

import base64
import html
import io
import os
import uuid
import zipfile
from typing import Any, Dict, List, Optional, Tuple, Union

import pptx
from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE, MSO_SHAPE_TYPE, PP_PLACEHOLDER
from pptx.enum.text import MSO_ANCHOR, PP_ALIGN
from pptx.util import Pt
from lxml import etree

from backend.exporter import EMU_PER_PIXEL
from backend.models import (
    CellFmt,
    PresentationDoc,
    SlideModel,
    SlideObject,
    SlideSize,
    TableBorder,
)

A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"

# Map python-pptx auto shape types to Laurevine Rose shape names
SHAPE_TYPE_MAP: Dict[Any, str] = {
    MSO_SHAPE.RECTANGLE: "rect",
    MSO_SHAPE.ROUNDED_RECTANGLE: "rounded",
    MSO_SHAPE.OVAL: "ellipse",
    MSO_SHAPE.ISOSCELES_TRIANGLE: "triangle",
    MSO_SHAPE.RIGHT_TRIANGLE: "rtriangle",
    MSO_SHAPE.DIAMOND: "diamond",
    MSO_SHAPE.REGULAR_PENTAGON: "pentagon",
    MSO_SHAPE.HEXAGON: "hexagon",
    MSO_SHAPE.OCTAGON: "octagon",
    MSO_SHAPE.PARALLELOGRAM: "parallelogram",
    MSO_SHAPE.TRAPEZOID: "trapezoid",
    MSO_SHAPE.RIGHT_ARROW: "arrow",
    MSO_SHAPE.LEFT_ARROW: "arrowLeft",
    MSO_SHAPE.UP_ARROW: "arrowUp",
    MSO_SHAPE.DOWN_ARROW: "arrowDown",
    MSO_SHAPE.LEFT_RIGHT_ARROW: "arrowLeftRight",
    MSO_SHAPE.UP_DOWN_ARROW: "arrowUpDown",
    MSO_SHAPE.STAR_5_POINT: "star",
    MSO_SHAPE.STAR_6_POINT: "star6",
    MSO_SHAPE.HEART: "heart",
    MSO_SHAPE.CLOUD: "cloud",
    MSO_SHAPE.LIGHTNING_BOLT: "lightning",
}

ALIGN_MAP: Dict[Any, str] = {
    PP_ALIGN.LEFT: "left",
    PP_ALIGN.CENTER: "center",
    PP_ALIGN.RIGHT: "right",
    PP_ALIGN.JUSTIFY: "justify",
}

VALIGN_MAP: Dict[Any, str] = {
    MSO_ANCHOR.TOP: "top",
    MSO_ANCHOR.MIDDLE: "middle",
    MSO_ANCHOR.BOTTOM: "bottom",
}


def _color_to_hex(color_obj: Any) -> Optional[str]:
    """Extract RGB hex string from python-pptx color object."""
    if not color_obj:
        return None
    try:
        # Check if solid RGB color
        if color_obj.type == 1:  # MSO_COLOR_TYPE.RGB
            return f"#{color_obj.rgb}"
    except Exception:
        pass
    try:
        # Fallback to direct rgb property
        rgb = getattr(color_obj, "rgb", None)
        if rgb is not None:
            return f"#{rgb}"
    except Exception:
        pass
    return None


def _extract_fill(shape: Any) -> Optional[str]:
    """Extract fill color hex from a shape, or None."""
    if not hasattr(shape, "fill"):
        return None
    try:
        fill = shape.fill
        if fill.type == 1:  # SOLID
            return _color_to_hex(fill.fore_color)
    except Exception:
        pass
    return None


def _extract_line(shape: Any) -> Tuple[Optional[str], Optional[float]]:
    """Extract (stroke_color, stroke_width_px) from a shape."""
    if not hasattr(shape, "line"):
        return None, None
    try:
        line = shape.line
        color = _color_to_hex(getattr(line, "color", None))
        width = None
        if getattr(line, "width", None) is not None and line.width > 0:
            width = round(line.width / EMU_PER_PIXEL, 1)
        return color, width
    except Exception:
        return None, None


def _extract_cell_fmt(cell: Any) -> Dict[str, Any]:
    """Extract formatting dictionary for a table cell."""
    fmt: Dict[str, Any] = {}
    try:
        if cell.fill and cell.fill.type == 1:
            color = _color_to_hex(cell.fill.fore_color)
            if color:
                fmt["fill"] = color
    except Exception:
        pass

    try:
        if cell.text_frame and cell.text_frame.paragraphs:
            p0 = cell.text_frame.paragraphs[0]
            if p0.runs:
                r0 = p0.runs[0]
                if r0.font.bold:
                    fmt["bold"] = True
                if r0.font.italic:
                    fmt["italic"] = True
                if r0.font.size:
                    fmt["fontSize"] = round(r0.font.size.pt, 1)
                run_color = _color_to_hex(getattr(r0.font, "color", None))
                if run_color:
                    fmt["color"] = run_color
            if p0.alignment in ALIGN_MAP:
                fmt["align"] = ALIGN_MAP[p0.alignment]
    except Exception:
        pass

    return fmt


def _extract_text_frame(tf: Any) -> Tuple[str, Optional[str], Optional[float], Optional[str], str, str]:
    """Parses a PowerPoint TextFrame into clean HTML and returns:
    (html_content, primary_font, primary_size_pt, primary_color_hex, align, v_align)
    """
    if tf is None:
        return "", None, None, None, "left", "top"

    v_align = VALIGN_MAP.get(tf.vertical_anchor, "top")
    align = "left"

    primary_font = None
    primary_size = None
    primary_color = None

    # Scan for primary styling from first available run
    for p in tf.paragraphs:
        if p.alignment in ALIGN_MAP and align == "left":
            align = ALIGN_MAP[p.alignment]
        for r in p.runs:
            if primary_font is None and getattr(r.font, "name", None):
                primary_font = r.font.name
            if primary_size is None and getattr(r.font, "size", None):
                primary_size = round(r.font.size.pt, 1)
            if primary_color is None:
                primary_color = _color_to_hex(getattr(r.font, "color", None))
            if primary_font and primary_size and primary_color:
                break
        if primary_font and primary_size and primary_color:
            break

    if primary_size is None:
        primary_size = 18.0

    paragraphs_html: List[str] = []

    for p in tf.paragraphs:
        p_runs_html: List[str] = []
        for r in p.runs:
            text = html.escape(r.text)
            if not text:
                continue

            # Check baseline for subscript / superscript and strikethrough in drawingml oxml
            rpr = r._r.find(f"{{{A_NS}}}rPr")
            baseline = None
            strike = None
            if rpr is not None:
                b_attr = rpr.get("baseline")
                if b_attr:
                    try:
                        baseline = int(b_attr)
                    except ValueError:
                        pass
                strike = rpr.get("strike")

            # Check run-specific styling overrides
            styles: List[str] = []
            if r.font.size and abs(r.font.size.pt - primary_size) > 0.5:
                styles.append(f"font-size:{round(r.font.size.pt, 1)}pt")
            run_color = _color_to_hex(getattr(r.font, "color", None))
            if run_color and primary_color and run_color.lower() != primary_color.lower():
                styles.append(f"color:{run_color}")

            inner = text
            if r.font.bold:
                inner = f"<b>{inner}</b>"
            if r.font.italic:
                inner = f"<i>{inner}</i>"
            if r.font.underline:
                inner = f"<u>{inner}</u>"
            if strike in ("sngStrike", "dblStrike"):
                inner = f"<s>{inner}</s>"
            if baseline is not None:
                if baseline < 0:
                    inner = f"<sub>{inner}</sub>"
                elif baseline > 0:
                    inner = f"<sup>{inner}</sup>"
            if styles:
                inner = f'<span style="{";".join(styles)}">{inner}</span>'

            p_runs_html.append(inner)

        if p_runs_html:
            p_align = ALIGN_MAP.get(p.alignment, align)
            align_attr = f' align="{p_align}"' if p_align != "left" else ""
            paragraphs_html.append(f"<p{align_attr}>{''.join(p_runs_html)}</p>")
        elif len(tf.paragraphs) > 1:
            paragraphs_html.append("<p><br></p>")

    full_html = "".join(paragraphs_html)
    if not full_html and getattr(tf, "text", None):
        full_html = f"<p>{html.escape(tf.text)}</p>"

    return full_html, primary_font, primary_size, primary_color, align, v_align


def import_presentation(
    source: Union[bytes, io.BytesIO, str, os.PathLike],
    warnings: Optional[List[Dict[str, Any]]] = None,
) -> PresentationDoc:
    """Imports a PowerPoint (.pptx) file or buffer and returns a canonical PresentationDoc.

    Args:
        source: bytes, file-like BytesIO, or path to PPTX file.
        warnings: optional list that will be populated with reliably identified unsupported elements.

    Returns:
        PresentationDoc representing the imported presentation.

    Raises:
        ValueError: If file is not a valid PPTX or is corrupted.
    """
    if warnings is None:
        warnings = []

    # Prepare input stream
    if isinstance(source, (str, os.PathLike)):
        try:
            with open(source, "rb") as f:
                stream = io.BytesIO(f.read())
        except Exception as exc:
            raise ValueError(f"Could not read PowerPoint file: {exc}") from exc
    elif isinstance(source, bytes):
        stream = io.BytesIO(source)
    else:
        stream = source

    try:
        stream.seek(0)
        prs = Presentation(stream)
    except Exception as exc:
        raise ValueError("The selected file is not a valid PowerPoint presentation or is corrupted.") from exc

    # Presentation canvas dimensions
    w_px = round(prs.slide_width / EMU_PER_PIXEL, 1) if prs.slide_width else 1280.0
    h_px = round(prs.slide_height / EMU_PER_PIXEL, 1) if prs.slide_height else 720.0
    doc_size = SlideSize(w=w_px, h=h_px)

    slides: List[SlideModel] = []

    for slide_idx, slide in enumerate(prs.slides, start=1):
        slide_id = f"s_{uuid.uuid4().hex[:8]}"

        # Speaker notes
        notes = ""
        try:
            if slide.has_notes_slide and slide.notes_slide.notes_text_frame:
                notes = slide.notes_slide.notes_text_frame.text or ""
        except Exception:
            pass

        # Slide background
        slide_bg = None
        try:
            if hasattr(slide, "background") and hasattr(slide.background, "fill"):
                if slide.background.fill.type == 1:
                    slide_bg = _color_to_hex(slide.background.fill.fore_color)
        except Exception:
            pass

        objects: List[SlideObject] = []

        def process_shape(shape: Any, group_id: Optional[str] = None) -> None:
            shape_type = getattr(shape, "shape_type", None)

            # 1. Reliable detection of unsupported elements
            if shape_type == MSO_SHAPE_TYPE.CHART:
                warnings.append({
                    "slide": slide_idx,
                    "shape": getattr(shape, "name", "Chart"),
                    "type": "chart",
                    "message": f"Chart '{shape.name}' on slide {slide_idx} is not supported and was omitted.",
                })
                return

            if shape_type == MSO_SHAPE_TYPE.IGX_GRAPHIC:
                warnings.append({
                    "slide": slide_idx,
                    "shape": getattr(shape, "name", "SmartArt"),
                    "type": "smartart",
                    "message": f"SmartArt diagram '{shape.name}' on slide {slide_idx} is not supported and was omitted.",
                })
                return

            if shape_type == MSO_SHAPE_TYPE.MEDIA:
                warnings.append({
                    "slide": slide_idx,
                    "shape": getattr(shape, "name", "Media"),
                    "type": "media",
                    "message": f"Media element '{shape.name}' on slide {slide_idx} is not supported and was omitted.",
                })
                return

            if shape_type == MSO_SHAPE_TYPE.EMBEDDED_OLE_OBJECT:
                warnings.append({
                    "slide": slide_idx,
                    "shape": getattr(shape, "name", "OLE Object"),
                    "type": "ole",
                    "message": f"Embedded OLE object '{shape.name}' on slide {slide_idx} is not supported and was omitted.",
                })
                return

            # Check 3D model if available
            model_3d_code = getattr(MSO_SHAPE_TYPE, "MODEL_3D", 26)
            if shape_type == model_3d_code:
                warnings.append({
                    "slide": slide_idx,
                    "shape": getattr(shape, "name", "3D Model"),
                    "type": "model_3d",
                    "message": f"3D Model '{shape.name}' on slide {slide_idx} is not supported and was omitted.",
                })
                return

            # 2. Group shapes
            if shape_type == MSO_SHAPE_TYPE.GROUP:
                gid = group_id or f"g_{uuid.uuid4().hex[:8]}"
                for child in shape.shapes:
                    process_shape(child, group_id=gid)
                return

            # 3. Tables
            if shape_type == MSO_SHAPE_TYPE.TABLE or getattr(shape, "has_table", False):
                table = shape.table
                rows = len(table.rows)
                cols = len(table.columns)
                col_w = [round(c.width / EMU_PER_PIXEL, 1) for c in table.columns]
                row_h = [round(r.height / EMU_PER_PIXEL, 1) for r in table.rows]
                cells = []
                cell_fmt = {}
                for r_idx, row in enumerate(table.rows):
                    row_cells = []
                    for c_idx, cell in enumerate(row.cells):
                        row_cells.append(cell.text or "")
                        fmt = _extract_cell_fmt(cell)
                        if fmt:
                            cell_fmt[f"{r_idx}_{c_idx}"] = CellFmt(**fmt)
                    cells.append(row_cells)

                obj_x = round(shape.left / EMU_PER_PIXEL, 1)
                obj_y = round(shape.top / EMU_PER_PIXEL, 1)
                obj_w = round(shape.width / EMU_PER_PIXEL, 1)
                obj_h = round(shape.height / EMU_PER_PIXEL, 1)

                objects.append(
                    SlideObject(
                        id=f"o_{uuid.uuid4().hex[:8]}",
                        type="table",
                        x=obj_x,
                        y=obj_y,
                        w=obj_w,
                        h=obj_h,
                        cells=cells,
                        colW=col_w,
                        rowH=row_h,
                        cellFmt=cell_fmt if cell_fmt else None,
                        headerRow=getattr(table, "first_row", True),
                        banded=getattr(table, "horz_banding", True),
                        groupId=group_id,
                    )
                )
                return

            # 4. Pictures / Images
            if shape_type == MSO_SHAPE_TYPE.PICTURE:
                image = shape.image
                blob = image.blob
                ctype = getattr(image, "content_type", "image/png")
                b64 = base64.b64encode(blob).decode("ascii")
                src = f"data:{ctype};base64,{b64}"

                alt = ""
                try:
                    alt = shape._element.nvPicPr.cNvPr.get("descr") or ""
                except Exception:
                    pass

                obj_x = round(shape.left / EMU_PER_PIXEL, 1)
                obj_y = round(shape.top / EMU_PER_PIXEL, 1)
                obj_w = round(shape.width / EMU_PER_PIXEL, 1)
                obj_h = round(shape.height / EMU_PER_PIXEL, 1)
                aspect = round(obj_w / obj_h, 4) if obj_h > 0 else 1.0

                objects.append(
                    SlideObject(
                        id=f"o_{uuid.uuid4().hex[:8]}",
                        type="image",
                        role="figure",
                        x=obj_x,
                        y=obj_y,
                        w=obj_w,
                        h=obj_h,
                        src=src,
                        name=getattr(shape, "name", "Picture"),
                        alt=alt,
                        aspect=aspect,
                        groupId=group_id,
                    )
                )
                return

            # 5. Lines / Connectors
            if shape_type == MSO_SHAPE_TYPE.LINE or isinstance(shape, MSO_CONNECTOR) or "Connector" in shape.name:
                bx = getattr(shape, "begin_x", shape.left) / EMU_PER_PIXEL
                by = getattr(shape, "begin_y", shape.top) / EMU_PER_PIXEL
                ex = getattr(shape, "end_x", shape.left + shape.width) / EMU_PER_PIXEL
                ey = getattr(shape, "end_y", shape.top + shape.height) / EMU_PER_PIXEL

                x = round(min(bx, ex), 1)
                y = round(min(by, ey), 1)
                w = round(max(abs(ex - bx), 1.0), 1)
                h = round(max(abs(ey - by), 1.0), 1)

                stroke, stroke_w = _extract_line(shape)
                objects.append(
                    SlideObject(
                        id=f"o_{uuid.uuid4().hex[:8]}",
                        type="shape",
                        shape="line",
                        x=x,
                        y=y,
                        w=w,
                        h=h,
                        x1=round(bx, 1),
                        y1=round(by, 1),
                        x2=round(ex, 1),
                        y2=round(ey, 1),
                        stroke=stroke or "#292A2D",
                        strokeWidth=stroke_w or 1.0,
                        groupId=group_id,
                    )
                )
                return

            # 6. Auto shapes and Text Boxes
            has_tf = getattr(shape, "has_text_frame", False)
            if has_tf or shape_type == MSO_SHAPE_TYPE.AUTO_SHAPE or shape_type == MSO_SHAPE_TYPE.TEXT_BOX:
                obj_x = round(shape.left / EMU_PER_PIXEL, 1)
                obj_y = round(shape.top / EMU_PER_PIXEL, 1)
                obj_w = round(shape.width / EMU_PER_PIXEL, 1)
                obj_h = round(shape.height / EMU_PER_PIXEL, 1)
                rotation = round(getattr(shape, "rotation", 0.0), 1)

                fill = _extract_fill(shape)
                stroke, stroke_w = _extract_line(shape)

                html_content, primary_font, primary_size, primary_color, align, v_align = (
                    _extract_text_frame(shape.text_frame) if has_tf else ("", None, 18.0, None, "left", "top")
                )

                # Determine role if placeholder
                role = None
                is_placeholder_shape = False
                try:
                    if getattr(shape, "is_placeholder", False):
                        is_placeholder_shape = True
                        ph = shape.placeholder_format.type
                        if ph in (PP_PLACEHOLDER.TITLE, PP_PLACEHOLDER.CENTER_TITLE):
                            role = "title"
                        elif ph == PP_PLACEHOLDER.SUBTITLE:
                            role = "subtitle"
                        elif ph == PP_PLACEHOLDER.BODY:
                            role = "text"
                except Exception:
                    pass

                # Safely get auto_shape_type
                auto_type = None
                try:
                    auto_type = shape.auto_shape_type
                except Exception:
                    auto_type = None

                # Check if this object is purely a text box
                is_textbox = (
                    shape_type == MSO_SHAPE_TYPE.TEXT_BOX
                    or is_placeholder_shape
                    or (
                        fill is None
                        and stroke is None
                        and auto_type in (None, MSO_SHAPE.RECTANGLE)
                        and ("TextBox" in getattr(shape, "name", "") or "Text Box" in getattr(shape, "name", "") or not getattr(shape, "name", ""))
                    )
                )

                if is_textbox:
                    objects.append(
                        SlideObject(
                            id=f"o_{uuid.uuid4().hex[:8]}",
                            type="text",
                            role=role,
                            x=obj_x,
                            y=obj_y,
                            w=obj_w,
                            h=obj_h,
                            html=html_content,
                            fontSize=primary_size,
                            font=primary_font,
                            color=primary_color,
                            align=align,
                            vAlign=v_align,
                            fill=fill,
                            stroke=stroke,
                            strokeWidth=stroke_w,
                            rotation=rotation if rotation else None,
                            groupId=group_id,
                        )
                    )
                else:
                    shape_name = SHAPE_TYPE_MAP.get(auto_type, "rect")
                    corner_radius = None
                    if shape_name == "rounded":
                        try:
                            if shape.adjustments and len(shape.adjustments) > 0:
                                corner_radius = round(shape.adjustments[0] * min(obj_w, obj_h), 1)
                        except Exception:
                            pass

                    objects.append(
                        SlideObject(
                            id=f"o_{uuid.uuid4().hex[:8]}",
                            type="shape",
                            shape=shape_name,
                            cornerRadius=corner_radius,
                            x=obj_x,
                            y=obj_y,
                            w=obj_w,
                            h=obj_h,
                            html=html_content,
                            fontSize=primary_size,
                            font=primary_font,
                            color=primary_color,
                            align=align,
                            vAlign=v_align,
                            fill=fill,
                            stroke=stroke,
                            strokeWidth=stroke_w,
                            rotation=rotation if rotation else None,
                            groupId=group_id,
                        )
                    )
                return

            # Any other shape: try to import as shape or text box if possible
            if getattr(shape, "width", 0) > 0 and getattr(shape, "height", 0) > 0:
                obj_x = round(shape.left / EMU_PER_PIXEL, 1)
                obj_y = round(shape.top / EMU_PER_PIXEL, 1)
                obj_w = round(shape.width / EMU_PER_PIXEL, 1)
                obj_h = round(shape.height / EMU_PER_PIXEL, 1)
                fill = _extract_fill(shape)
                stroke, stroke_w = _extract_line(shape)
                objects.append(
                    SlideObject(
                        id=f"o_{uuid.uuid4().hex[:8]}",
                        type="shape",
                        shape="rect",
                        x=obj_x,
                        y=obj_y,
                        w=obj_w,
                        h=obj_h,
                        fill=fill,
                        stroke=stroke,
                        strokeWidth=stroke_w,
                        groupId=group_id,
                    )
                )

        for shape in slide.shapes:
            process_shape(shape)

        slides.append(
            SlideModel(
                id=slide_id,
                layout="titleContent",
                bg=slide_bg,
                notes=notes,
                objects=objects,
            )
        )

    return PresentationDoc(
        schemaVersion=2,
        id=f"deck_{uuid.uuid4().hex[:8]}",
        title="Imported Presentation",
        size=doc_size,
        themeId="journal",
        paletteId="burgundy",
        typeId="outfit",
        slides=slides,
        comments=[],
        figures={},
    )
