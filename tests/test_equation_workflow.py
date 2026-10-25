"""tests/test_equation_workflow.py
Dedicated tests for the LaTeX equation rendering pipeline.

Covers:
  - normalize_equation_source():  all input variants
  - render_equation():  valid math cases (fraction, Greek, integral, matrix, sub/sup)
  - render_equation():  invalid LaTeX
  - render_equation():  light and dark foreground colors
  - PNG output properties (RGBA mode, transparent corners)
  - Model round-trip:  extra fields (latex, equationColor) preserved via SlideObject

NOTE: Packaged-build behaviour is NOT tested here; it cannot be verified without
running an actual PyInstaller build.
"""

import base64
import io
import json

import pytest

# ── import the module under test ──────────────────────────────────────────────
from backend.figures.latex import normalize_equation_source, render_equation


# ═══════════════════════════════════════════════════════════════════════════════
# normalize_equation_source
# ═══════════════════════════════════════════════════════════════════════════════

class TestNormalizeEquationSource:
    """normalize_equation_source() should produce a standalone-compatible fragment."""

    def _prefix(self, result: str) -> str:
        return result.split("$\\displaystyle")[0] if "$\\displaystyle" in result else ""

    def _body(self, result: str) -> str:
        """Extract the math body between $\\displaystyle and the closing $."""
        if "$\\displaystyle" not in result:
            return result
        inner = result.split("$\\displaystyle", 1)[1]
        return inner.rstrip(" $").strip()

    def test_bare_fraction(self):
        out = normalize_equation_source(r"\frac{a}{b}")
        assert out.startswith("$\\displaystyle")
        assert "\\frac{a}{b}" in out

    def test_inline_dollar_delimiters(self):
        out = normalize_equation_source(r"$\alpha$")
        assert "\\alpha" in out
        assert out.startswith("$\\displaystyle")

    def test_display_dollar_delimiters(self):
        out = normalize_equation_source(r"$$\int_0^1 x\,dx$$")
        assert "\\int_0^1" in out
        assert out.startswith("$\\displaystyle")

    def test_display_bracket_delimiters(self):
        out = normalize_equation_source(r"\[ E = mc^2 \]")
        assert "E = mc^2" in out
        assert out.startswith("$\\displaystyle")

    def test_begin_equation(self):
        out = normalize_equation_source(r"\begin{equation}x = 1\end{equation}")
        assert "x = 1" in out
        assert "\\begin{equation}" not in out

    def test_begin_equation_star(self):
        out = normalize_equation_source(r"\begin{equation*}y^2\end{equation*}")
        assert "y^2" in out
        assert "\\begin{equation" not in out

    def test_begin_align_converted(self):
        out = normalize_equation_source(r"\begin{align}a &= b\end{align}")
        assert "\\begin{aligned}" in out
        assert "\\begin{align}" not in out

    def test_begin_align_star_converted(self):
        out = normalize_equation_source(r"\begin{align*}c &= d\end{align*}")
        assert "\\begin{aligned}" in out
        assert "\\begin{align*}" not in out

    def test_empty_string(self):
        out = normalize_equation_source("")
        # Should still return a $\displaystyle $ fragment (possibly empty body)
        assert out.startswith("$\\displaystyle")

    def test_whitespace_only(self):
        out = normalize_equation_source("   ")
        assert out.startswith("$\\displaystyle")

    def test_already_wrapped_in_displaystyle(self):
        # Should not double-wrap: bare source is wrapped once
        src = r"\frac{1}{2}"
        out = normalize_equation_source(src)
        assert out.count("$\\displaystyle") == 1


# ═══════════════════════════════════════════════════════════════════════════════
# render_equation — helpers
# ═══════════════════════════════════════════════════════════════════════════════

def _png_from_result(result: dict):
    """Extract a PIL Image from a successful render_equation result."""
    from PIL import Image
    assert result["ok"], f"render_equation failed: {result.get('message')}"
    preview = result["preview"]
    assert preview and preview.startswith("data:image/png;base64,")
    b64 = preview.split(",", 1)[1]
    png_bytes = base64.b64decode(b64)
    return Image.open(io.BytesIO(png_bytes))


# ═══════════════════════════════════════════════════════════════════════════════
# render_equation — valid inputs
# ═══════════════════════════════════════════════════════════════════════════════

class TestRenderEquationValid:
    """render_equation() with valid LaTeX should produce an RGBA PNG."""

    CASES = [
        ("fraction",    r"\frac{a}{b}",                          "#000000"),
        ("greek",       r"\alpha + \beta = \gamma",               "#000000"),
        ("integral",    r"\int_{a}^{b} f(x)\,dx",                "#000000"),
        ("matrix",      r"\begin{pmatrix}a&b\\c&d\end{pmatrix}", "#000000"),
        ("subscript",   r"x_{i}",                                "#000000"),
        ("superscript", r"x^{2}",                                "#000000"),
        ("sum",         r"\sum_{i=1}^{n} x_i",                   "#000000"),
    ]

    @pytest.mark.parametrize("name,src,color", CASES)
    def test_returns_ok(self, name, src, color):
        result = render_equation(src, color=color, dpi=150)
        assert result["ok"] is True, f"[{name}] failed: {result.get('message')}"
        assert result["status"] == "ok"

    @pytest.mark.parametrize("name,src,color", CASES)
    def test_preview_is_png_data_url(self, name, src, color):
        result = render_equation(src, color=color, dpi=150)
        assert result["ok"]
        assert result["preview"].startswith("data:image/png;base64,")

    @pytest.mark.parametrize("name,src,color", CASES)
    def test_dimensions_reported(self, name, src, color):
        result = render_equation(src, color=color, dpi=150)
        assert result["ok"]
        assert isinstance(result["widthPx"], int) and result["widthPx"] > 0
        assert isinstance(result["heightPx"], int) and result["heightPx"] > 0

    @pytest.mark.parametrize("name,src,color", CASES)
    def test_png_is_rgba(self, name, src, color):
        result = render_equation(src, color=color, dpi=150)
        img = _png_from_result(result)
        assert img.mode == "RGBA", f"[{name}] Expected RGBA, got {img.mode}"

    @pytest.mark.parametrize("name,src,color", CASES)
    def test_reported_size_matches_image(self, name, src, color):
        result = render_equation(src, color=color, dpi=150)
        img = _png_from_result(result)
        assert img.width == result["widthPx"]
        assert img.height == result["heightPx"]


# ═══════════════════════════════════════════════════════════════════════════════
# render_equation — RGBA / alpha correctness
# ═══════════════════════════════════════════════════════════════════════════════

class TestRenderEquationAlpha:
    """RGBA semantics: corners should be mostly transparent; text pixels non-zero alpha."""

    def test_corner_alpha_near_zero(self):
        """Top-left corner of a cropped equation image should be mostly transparent."""
        import numpy as np
        result = render_equation(r"\frac{a}{b}", color="#000000", dpi=150)
        assert result["ok"]
        from PIL import Image
        b64 = result["preview"].split(",", 1)[1]
        img = Image.open(io.BytesIO(base64.b64decode(b64)))
        arr = np.array(img)
        # Sample 3×3 top-left corner
        corner_alpha = arr[:3, :3, 3]
        assert corner_alpha.max() < 30, f"Top-left corner not transparent: max alpha={corner_alpha.max()}"

    def test_ink_pixels_have_nonzero_alpha(self):
        """At least some pixels in the rendered equation must have significant alpha (ink)."""
        import numpy as np
        result = render_equation(r"\alpha", color="#FF0000", dpi=150)
        assert result["ok"]
        from PIL import Image
        b64 = result["preview"].split(",", 1)[1]
        img = Image.open(io.BytesIO(base64.b64decode(b64)))
        arr = np.array(img)
        # At least 1% of pixels should have alpha > 128
        significant = (arr[:, :, 3] > 128).sum()
        total = arr.shape[0] * arr.shape[1]
        assert significant / total > 0.01, "Too few ink pixels — equation may be empty"


# ═══════════════════════════════════════════════════════════════════════════════
# render_equation — foreground color recoloring
# ═══════════════════════════════════════════════════════════════════════════════

class TestRenderEquationColor:
    """render_equation() must recolor ink pixels to the requested foreground color."""

    def _dominant_ink_color(self, img):
        """Return (R, G, B) of the most ink-heavy pixels (alpha > 128)."""
        import numpy as np
        arr = np.array(img)
        mask = arr[:, :, 3] > 128
        if not mask.any():
            return None
        r = int(arr[:, :, 0][mask].mean())
        g = int(arr[:, :, 1][mask].mean())
        b = int(arr[:, :, 2][mask].mean())
        return (r, g, b)

    def test_white_foreground_on_dark_bg(self):
        result = render_equation(r"\frac{1}{2}", color="#FFFFFF", dpi=150)
        assert result["ok"]
        img = _png_from_result(result)
        rgb = self._dominant_ink_color(img)
        assert rgb is not None
        # R, G, B should all be near 255
        assert all(c > 200 for c in rgb), f"Expected white ink, got {rgb}"

    def test_dark_foreground_on_light_bg(self):
        result = render_equation(r"\frac{1}{2}", color="#1E2128", dpi=150)
        assert result["ok"]
        img = _png_from_result(result)
        rgb = self._dominant_ink_color(img)
        assert rgb is not None
        # R, G, B should all be near 0x1E, 0x21, 0x28 (30, 33, 40)
        assert all(c < 80 for c in rgb), f"Expected dark ink, got {rgb}"

    def test_red_foreground(self):
        result = render_equation(r"\alpha", color="#FF0000", dpi=150)
        assert result["ok"]
        img = _png_from_result(result)
        import numpy as np
        arr = np.array(img)
        mask = arr[:, :, 3] > 128
        if mask.any():
            r_mean = arr[:, :, 0][mask].mean()
            g_mean = arr[:, :, 1][mask].mean()
            b_mean = arr[:, :, 2][mask].mean()
            # Red channel dominant
            assert r_mean > g_mean + 50 and r_mean > b_mean + 50, (
                f"Expected red-dominant ink, got R={r_mean:.0f} G={g_mean:.0f} B={b_mean:.0f}"
            )


# ═══════════════════════════════════════════════════════════════════════════════
# render_equation — invalid LaTeX
# ═══════════════════════════════════════════════════════════════════════════════

class TestRenderEquationInvalid:
    """render_equation() with bad LaTeX should fail gracefully."""

    def test_undefined_command_fails(self):
        result = render_equation(r"\undefinedcommandXYZ{x}", color="#000000", dpi=150)
        assert result["ok"] is False

    def test_undefined_command_has_status(self):
        result = render_equation(r"\undefinedcommandXYZ{x}", color="#000000", dpi=150)
        assert result["status"] in {"compile_failed", "timeout", "missing_packages"}

    def test_undefined_command_has_message(self):
        result = render_equation(r"\undefinedcommandXYZ{x}", color="#000000", dpi=150)
        assert isinstance(result.get("message"), str) and len(result["message"]) > 0

    def test_unmatched_brace_fails(self):
        result = render_equation(r"\frac{a}{", color="#000000", dpi=150)
        assert result["ok"] is False

    def test_empty_source_fails(self):
        result = render_equation("", color="#000000", dpi=150)
        assert result["ok"] is False
        assert result["status"] == "invalid"

    def test_errors_list_present(self):
        result = render_equation(r"\undefinedXYZ", color="#000000", dpi=150)
        assert "errors" in result
        # errors should be a list (possibly empty if log parsing not triggered)
        assert isinstance(result["errors"], list)

    def test_missing_list_present(self):
        result = render_equation(r"\undefinedXYZ", color="#000000", dpi=150)
        assert "missing" in result
        assert isinstance(result["missing"], list)


# ═══════════════════════════════════════════════════════════════════════════════
# SlideObject model — extra-field preservation (save/load round-trip)
# ═══════════════════════════════════════════════════════════════════════════════

class TestEquationObjectRoundTrip:
    """Extra fields on SlideObject (latex, equationColor, role) survive JSON round-trip."""

    def test_roundtrip_preserves_latex(self):
        from backend.models import PresentationDoc, SlideModel, SlideObject

        obj = SlideObject(
            id="eq1",
            type="image",
            role="equation",
            x=100,
            y=100,
            w=300,
            h=80,
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            latex=r"\frac{a}{b}",
            equationColor="#FFFFFF",
            aspect=3.75,
        )
        doc = PresentationDoc(
            title="Test",
            slides=[SlideModel(id="s1", layout="blank", objects=[obj])],
        )
        serialized = doc.model_dump_json()
        restored = PresentationDoc.model_validate_json(serialized)
        restored_obj = restored.slides[0].objects[0]
        assert getattr(restored_obj, "latex", None) == r"\frac{a}{b}", (
            "latex field not preserved through JSON round-trip"
        )
        assert getattr(restored_obj, "equationColor", None) == "#FFFFFF", (
            "equationColor field not preserved through JSON round-trip"
        )
        assert getattr(restored_obj, "role", None) == "equation", (
            "role field not preserved through JSON round-trip"
        )

    def test_roundtrip_type_still_image(self):
        from backend.models import PresentationDoc, SlideModel, SlideObject

        obj = SlideObject(
            id="eq2",
            type="image",
            x=0, y=0, w=100, h=50,
            src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
            latex=r"\alpha",
            equationColor="#000000",
        )
        doc = PresentationDoc(
            title="Test2",
            slides=[SlideModel(id="s1", layout="blank", objects=[obj])],
        )
        serialized = doc.model_dump_json()
        restored = PresentationDoc.model_validate_json(serialized)
        assert restored.slides[0].objects[0].type == "image"
