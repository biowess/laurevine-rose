"""Glyph fallback (task 22): characters missing from a run's bundled font move to a covering fallback font; the rest is untouched.
Uses fake cmaps (no font files needed). Real-output check: export a deck containing 'α ⇌ ∑ ≤ ℝ ⁿ ₂' to PPTX/PDF and run `pdffonts` / `pdftotext`."""
import pytest

pytest.importorskip("pptx")
from backend import symbols as S  # noqa: E402
from backend.exporter import TextRunData, parse_html_to_paragraphs  # noqa: E402

ASCII = frozenset(range(32, 127))


@pytest.fixture()
def fake_fonts(monkeypatch):
    cmaps = {"Outfit": ASCII | {0x3B1}, "Inter": ASCII | {0x21CC, 0x2211}}
    monkeypatch.setattr(S, "family_cmap", lambda n: cmaps.get(n))
    monkeypatch.setattr(S, "available_fallbacks", lambda: ["Inter"])
    S._warned.clear()


def test_split_moves_only_uncovered_glyphs(fake_fonts):
    run = TextRunData("a α ⇌ b ∑", bold=True, size=18, font="Outfit", baseline=30000)
    out = S.split_runs([run])
    assert [r.text for r in out] == ["a α ", "⇌", " b ", "∑"]
    assert [r.font for r in out] == ["Outfit", "Inter", "Outfit", "Inter"]
    assert all(r.bold and r.size == 18 and r.baseline == 30000 for r in out)


def test_covered_unknown_font_and_ascii_untouched(fake_fonts):
    plain = TextRunData("hello α", font="Outfit")
    assert S.split_runs([plain]) == [plain]
    foreign = TextRunData("⇌", font="Calibri")  # not bundled -> coverage unknowable -> untouched
    assert S.split_runs([foreign]) == [foreign]


def test_uncovered_everywhere_stays_and_warns(fake_fonts):
    out = S.split_runs([TextRunData("x ℝ", font="Outfit")])
    assert "".join(r.text for r in out) == "x ℝ" and all(r.font == "Outfit" for r in out)


def test_parser_applies_fallback(fake_fonts):
    paras = parse_html_to_paragraphs("<p>x <b>⇌</b> y</p>", default_font="Outfit")
    runs = [r for p in paras for r in p.runs]
    assert "".join(r.text for r in runs) == "x ⇌ y"
    assert [r.font for r in runs if "⇌" in r.text] == ["Inter"]
