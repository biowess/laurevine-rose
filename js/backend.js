/* backend.js — communicates with the local Python FastAPI service.
   Handles PPTX export, project save validation, and service health checks. */
(function (RPE) {
  'use strict';

  function getBaseUrl() {
    if (window.location && window.location.protocol && window.location.protocol.startsWith('http')) {
      return window.location.origin;
    }
    if (RPE.store && RPE.store.prefs && RPE.store.prefs.backendUrl) {
      return RPE.store.prefs.backendUrl.replace(/\/+$/, '');
    }
    return 'http://127.0.0.1:8000';
  }

  const TIP_ONLINE = 'Local Python service is connected (PowerPoint export active)';

  /* Appends the figure-runtime summary (Python packages, LaTeX) to the connected tooltip once it is known. */
  function showRuntimeTip(el) {
    if (!RPE.figures) return;
    RPE.figures.runtime().then((rt) => {
      if (RPE.backend.connected && el.isConnected) el.dataset.tip = TIP_ONLINE + '\n' + RPE.figures.summary(rt);
    });
  }

  function updateStatusUI(connected) {
    const el = document.querySelector('.status-backend');
    if (!el) return;
    const dot = el.querySelector('.dot');
    if (connected) {
      if (dot) {
        dot.className = 'dot dot--on';
      }
      el.childNodes[el.childNodes.length - 1].textContent = 'Backend: connected';
      el.dataset.tip = TIP_ONLINE;
      showRuntimeTip(el);
    } else {
      if (dot) {
        dot.className = 'dot dot--off';
      }
      el.childNodes[el.childNodes.length - 1].textContent = 'Backend: offline';
      el.dataset.tip = 'Local Python service not detected. Start with python3 run.py';
    }
  }

  async function checkHealth() {
    const url = getBaseUrl() + '/api/health';
    try {
      const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        RPE.backend.connected = true;
        updateStatusUI(true);
        RPE.bus.emit('backend:status', { connected: true });
        return true;
      }
    } catch (err) {
      // Service not running yet or unreachable
    }
    RPE.backend.connected = false;
    updateStatusUI(false);
    RPE.bus.emit('backend:status', { connected: false });
    return false;
  }

  function saveBlob(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(blobUrl); a.remove(); }, 1000);
  }

  /* ---------- figure endpoints (contract section 4) ----------
     Every call resolves, never rejects: { ok:true, status, data|blob } or
     { ok:false, status, code:'offline'|'timeout'|'aborted'|'http'|'bad_response'|'too_large', message }.
     `message` is always one readable sentence for the UI (offline, 4xx detail, timeout). */
  const FIG_TIMEOUT = { 'figures.render': 150000, 'figures.export': 240000, 'figures.dataset.parse': 60000, 'figures.runtime': 15000, 'figures.sample': 15000, 'figures.layouts': 15000, 'figures.python.data': 20000, 'figures.python.run': 150000, 'figures.python.cancel': 10000, 'figures.python.templates': 15000, 'figures.latex.compile': 100000, 'figures.latex.render': 100000, 'figures.latex.templates': 15000, 'figures.latex.wrapper': 15000, 'figures.job': 5000, 'figures.job.cancel': 10000, 'figures.jobs': 10000 };
  const MAX_CSV_BYTES = 5 * 1024 * 1024;

  function detailText(body, raw) {
    const d = body && typeof body === 'object' ? (body.detail !== undefined ? body.detail : body.message) : null;
    if (typeof d === 'string' && d.trim()) return d.trim();
    if (Array.isArray(d) && d.length) { // FastAPI validation list: [{loc:[..], msg}]
      return d.map((e) => (e && e.msg ? ((Array.isArray(e.loc) ? e.loc.filter((x) => x !== 'body').join('.') : '') + (e.loc && e.loc.length > 1 ? ': ' : '') + e.msg) : String(e))).join('; ');
    }
    if (typeof raw === 'string' && raw.trim() && !/^\s*</.test(raw)) return raw.trim().slice(0, 300);
    return '';
  }

  function httpMessage(status, detail) {
    if (status === 404 && (!detail || detail === 'Not Found')) return 'The local Python service does not have this feature. Restart it with python3 run.py to load the current version.';
    if (status === 413) return detail || 'The request is too large for the local Python service.';
    if (status === 499) return 'The request was cancelled.';
    if (status >= 500) return 'The local Python service failed (HTTP ' + status + ')' + (detail ? ': ' + detail : '.');
    return detail || 'The local Python service rejected the request (HTTP ' + status + ').';
  }

  /* Session token (docs/SECURITY.md): fetched once from GET /api/session, sent as X-RPE-Token on every figure call. */
  let sessionToken = null;
  async function getToken(force, signal) {
    if (sessionToken && !force) return sessionToken;
    try {
      const r = await fetch(getBaseUrl() + '/api/session', { headers: { 'Accept': 'application/json' }, signal });
      const j = r.ok ? await r.json() : null;
      sessionToken = j && typeof j.token === 'string' ? j.token : null;
    } catch (e) { sessionToken = null; }
    return sessionToken;
  }

  async function figureCall(name, path, init, o) {
    o = o || {};
    const ctrl = new AbortController();
    const ms = o.timeoutMs || FIG_TIMEOUT[name] || 60000;
    let why = null;
    const timer = setTimeout(() => { why = 'timeout'; ctrl.abort(); }, ms);
    const onAbort = () => { why = why || 'aborted'; ctrl.abort(); };
    if (o.signal) { if (o.signal.aborted) onAbort(); else o.signal.addEventListener('abort', onAbort, { once: true }); }
    try {
      const send = async (force) => {
        const token = await getToken(force, ctrl.signal);
        if (ctrl.signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        const headers = Object.assign({}, init && init.headers, token ? { 'X-RPE-Token': token } : {});
        return fetch(getBaseUrl() + path, Object.assign({}, init, { headers, signal: ctrl.signal }));
      };
      let res = await send(false);
      if (res.status === 403 && sessionToken) res = await send(true);   // the server was restarted: new token
      if (!res.ok) {
        let body = null, raw = '';
        try { raw = await res.text(); body = JSON.parse(raw); } catch (e) { /* not JSON */ }
        return { ok: false, status: res.status, code: 'http', message: httpMessage(res.status, detailText(body, raw)) };
      }
      if (o.blob) return { ok: true, status: res.status, blob: await res.blob(), headers: res.headers };
      let data;
      try { data = await res.json(); } catch (e) { return { ok: false, status: res.status, code: 'bad_response', message: 'The local Python service sent an answer this app cannot read.' }; }
      return { ok: true, status: res.status, data };
    } catch (err) {
      if (why === 'timeout') return { ok: false, status: 0, code: 'timeout', message: 'The local Python service did not answer within ' + Math.round(ms / 1000) + ' seconds.' };
      if (why === 'aborted' || (err && err.name === 'AbortError')) return { ok: false, status: 0, code: 'aborted', message: 'The request was cancelled.' };
      return { ok: false, status: 0, code: 'offline', message: 'The local Python service is not reachable at ' + getBaseUrl() + '. Start it with python3 run.py, then try again.' };
    } finally {
      clearTimeout(timer);
      if (o.signal) o.signal.removeEventListener('abort', onAbort);
    }
  }

  function headerFilename(disp) {
    if (!disp) return null;
    const star = disp.match(/filename\*=UTF-8''([^;]+)/i);
    if (star) { try { return decodeURIComponent(star[1].trim()); } catch (e) { /* fall through */ } }
    const m = disp.match(/filename="?([^";]+)"?/i);
    return m ? m[1].trim() : null;
  }

  function figureRequest(name, payload) {
    const p = payload || {};
    const json = (body) => ({ method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) });
    const opt = { signal: p.signal, timeoutMs: p.timeoutMs };
    /* Job-backed calls (render, export, python run, latex compile / render) get a client job id, are shown as a progress chip when they
       run long or wait in the server queue (RPE.figures.jobs, js/figures/store.js), and an abort or client timeout also cancels the
       server job (kills its process group) instead of only dropping the connection. */
    const newJobId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const cancelUrl = (id) => '/api/figures/jobs/' + encodeURIComponent(id) + '/cancel';
    const sendCancel = (id) => figureCall('figures.job.cancel', cancelUrl(id), { method: 'POST', headers: { Accept: 'application/json' } }, {});
    const JOB_LABEL = {
      'figures.render': () => (p.purpose === 'final' ? 'Rendering final image' : 'Rendering preview'),
      'figures.export': () => 'Exporting ' + String(p.format || 'png').toUpperCase(),
      'figures.python.run': () => (p.purpose === 'final' ? 'Running Python (final image)' : 'Running Python'),
      'figures.latex.compile': () => 'Compiling LaTeX', 'figures.latex.render': () => 'Rendering LaTeX image'
    };
    function jobCall(path, body, extra) {
      const id = body.jobId = p.jobId || newJobId();
      const own = new AbortController();
      const stop = () => { if (!own.signal.aborted) { own.abort(); sendCancel(id); } };
      if (p.signal) { if (p.signal.aborted) stop(); else p.signal.addEventListener('abort', stop, { once: true }); }
      const J = RPE.figures && RPE.figures.jobs;
      const t = J ? J.track({ id, label: JOB_LABEL[name](), cancel: stop, quiet: p.purpose !== 'final' && (name === 'figures.render' || name === 'figures.python.run') }) : null;
      return figureCall(name, path, json(body), Object.assign({}, opt, extra, { signal: own.signal })).then((r) => {
        if (r.code === 'timeout') sendCancel(id);
        return r;
      }).finally(() => { if (p.signal) p.signal.removeEventListener('abort', stop); if (t) t.end(); });
    }
    if (name === 'figures.job') return figureCall(name, '/api/figures/jobs/' + encodeURIComponent(String(p.jobId || '')), { headers: { Accept: 'application/json' } }, opt);
    if (name === 'figures.jobs') return figureCall(name, '/api/figures/jobs', { headers: { Accept: 'application/json' } }, opt);
    if (name === 'figures.runtime') {
      return figureCall(name, '/api/figures/runtime' + (p.refresh ? '?refresh=true' : ''), { headers: { Accept: 'application/json' } }, opt);
    }
    if (name === 'figures.layouts') return figureCall(name, '/api/figures/layouts', { headers: { Accept: 'application/json' } }, opt);
    if (name === 'figures.sample') {
      return figureCall(name, '/api/figures/samples/' + encodeURIComponent(String(p.plotType || '')), { headers: { Accept: 'application/json' } }, opt);
    }
    if (name === 'figures.python.data') return figureCall(name, '/api/figures/python/data', json({ source: String(p.source || '') }), opt);
    if (name === 'figures.python.templates') return figureCall(name, '/api/figures/python/templates', { headers: { Accept: 'application/json' } }, opt);
    if (name === 'figures.python.cancel') return figureCall(name, '/api/figures/jobs/' + encodeURIComponent(String(p.jobId || '')) + '/cancel', { method: 'POST', headers: { Accept: 'application/json' } }, opt);
    if (name === 'figures.python.run') {
      const body = { source: String(p.source || ''), purpose: p.purpose || 'preview', dpi: p.dpi || 450, background: p.background || 'white' };
      if (p.sizeIn) body.sizeIn = p.sizeIn;
      return jobCall('/api/figures/python/run', body);
    }
    if (name === 'figures.latex.templates') return figureCall(name, '/api/figures/latex/templates', { headers: { Accept: 'application/json' } }, opt);
    if (name === 'figures.latex.wrapper') return figureCall(name, '/api/figures/latex/wrapper', json({ source: String(p.source || '') }), opt);
    if (name === 'figures.latex.compile' || name === 'figures.latex.render') {
      const body = { mode: p.mode || 'document', engine: p.engine || 'pdflatex' };
      if (p.pdfBase64) body.pdfBase64 = p.pdfBase64; else body.source = String(p.source || '');   // render may start from a compiled PDF
      if (p.dpi) body.dpi = p.dpi;
      if (p.wIn) body.wIn = p.wIn;
      if (p.background) body.background = p.background;
      return jobCall(name === 'figures.latex.compile' ? '/api/figures/latex/compile' : '/api/figures/latex/render', body);
    }
    if (name === 'figures.render') {
      const body = { record: p.record, purpose: p.purpose || 'preview' };
      if (p.dpi !== undefined && p.dpi !== null) body.dpi = p.dpi;
      return jobCall('/api/figures/render', body);
    }
    if (name === 'figures.export') {
      const body = { record: p.record, format: p.format || 'png' };
      if (p.dpi !== undefined && p.dpi !== null) body.dpi = p.dpi;
      if (p.background) body.background = p.background;
      return jobCall('/api/figures/export', body, { blob: true }).then((r) => {
        if (!r.ok) return r;
        const ext = { png: 'png', pdf: 'pdf', py: 'py', bundle: 'zip' }[body.format] || body.format;
        const base = String((p.record && p.record.name) || 'figure').replace(/[^\w.-]+/g, '_').slice(0, 80) || 'figure';
        const filename = headerFilename(r.headers.get('Content-Disposition')) || base + '.' + ext;
        if (p.save !== false) saveBlob(r.blob, filename);
        return { ok: true, status: r.status, filename, blob: r.blob, size: r.blob.size };
      });
    }
    // figures.dataset.parse — multipart {file} (File/Blob) or JSON {text}; delimiter / hasHeader are optional
    if (p.file && p.file.size > MAX_CSV_BYTES) {
      return Promise.resolve({ ok: false, status: 0, code: 'too_large', message: 'CSV files are limited to 5 MB; this one is ' + (p.file.size / 1048576).toFixed(1) + ' MB.' });
    }
    const opts = {};
    if (p.delimiter) opts.delimiter = p.delimiter;
    if (p.hasHeader === true || p.hasHeader === false || p.hasHeader === 'auto') opts.hasHeader = p.hasHeader;
    if (p.plotType) opts.plotType = p.plotType;
    if (p.file) {
      const form = new FormData();
      form.append('file', p.file, p.fileName || p.file.name || 'data.csv');
      Object.keys(opts).forEach((k) => form.append(k, String(opts[k])));
      return figureCall(name, '/api/figures/dataset/parse', { method: 'POST', headers: { Accept: 'application/json' }, body: form }, opt);
    }
    return figureCall(name, '/api/figures/dataset/parse', json(Object.assign({ text: String(p.text || ''), fileName: p.fileName }, opts)), opt);
  }

  async function request(name, payload) {
    RPE.bus.emit('backend', { name, payload });
    const baseUrl = getBaseUrl();

    if (FIG_TIMEOUT[name]) return figureRequest(name, payload);

    if (name === 'presentation.export') {
      const format = (payload && payload.format) || 'pptx';
      const endpoint = baseUrl + '/api/presentation/export';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ format, doc: payload.doc })
        });

        if (!res.ok) {
          let errDetail = 'Export failed';
          let errCode = null;
          try {
            const errJson = await res.json();
            // Server may return detail as an object {code, message} (e.g. PDF_CONVERTER_MISSING)
            // or as a plain string. Handle both.
            if (errJson && errJson.detail && typeof errJson.detail === 'object') {
              errCode = errJson.detail.code || null;
              errDetail = errJson.detail.message || errDetail;
            } else {
              errDetail = (errJson && (errJson.detail || errJson.message)) || errDetail;
            }
          } catch (e) { /* ignore */ }
          return { ok: false, status: res.status, code: errCode, message: errDetail };
        }

        // Parse content disposition for filename
        let filename = (payload.doc && payload.doc.title ? payload.doc.title : 'presentation')
          .replace(/[^\w.-]+/g, '_') + '.' + format;
        const disp = res.headers.get('Content-Disposition');
        if (disp && disp.includes('filename=')) {
          const m = disp.match(/filename="?([^"]+)"?/);
          if (m && m[1]) filename = m[1];
        }

        let warnings = [];
        try {
          const wh = res.headers.get('X-Export-Warnings');
          const parsed = wh ? JSON.parse(wh) : null;
          if (parsed && Array.isArray(parsed.items)) warnings = parsed.items;
        } catch (e) { /* header is optional */ }

        saveBlob(await res.blob(), filename);

        return { ok: true, status: 200, filename, warnings };
      } catch (err) {
        return { ok: false, status: 0, message: err.message || 'Network error connecting to backend' };
      }
    }

    if (name === 'presentation.save') {
      const endpoint = baseUrl + '/api/presentation/save';
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ doc: payload.doc })
        });
        if (res.ok) {
          const data = await res.json();
          return { ok: true, status: res.status, data };
        }
        return { ok: false, status: res.status };
      } catch (err) {
        return { ok: false, status: 0, message: err.message };
      }
    }

    // Default fallback for any other endpoints
    try {
      const path = name.replace(/\./g, '/');
      const res = await fetch(baseUrl + '/api/' + path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      return { ok: res.ok, status: res.status, data: await res.json() };
    } catch (err) {
      return { ok: false, status: 0, message: 'Could not reach the backend for ' + name };
    }
  }

  RPE.backend = {
    connected: false,
    getBaseUrl,
    checkHealth,
    request
  };

  // Check health shortly after startup and on window focus
  if (typeof window !== 'undefined') {
    window.addEventListener('load', () => setTimeout(checkHealth, 300));
    window.addEventListener('focus', checkHealth);
  }
})(window.RPE = window.RPE || {});
