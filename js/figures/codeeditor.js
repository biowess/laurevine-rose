/* codeeditor.js — dependency-free code editor: RPE.figures.codeEditor({language:'python'|'latex', value, readOnly, onChange, onRun, label, autoClose}).
   A transparent <textarea> (all real editing, caret, selection, native undo) sits over a highlighted <pre>. Only the visible lines (+ overscan) are
   tokenized and painted, so 100k characters stay fast; the multi-line lexer state (Python triple quotes, LaTeX display math) is cached per line and
   dropped from the first changed line on. Lines over 4,000 characters are shown uncoloured. The editing rules are pure functions on RPE.figures.codeEditor
   (tested in tests/test_js_checks.js, 25). Keys: Tab / Shift+Tab indent / outdent (Esc, then Tab, moves focus on; read-only never traps Tab),
   Enter keeps the indent (+4 after a Python ':'), Ctrl+/ comments, Ctrl+F finds, Ctrl+Enter calls onRun. */
(function (RPE) {
  'use strict';
  const F = RPE.figures = RPE.figures || {};
  const LH = 18, PADX = 8, PADY = 6, OVER = 30, MAXLINE = 4000;   // LH / paddings mirror css .ce__ta and .ce__hl
  const at = (re, s, i) => { re.lastIndex = i; return re.exec(s); };

  /* ---------- Python lexer: line + start state ('"""' / "'''" while inside a triple-quoted string) -> {t:[[type,text]], s:state} ---------- */
  const PY_KW = new Set('False None True and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield'.split(' '));
  const PY_BI = new Set('abs all any bin bool bytes callable chr dict dir divmod enumerate filter float format frozenset getattr hasattr hash hex id input int isinstance issubclass iter len list map max min next object oct open ord pow print range repr reversed round set setattr slice sorted str sum super tuple type vars zip Exception ValueError TypeError KeyError IndexError RuntimeError NotImplementedError'.split(' '));
  const NUM = /0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d+)?[jJ]?/y;
  const IDENT = /[\p{L}_][\p{L}\p{N}_]*/uy, DEC = /@[\w.]*/y, PFX = /^(?:[rRbBuUfF]|[rR][bBfF]|[bBfF][rR])$/;
  const closeAt = (s, i, q) => { for (let j = i; j < s.length;) { if (s[j] === '\\') j += 2; else if (s.startsWith(q, j)) return j + q.length; else j++; } return -1; };
  function lexPy(line, st) {
    const out = [], n = line.length; let i = 0, p = 0;
    const tok = (t, a, b) => { if (a > p) out.push(['', line.slice(p, a)]); out.push([t, line.slice(a, b)]); p = i = b; };
    const str = (a, q) => {   // string whose opening quote is at q (a = start incl. prefix)
      const d = line.startsWith(line[q].repeat(3), q) ? line[q].repeat(3) : line[q], e = closeAt(line, q + d.length, d);
      if (e < 0) { tok('str', a, n); if (d.length === 3) st = d; } else tok('str', a, e);
    };
    if (st) { const e = closeAt(line, 0, st); if (e < 0) return { t: [['str', line]], s: st }; tok('str', 0, e); st = null; }
    while (i < n) {
      const c = line[i];
      if (c === '#') { tok('com', i, n); break; }
      if (c === '"' || c === "'") { str(i, i); continue; }
      if (c === '@' && !line.slice(0, i).trim()) { tok('dec', i, i + at(DEC, line, i)[0].length); continue; }
      if (c >= '0' && c <= '9' || (c === '.' && /\d/.test(line[i + 1] || ''))) { const m = at(NUM, line, i); if (m) { tok('num', i, i + m[0].length); continue; } }
      const m = at(IDENT, line, i);
      if (m) {
        const w = m[0], e = i + w.length;
        if ((line[e] === '"' || line[e] === "'") && PFX.test(w)) str(i, e);
        else if (PY_KW.has(w)) tok('kw', i, e); else if (PY_BI.has(w)) tok('bi', i, e); else i = e;
        continue;
      }
      i++;
    }
    if (p < n) out.push(['', line.slice(p)]);
    return { t: out, s: st };
  }

  /* ---------- LaTeX lexer: state = null | '$$' | '\[' | 'env:<math environment>' (inline $…$ and \(…\) end with the line) ---------- */
  const TCMD = /\\(?:[A-Za-z@]+\*?|[\s\S])/y, TENV = /\{([^{}]*)\}/y, TMATH = /^(?:equation|align|alignat|gather|multline|flalign|eqnarray|displaymath|math)\*?$/;
  function lexTex(line, st) {
    const out = [], n = line.length; let i = 0, p = 0;
    const tok = (t, a, b) => { if (a > p) out.push([st ? 'math' : '', line.slice(p, a)]); out.push([t, line.slice(a, b)]); p = i = b; };
    while (i < n) {
      const c = line[i];
      if (c === '%') { tok('com', i, n); break; }
      if (c === '\\') {
        const w = (at(TCMD, line, i) || ['\\'])[0], e = i + w.length, en = (w === '\\begin' || w === '\\end') && at(TENV, line, e);
        if (en) {
          const nm = en[1], t = e + en[0].length;
          tok('cmd', i, e); tok('br', e, e + 1); tok('env', e + 1, t - 1); tok('br', t - 1, t);
          if (w === '\\begin' && !st && TMATH.test(nm)) st = 'env:' + nm; else if (w === '\\end' && st === 'env:' + nm) st = null;
        } else if ((w === '\\[' || w === '\\(') && !st) { tok('math', i, e); st = w; }
        else if ((w === '\\]' && st === '\\[') || (w === '\\)' && st === '\\(')) { tok('math', i, e); st = null; }
        else tok('cmd', i, e);
        continue;
      }
      if (c === '$') {
        if (st === '$') { tok('math', i, i + 1); st = null; }
        else if (line[i + 1] === '$' && (!st || st === '$$')) { tok('math', i, i + 2); st = st ? null : '$$'; }
        else if (!st) { tok('math', i, i + 1); st = '$'; }
        else i++;
        continue;
      }
      if (c === '{' || c === '}' || c === '[' || c === ']') { tok('br', i, i + 1); continue; }
      i++;
    }
    if (p < n) out.push([st ? 'math' : '', line.slice(p)]);
    return { t: out, s: st === '$' || st === '\\(' ? null : st };
  }

  /* ---------- pure API ---------- */
  const E = F.codeEditor = function (o) { return create(o || {}); };
  E.lexLine = (lang, line, st) => (line.length > MAXLINE ? { t: [['', line]], s: st || null } : (lang === 'latex' ? lexTex : lexPy)(line, st || null));
  E.tokenize = (lang, src) => { let st = null; return String(src == null ? '' : src).split('\n').map((l) => { const r = E.lexLine(lang, l, st); st = r.s; return r.t; }); };
  E.lineRange = (src, line) => {   // [start, end) of 1-based `line`
    const ls = String(src).split('\n'), i = Math.min(Math.max(1, line | 0), ls.length) - 1; let s = 0;
    for (let k = 0; k < i; k++) s += ls[k].length + 1;
    return [s, s + ls[i].length];
  };
  /* every edit is {from, to, text, sel:[a,b]}: replace [from,to) by text, then select sel (offsets in the new text) */
  const block = (v, s, e) => { const a = v.lastIndexOf('\n', s - 1) + 1, e2 = e > s && v[e - 1] === '\n' ? e - 1 : e, b = v.indexOf('\n', e2); return [a, b < 0 ? v.length : b]; };
  E.indentEdit = (v, s, e, shift) => {
    if (!shift && !v.slice(s, e).includes('\n')) {   // caret / one-line selection: spaces up to the next 4-column stop
      const n = 4 - (s - (v.lastIndexOf('\n', s - 1) + 1)) % 4; return { from: s, to: e, text: ' '.repeat(n), sel: [s + n, s + n] };
    }
    const [a, b] = block(v, s, e); let first = 0, total = 0;
    const text = v.slice(a, b).split('\n').map((l, k) => {
      let d = 0;
      if (!shift) { if (l.trim()) { l = '    ' + l; d = 4; } } else { const m = /^(?: {1,4}|\t)/.exec(l); if (m) { l = l.slice(m[0].length); d = -m[0].length; } }
      if (!k) first = d; total += d; return l;
    }).join('\n');
    const ns = Math.max(a, s + first);
    return { from: a, to: b, text, sel: [ns, Math.max(ns, e + total)] };
  };
  E.enterEdit = (v, s, e, lang) => {
    const before = v.slice(v.lastIndexOf('\n', s - 1) + 1, s), ind = /^[ \t]*/.exec(before)[0];
    const t = '\n' + ind + (lang === 'python' && /:\s*(?:#.*)?$/.test(before) ? '    ' : '');
    return { from: s, to: e, text: t, sel: [s + t.length, s + t.length] };
  };
  E.toggleComment = (v, s, e, lang) => {
    const tk = lang === 'latex' ? '%' : '#', [a, b] = block(v, s, e), ls = v.slice(a, b).split('\n'), live = ls.filter((l) => l.trim());
    const un = live.length > 0 && live.every((l) => l.trimStart().startsWith(tk));
    const col = Math.min(...live.map((l) => /^[ \t]*/.exec(l)[0].length), 1e9); let first = 0, total = 0;
    const text = ls.map((l, k) => {
      let d = 0;
      if (l.trim()) {
        if (un) { const m = new RegExp('^([ \\t]*)\\' + tk + ' ?').exec(l); d = m[0].length - m[1].length; l = m[1] + l.slice(m[0].length); d = -d; }
        else { l = l.slice(0, col) + tk + ' ' + l.slice(col); d = tk.length + 1; }
      }
      if (!k) first = d; total += d; return l;
    }).join('\n');
    const ns = Math.max(a, s + first);
    return { from: a, to: b, text, sel: [ns, Math.max(ns, e + total)] };
  };
  const PAIRS = { '(': ')', '[': ']', '{': '}' };
  E.pairEdit = (v, s, e, ch, lang) => {   // bracket / quote auto-close; null = let the key type normally
    const q = lang === 'python' && (ch === '"' || ch === "'"), close = q ? ch : PAIRS[ch], nx = v[e] || '', pv = v[s - 1] || '';
    if (s !== e) return close ? { from: s, to: e, text: ch + v.slice(s, e) + close, sel: [s + 1, e + 1] } : null;
    if ((q || ')]}'.includes(ch)) && nx === ch) return { from: s, to: s, text: '', sel: [s + 1, s + 1] };   // type over the closer
    if (!close || (q && (/\w/.test(pv) || /\w/.test(nx)))) return null;
    if (!q && nx && !/[\s)\]};,:.]/.test(nx)) return null;
    return { from: s, to: s, text: ch + close, sel: [s + 1, s + 1] };
  };
  E.pairDelete = (v, s, e) => (s === e && s > 0 && ['()', '[]', '{}', '""', "''"].includes(v.slice(s - 1, s + 1)) ? { from: s - 1, to: s + 1, text: '', sel: [s - 1, s - 1] } : null);
  /* case-insensitive find: {at, k (1-based), n}; dir 1 = first match at/after `from`, -1 = last match before it, both wrap */
  E.find = (text, q, from, dir) => {
    if (!q) return { at: -1, k: 0, n: 0 };
    const low = text.toLowerCase(), t = low.length === text.length ? low : text, nd = t === low ? q.toLowerCase() : q, all = [];
    for (let i = t.indexOf(nd); i >= 0 && all.length < 9999; i = t.indexOf(nd, i + nd.length)) all.push(i);
    if (!all.length) return { at: -1, k: 0, n: 0 };
    let k = -1;
    if (dir > 0) k = all.findIndex((i) => i >= from); else for (let j = all.length - 1; j >= 0 && k < 0; j--) if (all[j] < from) k = j;
    if (k < 0) k = dir > 0 ? 0 : all.length - 1;
    return { at: all[k], k: k + 1, n: all.length };
  };

  /* ---------- the component ---------- */
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const html = (toks) => toks.map((t) => (t[0] ? '<span class="ce-' + t[0] + '">' + esc(t[1]) + '</span>' : esc(t[1]))).join('');
  const raf = (f) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(f) : setTimeout(f, 0));
  const NAMES = { python: 'Python code', latex: 'LaTeX code' };

  function create(o) {
    const h = RPE.h, self = {}, autoClose = o.autoClose !== false;
    let lang = o.language === 'latex' ? 'latex' : 'python', ro = !!o.readOnly;
    let text = '', lines = [''], states = [null], valid = 1, errs = [], emap = new Map(), rf = 0, rl = -1;
    let cw = 7.2, cur = -1, focused = false, tabFree = false, hit = null, hitAt = -1, dead = false, obs = null, esig = '';

    const ta = h('textarea', { class: 'ce__ta', spellcheck: false, wrap: 'off', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', maxlength: o.maxLength || 1000000, 'aria-label': o.label || NAMES[lang] });
    const gin = h('pre', { class: 'ce__gin' }), gut = h('div', { class: 'ce__gut', 'aria-hidden': 'true' }, gin);
    const bands = h('div', { class: 'ce__bands' }), mk = h('div', { class: 'ce__match', hidden: true }), hl = h('pre', { class: 'ce__hl', 'aria-hidden': 'true' });
    const probe = h('span', { class: 'ce__probe', 'aria-hidden': 'true' }, '0000000000'), sr = h('div', { class: 'ce__sr', role: 'status' });
    const fi = h('input', { class: 'ce__fi', type: 'text', placeholder: 'Find', 'aria-label': 'Find in code', spellcheck: false, autocomplete: 'off' }), fc = h('span', { class: 'ce__fc', 'aria-live': 'polite' });
    const fb = (t, label, fn) => h('button', { type: 'button', class: 'ce__fb', 'aria-label': label, title: label, onclick: fn }, t);
    const fbar = h('div', { class: 'ce__find', role: 'search', hidden: true }, fi, fc, fb('↑', 'Previous match', () => step(-1)), fb('↓', 'Next match', () => step(1)), fb('×', 'Close find', () => closeFind()));
    const body = h('div', { class: 'ce__body' }, h('div', { class: 'ce__bg', 'aria-hidden': 'true' }, bands, mk), hl, ta, fbar);
    const el = h('div', { class: 'ce' }, gut, body, probe, sr);

    const view = () => ta.clientHeight || 300;
    const lineOf = (off) => { let n = 0, i = -1; while ((i = text.indexOf('\n', i + 1)) !== -1 && i < off) n++; return n; };
    const say = (m) => { sr.textContent = m; };
    const ensure = (upTo) => { while (valid <= upTo) { states[valid] = E.lexLine(lang, lines[valid - 1], states[valid - 1]).s; valid++; } };

    const place = () => {
      const sx = ta.scrollLeft || 0, sy = ta.scrollTop || 0;
      hl.style.transform = 'translate(' + (PADX - sx) + 'px,' + (PADY + rf * LH - sy) + 'px)';
      gin.style.transform = 'translateY(' + (PADY + rf * LH - sy) + 'px)';
      bands.style.transform = 'translateY(' + (PADY - sy) + 'px)';
      if (hit) mk.style.transform = 'translate(' + (PADX + hit.x - sx) + 'px,' + (PADY + hit.line * LH - sy) + 'px)';
    };
    const paint = () => {   // tokenize + draw only the visible lines (+ overscan)
      const st0 = ta.scrollTop || 0, first = Math.min(lines.length - 1, Math.max(0, Math.floor(st0 / LH) - OVER)), last = Math.min(lines.length - 1, Math.ceil((st0 + view()) / LH) + OVER);
      ensure(first);
      let st = states[first]; const hs = [], gs = [];
      for (let i = first; i <= last; i++) {
        const r = E.lexLine(lang, lines[i], st); st = r.s; hs.push(html(r.t));
        gs.push(emap.has(i + 1) ? '<b class="ce__ge" title="' + esc(emap.get(i + 1)).replace(/"/g, '&quot;') + '">' + (i + 1) + '</b>' : String(i + 1));
      }
      hl.innerHTML = hs.join('\n'); gin.innerHTML = gs.join('\n'); rf = first; rl = last; place();
    };
    const marks = () => {   // current-line and error bands live in one layer, positioned by line index
      let s = cur >= 0 ? '<i class="ce__cur" style="top:' + cur * LH + 'px"></i>' : '';
      errs.forEach((e) => { s += '<i class="ce__eb" style="top:' + (e.line - 1) * LH + 'px"></i>'; });
      bands.innerHTML = s;
    };
    const updateCur = () => {
      const c = focused && ta.selectionStart === ta.selectionEnd ? lineOf(ta.selectionStart) : -1;
      if (c !== cur) { cur = c; marks(); }
    };
    const measure = () => { const w = probe.getBoundingClientRect && probe.getBoundingClientRect().width; if (w > 0) cw = w / 10; };
    const setText = (v) => {   // text changed (typing, paste, setValue): drop cached states from the first changed line
      const old = text; text = v; let k = 0; const m = Math.min(old.length, v.length);
      while (k < m && old.charCodeAt(k) === v.charCodeAt(k)) k++;
      const L = lineOf(k); lines = v.split('\n'); valid = Math.min(valid, L + 1); states.length = valid;
      gut.style.width = 'calc(' + Math.max(3, String(lines.length).length) + 'ch + 16px)';
      if (hit) { hit = null; hitAt = -1; mk.hidden = true; fc.textContent = ''; }
      paint(); updateCur();
    };

    /* ----- edits go through execCommand so the browser's own undo stack keeps working ----- */
    const apply = (ed) => {
      ta.focus();
      if (ed.text !== '' || ed.to !== ed.from) {
        ta.setSelectionRange(ed.from, ed.to);
        if (!document.execCommand(ed.text === '' ? 'delete' : 'insertText', false, ed.text)) { ta.setRangeText(ed.text, ed.from, ed.to, 'end'); ta.dispatchEvent(new Event('input', { bubbles: true })); }
      }
      ta.setSelectionRange(ed.sel[0], ed.sel[1]); updateCur();
    };
    ta.addEventListener('input', () => { setText(ta.value); if (o.onChange) o.onChange(text); });
    ta.addEventListener('scroll', () => {
      const vf = Math.floor(ta.scrollTop / LH), vl = Math.min(lines.length - 1, Math.ceil((ta.scrollTop + view()) / LH));
      if (vf < rf || vl > rl) paint(); else place();
    });
    ta.addEventListener('focus', () => { focused = true; updateCur(); });
    ta.addEventListener('blur', () => { focused = false; tabFree = false; updateCur(); });
    ['keyup', 'mouseup'].forEach((n) => ta.addEventListener(n, updateCur));
    ta.addEventListener('keydown', (e) => {
      if (e.isComposing || e.keyCode === 229) return;
      const k = e.key, mod = e.ctrlKey || e.metaKey, s = ta.selectionStart, en = ta.selectionEnd;
      if (k === 'Escape') { if (!tabFree) { tabFree = true; e.stopPropagation(); say('Tab now moves focus out of the editor. Press any other key to indent with Tab again.'); } return; }   // 2nd Esc reaches the dialog
      if (k === 'Tab') { if (tabFree || ro || mod || e.altKey) return; e.preventDefault(); apply(E.indentEdit(text, s, en, e.shiftKey)); return; }
      if (k !== 'Shift' && k !== 'Control' && k !== 'Alt' && k !== 'Meta') tabFree = false;
      raf(updateCur);
      if (mod && !e.altKey && k === 'Enter' && o.onRun) { if (o.onRun() !== false) { e.preventDefault(); e.stopPropagation(); } return; }
      if (mod && !e.altKey && !e.shiftKey && (k === 'f' || k === 'F')) { e.preventDefault(); openFind(); return; }
      if (ro) return;
      if (mod && !e.altKey && (k === '/' || e.code === 'Slash')) { e.preventDefault(); apply(E.toggleComment(text, s, en, lang)); return; }
      if (mod || e.altKey) return;
      let ed = null;
      if (k === 'Enter' && !e.shiftKey) ed = E.enterEdit(text, s, en, lang);
      else if (autoClose && k.length === 1) ed = E.pairEdit(text, s, en, k, lang);
      else if (autoClose && k === 'Backspace') ed = E.pairDelete(text, s, en);
      if (ed) { e.preventDefault(); apply(ed); }
    });

    /* ----- find ----- */
    const show = (r, len) => {
      const ls = text.lastIndexOf('\n', r.at - 1) + 1, ln = lineOf(r.at), pre = text.slice(ls, r.at), vcols = (s, c0) => { let c = c0; for (const ch of s) c += ch === '\t' ? 4 - c % 4 : 1; return c - c0; };
      const c0 = vcols(pre, 0), w = vcols(text.slice(r.at, r.at + len), c0);
      hitAt = r.at; hit = { line: ln, x: c0 * cw }; mk.style.width = w * cw + 'px'; mk.hidden = false;
      const top = ln * LH, vh = view(), vw = ta.clientWidth || 400;
      if (top < ta.scrollTop || top + LH + PADY * 2 > ta.scrollTop + vh) ta.scrollTop = Math.max(0, top - vh / 3);
      if (hit.x < ta.scrollLeft || hit.x + w * cw + PADX * 2 > ta.scrollLeft + vw) ta.scrollLeft = Math.max(0, hit.x - 40);
      ta.setSelectionRange(r.at, r.at + len); paint(); fc.textContent = r.k + ' of ' + r.n;
    };
    const step = (dir, keep) => {
      const q = fi.value;
      if (!q) { hit = null; hitAt = -1; mk.hidden = true; fc.textContent = ''; return; }
      const from = hitAt >= 0 ? (keep ? hitAt : dir > 0 ? hitAt + 1 : hitAt) : ta.selectionStart, r = E.find(text, q, from, dir);
      if (r.at < 0) { hit = null; hitAt = -1; mk.hidden = true; fc.textContent = 'No matches'; return; }
      show(r, q.length);
    };
    const openFind = () => {
      fbar.hidden = false; const sel = text.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) fi.value = sel;
      fi.focus(); fi.select(); step(1, true);
    };
    const closeFind = () => { fbar.hidden = true; hit = null; hitAt = -1; mk.hidden = true; ta.focus(); };
    fi.addEventListener('input', () => step(1, true));
    fi.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); step(e.shiftKey ? -1 : 1); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeFind(); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) { e.preventDefault(); fi.select(); }
    });

    /* ----- public API ----- */
    self.el = el; self.textarea = ta;
    self.getValue = () => text;
    self.setValue = (v) => { v = String(v == null ? '' : v); if (v !== ta.value) ta.value = v; if (v !== text) setText(v); };
    self.setReadOnly = (b) => { ro = !!b; ta.readOnly = ro; ta.setAttribute('aria-readonly', String(ro)); el.classList.toggle('is-readonly', ro); };
    self.setLanguage = (l) => { l = l === 'latex' ? 'latex' : 'python'; if (l === lang) return; lang = l; valid = 1; states.length = 1; if (!o.label) ta.setAttribute('aria-label', NAMES[lang]); paint(); };
    self.setErrors = (list) => {   // [{line (1-based), message}] -> gutter marker + band; lines outside the text are dropped
      const next = (Array.isArray(list) ? list : []).map((e) => ({ line: Number(e && e.line), message: String((e && e.message) || '') })).filter((e) => Number.isInteger(e.line) && e.line >= 1 && e.line <= lines.length).slice(0, 50), sig = JSON.stringify(next);
      if (sig === esig) return; esig = sig; errs = next;
      emap = new Map(); errs.forEach((e) => emap.set(e.line, emap.has(e.line) ? emap.get(e.line) + '; ' + e.message : e.message));
      ta.setAttribute('aria-invalid', String(errs.length > 0));
      say(errs.length ? errs.length + (errs.length === 1 ? ' error: ' : ' errors: ') + errs.slice(0, 3).map((e) => 'line ' + e.line + ', ' + e.message).join('; ') : '');
      marks(); paint();
    };
    self.jumpToLine = (n) => {   // select the line and scroll it into the upper third
      n = Math.min(Math.max(1, n | 0), lines.length); const rg = E.lineRange(text, n);
      ta.focus(); ta.setSelectionRange(rg[0], rg[1]); ta.scrollTop = Math.max(0, (n - 1) * LH - view() / 3); paint(); updateCur();
    };
    self.focus = () => ta.focus();
    self.refresh = () => { measure(); paint(); };
    self.destroy = () => { dead = true; if (obs) obs.disconnect(); };

    if (typeof ResizeObserver === 'function') { obs = new ResizeObserver(() => { if (!dead) { measure(); paint(); } }); obs.observe(ta); }
    ta.value = String(o.value == null ? '' : o.value); setText(ta.value); self.setReadOnly(ro);
    return self;
  }
})(window.RPE);
