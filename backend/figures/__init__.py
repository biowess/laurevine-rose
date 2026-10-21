"""Scientific Figure Studio backend (docs/FIGURES_CONTRACT.md)."""

from backend.figures.models import (
    Appearance,
    Column,
    CompositePanel,
    CompositeSettings,
    Dataset,
    DatasetOrigin,
    ExportSettings,
    FigureRecord,
    LatexSettings,
    Mapping,
    Options,
    PlotConfig,
    RenderState,
    SeriesStyle,
    default_config,
    default_record,
)

__all__ = [
    "Appearance", "Column", "CompositePanel", "CompositeSettings", "Dataset",
    "DatasetOrigin", "ExportSettings", "FigureRecord", "LatexSettings", "Mapping",
    "Options", "PlotConfig", "RenderState", "SeriesStyle", "default_config", "default_record",
]
