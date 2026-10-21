/**
 * shapes.js - Single source of truth for shape geometry, adjust handles, and path serialization.
 */
(function (global) {
  'use strict';

  function clamp(val, min, max) {
    return Math.min(max, Math.max(min, val));
  }

  function starPoints(n, outerR, innerR) {
    const cx = 500, cy = 500, pts = [];
    for (let i = 0; i < n * 2; i++) {
      const angle = (i * Math.PI / n) - Math.PI / 2;
      const r = i % 2 === 0 ? outerR : innerR;
      pts.push([Math.round(cx + r * Math.cos(angle)), Math.round(cy + r * Math.sin(angle))]);
    }
    return pts;
  }

  function starCommands(n, outerR, innerR) {
    const pts = starPoints(n, outerR, innerR);
    const cmds = [['M', pts[0][0], pts[0][1]]];
    for (let i = 1; i < pts.length; i++) {
      cmds.push(['L', pts[i][0], pts[i][1]]);
    }
    cmds.push(['Z']);
    return cmds;
  }

  function starHandle(n, innerR) {
    const angle = (1 * Math.PI / n) - Math.PI / 2;
    return [
      Math.round(500 + innerR * Math.cos(angle)),
      Math.round(500 + innerR * Math.sin(angle))
    ];
  }

  const defs = {
    triangle: {
      strokeOnly: false,
      path: (a) => {
        const apexX = Math.round(150 + a * 700);
        return [['M', apexX, 30], ['L', 970, 970], ['L', 30, 970], ['Z']];
      },
      handle: (a) => [Math.round(150 + a * 700), 30],
    },
    rtriangle: {
      strokeOnly: false,
      path: () => [['M', 30, 30], ['L', 970, 970], ['L', 30, 970], ['Z']],
    },
    diamond: {
      strokeOnly: false,
      path: () => [['M', 500, 30], ['L', 970, 500], ['L', 500, 970], ['L', 30, 500], ['Z']],
    },
    pentagon: {
      strokeOnly: false,
      path: () => [['M', 500, 30], ['L', 970, 370], ['L', 785, 940], ['L', 215, 940], ['L', 30, 370], ['Z']],
    },
    hexagon: {
      strokeOnly: false,
      path: () => [['M', 250, 30], ['L', 750, 30], ['L', 970, 500], ['L', 750, 970], ['L', 250, 970], ['L', 30, 500], ['Z']],
    },
    octagon: {
      strokeOnly: false,
      path: () => [
        ['M', 295, 30], ['L', 705, 30], ['L', 970, 295], ['L', 970, 705],
        ['L', 705, 970], ['L', 295, 970], ['L', 30, 705], ['L', 30, 295], ['Z']
      ],
    },
    parallelogram: {
      strokeOnly: false,
      path: (a) => {
        const slant = Math.round(30 + a * 270);
        return [['M', slant, 30], ['L', 970, 30], ['L', 1000 - slant, 970], ['L', 30, 970], ['Z']];
      },
      handle: (a) => [Math.round(30 + a * 270), 30],
    },
    trapezoid: {
      strokeOnly: false,
      path: (a) => {
        const inset = Math.round(30 + a * 370);
        return [['M', inset, 30], ['L', 1000 - inset, 30], ['L', 970, 970], ['L', 30, 970], ['Z']];
      },
      handle: (a) => [Math.round(30 + a * 370), 30],
    },
    arrow: {
      strokeOnly: false,
      path: (a) => {
        const hw = Math.round(250 + a * 320);
        const hx = Math.round(1000 - hw * 1.45);
        const sy = Math.round(500 - 200 + a * 120);
        const sby = Math.round(500 + 200 - a * 120);
        return [
          ['M', 30, sy], ['L', hx, sy], ['L', hx, 500 - hw], ['L', 970, 500],
          ['L', hx, 500 + hw], ['L', hx, sby], ['L', 30, sby], ['Z']
        ];
      },
      handle: (a) => {
        const hw = Math.round(250 + a * 320);
        const hx = Math.round(1000 - hw * 1.45);
        const sy = Math.round(500 - 200 + a * 120);
        return [hx, sy];
      },
    },
    arrow2: {
      strokeOnly: false,
      path: (a) => {
        const hw = Math.round(270 + a * 180);
        const hx = Math.round(hw * 1.3);
        const sy = Math.round(500 - 190 + a * 100);
        const sby = Math.round(500 + 190 - a * 100);
        return [
          ['M', 30, 500], ['L', hx, 500 - hw], ['L', hx, sy], ['L', 1000 - hx, sy],
          ['L', 1000 - hx, 500 - hw], ['L', 970, 500], ['L', 1000 - hx, 500 + hw],
          ['L', 1000 - hx, sby], ['L', hx, sby], ['L', hx, 500 + hw], ['Z']
        ];
      },
      handle: (a) => {
        const hw = Math.round(270 + a * 180);
        const hx = Math.round(hw * 1.3);
        const sy = Math.round(500 - 190 + a * 100);
        return [1000 - hx, sy];
      },
    },
    callout: {
      strokeOnly: false,
      path: (a) => {
        const tailX = Math.round(80 + a * 840);
        const tx1 = Math.max(30, tailX - 55);
        const tx2 = Math.min(970, tailX + 55);
        return [
          ['M', 30, 30], ['L', 970, 30], ['L', 970, 730], ['L', tx2, 730],
          ['L', tailX, 970], ['L', tx1, 730], ['L', 30, 730], ['Z']
        ];
      },
      handle: (a) => {
        const tailX = Math.round(80 + a * 840);
        return [tailX, 970];
      },
    },
    callout2: {
      strokeOnly: false,
      path: (a) => {
        const tailX = Math.round(100 + a * 800);
        return [
          ['M', 500, 30],
          ['C', 790, 30, 970, 200, 970, 400],
          ['C', 970, 600, 790, 720, 500, 720],
          ['C', 390, 720, 288, 690, 210, 640],
          ['L', tailX, 970],
          ['L', 255, 680],
          ['C', 100, 630, 30, 530, 30, 400],
          ['C', 30, 200, 210, 30, 500, 30],
          ['Z']
        ];
      },
      handle: (a) => {
        const tailX = Math.round(100 + a * 800);
        return [tailX, 970];
      },
    },
    star4: {
      strokeOnly: false,
      path: (a) => starCommands(4, 470, Math.round(180 + a * 120)),
      handle: (a) => starHandle(4, Math.round(180 + a * 120)),
    },
    star5: {
      strokeOnly: false,
      path: (a) => starCommands(5, 470, Math.round(190 + a * 100)),
      handle: (a) => starHandle(5, Math.round(190 + a * 100)),
    },
    star6: {
      strokeOnly: false,
      path: (a) => starCommands(6, 470, Math.round(250 + a * 100)),
      handle: (a) => starHandle(6, Math.round(250 + a * 100)),
    },
    chevron: {
      strokeOnly: false,
      path: (a) => {
        const notch = Math.round(160 + a * 300);
        return [
          ['M', 30, 30], ['L', 1000 - notch, 30], ['L', 970, 500],
          ['L', 1000 - notch, 970], ['L', 30, 970], ['L', notch, 500], ['Z']
        ];
      },
      handle: (a) => {
        const notch = Math.round(160 + a * 300);
        return [notch, 500];
      },
    },
    ribbon: {
      strokeOnly: false,
      path: () => [
        ['M', 30, 200], ['L', 200, 200], ['L', 200, 30], ['L', 800, 30], ['L', 800, 200],
        ['L', 970, 200], ['L', 830, 500], ['L', 970, 800], ['L', 800, 800], ['L', 800, 970],
        ['L', 200, 970], ['L', 200, 800], ['L', 30, 800], ['L', 170, 500], ['Z']
      ],
    },
    cross: {
      strokeOnly: false,
      path: (a) => {
        const t = Math.round(200 + a * 100);
        return [
          ['M', t, 30], ['L', 1000 - t, 30], ['L', 1000 - t, t], ['L', 970, t],
          ['L', 970, 1000 - t], ['L', 1000 - t, 1000 - t], ['L', 1000 - t, 970],
          ['L', t, 970], ['L', t, 1000 - t], ['L', 30, 1000 - t], ['L', 30, t], ['L', t, t], ['Z']
        ];
      },
      handle: (a) => {
        const t = Math.round(200 + a * 100);
        return [1000 - t, t];
      },
    },
    line: {
      strokeOnly: true,
      path: () => [['M', 30, 500], ['L', 970, 500]],
    },
    brace: {
      strokeOnly: true,
      path: () => [
        ['M', 700, 30],
        ['Q', 500, 30, 500, 200],
        ['L', 500, 380],
        ['Q', 500, 500, 300, 500],
        ['Q', 500, 500, 500, 620],
        ['L', 500, 800],
        ['Q', 500, 970, 700, 970]
      ],
    },
    scalebar: {
      strokeOnly: true,
      path: () => [
        ['M', 30, 500], ['L', 970, 500],
        ['M', 30, 250], ['L', 30, 750],
        ['M', 970, 250], ['L', 970, 750]
      ],
    },
  };

  function has(kind) {
    return Object.prototype.hasOwnProperty.call(defs, kind);
  }

  function isAdjustable(kind) {
    return has(kind) && typeof defs[kind].handle === 'function';
  }

  function strokeOnly(kind) {
    return has(kind) && Boolean(defs[kind].strokeOnly);
  }

  function commands(kind, adj) {
    const a = adj != null ? clamp(adj, 0, 1) : 0.5;
    if (has(kind)) {
      return defs[kind].path(a);
    }
    return [];
  }

  function handle(kind, adj) {
    const a = adj != null ? clamp(adj, 0, 1) : 0.5;
    if (isAdjustable(kind)) {
      return defs[kind].handle(a);
    }
    return [970, 500];
  }

  function fmt(v) {
    return Number.isInteger(v) ? String(v) : (Math.round(v * 100) / 100).toString();
  }

  function toD(cmds, w, h) {
    const sx = (w != null && w > 0) ? w / 1000 : 1;
    const sy = (h != null && h > 0) ? h / 1000 : 1;
    const parts = [];

    for (let i = 0; i < cmds.length; i++) {
      const c = cmds[i];
      const type = c[0];
      if (type === 'M') {
        parts.push(`M${fmt(c[1] * sx)},${fmt(c[2] * sy)}`);
      } else if (type === 'L') {
        parts.push(`L${fmt(c[1] * sx)},${fmt(c[2] * sy)}`);
      } else if (type === 'C') {
        parts.push(`C${fmt(c[1] * sx)},${fmt(c[2] * sy)} ${fmt(c[3] * sx)},${fmt(c[4] * sy)} ${fmt(c[5] * sx)},${fmt(c[6] * sy)}`);
      } else if (type === 'Q') {
        parts.push(`Q${fmt(c[1] * sx)},${fmt(c[2] * sy)} ${fmt(c[3] * sx)},${fmt(c[4] * sy)}`);
      } else if (type === 'Z') {
        parts.push('Z');
      }
    }
    return parts.join(' ');
  }

  function fromPointer(kind, startAdj, p, o) {
    const h0 = handle(kind, 0);
    const h1 = handle(kind, 1);
    const ax = h0[0] * o.w / 1000;
    const ay = h0[1] * o.h / 1000;
    const dx = h1[0] * o.w / 1000 - ax;
    const dy = h1[1] * o.h / 1000 - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-6) return startAdj;
    return clamp(((p.x - o.x - ax) * dx + (p.y - o.y - ay) * dy) / len2, 0, 1);
  }

  function isLine(o) {
    if (!o) return false;
    return o.type === 'line' || o.shape === 'line' || (o.type === 'shape' && o.shape === 'line');
  }

  function lineGeometry(o) {
    if (!o) return { x1: 0, y1: 0, x2: 0, y2: 0, x: 0, y: 0, w: 0, h: 0 };
    let x1, y1, x2, y2;
    if (o.x1 != null && o.y1 != null && o.x2 != null && o.y2 != null) {
      x1 = Number(o.x1);
      y1 = Number(o.y1);
      x2 = Number(o.x2);
      y2 = Number(o.y2);
    } else {
      const x = Number(o.x || 0);
      const y = Number(o.y || 0);
      const w = Number(o.w || 0);
      const h = Number(o.h || 0);
      x1 = x;
      y1 = y + (h > 0 ? h / 2 : 0);
      x2 = x + w;
      y2 = y + (h > 0 ? h / 2 : 0);
    }
    const minX = Math.min(x1, x2);
    const minY = Math.min(y1, y2);
    const w = Math.abs(x2 - x1);
    const h = Math.abs(y2 - y1);
    return { x1, y1, x2, y2, x: minX, y: minY, w, h };
  }

  function lineBounds(x1, y1, x2, y2) {
    return {
      x: Math.min(x1, x2),
      y: Math.min(y1, y2),
      w: Math.abs(x2 - x1),
      h: Math.abs(y2 - y1),
    };
  }

  function snapAngle(x1, y1, x2, y2, stepRad) {
    stepRad = stepRad || (Math.PI / 4);
    const dx = x2 - x1, dy = y2 - y1;
    const dist = Math.hypot(dx, dy);
    if (dist < 1e-6) return { x: Math.round(x2), y: Math.round(y2) };
    const angle = Math.atan2(dy, dx);
    const snapped = Math.round(angle / stepRad) * stepRad;
    return {
      x: Math.round(x1 + dist * Math.cos(snapped)),
      y: Math.round(y1 + dist * Math.sin(snapped)),
    };
  }

  function createLine(x1, y1, x2, y2, props) {
    const b = lineBounds(x1, y1, x2, y2);
    const uid = (global.RPE && global.RPE.store && global.RPE.store.uid)
      ? global.RPE.store.uid('o')
      : 'o_' + Math.random().toString(36).slice(2, 9);
    return Object.assign({
      id: (props && props.id) || uid,
      type: 'shape',
      shape: 'line',
      x: Math.round(b.x),
      y: Math.round(b.y),
      w: Math.round(b.w),
      h: Math.round(b.h),
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      stroke: 'accent',
      strokeWidth: 3,
      fill: null,
      color: null,
      rotation: 0,
      opacity: 1,
    }, props || {});
  }

  const shapesAPI = {
    defs,
    has,
    isAdjustable,
    strokeOnly,
    commands,
    handle,
    toD,
    fromPointer,
    isLine,
    lineGeometry,
    lineBounds,
    snapAngle,
    createLine,
  };

  const RPE = global.RPE = global.RPE || {};
  RPE.shapes = shapesAPI;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = shapesAPI;
  }
})(typeof window !== 'undefined' ? window : global);
