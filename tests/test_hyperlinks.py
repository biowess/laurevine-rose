"""
Tests for inline hyperlink activation, editing, dragging, selection, and present mode.
"""
import os
import pytest
from playwright.sync_api import sync_playwright

def test_hyperlinks_comprehensive():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True)
        page = browser.new_page()
        page_errors = []
        page.on('pageerror', lambda err: page_errors.append(str(err)))

        url = 'file://' + os.path.abspath('index.html')
        page.goto(url)
        page.wait_for_load_state('networkidle')

        # Setup spy on window.open
        page.evaluate('''() => {
            window.__opened = [];
            window.open = (u, target, features) => {
                window.__opened.push({ url: u, target, features });
                return null;
            };
        }''')

        # 1. Non-editing canvas: click on link opens in new tab and selects object
        page.evaluate('''() => {
            const S = window.RPE.store;
            S.mutate('Add test link', () => {
                S.activeSlide().objects.push({
                    id: 'obj_link', type: 'text', role: 'text',
                    x: 100, y: 100, w: 400, h: 100,
                    html: '<p>Read <a id=\"link1\" href=\"https://google.com\">documentation</a> here</p>'
                });
            });
            S.select([]);
        }''')

        link = page.locator('#wsScroll #link1')
        link.click()
        page.wait_for_timeout(200)

        selected = page.evaluate('() => window.RPE.store.ui.selectedIds')
        opened = page.evaluate('() => window.__opened')
        assert selected == ['obj_link'], f'Expected obj_link selected, got {selected}'
        assert len(opened) == 1 and opened[0]['url'] == 'https://google.com' and opened[0]['target'] == '_blank' and opened[0]['features'] == 'noopener,noreferrer'
        assert 'index.html' in page.url

        # 2. Non-editing canvas: drag starting on link moves object and does NOT open link
        page.evaluate('() => { window.__opened = []; }')
        box = link.bounding_box()
        initial_x = page.evaluate('() => window.RPE.store.findObject(\"obj_link\").x')
        page.mouse.move(box['x'] + 10, box['y'] + 10)
        page.mouse.down()
        page.mouse.move(box['x'] + 60, box['y'] + 60)
        page.mouse.up()
        page.wait_for_timeout(200)

        final_x = page.evaluate('() => window.RPE.store.findObject(\"obj_link\").x')
        opened = page.evaluate('() => window.__opened')
        assert final_x != initial_x, f'Object should have moved, was {initial_x}, now {final_x}'
        assert len(opened) == 0, f'Expected 0 opened links on drag, got {len(opened)}'

        # 3. Double click on link: enters edit mode and word selection
        page.evaluate('() => { window.RPE.canvas.stopEdit(); window.RPE.store.select([]); window.__opened = []; }')
        link.dblclick()
        page.wait_for_timeout(200)

        editing_id = page.evaluate('() => window.RPE.store.ui.editingId')
        sel_text = page.evaluate('() => window.getSelection().toString()')
        assert editing_id == 'obj_link', f'Expected editing obj_link, got {editing_id}'
        assert sel_text == 'documentation', f'Expected \"documentation\" selected, got {repr(sel_text)}'

        # 4. Editing: plain click places caret / selects text as normal (does NOT open link)
        page.evaluate('() => { window.__opened = []; }')
        link.click()
        page.wait_for_timeout(200)
        opened = page.evaluate('() => window.__opened')
        still_editing = page.evaluate('() => window.RPE.store.ui.editingId')
        assert still_editing == 'obj_link'
        assert len(opened) == 0

        # 5. Editing: Ctrl+click opens link
        page.evaluate('() => { window.__opened = []; }')
        link.click(modifiers=['Control'])
        page.wait_for_timeout(200)
        opened = page.evaluate('() => window.__opened')
        assert len(opened) == 1 and opened[0]['url'] == 'https://google.com'

        # 6. Editing: Cmd+click (metaKey) opens link
        page.evaluate('() => { window.__opened = []; }')
        link.click(modifiers=['Meta'])
        page.wait_for_timeout(200)
        opened = page.evaluate('() => window.__opened')
        assert len(opened) == 1 and opened[0]['url'] == 'https://google.com'

        # 7. Invalid/javascript:/broken hrefs do nothing and must not throw
        page.evaluate('''() => {
            window.RPE.canvas.stopEdit();
            window.__opened = [];
            const S = window.RPE.store;
            S.mutate('Add invalid links', () => {
                S.activeSlide().objects.push({
                    id: 'obj_bad_links', type: 'text', role: 'text',
                    x: 100, y: 300, w: 400, h: 100,
                    html: '<p><a id=\"bad1\" href=\"javascript:alert(1)\">JS Link</a> ' +
                          '<a id=\"bad2\" href=\"http://\">Broken Link</a> ' +
                          '<a id=\"bad3\" href=\"ftp://bad.com\">FTP Link</a> ' +
                          '<a id=\"bad4\">No Href</a> ' +
                          '<a id=\"mail1\" href=\"mailto:test@example.com\">Mail Link</a></p>'
                });
            });
        }''')
        for bad_id in ['bad1', 'bad2', 'bad3', 'bad4']:
            page.locator(f'#wsScroll #{bad_id}').click()
            page.wait_for_timeout(100)
        opened = page.evaluate('() => window.__opened')
        assert len(opened) == 0, f'Expected 0 opened links for invalid links, got {len(opened)}'
        assert len(page_errors) == 0, f'Page errors occurred: {page_errors}'

        # Mailto link
        page.locator('#wsScroll #mail1').click()
        page.wait_for_timeout(100)
        opened = page.evaluate('() => window.__opened')
        assert len(opened) == 1 and opened[0]['url'] == 'mailto:test@example.com'

        # 8. Present mode: clicking link opens new tab and does not advance slide
        page.evaluate('''() => {
            window.__opened = [];
            window.RPE.present.start(0);
        }''')
        page.wait_for_timeout(300)
        slide_text_before = page.evaluate('() => document.querySelector(\".present__count\").textContent')
        present_link = page.locator('.present #link1')
        present_link.click()
        page.wait_for_timeout(200)
        slide_text_after = page.evaluate('() => document.querySelector(\".present__count\").textContent')
        opened = page.evaluate('() => window.__opened')
        assert slide_text_before == slide_text_after, 'Slide should NOT have advanced'
        assert len(opened) == 1 and opened[0]['url'] == 'https://google.com'
        page.evaluate('() => window.RPE.present.exit()')

        # 9. Thumbnails and sorter must never navigate
        page.evaluate('''() => {
            window.__opened = [];
            window.RPE.slidepane.render();
        }''')
        thumb = page.locator('#slideList .thumb-item').first
        thumb.click()
        page.wait_for_timeout(200)
        assert 'index.html' in page.url

        # Slide sorter view
        page.evaluate('() => window.RPE.store.setUI({ view: \"sorter\" })')
        sorter_item = page.locator('#sorter .sorter-item').first
        sorter_item.click()
        page.wait_for_timeout(200)
        assert 'index.html' in page.url

        assert len(page_errors) == 0, f'Console/page errors found: {page_errors}'
        browser.close()
