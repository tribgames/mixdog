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

// Text boxes sharing a left edge (within 6 pt) form one column; a text box no other box aligns with is stray.
function leftEdges(textBoxes) {
  const lefts = textBoxes.map((box) => box.left).sort((a, b) => a - b);
  const clusters = [];
  for (const left of lefts) {
    const last = clusters[clusters.length - 1];
    if (last && left - last.at(-1) <= 6) last.push(left);
    else clusters.push([left]);
  }
  return { columns: clusters.length, stray: clusters.filter((cluster) => cluster.length === 1).length };
}

function observe(shapes, { textBoxes, visuals, fills, titleBox }) {
  const boxes = shapes.map(footprint).filter(Boolean);
  if (!boxes.length) return null;
  const all = raster(boxes);
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
    if (shape.chart) { receipt.charts += 1; covered += area; if (box) visuals.push(box); continue; }
    if (shape.table) { receipt.tables += 1; covered += area; if (box) visuals.push(box); continue; }
    if (isPicture(shape)) { receipt.pictures += 1; covered += area; if (box) visuals.push(box); continue; }
    if (shape.group) { receipt.groups += 1; covered += area; if (box) visuals.push(box); continue; }
    const hasText = Boolean(String(shape.text || '').trim());
    if (hasText) {
      receipt.textBoxes += 1;
      const size = Number(shape.font?.size) || 0;
      if (size > receipt.largestText) { receipt.largestText = size; titleBox = box; }
      if (box) textBoxes.push(box);
      covered += area;
      continue;
    }
    receipt.drawn += 1;
    if (box) visuals.push(box);
    const geometry = String(shape.geometry || '');
    if (geometry === 'line' || geometry.includes('Connector')) receipt.lines += 1;
    else if (geometry === 'rect' || geometry === 'roundRect') { receipt.fields += 1; covered += area; }
    else if (geometry) { presets.add(geometry); covered += area; }
  }
  receipt.presets = [...presets];
  receipt.coverage = Math.min(1, Number((covered / CANVAS_AREA).toFixed(2)));
  const observed = observe(seen, { textBoxes, visuals, fills, titleBox });
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
    deck.rhythm = { air: observed.map((s) => s.observe.air), largestTextTops: observed.map((s) => s.observe.largestTextTop) };
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
      + ' observe: air = canvas share with no shape footprint; quadrantAir = [top-left, top-right, bottom-left, bottom-right]; largestShare = the biggest object; visualShare = non-text footprint; textColumns = distinct text left edges and stray boxes; fills = surface colors by area; largestTextTop = inches from the top to the biggest type (the title, or a hero numeral). deck.rhythm reads them in sequence.',
  };
}
