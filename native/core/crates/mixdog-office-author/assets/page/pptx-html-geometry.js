/** Runs inside the page: the geometry findings of slide `index`, in px of the 1920 × 1080 canvas. */
function readGeometry(index, tolerance, nearMiss) {
  const slide = document.querySelectorAll('section.slide')[index];
  view = { slide, base: slide.getBoundingClientRect(), findings: [] };
  checkDeclaredRelations(tolerance);
  const { blocks, drawn } = readBlocks();
  checkNearMisses(blocks, tolerance, nearMiss);
  checkContainment(blocks, drawn, tolerance, nearMiss);
  checkTextOnDrawings(blocks);
  checkSmallMarks(blocks, tolerance);
  return view.findings;
}

const DECLARED = ['data-on', 'data-inside', 'data-between', 'data-align', 'data-label'];
const EDGES = ['left', 'right', 'top', 'bottom', 'cx', 'cy'];
const CLEARANCE = 8;
// The edges an element visibly paints: all of them for a fill, a picture, a drawing or a full border;
// a lone border side shows its own edge and its two ends.
const SIDE_EDGES = {
  Top: ['top', 'left', 'right', 'cx'],
  Bottom: ['bottom', 'left', 'right', 'cx'],
  Left: ['left', 'top', 'bottom', 'cy'],
  Right: ['right', 'top', 'bottom', 'cy'],
};

// The slide being read, its box (the origin of every position) and the findings so far.
let view;

const r1 = (v) => Math.round(v * 10) / 10;
const rect = (x, y, w, h) => ({ type: 'box', x, y, w, h, cx: x + w / 2, cy: y + h / 2 });
const boxOf = (s) => (s.type === 'circle' ? rect(s.cx - s.r, s.cy - s.r, 2 * s.r, 2 * s.r) : s);
const area = (s) => (s.type === 'circle' ? Math.PI * s.r * s.r : s.w * s.h);

function toCanvas(el, x, y) {
  const p = new DOMPoint(x, y).matrixTransform(el.getScreenCTM());
  return { x: p.x - view.base.left, y: p.y - view.base.top };
}

function clientBox(el) {
  const r = el.getBoundingClientRect();
  return rect(r.left - view.base.left, r.top - view.base.top, r.width, r.height);
}

function painted(value) {
  const m = /rgba?\(([^)]+)\)/.exec(value || '');
  if (!m) return false;
  const parts = m[1]
    .split(/[ ,/]+/)
    .filter(Boolean)
    .map(parseFloat);
  return (parts.length > 3 ? parts[3] : 1) > 0;
}

function ownText(el) {
  return [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent.trim());
}

function label(el) {
  if (el.id) return `#${el.id}`;
  const classes = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean);
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  const shown = text.length > 14 ? `${text.slice(0, 14)}…` : text;
  const said = text ? ` "${shown}"` : '';
  return `<${el.tagName.toLowerCase()}${classes.length ? `.${classes.join('.')}` : ''}>${said}`;
}

function push(check, el, target, message, off) {
  view.findings.push({
    check,
    subject: label(el),
    ...(target ? { target: label(target) } : {}),
    off: r1(off),
    message: `${label(el)} ${message}`,
  });
}

function paintedEdges(el) {
  if (el instanceof SVGElement || el.tagName === 'IMG') return new Set(EDGES);
  const cs = getComputedStyle(el);
  if (painted(cs.backgroundColor) || cs.backgroundImage !== 'none') return new Set(EDGES);
  const sides = Object.keys(SIDE_EDGES).filter(
    (s) => parseFloat(cs[`border${s}Width`]) > 0 && cs[`border${s}Style`] !== 'none' && painted(cs[`border${s}Color`])
  );
  return new Set(sides.flatMap((s) => SIDE_EDGES[s]));
}

// What the eye reads as the element: an SVG circle by its radius, other SVG by its drawn extent, a
// round painted box as a circle, words by their glyph run, anything else by its border box.
function shape(el) {
  if (el instanceof SVGCircleElement || el instanceof SVGEllipseElement) {
    const m = el.getScreenCTM();
    const rx = (el instanceof SVGCircleElement ? el.r : el.rx).baseVal.value * Math.hypot(m.a, m.b);
    const ry = (el instanceof SVGCircleElement ? el.r : el.ry).baseVal.value * Math.hypot(m.c, m.d);
    const c = toCanvas(el, el.cx.baseVal.value, el.cy.baseVal.value);
    return Math.abs(rx - ry) < 0.5
      ? { type: 'circle', cx: c.x, cy: c.y, r: rx }
      : rect(c.x - rx, c.y - ry, 2 * rx, 2 * ry);
  }
  if (el instanceof SVGGraphicsElement) {
    const b = el.getBBox();
    const a = toCanvas(el, b.x, b.y);
    const z = toCanvas(el, b.x + b.width, b.y + b.height);
    return rect(Math.min(a.x, z.x), Math.min(a.y, z.y), Math.abs(z.x - a.x), Math.abs(z.y - a.y));
  }
  const b = clientBox(el);
  const edges = paintedEdges(el);
  const raw = getComputedStyle(el).borderTopLeftRadius.trim();
  const radius = raw.endsWith('%') ? (parseFloat(raw) / 100) * Math.min(b.w, b.h) : parseFloat(raw) || 0;
  if (edges.size === EDGES.length && Math.abs(b.w - b.h) < 1 && radius >= b.w / 2 - 0.5)
    return { type: 'circle', cx: b.cx, cy: b.cy, r: b.w / 2 };
  if (!edges.size && ownText(el)) {
    const range = document.createRange();
    range.selectNodeContents(el);
    const r = range.getBoundingClientRect();
    return rect(r.left - view.base.left, r.top - view.base.top, r.width, r.height);
  }
  return b;
}

function edge(s, name) {
  const b = boxOf(s);
  return { left: b.x, right: b.x + b.w, top: b.y, bottom: b.y + b.h, cx: b.cx, cy: b.cy }[name];
}

function ref(el, token, attribute) {
  const id = String(token || '')
    .trim()
    .replace(/^#/, '');
  const found = id ? view.slide.querySelector(`#${CSS.escape(id)}`) : null;
  if (!found) push('reference', el, null, `${attribute} names "${token || ''}", which is no element id on this slide`, 0);
  return found;
}

// Distance from a point to a target's centre line; null when the target has no line to measure.
function lineDistance(target, p) {
  if (target instanceof SVGGeometryElement) {
    const length = target.getTotalLength();
    const steps = Math.min(4000, Math.max(8, Math.ceil(length)));
    let best = Infinity;
    for (let i = 0; i <= steps; i += 1) {
      const q = target.getPointAtLength((length * i) / steps);
      const c = toCanvas(target, q.x, q.y);
      best = Math.min(best, Math.hypot(c.x - p.x, c.y - p.y));
    }
    return best;
  }
  if (target instanceof SVGElement) return null;
  const cs = getComputedStyle(target);
  if (cs.clipPath !== 'none' || cs.transform !== 'none') return null;
  const t = clientBox(target);
  return t.w >= t.h
    ? Math.abs(p.y - t.cy) + Math.max(0, t.x - p.x, p.x - (t.x + t.w))
    : Math.abs(p.x - t.cx) + Math.max(0, t.y - p.y, p.y - (t.y + t.h));
}

// How far a shape reaches outside another (≤ 0 when wholly inside).
function overflow(s, t) {
  if (t.type === 'circle') {
    if (s.type === 'circle') return Math.hypot(s.cx - t.cx, s.cy - t.cy) + s.r - t.r;
    const corners = [
      [s.x, s.y],
      [s.x + s.w, s.y],
      [s.x, s.y + s.h],
      [s.x + s.w, s.y + s.h],
    ];
    return Math.max(...corners.map(([x, y]) => Math.hypot(x - t.cx, y - t.cy))) - t.r;
  }
  const b = boxOf(s);
  return Math.max(t.x - b.x, t.y - b.y, b.x + b.w - (t.x + t.w), b.y + b.h - (t.y + t.h));
}

function centreInside(s, t) {
  return t.type === 'circle'
    ? Math.hypot(s.cx - t.cx, s.cy - t.cy) < t.r
    : s.cx > t.x && s.cx < t.x + t.w && s.cy > t.y && s.cy < t.y + t.h;
}

// A connector's miss from the centre of the gap between two separated blocks; null when they overlap.
function gapMiss(c, a, b) {
  if (a.x + a.w <= b.x || b.x + b.w <= a.x) {
    const [l, r] = a.x < b.x ? [a, b] : [b, a];
    const dx = c.cx - (l.x + l.w + r.x) / 2;
    const dy = c.cy - (l.cy + r.cy) / 2;
    return { d: Math.max(Math.abs(dx), Math.abs(dy)), dx, dy };
  }
  if (a.y + a.h <= b.y || b.y + b.h <= a.y) {
    const [t, u] = a.y < b.y ? [a, b] : [b, a];
    const dx = c.cx - (t.cx + u.cx) / 2;
    const dy = c.cy - (t.y + t.h + u.y) / 2;
    return { d: Math.max(Math.abs(dx), Math.abs(dy)), dx, dy };
  }
  return null;
}

function intersects(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function span(a0, a1, b0, b1) {
  return Math.min(a1, b1) - Math.max(a0, b0);
}

function shown(el) {
  const cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && el.getClientRects().length > 0;
}

function exempt(el) {
  return el.closest('[data-free]') || DECLARED.some((attribute) => el.hasAttribute(attribute));
}

// Declared relations.
function checkDeclaredRelations(tolerance) {
  const { slide } = view;
  for (const el of slide.querySelectorAll('[data-on]')) {
    const target = ref(el, el.dataset.on, 'data-on');
    if (!target) continue;
    const s = shape(el);
    const d = lineDistance(target, { x: s.cx, y: s.cy });
    if (d === null) {
      push(
        'on',
        el,
        target,
        `is declared on ${label(target)}, which has no centre line to measure: draw it as an SVG <line>, <polyline> or <path>`,
        0
      );
    } else if (d > tolerance) {
      push('on', el, target, `centre is ${r1(d)}px off the centre line of ${label(target)}`, d);
    }
  }
  for (const el of slide.querySelectorAll('[data-inside]')) {
    const target = ref(el, el.dataset.inside, 'data-inside');
    if (!target) continue;
    const o = overflow(shape(el), shape(target));
    if (o > tolerance) push('inside', el, target, `reaches ${r1(o)}px outside ${label(target)}`, o);
  }
  for (const el of slide.querySelectorAll('[data-between]')) {
    const [first, second] = el.dataset.between.trim().split(/\s+/);
    const a = ref(el, first, 'data-between');
    const b = ref(el, second, 'data-between');
    if (!a || !b) continue;
    const miss = gapMiss(boxOf(shape(el)), boxOf(shape(a)), boxOf(shape(b)));
    if (!miss)
      push('between', el, a, `is declared between ${label(a)} and ${label(b)}, which overlap and leave no gap`, 0);
    else if (miss.d > tolerance) {
      push(
        'between',
        el,
        a,
        `is off the centre of the gap between ${label(a)} and ${label(b)} (dx ${r1(miss.dx)}, dy ${r1(miss.dy)})`,
        miss.d
      );
    }
  }
  for (const el of slide.querySelectorAll('[data-align]')) {
    for (const part of el.dataset.align.split(',')) {
      const [name, token] = part.trim().split(/\s+/);
      if (!EDGES.includes(name)) {
        push('align', el, null, `data-align names "${name}"; the edges are ${EDGES.join(', ')}`, 0);
        continue;
      }
      const target = ref(el, token, 'data-align');
      if (!target) continue;
      const d = edge(shape(el), name) - edge(shape(target), name);
      if (Math.abs(d) > tolerance)
        push('align', el, target, `${name} is ${r1(d)}px from the ${name} of ${label(target)}`, Math.abs(d));
    }
  }
  for (const el of slide.querySelectorAll('[data-label]')) {
    const target = ref(el, el.dataset.label, 'data-label');
    if (!target) continue;
    const s = boxOf(shape(el));
    const t = shape(target);
    const dx = s.cx - t.cx;
    const dy = s.cy - t.cy;
    const d = Math.max(Math.abs(dx), Math.abs(dy));
    if (d > tolerance)
      push('label', el, target, `is off the centre of ${label(target)} (dx ${r1(dx)}, dy ${r1(dy)})`, d);
  }
}

// Undeclared: the painted blocks of the page (fills, borders, pictures, drawings), then the shapes
// drawn inside its SVGs.
function readBlocks() {
  const blocks = [];
  const drawn = [];
  for (const el of view.slide.querySelectorAll('*')) {
    if (el.closest('aside.notes') || !shown(el)) continue;
    const inSvg = el instanceof SVGElement && !(el instanceof SVGSVGElement && !el.ownerSVGElement);
    if (inSvg) {
      if (
        (el instanceof SVGCircleElement || el instanceof SVGEllipseElement || el instanceof SVGRectElement) &&
        !exempt(el)
      ) {
        const cs = getComputedStyle(el);
        if (cs.fill !== 'none' || cs.stroke !== 'none') drawn.push({ el, s: shape(el), owner: el.ownerSVGElement });
      }
      continue;
    }
    // A table is laid out as one native table; its cells are not blocks of the page.
    if (el.tagName !== 'TABLE' && el.closest('table')) continue;
    const edges = paintedEdges(el);
    if (!edges.size) continue;
    // The frame is where the element was placed (what a column lines up); the shape is what it draws.
    const frame = clientBox(el);
    if ((frame.w >= 1900 && frame.h >= 1060) || (frame.w < 4 && frame.h < 4)) continue;
    const s = shape(el);
    const b = boxOf(s);
    const cs = getComputedStyle(el);
    const turned = el instanceof HTMLElement && (cs.clipPath !== 'none' || cs.transform !== 'none');
    blocks.push({ el, s, b, frame, edges, free: exempt(el), text: Boolean((el.textContent || '').trim()), turned });
  }
  assignContainers(blocks);
  return { blocks, drawn };
}

// Each block's container: the smallest other block whose frame holds it (none on the open page).
function assignContainers(blocks) {
  const holds = (outer, inner) =>
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.w <= outer.x + outer.w + 1 &&
    inner.y + inner.h <= outer.y + outer.h + 1;
  for (const block of blocks) {
    block.container =
      blocks
        .filter(
          (other) =>
            other !== block &&
            other.frame.w * other.frame.h > block.frame.w * block.frame.h &&
            holds(other.frame, block.frame)
        )
        .sort((p, q) => p.frame.w * p.frame.h - q.frame.w * q.frame.h)[0] || null;
  }
}

// Peer blocks in one container and one column (or row) whose visible edges almost meet.
function checkNearMisses(blocks, tolerance, nearMiss) {
  for (let i = 0; i < blocks.length; i += 1) {
    for (let j = i + 1; j < blocks.length; j += 1) {
      const a = blocks[i];
      const b = blocks[j];
      if (a.free || b.free || a.container !== b.container || intersects(a.frame, b.frame)) continue;
      const column = span(a.frame.x, a.frame.x + a.frame.w, b.frame.x, b.frame.x + b.frame.w) > 0;
      const row = !column && span(a.frame.y, a.frame.y + a.frame.h, b.frame.y, b.frame.y + b.frame.h) > 0;
      if (!column && !row) continue;
      const [sa, sb] = column ? [a.frame.w, b.frame.w] : [a.frame.h, b.frame.h];
      if (Math.min(sa, sb) / Math.max(sa, sb) < 0.5) continue;
      let best = null;
      for (const name of column ? ['left', 'right', 'cx'] : ['top', 'bottom', 'cy']) {
        if (!a.edges.has(name) || !b.edges.has(name)) continue;
        const d = Math.abs(edge(a.frame, name) - edge(b.frame, name));
        if (d > tolerance && d <= nearMiss && (!best || d < best.d)) best = { name, d };
      }
      if (best) {
        const what = best.name === 'cx' || best.name === 'cy' ? 'centres' : `${best.name} edges`;
        push(
          'near_miss',
          a.el,
          b.el,
          `and ${label(b.el)} share a ${column ? 'column' : 'row'} but their ${what} are ${r1(best.d)}px apart: align them, or mark the offset data-free`,
          best.d
        );
      }
    }
  }
}

// A shape almost inside another: its centre within, a part reaching just past the edge.
function checkContainment(blocks, drawn, tolerance, nearMiss) {
  const shapes = [
    ...blocks.filter((b) => !b.free && !b.text).map((b) => ({ el: b.el, s: b.s, owner: null })),
    ...drawn,
  ];
  for (const a of shapes) {
    for (const t of shapes) {
      if (a === t || area(a.s) >= area(t.s) || a.owner === t.el || t.owner === a.el || !centreInside(a.s, t.s))
        continue;
      const o = overflow(a.s, t.s);
      if (o > tolerance && o <= nearMiss)
        push(
          'containment',
          a.el,
          t.el,
          `sits inside ${label(t.el)} but reaches ${r1(o)}px past its edge: bring it inside, or mark it data-free`,
          o
        );
    }
  }
}

// The drawings words can collide with: SVG shapes with a fill or stroke, and round painted boxes without text.
function readInks(blocks) {
  const inks = [];
  for (const root of view.slide.querySelectorAll('svg')) {
    if (root.ownerSVGElement || !shown(root)) continue;
    // A drawing the size of the page is its ground (a texture, a field), not a figure words collide with.
    const frame = clientBox(root);
    if (frame.w >= 1900 && frame.h >= 1060) continue;
    for (const el of root.querySelectorAll('path, polygon, polyline, line, circle, ellipse, rect')) {
      if (el.closest('defs, clipPath, mask, pattern, marker, symbol')) continue;
      const cs = getComputedStyle(el);
      const fill = cs.fill !== 'none' && parseFloat(cs.fillOpacity) > 0;
      const stroke = cs.stroke !== 'none' && parseFloat(cs.strokeWidth) > 0 && parseFloat(cs.strokeOpacity) > 0;
      if (!fill && !stroke) continue;
      const inverse = el.getScreenCTM().inverse();
      inks.push({
        el,
        b: boxOf(shape(el)),
        hit: (x, y) => {
          const p = new DOMPoint(x + view.base.left, y + view.base.top).matrixTransform(inverse);
          return (fill && el.isPointInFill(p)) || (stroke && el.isPointInStroke(p));
        },
      });
    }
  }
  for (const block of blocks) {
    if (block.s.type !== 'circle' || block.text) continue;
    const c = block.s;
    inks.push({ el: block.el, b: block.b, hit: (x, y) => Math.hypot(x - c.cx, y - c.cy) <= c.r });
  }
  return inks;
}

// A filled surface under the words (their own chip, or a card) painted after the drawing hides it there.
function coveredAbove(el, ink) {
  for (let node = el; node && node !== view.slide; node = node.parentElement) {
    if (
      !node.contains(ink.el) &&
      painted(getComputedStyle(node).backgroundColor) &&
      ink.el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
    )
      return true;
  }
  return false;
}

// At most 4 px apart and reaching both edges, so the outer rows of the ring are always read.
function sampleAlong(start, length) {
  const n = Math.max(1, Math.ceil((length - 1) / 4));
  return Array.from({ length: n + 1 }, (_, k) => start + 0.5 + (k * (length - 1)) / n);
}

// How much of the words' own lines lie on the drawing, and how much of the clearance ring around them.
function inkSamples(ink, lines, near) {
  let on = 0;
  let all = 0;
  let ring = 0;
  lines.forEach((line, i) => {
    const zone = near[i];
    for (const y of sampleAlong(zone.y, zone.h)) {
      for (const x of sampleAlong(zone.x, zone.w)) {
        const inside = x > line.x && x < line.x + line.w && y > line.y && y < line.y + line.h;
        const hit = ink.hit(x, y);
        if (inside) {
          all += 1;
          if (hit) on += 1;
        } else if (hit) ring += 1;
      }
    }
  });
  return { on, all, ring };
}

// Words that run partly onto a drawing: sampled across their glyph lines against the drawing's own fill
// and stroke (SVG shapes, and round painted boxes). Words wholly on a shape are its label, wholly off it
// its neighbour; a part on and a part off is a collision.
function checkTextOnDrawings(blocks) {
  const inks = readInks(blocks);
  if (!inks.length) return;
  for (const el of view.slide.querySelectorAll('*')) {
    if (el instanceof SVGElement || el.closest('aside.notes, [data-free]') || !ownText(el) || !shown(el)) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = [...range.getClientRects()]
      .map((r) => rect(r.left - view.base.left, r.top - view.base.top, r.width, r.height))
      .filter((r) => r.w > 1 && r.h > 1);
    const near = lines.map((line) =>
      rect(line.x - CLEARANCE, line.y - CLEARANCE, line.w + 2 * CLEARANCE, line.h + 2 * CLEARANCE)
    );
    for (const ink of inks) {
      if (ink.el === el || el.contains(ink.el) || !near.some((zone) => intersects(zone, ink.b)) || coveredAbove(el, ink))
        continue;
      const { on, all, ring } = inkSamples(ink, lines, near);
      const share = all ? on / all : 0;
      if (share >= 0.98) continue;
      if (share > 0.02) {
        push(
          'text_on_drawing',
          el,
          ink.el,
          `runs partly onto ${label(ink.el)} (${Math.round(share * 100)}% of its words on the drawing): set it wholly on the shape or clear of it by ${CLEARANCE}px`,
          share * 100
        );
        break;
      }
      // A small mark beside its words (a bracket, a pin) is theirs; only a drawing well larger than the words
      // is a surface they must keep clear of.
      const wordsArea = lines.reduce((sum, line) => sum + line.w * line.h, 0);
      if (ring && ink.b.w * ink.b.h >= 4 * wordsArea) {
        push(
          'text_on_drawing',
          el,
          ink.el,
          `comes within ${CLEARANCE}px of ${label(ink.el)}: clear it by ${CLEARANCE}px or set it on the shape`,
          0
        );
        break;
      }
    }
  }
}

// The long thin or turned block a marker of at most 64 px sits on, if any.
function markerHost(c, blocks) {
  if (Math.max(c.b.w, c.b.h) > 64) return null;
  return blocks.find(
    (b) =>
      b !== c &&
      intersects(b.b, c.b) &&
      (b.turned ||
        b.el instanceof SVGSVGElement ||
        Math.max(b.b.w, b.b.h) / Math.max(1, Math.min(b.b.w, b.b.h)) >= 6)
  );
}

// The two blocks a connector in open space stands between (left and right, or above and below), if it has both.
function connectorPair(c, blocks, tolerance) {
  const neighbours = blocks.filter(
    (b) =>
      b !== c &&
      !intersects(b.b, c.b) &&
      b.edges.size === EDGES.length &&
      Math.min(b.b.w, b.b.h) >= 60 &&
      b.b.w * b.b.h >= 4 * c.b.w * c.b.h
  );
  const beside = (b) => span(b.b.y, b.b.y + b.b.h, c.b.y, c.b.y + c.b.h) > 0;
  const stacked = (b) => span(b.b.x, b.b.x + b.b.w, c.b.x, c.b.x + c.b.w) > 0;
  const nearest = (list, key, pick) => list.sort((p, q) => pick * (key(q) - key(p)))[0];
  const left = nearest(
    neighbours.filter((b) => beside(b) && b.b.x + b.b.w <= c.b.x + tolerance),
    (b) => b.b.x + b.b.w,
    1
  );
  const right = nearest(
    neighbours.filter((b) => beside(b) && b.b.x >= c.b.x + c.b.w - tolerance),
    (b) => b.b.x,
    -1
  );
  const above = nearest(
    neighbours.filter((b) => stacked(b) && b.b.y + b.b.h <= c.b.y + tolerance),
    (b) => b.b.y + b.b.h,
    1
  );
  const below = nearest(
    neighbours.filter((b) => stacked(b) && b.b.y >= c.b.y + c.b.h - tolerance),
    (b) => b.b.y,
    -1
  );
  if (left && right) return [left, right];
  if (above && below) return [above, below];
  return null;
}

// Small connectors and markers: no text, at most 240 px (a marker at most 64 px).
function checkSmallMarks(blocks, tolerance) {
  for (const c of blocks) {
    if (c.free || c.text || Math.max(c.b.w, c.b.h) > 240) continue;
    const host = markerHost(c, blocks);
    if (host) {
      push(
        'marker',
        c.el,
        host.el,
        `sits on ${label(host.el)} with no declared relation: declare data-on (an SVG line or path) or data-inside, or mark it data-free`,
        0
      );
      continue;
    }
    // A connector stands in open space; a glyph inside a card belongs to the card.
    if (blocks.some((b) => b !== c && intersects(b.b, c.b))) continue;
    const pair = connectorPair(c, blocks, tolerance);
    if (!pair) continue;
    const [a, b] = pair;
    const miss = gapMiss(c.b, a.b, b.b);
    if (miss && miss.d > tolerance) {
      push(
        'connector',
        c.el,
        a.el,
        `sits between ${label(a.el)} and ${label(b.el)} but off the centre of their gap (dx ${r1(miss.dx)}, dy ${r1(miss.dy)}): centre it, declare data-between, or mark it data-free`,
        miss.d
      );
    }
  }
}