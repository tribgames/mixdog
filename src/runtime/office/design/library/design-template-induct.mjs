import { inferPptxSampleKind } from './design-template-inspect.mjs';
import { isPictureShape } from '../design-discipline.mjs';

// A deck someone brings was drawn, not filled in: its pages carry plain text
// boxes instead of {{TOKEN}} slots or layout placeholders, so the token and
// placeholder rules find no title on them and never a column or a step. What
// such a page does show is its geometry — the box set in the loudest type is
// the title, a row of equally sized boxes reads as columns, a number above its
// caption reads as a metric, and a row of arrows reads as steps. Those roles
// are induced here so a page the user already owns can be chosen by what it
// carries and filled slot by slot.

const WIDE_CANVAS = Object.freeze({ width: 12_192_000, height: 6_858_000 });
// A row is peers when the boxes sit on one band at one height; the tolerances
// are shares of the members themselves, so they hold at any slide scale.
const ROW_TOP_TOLERANCE = 0.34;
const PEER_HEIGHT_TOLERANCE = 0.06;
const COLUMN_ALIGN_TOLERANCE = 0.12;
const PAIR_GAP_TOLERANCE = 1.5;
// The title leads the page's other type by a clear step; without that lead the
// page has no single loudest voice and no title is claimed.
const TITLE_SIZE_LEAD = 1.15;
const TITLE_MAX_CHARS = 140;
// A full-bleed rectangle is the page's surface, not one of its objects.
const BACKGROUND_AREA_SHARE = 0.7;
const STEP_PRESETS = new Set(['chevron', 'homePlate', 'rightArrow', 'pentagon', 'arrow']);
// A metric reads as a figure and its unit, never as a sentence.
const VALUE_TEXT = /^[+\-−]?[₩$€£¥]?\d[\d.,]*\s*[%a-zA-Z가-힣]{0,6}$/;

function area(shape) {
  return Math.max(0, Number(shape?.geometry?.width) || 0) * Math.max(0, Number(shape?.geometry?.height) || 0);
}

function drawable(shape, canvas) {
  const size = area(shape);
  if (!size) return false;
  const page = Math.max(1, canvas.width * canvas.height);
  return size < page * BACKGROUND_AREA_SHARE;
}

// The band is a share of the shorter box, so a 26pt caption does not join the
// 170pt card it sits inside. Width is free: a chevron flow and a two-panel page
// both size their boxes to the words they carry, and demanding equal widths
// read a four-step flow as three columns with one step missing.
function sharesRow(left, right) {
  const shorter = Math.min(left.geometry.height, right.geometry.height);
  const taller = Math.max(left.geometry.height, right.geometry.height);
  return (
    Math.abs(left.geometry.top - right.geometry.top) <= shorter * ROW_TOP_TOLERANCE &&
    Math.abs(left.geometry.height - right.geometry.height) <= taller * PEER_HEIGHT_TOLERANCE
  );
}

function rowBands(shapes) {
  const rows = [];
  const ordered = [...shapes].sort(
    (left, right) => left.geometry.top - right.geometry.top || left.geometry.left - right.geometry.left
  );
  for (const shape of ordered) {
    const row = rows.find((members) => sharesRow(members[0], shape));
    if (row) row.push(shape);
    else rows.push([shape]);
  }
  return rows
    .filter((members) => members.length >= 2)
    .map((members) => members.sort((left, right) => left.geometry.left - right.geometry.left));
}

// The caption row sits directly under its values and shares their left edges;
// anything further down belongs to another band of the page.
function pairsWith(top, bottom) {
  if (top.length !== bottom.length) return false;
  const lead = top[0].geometry;
  const gap = bottom[0].geometry.top - (lead.top + lead.height);
  if (gap < 0 || gap > Math.max(lead.height, bottom[0].geometry.height) * PAIR_GAP_TOLERANCE) return false;
  return top.every((shape, position) => {
    const width = Math.max(shape.geometry.width, bottom[position].geometry.width);
    return Math.abs(shape.geometry.left - bottom[position].geometry.left) <= width * COLUMN_ALIGN_TOLERANCE;
  });
}

function inducedTitle(shapes) {
  const texts = shapes.filter((shape) => shape.type === 'text' && shape.text.trim());
  const sized = texts.filter((shape) => Number(shape.fontSize) > 0);
  if (!sized.length) return null;
  // A row of equal boxes is the page's structure, not its title: on a metrics
  // page the numerals are the loudest type on the canvas and there are several
  // of them, so reading the loudest box as the title left such a page with no
  // title at all — and a page with no title slot cannot be filled by role.
  // The peers step aside; the title is the largest box left standing alone.
  const peers = new Set(
    rowBands(sized)
      .filter((members) => members.every((shape) => shape.fontSize === members[0].fontSize))
      .flatMap((members) => members.map((shape) => shape.shape))
  );
  // A figure is the page's evidence, never its title: the 82 pt "18" beside a statement, or the "1 call" leading
  // a summary, is the loudest type on its page, and read as the title it took the headline's slot.
  const candidates = sized.filter((shape) => !peers.has(shape.shape) && !VALUE_TEXT.test(shape.text.trim()));
  if (!candidates.length) return null;
  const [largest, runnerUp] = [...candidates].sort((left, right) => right.fontSize - left.fontSize);
  if (largest.text.trim().length > TITLE_MAX_CHARS) return null;
  if (runnerUp && largest.fontSize < runnerUp.fontSize * TITLE_SIZE_LEAD) return null;
  return largest;
}

function assignGroup(roles, row, prefix) {
  for (const [position, shape] of row.entries()) roles.set(shape.shape, `${prefix}-${position + 1}`);
}

function rowArea(row) {
  return row.reduce((total, shape) => total + area(shape), 0);
}

// One page carries one such structure. Two stacked rows of equal boxes are a
// grid, not six columns, and a role has to name exactly one box for the page to
// be filled by role at all, so the page's strongest row is the one that speaks:
// the widest row first, then the row that captions another, then the heavier.
function strongestRow(rows, captions = () => false) {
  let best = null;
  for (const row of rows) {
    if (!best) {
      best = row;
      continue;
    }
    if (row.length !== best.length) {
      if (row.length > best.length) best = row;
      continue;
    }
    if (captions(row) !== captions(best)) {
      if (captions(row)) best = row;
      continue;
    }
    if (rowArea(row) > rowArea(best)) best = row;
  }
  return best;
}

// Microsoft Office reports a shape type as a number and the portable reader as
// the element name; both name their preset outline and their type size the same
// way, so one reading of a snapshot serves either backend.
function objectRole(shape) {
  if (shape.chart || Number(shape.type) === 3) return 'chart';
  if (shape.table) return 'table';
  if (isPictureShape(shape)) return 'image';
  return '';
}

function snapshotShape(shape) {
  return {
    shape: Number(shape.index) || 0,
    type: objectRole(shape) || 'text',
    text: String(shape.text || ''),
    geometry: {
      left: Number(shape.left) || 0,
      top: Number(shape.top) || 0,
      width: Number(shape.width) || 0,
      height: Number(shape.height) || 0,
    },
    fontSize: Number(shape.font?.size) || 0,
    preset: String(shape.geometry || ''),
  };
}

// The catalog is only worth building if the reader of a deck can see it: a page
// answers with the job it does and each box with the slot it fills, so a page
// the user already owns can be chosen and filled instead of composed again.
export function annotatePptxSnapshotRoles(document) {
  const slides = Array.isArray(document?.slides) ? document.slides : [];
  const canvas = { width: Number(document?.slideWidth) || 0, height: Number(document?.slideHeight) || 0 };
  if (!slides.length || canvas.width <= 0 || canvas.height <= 0) return document;
  for (const slide of slides) {
    const shapes = Array.isArray(slide.shapes) ? slide.shapes : [];
    const induced = inducePptxSampleRoles({ shapes: shapes.map(snapshotShape) }, canvas);
    const slots = [];
    for (const shape of shapes) {
      const role = induced.get(Number(shape.index) || 0) || objectRole(shape);
      if (!role) continue;
      shape.slot = role;
      slots.push({ role });
    }
    slide.role = inferPptxSampleKind(
      {
        slide: Number(slide.index) || 0,
        slots,
        title: shapes.find((shape) => shape.slot === 'title')?.text || '',
        textChars: shapes.reduce((total, shape) => total + String(shape.text || '').length, 0),
        shapes,
      },
      Number(document.slideCount) || slides.length
    );
  }
  return document;
}

// A source line names where the page's figures came from; on a page about
// something else it names the wrong place.
const SOURCE_TEXT = /^(출처|자료|주|단위|source|sources|note|notes|units?)\s*[:：]/i;
// Prose, as opposed to a node label or a unit: a sentence the page states.
const BODY_MIN_CHARS = 25;
const EYEBROW_MAX_CHARS = 60;

// The page's other words around its title and its structure: the kicker set
// just above the title, the line just below it, the prose it states, and the
// source at its foot. They are the template's words, not the deck's, so each
// one needs a slot to be written or emptied through; left unnamed, a page built
// from a drawn deck kept the old cover's date and the old summary's sentence
// under a new title.
function inducedFrame(shapes, title, taken) {
  const roles = new Map();
  const free = shapes.filter((shape) => shape.type === 'text' && shape.text.trim() && !taken.has(shape.shape));
  for (const shape of free) if (SOURCE_TEXT.test(shape.text.trim())) roles.set(shape.shape, 'source');
  const quieter = (shape) => !title || !(Number(shape.fontSize) >= Number(title.fontSize));
  if (title) {
    const head = title.geometry;
    const bottom = (shape) => shape.geometry.top + shape.geometry.height;
    const open = free.filter(
      (shape) =>
        !roles.has(shape.shape) &&
        quieter(shape) &&
        Math.abs(shape.geometry.left - head.left) <= head.width * COLUMN_ALIGN_TOLERANCE
    );
    const above = open
      .filter((shape) => bottom(shape) <= head.top + head.height * 0.1 && head.top - bottom(shape) <= head.height)
      .sort((left, right) => bottom(right) - bottom(left))[0];
    if (above && above.text.trim().length <= EYEBROW_MAX_CHARS) roles.set(above.shape, 'eyebrow');
    const below = open
      .filter(
        (shape) =>
          !roles.has(shape.shape) &&
          shape.geometry.top >= bottom(title) - head.height * 0.1 &&
          shape.geometry.top - bottom(title) <= head.height
      )
      .sort((left, right) => left.geometry.top - right.geometry.top)[0];
    if (below) roles.set(below.shape, 'subtitle');
  }
  let prose = 0;
  for (const shape of free) {
    if (roles.has(shape.shape) || !quieter(shape) || shape.text.trim().length < BODY_MIN_CHARS) continue;
    prose += 1;
    roles.set(shape.shape, prose === 1 ? 'body' : `body-${prose}`);
  }
  return roles;
}

export function inducePptxSampleRoles(sample, canvas = WIDE_CANVAS) {
  const roles = new Map();
  const shapes = (sample?.shapes || []).filter((shape) => drawable(shape, canvas));
  const title = inducedTitle(shapes);
  if (title) roles.set(title.shape, 'title');
  inducePptxGroupRoles(roles, shapes, title);
  for (const [shape, role] of inducedFrame(shapes, title, new Set(roles.keys()))) roles.set(shape, role);
  return roles;
}

function inducePptxGroupRoles(roles, shapes, title) {
  // A band holds what the reader takes as one row: the boxes carrying the words
  // and the markers drawn behind them. A chevron with its label on top is one
  // step, so the marker names the structure and the label fills the slot.
  const groups = rowBands(shapes.filter((shape) => shape.shape !== title?.shape))
    .map((members) => ({
      labels: members.filter((shape) => shape.type === 'text' && shape.text.trim()),
      stepped: members.some((shape) => !shape.text.trim() && STEP_PRESETS.has(shape.preset || '')),
    }))
    .filter((group) => group.labels.length >= 2);
  const steps = groups.filter((group) => group.stepped).map((group) => group.labels);
  const texts = groups.map((group) => group.labels);
  // Where one row captions another the upper row leads: it is what the page
  // states, and the caption row underneath belongs to it.
  const captions = (row) => texts.some((other) => other !== row && pairsWith(row, other));
  const leading = strongestRow(steps) || strongestRow(texts, captions);
  if (!leading) return;
  if (steps.includes(leading)) {
    assignGroup(roles, leading, 'step-title');
    return;
  }
  const metric = leading.every((shape) => VALUE_TEXT.test(shape.text.trim()));
  assignGroup(roles, leading, metric ? 'metric-value' : 'column-title');
  const partner = texts.find((row) => row !== leading && pairsWith(leading, row));
  if (partner) assignGroup(roles, partner, metric ? 'metric-label' : 'column-body');
}
