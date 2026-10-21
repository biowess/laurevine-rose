import os
import pytest
from playwright.sync_api import sync_playwright

def test_find_replace_engine_f1():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True)
        page = browser.new_page()
        page_errors = []
        page.on('pageerror', lambda err: page_errors.append(str(err)))

        url = 'file://' + os.path.abspath('index.html')
        page.goto(url)
        page.wait_for_load_state('networkidle')

        # 1. Matching across inline elements: "hel<b>lo</b>" matches "hello"
        res = page.evaluate('''() => {
            const S = window.RPE.store;
            const D = window.RPE.dialogs;
            S.mutate('Setup inline test', () => {
                S.doc.slides = [{
                    id: 's1',
                    objects: [{
                        id: 't1', type: 'text', role: 'text',
                        x: 50, y: 50, w: 300, h: 100,
                        html: '<p>hel<b>lo</b> world</p>'
                    }]
                }];
                S.setUI({ activeSlideId: 's1', selectedIds: [] });
            });

            const m = D.findMatches('hello', false);
            return {
                count: m.length,
                first: m[0]
            };
        }''')
        assert res['count'] == 1
        assert res['first']['kind'] == 'html'
        assert res['first']['start'] == 0
        assert res['first']['end'] == 5

        # 2. Formatting preserved when replacing across inline element boundary
        rep_res = page.evaluate('''() => {
            const S = window.RPE.store;
            const D = window.RPE.dialogs;
            const m = D.findMatches('hello', false)[0];
            D.replaceOneRecord(m, 'goodbye');
            const o = S.doc.slides[0].objects[0];
            return o.html;
        }''')
        # Expect replacement inside the first node (preserving <p>), remaining node deleted
        assert 'goodbye' in rep_res
        assert 'hello' not in rep_res

        # 3. Two matches in one box: Replace One changes ONLY the active one
        two_matches = page.evaluate('''() => {
            const S = window.RPE.store;
            const D = window.RPE.dialogs;
            S.mutate('Setup 2 matches', () => {
                S.doc.slides = [{
                    id: 's1',
                    objects: [{
                        id: 't2', type: 'text', role: 'text',
                        x: 50, y: 50, w: 300, h: 100,
                        html: '<p>alpha foo beta foo gamma</p>'
                    }]
                }];
                S.setUI({ activeSlideId: 's1', selectedIds: [] });
            });

            const m = D.findMatches('foo', false);
            // Replace the second match only
            D.replaceOneRecord(m[1], 'BAR');
            return S.doc.slides[0].objects[0].html;
        }''')
        assert 'alpha foo beta BAR gamma' in two_matches

        # 4. Tables match per cell and Replace One works in cells
        table_res = page.evaluate('''() => {
            const S = window.RPE.store;
            const D = window.RPE.dialogs;
            S.mutate('Setup table', () => {
                S.doc.slides = [{
                    id: 's1',
                    objects: [{
                        id: 'tbl1', type: 'table',
                        x: 50, y: 50, w: 400, h: 200,
                        cells: [['foo bar', 'baz'], ['test', 'foo']]
                    }]
                }];
                S.setUI({ activeSlideId: 's1', selectedIds: [] });
            });

            const m = D.findMatches('foo', false);
            const matchesSummary = m.map(x => ({ r: x.rowIndex, c: x.colIndex, start: x.start, end: x.end }));
            D.replaceOneRecord(m[0], 'REPLACED');
            return {
                count: m.length,
                matchesSummary,
                cells: S.doc.slides[0].objects[0].cells
            };
        }''')
        assert table_res['count'] == 2
        assert table_res['cells'][0][0] == 'REPLACED bar'
        assert table_res['cells'][1][1] == 'foo'

        # 5. Case sensitivity correct
        case_res = page.evaluate('''() => {
            const S = window.RPE.store;
            const D = window.RPE.dialogs;
            S.mutate('Setup case test', () => {
                S.doc.slides = [{
                    id: 's1',
                    objects: [{
                        id: 't3', type: 'text', role: 'text',
                        x: 50, y: 50, w: 300, h: 100,
                        html: '<p>Case CASE case</p>'
                    }]
                }];
            });

            const mInsensitive = D.findMatches('case', false);
            const mSensitive = D.findMatches('case', true);
            return {
                insensitive: mInsensitive.length,
                sensitive: mSensitive.length
            };
        }''')
        assert case_res['insensitive'] == 3
        assert case_res['sensitive'] == 1

        # 6. Replace All counts every occurrence across slides and tables, and undo reverts in one step
        all_res = page.evaluate('''() => {
            const S = window.RPE.store;
            const D = window.RPE.dialogs;
            S.mutate('Setup replace all test', () => {
                S.doc.slides = [
                    {
                        id: 's1',
                        objects: [
                            { id: 'o1', type: 'text', role: 'text', x: 0, y: 0, w: 100, h: 50, html: '<p>target target</p>' },
                            { id: 'o2', type: 'table', x: 0, y: 0, w: 100, h: 50, cells: [['target', 'other'], ['target', 'target']] }
                        ]
                    },
                    {
                        id: 's2',
                        objects: [
                            { id: 'o3', type: 'text', role: 'text', x: 0, y: 0, w: 100, h: 50, html: '<p>target in slide 2</p>' }
                        ]
                    }
                ];
                S.setUI({ activeSlideId: 's1', selectedIds: [] });
            });

            // Total target occurrences: o1 has 2, o2 has 3, o3 has 1 -> Total = 6
            const count = D.replaceAllMatches('target', 'DONE', false);
            const afterMatches = D.findMatches('target', false).length;

            // Undo
            RPE.commands.run('app.undo');
            const restoredMatches = D.findMatches('target', false).length;

            return {
                count,
                afterMatches,
                restoredMatches
            };
        }''')
        assert all_res['count'] == 6
        assert all_res['afterMatches'] == 0
        assert all_res['restoredMatches'] == 6

        assert len(page_errors) == 0
        browser.close()

def test_find_replace_modal_f1():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True)
        page = browser.new_page()
        page_errors = []
        page.on('pageerror', lambda err: page_errors.append(str(err)))

        url = 'file://' + os.path.abspath('index.html')
        page.goto(url)
        page.wait_for_load_state('networkidle')

        page.evaluate('''() => {
            const S = window.RPE.store;
            S.mutate('Setup modal test', () => {
                S.doc.slides = [{
                    id: 's1',
                    objects: [
                        { id: 't1', type: 'text', role: 'text', x: 50, y: 50, w: 300, h: 100, html: '<p>alpha hello beta hello gamma</p>' }
                    ]
                }];
                S.setUI({ activeSlideId: 's1', selectedIds: [] });
            });
            window.__dlg = window.RPE.dialogs.find(true);
        }''')

        # Check modal is visible
        dlg = page.locator('.dlg--find')
        assert dlg.is_visible()

        # Type in find box
        find_input = dlg.locator('.field input').first
        find_input.fill('hello')
        page.wait_for_timeout(100)

        # Check count message
        status_text = dlg.locator('.pd__status').inner_text()
        assert '2 occurrences on 1 slide match' in status_text

        # Click Find Next
        next_btn = dlg.locator('button:has-text("Find next")')
        next_btn.click()
        page.wait_for_timeout(100)
        assert 'Match 1 of 2.' in dlg.locator('.pd__status').inner_text()

        # Fill Replace With and click Replace
        rep_input = dlg.locator('.field input').nth(1)
        rep_input.fill('WORLD')
        rep_btn = dlg.locator('button:has-text("Replace")').first
        rep_btn.click()
        page.wait_for_timeout(100)

        # Check text in model
        html = page.evaluate('() => window.RPE.store.doc.slides[0].objects[0].html')
        assert 'alpha WORLD beta hello gamma' in html

        # Click close
        dlg.locator('button:has-text("Close")').click()
        page.wait_for_timeout(250)
        assert not dlg.is_visible()

        assert len(page_errors) == 0
        browser.close()

def test_find_replace_panel_f2():
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path='/usr/bin/chromium-browser', headless=True)
        # Set viewport to 1280x720
        page = browser.new_page(viewport={'width': 1280, 'height': 720})
        page_errors = []
        page.on('pageerror', lambda err: page_errors.append(str(err)))

        url = 'file://' + os.path.abspath('index.html')
        page.goto(url)
        page.wait_for_load_state('networkidle')

        # 1. Setup two slides with test data
        page.evaluate('''() => {
            const S = window.RPE.store;
            S.mutate('Setup F2 deck', () => {
                S.doc.slides = [
                    {
                        id: 's1',
                        objects: [
                            {
                                id: 't1', type: 'text', role: 'text',
                                x: 60, y: 60, w: 500, h: 100,
                                html: '<p>the quick brown fox jumps over the lazy dog</p>'
                            },
                            {
                                id: 'tbl1', type: 'table',
                                x: 60, y: 200, w: 400, h: 100,
                                cells: [['The first', 'the second'], ['third', 'fourth']]
                            }
                        ]
                    },
                    {
                        id: 's2',
                        objects: [
                            {
                                id: 't2', type: 'text', role: 'text',
                                x: 60, y: 60, w: 500, h: 100,
                                html: '<p>one more the on slide two</p>'
                            }
                        ]
                    }
                ];
                S.setUI({ activeSlideId: 's1', selectedIds: [] });
            });
        }''')

        # 2. Press Ctrl+F to open panel
        page.keyboard.press('Control+f')
        page.wait_for_timeout(100)

        panel = page.locator('#findPanel')
        assert panel.is_visible()

        # Check Find input is focused
        find_input = page.locator('#findInput')
        assert page.evaluate('() => document.activeElement.id') == 'findInput'

        # Check layout: Panel is positioned above status bar and next to slidepane (does not cut slidepane)
        statusbar = page.locator('#statusbar')
        slidepane = page.locator('#slidepane')
        panel_box = panel.bounding_box()
        status_box = statusbar.bounding_box()
        slidepane_box = slidepane.bounding_box()
        assert panel_box is not None and status_box is not None and slidepane_box is not None
        assert panel_box['y'] + panel_box['height'] <= status_box['y'] + 2
        assert panel_box['x'] >= slidepane_box['x'] + slidepane_box['width'] - 5
        assert slidepane_box['y'] + slidepane_box['height'] >= status_box['y'] - 2
        # Ensure modal is not blocking canvas
        assert page.locator('.dlg--find').count() == 0 or not page.locator('.dlg--find').is_visible()

        # 3. Type "the" in find box
        find_input.fill('the')
        page.wait_for_timeout(150)

        # Total occurrences of "the" (case insensitive):
        # s1: t1 has 2 ("the", "the"), tbl1 has 2 ("The", "the") -> 4
        # s2: t2 has 1 ("the") -> 1
        # Total = 5 matches
        count_el = page.locator('#findCount')
        assert '1 of 5' in count_el.inner_text()

        # Check highlights: on current slide (s1) there are 4 matches
        hl_info = page.evaluate('''() => {
            const hasApi = typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined';
            let allCount = 0, activeCount = 0;
            if (hasApi && CSS.highlights.has('find-all')) {
                allCount = CSS.highlights.get('find-all').size;
                activeCount = CSS.highlights.has('find-active') ? CSS.highlights.get('find-active').size : 0;
            } else {
                allCount = document.querySelectorAll('#findHighlightLayer .find-highlight').length;
                activeCount = document.querySelectorAll('#findHighlightLayer .find-highlight--active').length;
            }
            return { hasApi, allCount, activeCount };
        }''')
        assert hl_info['allCount'] == 4
        assert hl_info['activeCount'] == 1

        # 4. Next/Prev navigation and wrapping
        btn_next = page.locator('#findNext')
        btn_prev = page.locator('#findPrev')
        btn_first = page.locator('#findFirst')
        btn_last = page.locator('#findLast')

        # Click Next 4 times: 1->2->3->4->5 (slide 2)
        btn_next.click()
        page.wait_for_timeout(100)
        assert '2 of 5' in count_el.inner_text()

        btn_next.click()
        page.wait_for_timeout(100)
        assert '3 of 5' in count_el.inner_text()

        btn_next.click()
        page.wait_for_timeout(100)
        assert '4 of 5' in count_el.inner_text()

        btn_next.click()
        page.wait_for_timeout(100)
        assert '5 of 5' in count_el.inner_text()
        # Verify active slide switched to s2
        active_slide = page.evaluate('() => window.RPE.store.ui.activeSlideId')
        assert active_slide == 's2'

        # Next wraps around to 1 (slide 1)
        btn_next.click()
        page.wait_for_timeout(100)
        assert '1 of 5' in count_el.inner_text()
        assert page.evaluate('() => window.RPE.store.ui.activeSlideId') == 's1'

        # Prev wraps from 1 to 5
        btn_prev.click()
        page.wait_for_timeout(100)
        assert '5 of 5' in count_el.inner_text()
        assert page.evaluate('() => window.RPE.store.ui.activeSlideId') == 's2'

        # First jumps to 1
        btn_first.click()
        page.wait_for_timeout(100)
        assert '1 of 5' in count_el.inner_text()
        assert page.evaluate('() => window.RPE.store.ui.activeSlideId') == 's1'

        # Last jumps to 5
        btn_last.click()
        page.wait_for_timeout(100)
        assert '5 of 5' in count_el.inner_text()
        assert page.evaluate('() => window.RPE.store.ui.activeSlideId') == 's2'

        # 5. Case toggle: Match case on
        btn_first.click()
        page.wait_for_timeout(100)
        case_cb = page.locator('#findCase')
        case_cb.check()
        page.wait_for_timeout(150)
        # Case sensitive "the": "The" in table excluded -> 4 total
        assert '1 of 4' in count_el.inner_text()

        case_cb.uncheck()
        page.wait_for_timeout(150)
        assert '1 of 5' in count_el.inner_text()

        # 6. Replace One replaces active match and advances
        rep_input = page.locator('#findReplaceInput')
        rep_input.fill('A')
        btn_replace = page.locator('#findReplaceBtn')
        btn_replace.click()
        page.wait_for_timeout(150)

        # Verify first match replaced in t1
        t1_html = page.evaluate('() => window.RPE.store.doc.slides[0].objects[0].html')
        assert 'A quick brown fox' in t1_html
        # Count decreases to 4
        assert '1 of 4' in count_el.inner_text()

        # 7. Replace All across all slides
        btn_replace_all = page.locator('#findReplaceAllBtn')
        btn_replace_all.click()
        page.wait_for_timeout(150)

        assert '0 of 0' in count_el.inner_text()
        # Verify all occurrences replaced
        all_the = page.evaluate('''() => {
            return window.RPE.dialogs.findMatches('the', false).length;
        }''')
        assert all_the == 0

        # Check no highlight spans were added to HTML
        html_check = page.evaluate('''() => {
            const o1 = window.RPE.store.doc.slides[0].objects[0];
            return o1.html;
        }''')
        assert 'find-highlight' not in html_check
        assert '<mark' not in html_check

        # 8. Close panel
        btn_close = page.locator('#findClose')
        btn_close.click()
        page.wait_for_timeout(100)
        assert not panel.is_visible()

        # Verify no highlight residue
        cleared_hl = page.evaluate('''() => {
            const hasApi = typeof CSS !== 'undefined' && typeof CSS.highlights !== 'undefined';
            if (hasApi) {
                return (CSS.highlights.has('find-all') && CSS.highlights.get('find-all').size > 0) ||
                       (CSS.highlights.has('find-active') && CSS.highlights.get('find-active').size > 0);
            }
            return document.querySelectorAll('#findHighlightLayer .find-highlight').length > 0;
        }''')
        assert not cleared_hl

        # 9. Verify Esc closes only when focus is inside panel
        # Open panel again
        page.keyboard.press('Control+h')
        page.wait_for_timeout(100)
        assert panel.is_visible()

        # Focus canvas
        page.evaluate('() => document.getElementById("wsScroll").focus()')
        page.keyboard.press('Escape')
        page.wait_for_timeout(100)
        # Panel should still be visible because focus was not in panel
        assert panel.is_visible()

        # Focus inside panel and press Escape
        find_input.focus()
        page.keyboard.press('Escape')
        page.wait_for_timeout(100)
        assert not panel.is_visible()

        # 10. Verify Ctrl+F works while editing text
        page.evaluate('''() => {
            const S = window.RPE.store;
            S.select(['t1']);
            RPE.canvas.startEdit('t1', { atEnd: true });
        }''')
        page.wait_for_timeout(100)
        assert page.evaluate('() => window.RPE.store.ui.editingId') == 't1'

        # Press Ctrl+F while editing
        page.keyboard.press('Control+f')
        page.wait_for_timeout(100)
        assert panel.is_visible()
        assert page.evaluate('() => document.activeElement.id') == 'findInput'

        assert len(page_errors) == 0
        browser.close()
