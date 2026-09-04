// The composition receipt: what each saved slide actually carries, read from
// the snapshot after a script authored the deck, and handed back beside the
// render. It is information, never a gate — the author compares it with the
// plan line and answers a deck-wide zero or a contradicted promise with a
// reason or a fix (pptx skill §2 step 7). Counts are not quotas.

import { plannedCarrierGaps } from './pptx-brief.mjs';

// Rectangles and lines are furniture; every other preset is a contour the
// author reached for on purpose (a chevron, a brace, an arc, a trapezoid).
const FURNITURE = new Set(['rect', 'line', 'straightConnector1']);
const CANVAS_AREA = 960 * 540;   // 13.33 × 7.5 in, in points

function luminance(hex) {
  const value = String(hex || '').replace('#', '');
  if (!/^[0-9A-Fa-f]{6}$/.test(value)) return null;
  const channel = (i) => {
    const v = parseInt(value.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function backgroundRole(slide) {
  const l = luminance(slide?.background?.color);
  if (l === null) return '';
  return l < 0.2 ? 'dark' : l > 0.6 ? 'light' : 'mid';
}

function isPicture(shape) {
  return shape?.type === 'p:pic' || Number(shape?.type) === 13;
}

// The surface color of a shape: the portable snapshot's hex, or the COM
// snapshot's BGR long when the fill is visible and not fully transparent.
function surfaceColor(shape) {
  const hex = String(shape?.fill?.color || '').toUpperCase();
  if (/^[0-9A-F]{6}$/.test(hex)) return hex;
  if (shape?.fillVisible === false || Number(shape?.fillTransparency) >= 1) return '';
  const rgb = Number(shape?.fillColor);
  if (!Number.isFinite(rgb) || rgb < 0 || shape?.fillVisible !== true) return '';
  const part = (value) => Math.round(value).toString(16).padStart(2, '0').toUpperCase();
  return `${part(rgb % 256)}${part(Math.floor(rgb / 256) % 256)}${part(Math.floor(rgb / 65536) % 256)}`;
}

// --- Observations: what a designer would read off the canvas, as numbers. ---
// Air, quadrant air, the largest object's share, the visual footprint, text
// left edges, fill areas, and where the title sits. Read from shape footprints
// on a 5 pt raster; no threshold turns any of them into a verdict.
const CANVAS_W = 960;
const CANVAS_H = 540;
const CELL = 5;

function footprint(shape) {
  const left = Number(shape?.left), top = Number(shape?.top), width = Number(shape?.width), height = Number(shape?.height);
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return null;
  return { left, top, width, height };
}

function raster(shapes) {
  const cols = Math.ceil(CANVAS_W / CELL), rows = Math.ceil(CANVAS_H / CELL);
  const cells = new Uint8Array(cols * rows);
  for (const box of shapes) {
    const x0 = Math.max(0, Math.floor(box.left / CELL)), x1 = Math.min(cols, Math.ceil((box.left + box.width) / CELL));
    const y0 = Math.max(0, Math.floor(box.top / CELL)), y1 = Math.min(rows, Math.ceil((box.top + box.height) / CELL));
    for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) cells[y * cols + x] = 1;
  }
  return { cells, cols, rows };
}

function airOf({ cells, cols, rows }, x0 = 0, y0 = 0, x1 = cols, y1 = rows) {
  let covered = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) covered += cells[y * cols + x];
  const total = (x1 - x0) * (y1 - y0);
  return total ? Number((1 - covered / total).toFixed(2)) : 1;
}

// Values within `tolerance` pt of their predecessor form one cluster.
function clusters(values, tolerance = 6) {
  const out = [];
  for (const value of [...values].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && value - last.at(-1) <= tolerance) last.push(value);
    else out.push([value]);
  }
  return out;
}

// Text boxes sharing a left edge (within 6 pt) form one column; a text box no other box aligns with is stray.
// Right edges are read the same way: a box whose left edge shares a column but whose right edge shares
// nothing is a width that drifted (a title 0.2 in wider than the prose under it) — the reader sees a ragged column.
function leftEdges(textBoxes) {
  const lefts = clusters(textBoxes.map((box) => box.left));
  const rights = clusters(textBoxes.map((box) => box.left + box.width));
  return {
    columns: lefts.length,
    stray: lefts.filter((cluster) => cluster.length === 1).length,
    rightEdges: rights.length,
    rightStray: rights.filter((cluster) => cluster.length === 1).length,
  };
}

// Vertical gaps: for every box, the space to the nearest box below it that overlaps it horizontally,
// in inches rounded to 0.05, when the two do not touch and sit within 1.5 in. The distinct values are
// the slide's spacing vocabulary — a deck with two spacing steps reads as two values, a hand-spaced
// deck as a spread of them (composition.md §6). Numbers only; the plan line decides what a gap means.
function verticalGaps(boxes) {
  const values = [];
  for (const box of boxes) {
    const bottom = box.top + box.height;
    let nearest = null;
    for (const other of boxes) {
      if (other === box || other.top < bottom - 1) continue;
      const overlap = Math.min(box.left + box.width, other.left + other.width) - Math.max(box.left, other.left);
      if (overlap <= 0) continue;
      if (!nearest || other.top < nearest.top) nearest = other;
    }
    if (!nearest) continue;
    const gap = (nearest.top - bottom) / 72;
    if (gap > 0.01 && gap <= 1.5) values.push(Number((Math.round(gap / 0.05) * 0.05).toFixed(2)));
  }
  return [...new Set(values)].sort((a, b) => a - b);
}

const bgrHex = (rgb) => {
  const part = (value) => Math.round(value).toString(16).padStart(2, '0').toUpperCase();
  return `${part(rgb % 256)}${part(Math.floor(rgb / 256) % 256)}${part(Math.floor(rgb / 65536) % 256)}`;
};
const asList = (value) => (value == null ? [] : [].concat(value));

// The text colors of a shape: the portable snapshot's run colors minus the shape's own surface,
// or the COM run colors (BGR longs; a mixed range reports a negative sentinel, which is skipped).
function textColorsOf(shape) {
  const surface = surfaceColor(shape);
  const listed = asList(shape?.colors).map((c) => String(c).toUpperCase()).filter((c) => /^[0-9A-F]{6}$/.test(c) && c !== surface);
  if (listed.length) return listed;
  const longs = asList(shape?.runs?.colors).map(Number);
  const source = longs.length ? longs : [Number(shape?.font?.color)];
  return [...new Set(source.filter((rgb) => Number.isFinite(rgb) && rgb >= 0).map(bgrHex))];
}

// The type sizes of a shape: every run size the portable or COM snapshot lists, else the box's font size.
function typeSizesOf(shape) {
  const listed = [...asList(shape?.sizes), ...asList(shape?.runs?.sizes)].map(Number).filter((s) => s > 0);
  if (listed.length) return [...new Set(listed)];
  const size = Number(shape?.font?.size);
  return size > 0 ? [size] : [];
}

// Page chrome (a slide-number placeholder from the master) is not the author's type or color.
const isChrome = (shape) => Boolean(shape?.placeholder) || Number(shape?.type) === 14;

// Visual centroid: the area-weighted center of every shape that is not a canvas-wide surface,
// in canvas units [0, 1]; offset is its ellipse-normalized distance from the canvas center with
// a horizontal tolerance of 0.05 and a vertical one of 0.15 (a sideways drift reads first, as in
// AeSlides' imbalance metric). Both are numbers the author weighs; a breathing slide may sit off center on purpose.
function centroidOf(boxes) {
  let area = 0, sx = 0, sy = 0;
  for (const box of boxes) {
    const a = box.width * box.height;
    if (a >= CANVAS_W * CANVAS_H * 0.9) continue;
    area += a;
    sx += a * (box.left + box.width / 2);
    sy += a * (box.top + box.height / 2);
  }
  if (!area) return null;
  const x = sx / area / CANVAS_W, y = sy / area / CANVAS_H;
  const offset = Math.sqrt(((x - 0.5) / 0.05) ** 2 + ((y - 0.5) / 0.15) ** 2);
  return { centroid: [Number(x.toFixed(2)), Number(y.toFixed(2))], centroidOffset: Number(offset.toFixed(1)) };
}

// Body top: the top edge (inches) of the first element below the largest type — where the page's
// content zone begins. Read across the deck it shows whether content slides share one body top.
// Body fill: how much of the zone under the title (down to the lower safe margin) the content spans,
// as a share — a dense slide whose content stops halfway reads as a hollow; a breathing slide is meant to.
function bodyTopOf(boxes, titleBox) {
  if (!titleBox) return { bodyTop: null, bodyFill: null };
  const titleBottom = titleBox.top + titleBox.height;
  const below = boxes.filter((box) => box !== titleBox && box.top >= titleBottom - 2 && box.width * box.height < CANVAS_W * CANVAS_H * 0.9);
  if (!below.length) return { bodyTop: null, bodyFill: null };
  const top = Math.min(...below.map((box) => box.top)), bottom = Math.max(...below.map((box) => box.top + box.height));
  const zone = CANVAS_H - 0.5 * 72 - top;
  return { bodyTop: Number((top / 72).toFixed(2)), bodyFill: zone > 0 ? Number(Math.min(1, (bottom - top) / zone).toFixed(2)) : null };
}

function observe(shapes, { textBoxes, visuals, content, blocks, fills, titleBox }) {
  const boxes = shapes.map(footprint).filter(Boolean);
  if (!boxes.length) return null;
  const authored = shapes.filter((shape) => !isChrome(shape));
  const typeSet = [...new Set(authored.flatMap(typeSizesOf))].sort((a, b) => a - b);
  const textColors = [...new Set(authored.filter((shape) => String(shape.text || '').trim()).flatMap(textColorsOf))];
  const all = raster(boxes);
  const centroid = centroidOf(boxes);
  // Body top and gaps read the content (text, charts, tables, pictures, contours), never a surface field or a rule.
  const { bodyTop, bodyFill } = bodyTopOf(content, titleBox ? content.find((box) => box.left === titleBox.left && box.top === titleBox.top && box.width === titleBox.width) || titleBox : null);
  const midX = Math.floor(all.cols / 2), midY = Math.floor(all.rows / 2);
  const canvas = CANVAS_W * CANVAS_H;
  const fillShares = [...fills.entries()].map(([color, area]) => ({ color, share: Number((area / canvas).toFixed(2)) }))
    .filter((entry) => entry.share > 0).sort((a, b) => b.share - a.share).slice(0, 3);
  return {
    air: airOf(all),
    quadrantAir: [airOf(all, 0, 0, midX, midY), airOf(all, midX, 0, all.cols, midY), airOf(all, 0, midY, midX, all.rows), airOf(all, midX, midY, all.cols, all.rows)],
    largestShare: Number((Math.max(...boxes.map((box) => box.width * box.height)) / canvas).toFixed(2)),
    visualShare: visuals.length ? Number((1 - airOf(raster(visuals))).toFixed(2)) : 0,
    textColumns: leftEdges(textBoxes),
    fills: fillShares,
    largestTextTop: titleBox ? Number((titleBox.top / 72).toFixed(2)) : null,
    bodyTop,
    bodyFill,
    ...(centroid || {}),
    gaps: verticalGaps(blocks),
    typeSet,
    textColors,
  };
}

export function slideReceipt(slide) {
  const shapes = Array.isArray(slide?.shapes) ? slide.shapes : [];
  const receipt = {
    slide: Number(slide?.index) || 0,
    background: backgroundRole(slide),
    charts: 0, tables: 0, pictures: 0, groups: 0,
    textBoxes: 0, drawn: 0, fields: 0, lines: 0,
    presets: [],
    largestText: 0,
    coverage: 0,
  };
  let covered = 0;
  const presets = new Set();
  const textBoxes = [];
  const visuals = [];
  const content = [];   // what the reader reads as content: text, data, pictures, contours — not fields, lines, or chrome
  const blocks = [];    // the spacing vocabulary's units: text and data blocks (a contour is part of a device, not a block)
  const fills = new Map();
  let titleBox = null;
  const seen = [];
  for (const shape of shapes) {
    if (shape.placeholder && !String(shape.text || '').trim()) continue;
    seen.push(shape);
    const area = (Number(shape.width) || 0) * (Number(shape.height) || 0);
    const box = footprint(shape);
    const fill = surfaceColor(shape);
    if (fill && box) fills.set(fill, (fills.get(fill) || 0) + area);
    if (shape.chart) { receipt.charts += 1; covered += area; if (box) { visuals.push(box); content.push(box); blocks.push(box); } continue; }
    if (shape.table) { receipt.tables += 1; covered += area; if (box) { visuals.push(box); content.push(box); blocks.push(box); } continue; }
    if (isPicture(shape)) { receipt.pictures += 1; covered += area; if (box) { visuals.push(box); content.push(box); blocks.push(box); } continue; }
    if (shape.group) { receipt.groups += 1; covered += area; if (box) { visuals.push(box); content.push(box); blocks.push(box); } continue; }
    const hasText = Boolean(String(shape.text || '').trim());
    if (hasText) {
      receipt.textBoxes += 1;
      const size = Number(shape.font?.size) || 0;
      if (size > receipt.largestText) { receipt.largestText = size; titleBox = box; }
      if (box) { textBoxes.push(box); if (!isChrome(shape)) { content.push(box); blocks.push(box); } }
      covered += area;
      continue;
    }
    receipt.drawn += 1;
    if (box) visuals.push(box);
    const geometry = String(shape.geometry || '');
    if (geometry === 'line' || geometry.includes('Connector')) receipt.lines += 1;
    else if (geometry === 'rect' || geometry === 'roundRect') { receipt.fields += 1; covered += area; }
    else if (geometry) { presets.add(geometry); covered += area; if (box) content.push(box); }
  }
  receipt.presets = [...presets];
  receipt.coverage = Math.min(1, Number((covered / CANVAS_AREA).toFixed(2)));
  const observed = observe(seen, { textBoxes, visuals, content, blocks, fills, titleBox });
  if (observed) receipt.observe = observed;
  return receipt;
}

// The whole deck: per-slide receipts, totals, the families that never appear,
// and the plan lines whose named carriers the snapshot cannot see.
export function compositionReceipt(document, brief = null) {
  const slides = (Array.isArray(document?.slides) ? document.slides : []).map(slideReceipt);
  const deck = {
    slides: slides.length,
    charts: 0, tables: 0, pictures: 0, presets: 0, fields: 0, lines: 0, groups: 0,
    backgrounds: [...new Set(slides.map((s) => s.background).filter(Boolean))],
    textOnly: 0,
  };
  for (const s of slides) {
    deck.charts += s.charts; deck.tables += s.tables; deck.pictures += s.pictures;
    deck.presets += s.presets.length; deck.fields += s.fields; deck.lines += s.lines; deck.groups += s.groups;
    if (s.textBoxes && !s.charts && !s.tables && !s.pictures && !s.drawn && !s.groups) deck.textOnly += 1;
  }
  const absent = ['charts', 'tables', 'pictures', 'presets', 'fields', 'lines']
    .filter((family) => deck[family] === 0);
  // The deck read as a sequence: air per slide is the density rhythm, title tops the composition variety.
  const observed = slides.filter((s) => s.observe);
  if (observed.length) {
    deck.rhythm = {
      air: observed.map((s) => s.observe.air),
      largestTextTops: observed.map((s) => s.observe.largestTextTop),
      centroidX: observed.map((s) => s.observe.centroid?.[0] ?? null),
      bodyTops: observed.map((s) => s.observe.bodyTop ?? null),
      bodyFills: observed.map((s) => s.observe.bodyFill ?? null),
      gapSet: [...new Set(observed.flatMap((s) => s.observe.gaps || []))].sort((a, b) => a - b),
      typeSet: [...new Set(observed.flatMap((s) => s.observe.typeSet || []))].sort((a, b) => a - b),
      textColors: [...new Set(observed.flatMap((s) => s.observe.textColors || []))],
      rightStray: observed.map((s) => s.observe.textColumns?.rightStray ?? 0),
    };
  }
  const gaps = brief ? plannedCarrierGaps(document, brief) : [];
  for (const gap of gaps) {
    const target = slides.find((s) => s.slide === gap.slide);
    if (target) target.missing = [...(target.missing || []), gap.carrier];
  }
  return {
    slides,
    deck,
    absent,
    note: (absent.length || gaps.length
      ? 'Information, not a verdict: a family the whole deck never uses, or a plan line whose carrier the saved slide does not show, gets one line of reason or a fix in the script.'
      : 'Every plan line\'s carriers are visible on its slide.')
      + ' observe: air = canvas share with no shape footprint; quadrantAir = [top-left, top-right, bottom-left, bottom-right]; largestShare = the biggest object; visualShare = non-text footprint; textColumns = distinct text left edges and stray boxes; fills = surface colors by area; largestTextTop = inches from the top to the biggest type (the title, or a hero numeral); centroid = [x, y] of the area-weighted visual center in canvas units (0.5, 0.5 is dead center), centroidOffset = its distance from center with a 0.05 horizontal / 0.15 vertical tolerance (1 = at the tolerance edge); bodyTop = inches from the top to the first element under the largest type (content slides of one deck share it unless the plan says otherwise); bodyFill = the share of the zone under the title (to the lower safe margin) that the content spans (a dense page near 1, a breathing page low on purpose); renderAir (after a render) = share of the rendered page with no local pixel variation, which counts the flat part of a picture or a field as air where the shape footprint cannot; gaps = the distinct vertical gaps (inches, 0.05 steps) between stacked neighbors, the slide\'s spacing vocabulary; typeSet = the distinct type sizes; textColors = the distinct text colors; textColumns.rightStray = text boxes whose right edge aligns with no other. deck.rhythm reads them in sequence and unions gapSet, typeSet, and textColors across the deck: a deck built on two spacing steps, one type scale, and one ladder shows short sets.',
  };
}

// The rendered page, read after the fact: renderAir per slide joins the shape-based observation so
// the two readings can be compared (a picture-heavy slide shows a low shape air and a high render air).
export function attachRenderedAir(receipt, airByPage) {
  if (!receipt?.slides?.length || !airByPage?.size) return receipt;
  const sequence = [];
  for (const slide of receipt.slides) {
    const air = airByPage.get(slide.slide);
    if (typeof air === 'number') {
      slide.observe = { ...(slide.observe || {}), renderAir: air };
      sequence.push(air);
    } else sequence.push(null);
  }
  if (receipt.deck) receipt.deck.rhythm = { ...(receipt.deck.rhythm || {}), renderAir: sequence };
  return receipt;
}
