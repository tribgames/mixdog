// Slide roles read from the saved shapes of an authored deck (no composer plan).
// The render review judges density per role: a diagram slide draws its evidence
// as native shapes — tinted fields, hairlines, braces, arcs — that the rendered
// foreground sampler (channel distance ≥ 28 from the background) barely sees,
// so it is judged by the field its shapes cover, not by the ink they leave.
import { isMotifShape } from '../design/design-discipline.mjs';

const DEFAULT_SLIDE = Object.freeze({ width: 960, height: 540 });
const DIAGRAM_MIN_SHAPES = 3;
const DIAGRAM_MIN_FIELD_SHARE = 0.25;

// A line has one zero extent; it still spans the field.
function hasBox(shape) {
  return Number(shape?.width) > 0 || Number(shape?.height) > 0;
}

function box(shape) {
  const left = Number(shape.left) || 0;
  const top = Number(shape.top) || 0;
  return { left, top, right: left + (Number(shape.width) || 0), bottom: top + (Number(shape.height) || 0) };
}

function spansOverlap(aStart, aEnd, bStart, bEnd) {
  return aStart <= bEnd && bStart <= aEnd;
}

// A text box registered to a diagram shape (sharing its row or its column) is
// part of the diagram: the label beside a brace, the caption under a node.
function isRegisteredText(shape, anchors) {
  const own = box(shape);
  return anchors.some((anchor) => spansOverlap(own.top, own.bottom, anchor.top, anchor.bottom)
    || spansOverlap(own.left, own.right, anchor.left, anchor.right));
}

// A diagram shape is a connector, a preset geometry that is not a plain text
// rectangle, or a rectangle with a surface fill (a field, a plane, a lane).
export function isPptxDiagramShape(shape) {
  if (!shape || shape.placeholder || isMotifShape(shape)) return false;
  if (shape.type === 'p:cxnSp') return true;
  if (shape.type !== 'p:sp' || !shape.geometry) return false;
  if (shape.geometry === 'rect') return Boolean(shape.fill?.color);
  return true;
}

// count: the drawn shapes; fieldShare: the union box of those shapes and the
// text registered to them (the slide's title — its largest type — excluded),
// as a share of the canvas.
export function pptxDiagramCoverage(slide, size = DEFAULT_SLIDE) {
  const all = (Array.isArray(slide?.shapes) ? slide.shapes : []).filter((shape) => hasBox(shape) && !shape.placeholder && !isMotifShape(shape));
  const drawn = all.filter(isPptxDiagramShape);
  if (!drawn.length) return { count: 0, fieldShare: 0 };
  const anchors = drawn.map(box);
  const largestType = Math.max(0, ...all.map((shape) => Number(shape.font?.size) || 0));
  const registered = all.filter((shape) => !drawn.includes(shape)
    && String(shape.text || '').trim()
    && (Number(shape.font?.size) || 0) < largestType
    && isRegisteredText(shape, anchors));
  const boxes = [...anchors, ...registered.map(box)];
  const left = Math.min(...boxes.map((entry) => entry.left));
  const top = Math.min(...boxes.map((entry) => entry.top));
  const right = Math.max(...boxes.map((entry) => entry.right));
  const bottom = Math.max(...boxes.map((entry) => entry.bottom));
  const canvas = Math.max(1, (Number(size?.width) || DEFAULT_SLIDE.width) * (Number(size?.height) || DEFAULT_SLIDE.height));
  const fieldShare = Math.max(0, right - left) * Math.max(0, bottom - top) / canvas;
  return { count: drawn.length, fieldShare: Number(fieldShare.toFixed(4)) };
}

const PICTURE_MIN_SHARE = 0.25;

// The share of the canvas under pictures (each frame's own area; overlaps count twice, which only helps a stack).
export function pptxPictureShare(slide, size = DEFAULT_SLIDE) {
  const canvas = Math.max(1, (Number(size?.width) || DEFAULT_SLIDE.width) * (Number(size?.height) || DEFAULT_SLIDE.height));
  const area = (Array.isArray(slide?.shapes) ? slide.shapes : [])
    .filter((shape) => shape?.type === 'p:pic' && Number(shape.width) > 0 && Number(shape.height) > 0)
    .reduce((total, shape) => total + Number(shape.width) * Number(shape.height), 0);
  return Number(Math.min(1, area / canvas).toFixed(4));
}

// A picture slide: pictures cover a quarter of the canvas or more.
export function isPptxPictureSlide(slide, size = DEFAULT_SLIDE) {
  return pptxPictureShare(slide, size) >= PICTURE_MIN_SHARE;
}

// Three or more drawn shapes whose field (with the text registered to them) covers a quarter of the slide.
export function isPptxDiagramSlide(slide, size = DEFAULT_SLIDE) {
  const coverage = pptxDiagramCoverage(slide, size);
  return coverage.count >= DIAGRAM_MIN_SHAPES && coverage.fieldShare >= DIAGRAM_MIN_FIELD_SHARE;
}

// A statement slide carries one thesis, quote, or number and air. Composer
// plans say so through slideRole; an authored deck has no plan, so the same
// criterion is read from the saved shapes and shared with the render review.
export function isPptxStatementSlide(slide) {
  const textShapes = (Array.isArray(slide?.shapes) ? slide.shapes : [])
    .filter((shape) => String(shape.text || '').trim() && !isMotifShape(shape) && !shape.placeholder);
  if (!textShapes.length || textShapes.length > 5) return false;
  const sizes = textShapes.map((shape) => Number(shape.font?.size) || 0);
  const largest = Math.max(...sizes);
  const totalText = textShapes.reduce((total, shape) => total + String(shape.text || '').length, 0);
  return largest >= 42
    || sizes.filter((size) => size >= 34).length >= 2
    || (largest >= 24 && totalText <= 280);
}

// A specimen draws its subject: three or more text blocks sharing one left edge,
// each a different size/weight step, with the largest at 24 pt or more.
export function isPptxSpecimenSlide(textShapes) {
  const columns = new Map();
  for (const shape of textShapes) {
    const key = Math.round((Number(shape.left) || 0) / 12);
    const step = `${Number(shape.font?.size) || 0}|${shape.font?.bold === true ? 1 : 0}|${String(shape.font?.name || '')}`;
    if (!columns.has(key)) columns.set(key, { steps: new Set(), largest: 0 });
    const column = columns.get(key);
    column.steps.add(step);
    column.largest = Math.max(column.largest, Number(shape.font?.size) || 0);
  }
  return [...columns.values()].some((column) => column.steps.size >= 3 && column.largest >= 24);
}

// The roles the render review must know before it judges density: a diagram
// is dense in shapes the sampler barely sees, a picture slide is all frame, a
// statement beat is sparse on purpose. Drawn evidence wins over the statement
// reading: a slide whose shapes or pictures fill a quarter of the canvas is
// not one thesis and air, however few words it carries.
export function inferPptxSlideRoles(document) {
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const size = { width: Number(document?.slideWidth) || 0, height: Number(document?.slideHeight) || 0 };
  const roles = {};
  for (const slide of slides) {
    if (!(Number(slide?.index) > 0)) continue;
    if (isPptxDiagramSlide(slide, size)) roles[Number(slide.index)] = { visualType: 'diagram' };
    else if (isPptxPictureSlide(slide, size)) roles[Number(slide.index)] = { visualType: 'picture' };
    else if (isPptxStatementSlide(slide)) roles[Number(slide.index)] = { slideRole: 'statement' };
  }
  return roles;
}
