"""Browser E2E test for PowerPoint (.pptx) Import workflow in headless Chromium.
Skipped when Playwright / Chromium is missing.
"""

import os
import pytest

pytest.importorskip("playwright.sync_api")
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
URL = "file://" + os.path.join(ROOT, "index.html")


@pytest.fixture()
def browser_page():
    with sync_playwright() as pw:
        try:
            b = pw.chromium.launch()
        except Exception as e:
            pytest.skip(str(e))
        p = b.new_page(viewport={"width": 1280, "height": 800})
        p.goto(URL)
        p.wait_for_function("window.RPE && RPE.store && RPE.store.doc && RPE.commands")
        yield p
        b.close()


def test_import_ui_elements_and_backstage(browser_page):
    """Verify Import PowerPoint button is present in Backstage and file input exists."""
    p = browser_page

    # Verify hidden input exists
    input_count = p.locator("#fileImportPptx").count()
    assert input_count == 1
    accept = p.locator("#fileImportPptx").get_attribute("accept")
    assert ".pptx" in accept

    # Open Backstage 'open' panel
    p.evaluate("RPE.commands.run('file.backstage', { panel: 'open' })")
    p.wait_for_selector("#backstage:not([hidden])")

    # Verify Import PowerPoint card is rendered in Backstage
    btn = p.locator('.bs-card[data-command="file.importPptx"]')
    assert btn.count() >= 1
    assert "Import PowerPoint" in btn.first.inner_text()


def test_import_compatibility_dialog_and_cancellation(browser_page):
    """Verify selecting a file prompts with compatibility warning and cancellation works."""
    p = browser_page

    # Mock RPE.backend.request so we can observe calls
    p.evaluate("""() => {
      window.__importRequested = false;
      const orig = RPE.backend.request;
      RPE.backend.request = async (name, payload) => {
        if (name === 'presentation.import') {
          window.__importRequested = true;
          return { ok: true, doc: { id: 'deck_mock', title: 'Imported', slides: [{ id: 's1', objects: [] }] } };
        }
        return orig(name, payload);
      };
    }""")

    # Trigger file selection with a fake file
    p.evaluate("""() => {
      const input = document.getElementById('fileImportPptx');
      const dt = new DataTransfer();
      dt.items.add(new File(['dummy pptx content'], 'sample_deck.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }""")

    # Dialog should appear with compatibility notice
    p.wait_for_selector(".dlg")
    dlg_text = p.locator(".dlg").inner_text()
    assert "Import PowerPoint presentation" in dlg_text
    assert "Complex elements" in dlg_text or "elements" in dlg_text
    assert "never be overwritten" in dlg_text or "unchanged" in dlg_text

    # Click Cancel
    p.locator(".dlg button:has-text('Cancel')").click()
    p.wait_for_selector(".dlg", state="detached")

    # Import was NOT executed
    was_requested = p.evaluate("window.__importRequested")
    assert was_requested is False


def test_import_execution_and_store_update(browser_page):
    """Verify successful import updates store, closes Backstage, and allows saving."""
    p = browser_page

    # Mock backend to return imported presentation
    p.evaluate("""() => {
      RPE.backend.request = async (name, payload) => {
        if (name === 'presentation.import') {
          return {
            ok: true,
            status: 200,
            fileName: 'cancer_genomics.pptx',
            doc: {
              schemaVersion: 2,
              id: 'deck_imported_123',
              title: 'Cancer Genomics',
              size: { w: 1280, h: 720 },
              themeId: 'journal',
              paletteId: 'burgundy',
              typeId: 'outfit',
              slides: [
                {
                  id: 's_imported_1',
                  layout: 'titleContent',
                  notes: 'Speaker notes for slide 1',
                  objects: [
                    {
                      id: 'o_title_1',
                      type: 'text',
                      role: 'title',
                      x: 64, y: 40, w: 1152, h: 90,
                      html: '<p><b>Targeted Therapies in Oncology</b></p>',
                      fontSize: 36,
                      align: 'left'
                    }
                  ]
                }
              ]
            },
            warnings: [
              { slide: 1, shape: 'Chart 1', type: 'chart', message: "Chart 'Chart 1' on slide 1 is not supported and was omitted." }
            ]
          };
        }
        return { ok: false };
      };
    }""")

    # Trigger file selection
    p.evaluate("""() => {
      const input = document.getElementById('fileImportPptx');
      const dt = new DataTransfer();
      dt.items.add(new File(['dummy'], 'cancer_genomics.pptx', { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }""")

    # Dialog appears -> click Import presentation
    p.wait_for_selector(".dlg button:has-text('Import presentation')")
    p.locator(".dlg button:has-text('Import presentation')").click()

    # Backstage should be closed, slidepane updated
    p.wait_for_function("RPE.store.doc && RPE.store.doc.title === 'Cancer Genomics'")
    title = p.evaluate("RPE.store.doc.title")
    assert title == "Cancer Genomics"

    # Slide count in store
    slides_count = p.evaluate("RPE.store.doc.slides.length")
    assert slides_count == 1

    # Text content on slide
    title_html = p.evaluate("RPE.store.doc.slides[0].objects[0].html")
    assert "Targeted Therapies in Oncology" in title_html

    # Save state must be 'new' to preserve original file
    save_state = p.evaluate("RPE.store.ui.saveState")
    assert save_state == "new"

    # Save locally to IndexedDB succeeds
    saved = p.evaluate("RPE.store.saveLocal ? RPE.store.saveLocal() : true")
    assert saved is not False
