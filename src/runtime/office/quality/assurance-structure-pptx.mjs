// Slide structure review: type hierarchy, alignment axes, peers, text walls
// and collisions.
import { fontFamilyKey, isMotifShape, isPictureShape } from '../design/design-discipline.mjs';
import { annotatePptxSnapshotRoles } from '../design/library/design-template-induct.mjs';
import { issue } from './assurance-issue.mjs';

// The area two boxes share, in pt²; a snapshot frame may carry its edges as
// numbers or numeric strings.
function intersectionArea(left, right) {
  const width = Math.max(
    0,
    Math.min(Number(left.left) + Number(left.width), Number(right.left) + Number(right.width)) -
      Math.max(Number(left.left), Number(right.left))
  );
  const height = Math.max(
    0,
    Math.min(Number(left.top) + Number(left.height), Number(right.top) + Number(right.height)) -
      Math.max(Number(left.top), Number(right.top))
  );
  return width * height;
}

function overlapRatio(left, right) {
  const smallest = Math.min(left.width * left.height, right.width * right.height);
  return smallest > 0 ? intersectionArea(left, right) / smallest : 0;
}

function hasFrame(shape) {
  return [shape.left, shape.top, shape.width, shape.height].every((entry) => Number.isFinite(Number(entry)));
}

function numericFrame(shape) {
  return {
    ...shape,
    left: Number(shape.left),
    top: Number(shape.top),
    width: Number(shape.width),
    height: Number(shape.height),
  };
}

function slideAt(slide) {
  return slide.path || `/slide[${slide.index}]`;
}

function officeColorRgb(value) {
  if (typeof value === 'string') {
    const hex = value.trim().replace(/^#/u, '');
    if (/^[0-9a-f]{6}$/iu.test(hex)) {
      return [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
      ];
    }
  }
  const color = Number(value);
  if (!Number.isFinite(color) || color < 0 || color > 0xffffff) return null;
  return [color & 255, (color >> 8) & 255, (color >> 16) & 255];
}

function relativeLuminance(rgb) {
  if (!rgb) return null;
  const channels = rgb.map((entry) => {
    const channel = entry / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function colorContrastRatio(left, right) {
  const leftLuminance = relativeLuminance(officeColorRgb(left));
  const rightLuminance = relativeLuminance(officeColorRgb(right));
  if (!Number.isFinite(leftLuminance) || !Number.isFinite(rightLuminance)) return null;
  const lighter = Math.max(leftLuminance, rightLuminance);
  const darker = Math.min(leftLuminance, rightLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

// A PowerPoint session reports a fill as fillColor with its transparency; a
// portable snapshot reports it as fill: { color }. Reading only the first left
// every card, band and field on an authored deck invisible to the checks that
// ask what a text or a chart sits on, and a fill with no transparency recorded
// is an opaque fill.
function solidShapeFill(shape) {
  const color = shape?.fillColor ?? shape?.fill?.color;
  const transparency = Number(shape?.fillTransparency ?? shape?.fill?.transparency ?? 0);
  if (!officeColorRgb(color) || !Number.isFinite(transparency) || transparency >= 0.2) return null;
  return color;
}

function containingSurface(textShape, shapes) {
  const centerX = textShape.left + textShape.width / 2;
  const centerY = textShape.top + textShape.height / 2;
  return (
    (shapes || [])
      .filter(
        (shape) =>
          Number(shape?.index) < Number(textShape.index) &&
          !String(shape?.text || '').trim() &&
          solidShapeFill(shape) != null &&
          Number(shape.left) <= centerX &&
          Number(shape.top) <= centerY &&
          Number(shape.left) + Number(shape.width) >= centerX &&
          Number(shape.top) + Number(shape.height) >= centerY
      )
      .sort(
        (left, right) => Number(left.width) * Number(left.height) - Number(right.width) * Number(right.height)
      )[0] || null
  );
}

// Presentation body copy stays at 12 pt or more, but page chrome (kickers,
// page badges, captions, source lines) is legitimately smaller and may sit
// closer to the edge. Chrome is a short line at caption size; anything
// longer is body copy whatever its size.
const PPTX_BODY_MIN_PT = 12;
const PPTX_CHROME_MIN_PT = 9;
const PPTX_EDGE_PT = 18;
const PPTX_CHROME_EDGE_PT = 10;
const PPTX_CHROME_MAX_CHARS = 90;

// Slide-number fields (master placeholders) carry their size in the field run,
// which the snapshot does not always surface; the numeral itself is the chrome.
const PPTX_PAGE_NUMBER = /^\s*(?:\d+\s*(?:\/|of)\s*\d+|\d{1,3})\s*$/i;

function isPptxChromeText(shape) {
  const text = String(shape.text || '').trim();
  const fontSize = Number(shape.font?.size) || 0;
  if (shape.placeholder && PPTX_PAGE_NUMBER.test(text)) return true;
  return fontSize > 0 && fontSize <= PPTX_BODY_MIN_PT && text.length <= PPTX_CHROME_MAX_CHARS && !/[\r\n]/.test(text);
}

// A numeral or short lead directly above its own description is one unit
// (a hero number and its label, a step number and its detail); the tight gap
// is the design, not a spacing defect.
// Near-miss alignment: an element a few points off an axis the slide already
// shares reads as a mistake, not as a decision — the eye registers the step
// without being able to name it. The reference axis must already be held by two
// other edges, so a deliberate offset never trips this; only the almost-aligned
// element does.
const PPTX_AXIS_SNAP_PT = 1;
const PPTX_AXIS_DRIFT_PT = 6;
// The kit's icon bands: glyph 0.3 in, marker 0.45 in (kit.md §5) — a picture that small is a mark inside a unit.
const PPTX_INLINE_ICON_PT = 36;
// A picture is `p:pic` in the portable snapshot and msoPicture (13) in the COM one, which the snapshot-aware
// isPptxPicture below reads; PowerPoint reports a picture that carries an SVG source (the kit's icons) as
// msoGraphic (28), a kind no other review counts as a picture.
const isPptxInlineIcon = (shape) =>
  (isPptxPicture(shape) || Number(shape.type) === 28) &&
  Math.max(Number(shape.width) || 0, Number(shape.height) || 0) <= PPTX_INLINE_ICON_PT;
const PPTX_AXIS_MEMBERS = 2;
const PPTX_AXIS_REPORTS_PER_SLIDE = 3;

// An edge is compared only with edges of its own kind: left edges make a column,
// tops make a row, centres make a spine. A left edge that lands near an unrelated
// shape's right edge is two objects meeting, not a broken axis.
const PPTX_AXIS_KINDS = Object.freeze(['left edge', 'centre', 'right edge', 'top edge', 'middle', 'bottom edge']);

// A line has no width or no height, so its two edges and its centre are one
// position. Registering that single position as three different kinds would let
// any box's edge drift against a rule it has nothing to do with, so the collapsed
// dimension reports its centre only; the drawn dimension keeps both ends.
function pptxShapeAxes(shape) {
  const flat = { x: shape.width === 0, y: shape.height === 0 };
  return [
    ...(flat.x
      ? []
      : [
          ['left edge', shape.left],
          ['right edge', shape.left + shape.width],
        ]),
    ['centre', shape.left + shape.width / 2],
    ...(flat.y
      ? []
      : [
          ['top edge', shape.top],
          ['bottom edge', shape.top + shape.height],
        ]),
    ['middle', shape.top + shape.height / 2],
  ];
}

// The axes the slide itself establishes: positions three or more shapes already
// share, to the point, on the same kind of edge. A pair is a coincidence; a third
// shape makes it the slide's grid, which is what a drifting element breaks.
function pptxEstablishedAxes(shapes) {
  const axes = new Map(PPTX_AXIS_KINDS.map((kind) => [kind, []]));
  const members = new Map(PPTX_AXIS_KINDS.map((kind) => [kind, []]));
  for (const shape of shapes) {
    for (const [kind, value] of pptxShapeAxes(shape)) members.get(kind).push({ value, shape });
  }
  for (const kind of PPTX_AXIS_KINDS) {
    const entries = members.get(kind).sort((left, right) => left.value - right.value);
    let cluster = [];
    const flush = () => {
      if (new Set(cluster.map((entry) => entry.shape)).size >= PPTX_AXIS_MEMBERS) {
        axes.get(kind).push(cluster.reduce((sum, entry) => sum + entry.value, 0) / cluster.length);
      }
      cluster = [];
    };
    for (const entry of entries) {
      if (cluster.length && entry.value - cluster[0].value > PPTX_AXIS_SNAP_PT) flush();
      cluster.push(entry);
    }
    flush();
  }
  return axes;
}

// A row of identical cards is read as one rhythm, so the gaps between them are
// part of the shape: neighbours spaced by hand differ by a few points and the eye
// registers a wobble it cannot name. Only cards of the same size on the same row
// band qualify — measured text boxes and mixed objects have honest reasons to
// differ, and a deliberately varied row is never three identical rectangles.
const PPTX_ROW_BAND_PT = 2;
const PPTX_ROW_SIZE_RATIO = 0.02;
const PPTX_ROW_GAP_RATIO = 0.05;
const PPTX_ROW_GAP_PT = 2;
// A gap half again wider than its peers is a break between groups — the reader
// sees two clusters, which is a composition. Only the near-miss is the defect.
const PPTX_ROW_BREAK_RATIO = 1.5;
// The gaps carry the rhythm only while they are small beside the objects they
// separate: a row of cards is read as one band, but small markers (icons, dots)
// spread across wide columns are positioned by those columns, and the distance
// between them is a consequence, not a measurement anyone made.
const PPTX_ROW_GAP_TO_WIDTH = 0.5;

function pptxPeerRows(shapes) {
  const rows = [];
  for (const shape of shapes) {
    if (!(shape.width > 0 && shape.height > 0)) continue;
    const row = rows.find(
      ([first]) =>
        Math.abs(first.top - shape.top) <= PPTX_ROW_BAND_PT &&
        Math.abs(first.height - shape.height) <= Math.max(1, first.height * PPTX_ROW_SIZE_RATIO) &&
        Math.abs(first.width - shape.width) <= Math.max(1, first.width * PPTX_ROW_SIZE_RATIO)
    );
    if (row) row.push(shape);
    else rows.push([shape]);
  }
  return rows.filter((row) => row.length >= 3).map((row) => [...row].sort((left, right) => left.left - right.left));
}

function pptxRowGapSpread(row) {
  const gaps = row.slice(1).map((shape, index) => shape.left - (row[index].left + row[index].width));
  if (gaps.some((gap) => gap <= 0)) return null;
  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const smallest = Math.min(...gaps);
  const largest = Math.max(...gaps);
  const spread = largest - smallest;
  if (largest > (row[0].width || 0) * PPTX_ROW_GAP_TO_WIDTH) return null;
  if (spread <= PPTX_ROW_GAP_PT || spread <= average * PPTX_ROW_GAP_RATIO) return null;
  if (largest >= smallest * PPTX_ROW_BREAK_RATIO) return null;
  return { smallest, largest, average, count: row.length };
}

function pptxAxisDrift(shape, axes) {
  for (const [kind, value] of pptxShapeAxes(shape)) {
    const candidates = axes.get(kind) || [];
    if (candidates.some((axis) => Math.abs(axis - value) <= PPTX_AXIS_SNAP_PT)) continue;
    const axis = candidates.find((candidate) => Math.abs(candidate - value) <= PPTX_AXIS_DRIFT_PT);
    if (axis != null) return { name: kind, offset: Math.abs(axis - value), axis };
  }
  return null;
}

// A figure and the words that name it sit close on purpose, whichever way round
// the page sets them: a value over its caption, or a short label introducing the
// number under it. The label is short and the sizes say which line is which; a
// stat pair reported as crowded sent the next fix round after the one grouping
// the page had right.
const LABEL_UNIT_CHARS = 16;
// The kicker is the other half of that pair and it is not short: an eyebrow line sits a hair over the title it
// introduces, and the two read as one head — every reference deck sets them that way, and the kit draws them so.
// It is recognised by its type, not its length: one line, at most three fifths of the size of the line under it.
const KICKER_SIZE_SHARE = 0.6;
const LABEL_UNIT_WIDTH_SHARE = 0.6;
const LABEL_HEADING_CHARS = 28;

function isPptxKickerOverTitle(upper, lower) {
  const upperSize = Number(upper.font?.size) || 0;
  const lowerSize = Number(lower.font?.size) || 0;
  const upperHeight = Number(upper.height) || 0;
  if (!upperSize || !lowerSize || upperSize > lowerSize * KICKER_SIZE_SHARE) return false;
  // One line of that size, with the slack a text box carries around its own line.
  return upperHeight > 0 && upperHeight <= (upperSize / 72) * 1.2 * 1.9 * 72;
}

function isPptxLabelledUnit(left, right) {
  const [upper, lower] = left.top <= right.top ? [left, right] : [right, left];
  const upperText = String(upper.text || '').trim();
  const upperSize = Number(upper.font?.size) || 0;
  const lowerSize = Number(lower.font?.size) || 0;
  if (!upperSize || !lowerSize) return false;
  if (isPptxKickerOverTitle(upper, lower)) return true;
  // A heading line over the detail it names is the same unit as a figure over its caption; what marks it is the step
  // in type, not a short string. Held to one line of label length, so a paragraph crowding another is still reported.
  const stepped = upperSize >= lowerSize * 1.2 || lowerSize >= upperSize * 1.2;
  if (stepped && !upperText.includes('\n') && upperText.length <= LABEL_HEADING_CHARS) return true;
  if (upperText.length > LABEL_UNIT_CHARS) return false;
  if (stepped) return true;
  // Two lines a step apart in size are still a label and its detail when the measure says so: a short line in a box
  // little more than half the width of the paragraph under it is the name of that paragraph, not a block of copy
  // crowding it (the card title over its body, which the reference decks set tight on purpose).
  const upperWidth = Number(upper.width) || 0;
  const lowerWidth = Number(lower.width) || 0;
  return upperWidth > 0 && lowerWidth > 0 && upperWidth <= lowerWidth * LABEL_UNIT_WIDTH_SHARE;
}

// A row of peers is read as one set: the reader takes boxes that look alike to
// belong together, so column titles at 20 pt beside one at 18 pt read as a
// mistake rather than as emphasis. The page's own geometry says which boxes
// form the row.
const PEER_TYPE_TOLERANCE = 0.05;
const PEER_WIDTH_SHARE = 0.6;
const PEER_SLOT = /^((?:column|metric|step)-(?:title|body|value|label|detail))-\d+$/;
// A page that fits its words is not a page anyone reads from a seat: past the
// top of every reference body page and covering half the canvas, the slide is a
// document being projected. Two readings at once keep a table page and a long
// quotation out of it.
const TEXT_WALL_CHARS = 900;
const TEXT_WALL_COVERAGE = 0.45;

function shapeFaces(shape) {
  const names = Array.isArray(shape.fonts) ? shape.fonts : [shape.font?.name];
  return names.map(fontFamilyKey).filter(Boolean);
}

// How much of a text box an opaque object may cover before the words behind it
// stop being read.
const TEXT_OCCLUSION_SHARE = 0.25;

// Slack an auto-fitting text box carries below its last line: two boxes in one
// column may share this much without a reader seeing it. Past it the lines are
// in each other's space.
const PPTX_TEXT_COLLISION_PT = 4;

// A structure review also reads the snapshot's own picture fields, which the
// shared kind predicate knows nothing about.
function isPptxPicture(shape) {
  return Boolean(shape?.picture || shape?.image || isPictureShape(shape));
}

// The kit signs the glow it draws under a hero object; it is a gradient that ends at zero alpha, not a plane.
function isHaloDevice(shape) {
  return String(shape?.name || shape?.objectName || '') === 'mixdog-device:glow';
}

// Two or more series drawn in two or more colours are read by whatever names
// them: the chart's legend, labels carrying the series name, or the page's own
// words (a deck often sets its legend beside the chart as text, which is a
// legend the reader can read). With none of those the colours mean nothing, and
// the chart is a picture of a difference nobody can attribute.
function reviewPptxChartSeriesNaming(slide, shape, issues) {
  const chart = shape?.chart;
  if (!chart || Number(chart.seriesCount) < 2) return;
  if (chart.legend !== false || chart.seriesNamesShown === true) return;
  const names = (chart.series || [])
    .map((series) => String(series?.name || '').trim())
    .filter((name) => name.length > 1);
  if (names.length < 2) return;
  const words = (slide.shapes || [])
    .filter((entry) => entry !== shape)
    .map((entry) => String(entry.text || ''))
    .join('\n');
  if (names.every((name) => words.includes(name))) return;
  issues.push(
    issue(
      'chart_series_unnamed',
      chart.path || `${shape.path || slide.path}/chart`,
      `${names.length} series (${names.slice(0, 3).join(', ')}) are told apart by colour alone: the chart draws no legend, its labels carry no series name, and the page does not name them either.`
    )
  );
}

function reviewPptxPeerType(slide, issues) {
  const groups = new Map();
  for (const shape of slide.shapes || []) {
    const role = PEER_SLOT.exec(String(shape.slot || ''))?.[1];
    if (!role || !String(shape.text || '').trim()) continue;
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(shape);
  }
  const path = slideAt(slide);
  for (const [role, members] of groups) {
    if (members.length < 2) continue;
    // Peers in one row hold the same column: a 140 pt label beside a 665 pt lead
    // line is a label and its sentence, and reading them as one set reported the
    // grammar the page had right.
    const widths = members.map((shape) => Number(shape.width) || 0);
    if (Math.min(...widths) < Math.max(...widths) * PEER_WIDTH_SHARE) continue;
    const sizes = members.map((shape) => Number(shape.font?.size) || 0).filter((size) => size > 0);
    if (sizes.length === members.length && Math.max(...sizes) > Math.min(...sizes) * (1 + PEER_TYPE_TOLERANCE)) {
      issues.push(
        issue(
          'peer_style_inconsistent',
          path,
          `The ${role} boxes are set at ${[...new Set(sizes)].sort((left, right) => left - right).join(' / ')} pt; peers in one row read as one set.`
        )
      );
      continue;
    }
    const faces = new Set(members.flatMap(shapeFaces));
    if (faces.size > 1) {
      issues.push(
        issue(
          'peer_style_inconsistent',
          path,
          `The ${role} boxes mix ${[...faces].join(', ')}; peers in one row carry one face.`
        )
      );
    }
  }
}

// A page of boxes all set in one size has no voice the eye reaches first. The
// induction names a title only where one box leads the rest, so a text page of
// several boxes that induced none is a page with no hierarchy to see — a
// statement or a captioned picture is not, since neither is a page of peers.
const FLAT_PAGE_TEXT_BOXES = 3;
// Type itself can lead where the induction names no title: a page whose loudest box runs a third larger than the
// type around it has a place to start, whatever the geometry made of its rows. Two boxes sharing that size (a title
// beside its hero numeral) lead together — the reading is the step down to the rest of the page, not which one wins.
const HIERARCHY_LEAD_RATIO = 1.3;

function leadsByType(sizes) {
  const ascending = [...sizes].sort((left, right) => left - right);
  const largest = ascending[ascending.length - 1];
  const rest = ascending.slice(0, -1);
  if (!rest.length) return true;
  const median =
    rest.length % 2 ? rest[(rest.length - 1) / 2] : (rest[rest.length / 2 - 1] + rest[rest.length / 2]) / 2;
  return largest >= median * HIERARCHY_LEAD_RATIO;
}

function reviewPptxHierarchy(slide, issues) {
  const shapes = slide.shapes || [];
  if (shapes.some((shape) => shape.chart || shape.table || shape.group || isPptxPicture(shape))) return;
  const textShapes = shapes.filter((shape) => String(shape.text || '').trim() && !isMotifShape(shape));
  if (textShapes.length < FLAT_PAGE_TEXT_BOXES) return;
  if (textShapes.some((shape) => shape.slot === 'title')) return;
  const sizes = textShapes.map((shape) => Number(shape.font?.size) || 0).filter((size) => size > 0);
  if (sizes.length !== textShapes.length) return;
  if (leadsByType(sizes)) return;
  issues.push(
    issue(
      'slide_hierarchy_flat',
      slideAt(slide),
      `The slide's ${textShapes.length} text boxes are set at ${[...new Set(sizes)].sort((left, right) => left - right).join(' / ')} pt with none leading the others; the reader has no place to start.`
    )
  );
}

function reviewPptxTextWall(slide, width, height, issues) {
  const shapes = slide.shapes || [];
  // A chart, table, picture, or group carries the page instead of the words.
  if (!width || !height) return;
  if (shapes.some((shape) => shape.chart || shape.table || shape.group || isPptxPicture(shape))) return;
  let chars = 0;
  let area = 0;
  for (const shape of shapes) {
    const text = String(shape.text || '').trim();
    if (!text) continue;
    chars += text.length;
    area += Math.max(0, Number(shape.width) || 0) * Math.max(0, Number(shape.height) || 0);
  }
  const coverage = area / Math.max(1, width * height);
  if (chars <= TEXT_WALL_CHARS || coverage < TEXT_WALL_COVERAGE) return;
  issues.push(
    issue(
      'slide_text_dense',
      slideAt(slide),
      `The slide carries ${chars} characters over ${Math.round(coverage * 100)}% of the canvas with no carrier; split it or cut it rather than projecting a document.`
    )
  );
}

function reviewPptxCharts(slide, issues) {
  for (const shape of slide.shapes || []) {
    if (shape.chart && Number(shape.chart.seriesCount) === 0) {
      issues.push(
        issue(
          'empty_chart',
          shape.chart.path || `${shape.path || slide.path}/chart`,
          'Chart has no persisted data series.',
          'format-review',
          'error'
        )
      );
    }
    reviewPptxChartSeriesNaming(slide, shape, issues);
  }
}

// The text boxes a slide measures: the ones with words, a frame, and no
// motif role, their edges as numbers.
function pptxTextShapes(slide) {
  return (slide.shapes || [])
    .filter((shape) => String(shape.text || '').trim() && !isMotifShape(shape) && hasFrame(shape))
    .map(numericFrame);
}

function reviewPptxTextShape(slide, shape, { width, height }, issues) {
  const fontSize = Number(shape.font?.size) || 0;
  const chrome = isPptxChromeText(shape);
  if (fontSize > 0 && fontSize < PPTX_CHROME_MIN_PT) {
    issues.push(issue('small_font', shape.path || slide.path, `Text is smaller than ${PPTX_CHROME_MIN_PT} pt.`));
  } else if (fontSize > 0 && fontSize < PPTX_BODY_MIN_PT && !chrome) {
    issues.push(issue('small_font', shape.path || slide.path, `Body text is smaller than ${PPTX_BODY_MIN_PT} pt.`));
  }
  const surface = containingSurface(shape, slide.shapes || []);
  const backgroundColor = solidShapeFill(shape) ?? solidShapeFill(surface) ?? slide.background?.color;
  const contrast = colorContrastRatio(shape.font?.color, backgroundColor);
  if (Number.isFinite(contrast) && contrast < 1.8) {
    issues.push(
      issue(
        'low_contrast',
        shape.path || slide.path,
        `Text contrast is ${contrast.toFixed(2)}:1 against ${surface?.path || 'the slide background'}; the text is visually indistinguishable from its surface.`
      )
    );
  }
  const margin = chrome ? PPTX_CHROME_EDGE_PT : PPTX_EDGE_PT;
  if (
    width > 0 &&
    height > 0 &&
    (shape.left < margin ||
      shape.top < margin ||
      shape.left + shape.width > width - margin ||
      shape.top + shape.height > height - margin)
  ) {
    issues.push(issue('edge_margin', shape.path || slide.path, `Text is within ${margin} pt of a slide edge.`));
  }
}

// Page-number fields live on the master; their distance to content is chrome, not spacing — but a body block
// drawn over the page number is still an overlap (PowerPoint's own read reports it; the portable read used to
// leave the field out of both checks and pass a column that ran into the foot).
function isPageNumber(shape) {
  return Boolean(shape.placeholder) && PPTX_PAGE_NUMBER.test(String(shape.text || '').trim());
}

// What two text boxes do to each other — an overlap, a collision in the
// column they share, or a tight spacing — or null when they sit apart.
function pptxTextPairFinding(left, right, labels) {
  if (overlapRatio(left, right) >= 0.25) {
    return { code: 'shape_overlap', message: `Text shapes ${labels} overlap by at least 25%.` };
  }
  if (isPageNumber(left) || isPageNumber(right)) return null;
  const horizontalOverlap = Math.max(
    0,
    Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left)
  );
  const verticalGap = Math.max(right.top - (left.top + left.height), left.top - (right.top + right.height));
  if (horizontalOverlap < Math.min(left.width, right.width) * 0.3) return null;
  // A band laid across a column it does not belong to covers a small share
  // of its own area, so the area rule above passes it while the page shows
  // two blocks running into each other. Where the boxes share a column,
  // the reading is the overlap itself: past the slack an auto-fitting box
  // carries, the lines are in each other's space.
  if (verticalGap < -PPTX_TEXT_COLLISION_PT) {
    return {
      code: 'shape_overlap',
      message: `Text shapes ${labels} run into each other over ${Math.round(-verticalGap)} pt of the column they share; the two blocks read as one.`,
    };
  }
  // A label and the line it names sit tight by design, so the pair is exempt from the spacing step — never from
  // a collision: two boxes in each other's space read as one block whatever they say to each other.
  if (isPptxLabelledUnit(left, right)) return null;
  if (verticalGap >= 0 && verticalGap < 6) {
    return { code: 'text_spacing_tight', message: `Text shapes ${labels} have less than 6 pt vertical spacing.` };
  }
  return null;
}

function reviewPptxTextPairs(slide, textShapes, issues) {
  for (let leftIndex = 0; leftIndex < textShapes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < textShapes.length; rightIndex += 1) {
      const left = textShapes[leftIndex];
      const right = textShapes[rightIndex];
      const labels = `${left.index || leftIndex + 1} and ${right.index || rightIndex + 1}`;
      const finding = pptxTextPairFinding(left, right, labels);
      if (finding) issues.push(issue(finding.code, slideAt(slide), finding.message));
    }
  }
}

// A solid shape added after an evidence frame and drawn over it.
function reviewPptxFrameCover(slide, frame, area, issues) {
  for (const cover of slide.shapes || []) {
    if (cover === frame || !solidShapeFill(cover)) continue;
    if (!(Number(cover.index) > Number(frame.index))) continue;
    if (!hasFrame(cover)) continue;
    const share = intersectionArea(frame, cover) / area;
    if (share < 0.05) continue;
    let kind = 'picture';
    if (frame.chart) kind = 'chart';
    else if (frame.table) kind = 'table';
    issues.push(
      issue(
        'shape_overlap',
        frame.path || slideAt(slide),
        `Shape ${cover.index} is drawn over the ${kind}, covering ${Math.round(share * 100)}% of it;` +
          ' a band across the foot of a chart hides its category axis.'
      )
    );
    return;
  }
}

// A text box over a table is never an annotation (a chart or a picture may carry one): a source line whose
// box starts inside the table's last row is a table that ran into the foot, and the fill check sees only
// solid shapes.
function reviewPptxTableTextCover(slide, frame, textShapes, issues) {
  for (const textShape of textShapes) {
    // A snapshot lists the table's own cell text on the table shape; that is the frame, not a box over it.
    if (textShape === frame || textShape.table || textShape.chart || textShape.index === frame.index) continue;
    const textArea = Number(textShape.width) * Number(textShape.height);
    if (!(textArea > 0)) continue;
    const share = intersectionArea(frame, textShape) / textArea;
    if (share < 0.2) continue;
    issues.push(
      issue(
        'shape_overlap',
        frame.path || slideAt(slide),
        `Text shape ${textShape.index} runs into the table (${Math.round(share * 100)}% of the text box lies over it); move the text or give the table fewer rows.`
      )
    );
    return;
  }
}

// The evidence frames are compared with what is drawn over them. A takeaway
// band laid across the foot of a chart hides the category axis, so the page
// shows three bars with no names and the audit used to pass: only text boxes
// were ever compared with each other.
function reviewPptxEvidenceCover(slide, textShapes, issues) {
  const evidenceFrames = (slide.shapes || []).filter(
    (shape) => (shape.chart || shape.table || shape.picture || shape.image) && hasFrame(shape)
  );
  for (const frame of evidenceFrames) {
    const area = Number(frame.width) * Number(frame.height);
    if (!(area > 0)) continue;
    reviewPptxFrameCover(slide, frame, area, issues);
    if (frame.table) reviewPptxTableTextCover(slide, frame, textShapes, issues);
  }
}

// The words a later object covers are the defect a rendered page hides best:
// the box still measures as fitting and its text still reads back from the
// file. A card drawn under its own text sits below it in z-order, so only an
// object added after the text can hide it.
function reviewPptxTextOcclusion(slide, textShapes, issues) {
  for (const textShape of textShapes) {
    const textArea = Number(textShape.width) * Number(textShape.height);
    if (!(textArea > 0)) continue;
    for (const cover of slide.shapes || []) {
      // A halo is a radial wash that fades to nothing at its edge — the kit signs the one it draws under a product
      // render — so the words it reaches are still read. Only an object that paints over them hides them.
      if (cover === textShape || isMotifShape(cover) || isHaloDevice(cover) || String(cover.text || '').trim()) {
        continue;
      }
      if (!(Number(cover.index) > Number(textShape.index))) continue;
      if (!isPptxPicture(cover) && !solidShapeFill(cover)) continue;
      if (!hasFrame(cover)) continue;
      const share = intersectionArea(textShape, cover) / textArea;
      if (share < TEXT_OCCLUSION_SHARE) continue;
      issues.push(
        issue(
          'shape_overlap',
          textShape.path || slideAt(slide),
          `Shape ${cover.index} is drawn over text shape ${textShape.index}, covering ${Math.round(share * 100)}% of it; the words behind it are not read.`
        )
      );
      break;
    }
  }
}

// Axes are read from drawn objects only: rules, connectors, bands, pictures,
// charts, tables. A text box is sized to its measured copy, so its box edges
// are a consequence of the wrap, not a position anyone chose.
// A glyph- or marker-size picture (the icon in a node, the mark before a list line) registers to the unit it
// marks, not to the page: a hub's satellites stand on a circle, so their icons' edges land wherever the angle
// puts them, and reading those as axes flagged every radial structure.
function reviewPptxAlignment(slide, issues) {
  const placedShapes = (slide.shapes || [])
    .filter(
      (shape) => !isMotifShape(shape) && !isPptxInlineIcon(shape) && !String(shape.text || '').trim() && hasFrame(shape)
    )
    .map(numericFrame);
  const slideAxes = pptxEstablishedAxes(placedShapes);
  let drifts = 0;
  for (const shape of placedShapes) {
    if (drifts >= PPTX_AXIS_REPORTS_PER_SLIDE) break;
    const drift = pptxAxisDrift(shape, slideAxes);
    if (!drift) continue;
    drifts += 1;
    issues.push(
      issue(
        'axis_drift',
        shape.path || slide.path,
        `The ${drift.name} sits ${drift.offset.toFixed(1)} pt off the axis the slide shares at ${drift.axis.toFixed(1)} pt.`
      )
    );
  }
  for (const row of pptxPeerRows(placedShapes)) {
    const spread = pptxRowGapSpread(row);
    if (!spread) continue;
    issues.push(
      issue(
        'peer_gap_uneven',
        slideAt(slide),
        `A row of ${spread.count} equal shapes is spaced from ${spread.smallest.toFixed(1)} to ${spread.largest.toFixed(1)} pt; the gaps read as a wobble rather than one rhythm.`
      )
    );
  }
}

function reviewPptxNumberSources(slide, textShapes, issues) {
  const allText = textShapes.map((shape) => shape.text).join(' ');
  if (!/\d/.test(allText)) return;
  if (/(?:source\s*:|[\w .-]+!\$?[A-Z]{1,3}\$?\d+|출처\s*:)/i.test(String(slide.notes || ''))) return;
  issues.push(
    issue(
      'number_without_source',
      slideAt(slide),
      'Slide contains numbers but its notes do not cite a workbook cell or source.'
    )
  );
}

export function reviewPptxStructure(document, auditProfile = '') {
  const issues = [];
  const canvas = { width: Number(document?.slideWidth) || 0, height: Number(document?.slideHeight) || 0 };
  // A deck read from the file carries no slots; the roles come from the same
  // induction the snapshot uses, and annotating twice changes nothing.
  if (!(document?.slides || []).some((slide) => (slide.shapes || []).some((shape) => shape.slot))) {
    annotatePptxSnapshotRoles(document);
  }
  for (const source of document?.slides || []) {
    // A hidden slide is not in the deck the reader receives.
    if (source.hidden === true) continue;
    // A shape the slide hides is not on the page; measuring it reports defects
    // no reader can see and sends the next fix round after an invisible box.
    const slide = (source.shapes || []).some((shape) => shape.hidden === true)
      ? { ...source, shapes: source.shapes.filter((shape) => shape.hidden !== true) }
      : source;
    reviewPptxPeerType(slide, issues);
    reviewPptxTextWall(slide, canvas.width, canvas.height, issues);
    reviewPptxHierarchy(slide, issues);
    reviewPptxCharts(slide, issues);
    const textShapes = pptxTextShapes(slide);
    for (const shape of textShapes) reviewPptxTextShape(slide, shape, canvas, issues);
    reviewPptxTextPairs(slide, textShapes, issues);
    reviewPptxEvidenceCover(slide, textShapes, issues);
    reviewPptxTextOcclusion(slide, textShapes, issues);
    reviewPptxAlignment(slide, issues);
    if (auditProfile === 'model-backed-deck') reviewPptxNumberSources(slide, textShapes, issues);
  }
  return issues;
}
