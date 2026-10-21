/* icons.js — Lucide icon helper.
   Markup uses <i data-lucide="name" class="ic"></i>. RPE.icons.render(root) asks the Lucide CDN build to
   replace those placeholders; anything still unresolved (CDN blocked/offline, or an icon missing in the
   pinned version) is drawn from the small bundled subset in icons-fallback.js so the UI never loses its icons. */
(function (RPE) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  function fallback(name, cls) {
    const inner = (RPE.iconData || {})[name];
    if (!inner) return null;
    const svg = document.createElementNS(NS, 'svg');
    const attrs = { width: 24, height: 24, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
    Object.keys(attrs).forEach((k) => svg.setAttribute(k, attrs[k]));
    svg.setAttribute('class', 'lucide lucide-' + name + (cls ? ' ' + cls : ''));
    svg.innerHTML = inner;
    return svg;
  }

  const warned = {};
  RPE.icons = {
    html(name, cls) { return `<i data-lucide="${name}" class="ic${cls ? ' ' + cls : ''}" aria-hidden="true"></i>`; },
    render(root) {
      root = root || document;
      if (window.lucide && typeof window.lucide.createIcons === 'function' && root.querySelector('[data-lucide]')) {
        try { window.lucide.createIcons({ root }); } catch (e) { try { window.lucide.createIcons(); } catch (e2) { /* fall through to bundled icons */ } }
      }
      root.querySelectorAll('[data-lucide]').forEach((el) => {
        const name = el.getAttribute('data-lucide'), svg = fallback(name, el.getAttribute('class') || '');
        if (svg) el.replaceWith(svg);
        else { el.removeAttribute('data-lucide'); el.classList.add('ic-missing'); if (!warned[name]) { warned[name] = 1; console.warn('[rpe] icon not available:', name); } }
      });
    }
  };
})(window.RPE = window.RPE || {});
