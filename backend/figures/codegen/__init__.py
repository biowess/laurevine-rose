"""Matplotlib script generators for structured figures (docs/FIGURES_CONTRACT.md s2, s4c)."""

from backend.figures.codegen import bar, box, common, composite, heatmap, hist, line, scatter
from backend.figures.codegen.common import CodegenError, GeneratedScript, emit_fragment, emit_script

common.GENERATORS["line"] = line.generate        # one line per plot type; new generators register here
common.GENERATORS["scatter"] = scatter.generate
common.GENERATORS["bar"] = bar.generate
common.GENERATORS["hist"] = hist.generate
common.GENERATORS["box"] = box.generate
common.GENERATORS["heatmap"] = heatmap.generate
common.GENERATORS["composite"] = composite.generate   # keyed by record kind; takes the extra keyword preview

emit_axes = emit_fragment    # emit_axes(record, ax_name="ax"): the plot of a structured record as a fragment drawing onto ax_name

__all__ = ["CodegenError", "GeneratedScript", "emit_axes", "emit_script"]
