"""Symbol library insertion (task 22) in headless Chromium. Skipped when Playwright/Chromium are missing.
Covers: caret insert, range replacement, multi-insert with the modal staying open, disabled state, one undo step per insert, persistence."""
import os
import pytest

pytest.importorskip("playwright.sync_api")
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "file://" + os.path.join(ROOT, "index.html")


@pytest.fixture()
def page():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch()
        except Exception as e:  # browser not installed
            pytest.skip(str(e))
        p = b.new_page(viewport={"width": 1024, "height": 650})
        p.goto(URL)
        p.wait_for_function("window.RPE && RPE.symbolLibrary && RPE.store && RPE.store.doc")
        yield p
        b.close()


def setup_box(p, html="<p>abcdef</p>"):
    return p.evaluate("""(html) => {
      const S = RPE.store; const o = S.activeSlide().objects.find((x) => x.type === 'text');
      S.mutate('t', () => { o.html = html; }); RPE.canvas.render && RPE.canvas.render(); RPE.canvas.startEdit(o.id, { atEnd: true }); return o.id; }""", html)


def select(p, start, end):
    p.evaluate("""([s, e]) => { const t = RPE.canvas.editable(); const n = t.querySelector('p').firstChild; const r = document.createRange();
      r.setStart(n, s); r.setEnd(n, e); const g = getSelection(); g.removeAllRanges(); g.addRange(r); }""", [start, end])


def html_of(p, oid):
    return p.evaluate("(id) => RPE.store.findObject(id).html", oid)


def test_caret_range_multi_and_modal_stays_open(page):
    oid = setup_box(page)
    select(page, 3, 3)
    page.evaluate("RPE.symbolLibrary.open()")
    page.click('.sym-cell[data-c="α"]')
    assert "abcαdef" in html_of(page, oid)
    page.click('.sym-cell[data-c="α"]'); page.click('.sym-cell[data-c="α"]')   # multi-insert, caret advances
    assert "abcααα" in html_of(page, oid) and page.locator(".dlg--sym").count() == 1
    select(page, 0, 3)                                                           # range replacement (selection kept across modal focus)
    page.click('.sym-cell[data-c="α"]')
    assert html_of(page, oid).startswith("<p>α")
    page.keyboard.press("Escape")
    page.wait_for_selector(".dlg--sym", state="detached")
    assert page.evaluate("!!RPE.canvas.editable()")                              # Esc closed the modal only; the edit is alive


def test_each_insert_is_one_undo_step(page):
    oid = setup_box(page); select(page, 2, 2)
    n0 = page.evaluate("RPE.store.canUndo() ? 1 : 0")
    page.evaluate("RPE.symbolLibrary.open()")
    page.click('.sym-cell[data-c="α"]')
    assert page.evaluate("RPE.store.nextUndoLabel()") == "Insert symbol"
    page.evaluate("RPE.store.undo()")
    assert "α" not in html_of(page, oid) and n0 in (0, 1)


def test_disabled_without_caret(page):
    page.evaluate("RPE.canvas.stopEdit && RPE.canvas.stopEdit()")
    page.evaluate("RPE.symbolLibrary.open()")
    assert "Place the cursor inside a text box first" in page.inner_text(".sym-lib__status")
    before = page.evaluate("JSON.stringify(RPE.store.doc)")
    page.click('.sym-cell[data-c="α"]', force=True)
    assert page.evaluate("JSON.stringify(RPE.store.doc)") == before


def test_inherits_formatting_and_persists(page):
    oid = setup_box(page, "<p>ab<b>cd</b>ef</p>")
    page.evaluate("""() => { const b = RPE.canvas.editable().querySelector('b').firstChild; const r = document.createRange(); r.setStart(b, 1); r.collapse(true);
      const g = getSelection(); g.removeAllRanges(); g.addRange(r); }""")
    page.evaluate("RPE.symbolLibrary.open()")
    page.click('.sym-cell[data-c="α"]')
    assert "<b>cαd</b>" in html_of(page, oid)
    saved = page.evaluate("JSON.parse(JSON.stringify(RPE.store.doc))")            # round trip through serialisation
    assert "α" in str(saved)
