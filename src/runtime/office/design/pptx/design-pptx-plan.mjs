import {
  hex,
  metricDisplayValue,
  provenanceText,
  strings,
} from '../design-tokens.mjs';
import {
  balancedPptTitle,
  canvasSize,
  pptBodyParagraphs,
  pptBulletParagraphs,
  pptShape,
  pptText,
  WRAP_OVERHANG_EM,
} from './design-pptx-primitives.mjs';
import { measuredTextHeight, packedTextStack } from './design-pptx-stack.mjs';
import { measureTextWidth } from '../../portable/text-metrics.mjs';
import { PPTX_SEMANTIC_ROLES, renderPptxSemanticRegion } from './design-pptx-semantic-visuals.mjs';
import { expandPptxAuthoredScene, hasPptxAuthoredScene } from './design-pptx-authored-scene.mjs';
import { motifOperations } from './design-pptx-motifs.mjs';
import { spreadRegionsVertically } from './design-pptx-scene-discipline.mjs';
import { clamp, plainObject } from '../../shared/values.mjs';

const PLAN_UNITS = new Set(['percent', 'points']);
const PLAN_ROLES = new Set([
  'eyebrow',
  'title',
  'subtitle',
  'meta',
  'body',
  'bullets',
  'metric',
  'metrics',
  'chart',
  'table',
  'image',
  'visual',
  'process',
  'comparison',
  'annotated-chart',
  'allocation',
  'timeline',
  'scorecard',
  'shape',
  'source',
]);
const EVIDENCE_ROLES = new Set([
  'metric',
  'metrics',
  'chart',
  'table',
  'image',
  'visual',
  'process',
  'comparison',
  'annotated-chart',
  'allocation',
  'timeline',
  'scorecard',
]);
const TEXT_ROLES = new Set(['eyebrow', 'title', 'subtitle', 'meta', 'body', 'bullets', 'source']);
const ALIGNMENTS = new Set(['left', 'center', 'right']);
const MIN_VISIBLE_FONT_SIZE = 12;
const TEXT_SHAPE_GAP = 8;
const REGION_MINIMUMS = Object.freeze({
  eyebrow: [120, 18],
  title: [180, 36],
  subtitle: [140, 24],
  meta: [120, 18],
  body: [120, 54],
  bullets: [120, 54],
  metric: [120, 72],
  metrics: [180, 90],
  chart: [220, 130],
  table: [220, 90],
  image: [160, 100],
  visual: [120, 90],
  process: [220, 120],
  comparison: [220, 120],
  'annotated-chart': [300, 150],
  allocation: [220, 120],
  timeline: [260, 120],
  scorecard: [260, 140],
  shape: [36, 24],
  source: [120, 16],
});

function rounded(value) {
  return Math.round(Number(value) * 100) / 100;
}

function planError(code, slide, message, details = {}) {
  const error = new Error(
    `MODEL_COMPOSITION_PLAN_${code} slide ${slide}: ${message} No template fallback was applied.`,
  );
  error.code = `MODEL_COMPOSITION_PLAN_${code}`;
  error.details = { slide, ...details };
  return error;
}

function rawBox(region) {
  if (Array.isArray(region.box) && region.box.length === 4) {
    return {
      left: region.box[0],
      top: region.box[1],
      width: region.box[2],
      height: region.box[3],
    };
  }
  return {
    left: region.x ?? region.left,
    top: region.y ?? region.top,
    width: region.w ?? region.width,
    height: region.h ?? region.height,
  };
}

function colorValue(value, design, fallback) {
  const requested = String(value || '').trim();
  if (!requested) return fallback;
  if (Object.hasOwn(design.tokens.colors, requested)) return design.tokens.colors[requested];
  return hex(requested, fallback);
}

function fontValue(value, design, fallback = 'body') {
  const requested = String(value || '').trim();
  if (requested && Object.hasOwn(design.tokens.typography, requested)) {
    return design.tokens.typography[requested];
  }
  return design.tokens.typography[fallback] || design.tokens.typography.body;
}

function overlaps(left, right) {
  const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
  const area = width * height;
  const denominator = Math.max(1, Math.min(left.width * left.height, right.width * right.height));
  return { area, ratio: area / denominator };
}

function inside(box, safe) {
  return box.left >= safe.left
    && box.top >= safe.top
    && box.left + box.width <= safe.right
    && box.top + box.height <= safe.bottom;
}

function repairCollision(region, prior, safe, gap) {
  const candidates = [
    { ...region, left: prior.left + prior.width + gap },
    { ...region, top: prior.top + prior.height + gap },
    { ...region, left: prior.left - region.width - gap },
    { ...region, top: prior.top - region.height - gap },
  ].filter((candidate) => inside(candidate, safe));
  candidates.sort((left, right) => (
    (Math.abs(left.left - region.left) + Math.abs(left.top - region.top))
    - (Math.abs(right.left - region.left) + Math.abs(right.top - region.top))
  ));
  return candidates[0] || null;
}

function normalizeRegion(raw, index, {
  units,
  canvas,
  safe,
  slide,
  repairs,
}) {
  if (!plainObject(raw)) {
    throw planError('INVALID_REGION', slide, `Region ${index + 1} must be an object.`);
  }
  const role = String(raw.role || '').trim().toLowerCase();
  if (!PLAN_ROLES.has(role)) {
    throw planError(
      'UNKNOWN_ROLE',
      slide,
      `Region "${raw.id || index + 1}" uses unsupported role "${role}". Use one of: ${[...PLAN_ROLES].join(', ')}.`,
    );
  }
  const id = String(raw.id || `${role}-${index + 1}`).trim();
  const box = rawBox(raw);
  if (Object.values(box).some((value) => !Number.isFinite(Number(value)))) {
    throw planError(
      'MISSING_GEOMETRY',
      slide,
      `Region "${id}" requires numeric x, y, w, h coordinates.`,
      { region: id },
    );
  }
  if (units === 'percent' && Object.values(box).some((value) => Math.abs(Number(value)) > 100)) {
    throw planError(
      'INVALID_UNITS',
      slide,
      `Region "${id}" exceeds the 0-100 percent canvas. Use plan.units:"points" for point coordinates.`,
      { region: id },
    );
  }
  const scaleX = units === 'percent' ? canvas.width / 100 : 1;
  const scaleY = units === 'percent' ? canvas.height / 100 : 1;
  const [minimumWidth, minimumHeight] = REGION_MINIMUMS[role];
  const original = {
    left: Number(box.left) * scaleX,
    top: Number(box.top) * scaleY,
    width: Number(box.width) * scaleX,
    height: Number(box.height) * scaleY,
  };
  const normalized = {
    ...raw,
    id,
    role,
    index: Number.isInteger(Number(raw.index)) ? Number(raw.index) : 0,
    layer: Number.isFinite(Number(raw.layer)) ? Number(raw.layer) : index,
    left: clamp(original.left, safe.left, Math.max(safe.left, safe.right - minimumWidth)),
    top: clamp(original.top, safe.top, Math.max(safe.top, safe.bottom - minimumHeight)),
    width: Math.max(minimumWidth, Number(original.width) || 0),
    height: Math.max(minimumHeight, Number(original.height) || 0),
    style: plainObject(raw.style) ? raw.style : {},
    allowOverlap: raw.allowOverlap === true,
  };
  normalized.width = Math.min(normalized.width, safe.right - normalized.left);
  normalized.height = Math.min(normalized.height, safe.bottom - normalized.top);
  if (normalized.width < minimumWidth || normalized.height < minimumHeight) {
    throw planError(
      'REGION_TOO_SMALL',
      slide,
      `Region "${id}" cannot satisfy its minimum ${minimumWidth}×${minimumHeight} point size inside the safe canvas.`,
      { region: id },
    );
  }
  if (
    rounded(original.left) !== rounded(normalized.left)
    || rounded(original.top) !== rounded(normalized.top)
    || rounded(original.width) !== rounded(normalized.width)
    || rounded(original.height) !== rounded(normalized.height)
  ) {
    repairs.push({
      type: 'bounds',
      region: id,
      from: Object.fromEntries(Object.entries(original).map(([key, value]) => [key, rounded(value)])),
      to: {
        left: rounded(normalized.left),
        top: rounded(normalized.top),
        width: rounded(normalized.width),
        height: rounded(normalized.height),
      },
    });
  }
  return normalized;
}

function repairRegionCollisions(regions, safe, slide, repairs) {
  const gap = 8;
  const placed = [];
  for (const source of regions) {
    let region = { ...source };
    if (!region.allowOverlap) {
      for (const prior of placed.filter((entry) => !entry.allowOverlap)) {
        const collision = overlaps(region, prior);
        if (collision.ratio <= 0.01) continue;
        const repaired = repairCollision(region, prior, safe, gap);
        if (!repaired || placed.some((entry) => !entry.allowOverlap && overlaps(repaired, entry).ratio > 0.01)) {
          throw planError(
            'OVERLAP',
            slide,
            `Regions "${prior.id}" and "${region.id}" overlap ${Math.round(collision.ratio * 100)}% and cannot be repaired inside the safe canvas. Move or resize one region; use allowOverlap:true only for intentional layering.`,
            { regions: [prior.id, region.id], overlapRatio: rounded(collision.ratio) },
          );
        }
        repairs.push({
          type: 'collision',
          region: region.id,
          against: prior.id,
          from: { left: rounded(region.left), top: rounded(region.top) },
          to: { left: rounded(repaired.left), top: rounded(repaired.top) },
        });
        region = repaired;
      }
    }
    placed.push(region);
  }
  return placed;
}

function inferredVisualType(regions) {
  const roles = regions.map((region) => region.role);
  return roles.find((role) => EVIDENCE_ROLES.has(role)) || 'typography';
}

export function normalizePptxModelPlan(operation, design, slide) {
  const source = plainObject(operation?.plan) ? operation.plan : {};
  if (!Array.isArray(source.regions) || source.regions.length === 0) {
    throw planError(
      'REQUIRED',
      slide,
      'compose_slide requires plan.regions for model-first authoring. Provide 0-100 normalized regions with id, role, x, y, w, h.',
    );
  }
  if (source.regions.length > 16) {
    throw planError('TOO_MANY_REGIONS', slide, 'A slide may contain at most 16 model-authored regions.');
  }
  const units = PLAN_UNITS.has(String(source.units || '').toLowerCase())
    ? String(source.units).toLowerCase()
    : 'percent';
  const canvas = canvasSize(design);
  const defaultMargin = units === 'percent' ? 4 : Math.min(canvas.width, canvas.height) * 0.04;
  const requestedMargin = Number(source.safeMargin);
  const margin = units === 'percent'
    ? clamp(Number.isFinite(requestedMargin) ? requestedMargin : defaultMargin, 2, 10) * canvas.width / 100
    : clamp(Number.isFinite(requestedMargin) ? requestedMargin : defaultMargin, 12, Math.min(canvas.width, canvas.height) * 0.12);
  const verticalMargin = units === 'percent'
    ? (margin / canvas.width) * canvas.height
    : margin;
  const safe = {
    left: margin,
    top: verticalMargin,
    right: canvas.width - margin,
    bottom: canvas.height - verticalMargin,
  };
  const repairs = [];
  const ids = new Set();
  const normalized = source.regions.map((region, index) => {
    const entry = normalizeRegion(region, index, {
      units,
      canvas,
      safe,
      slide,
      repairs,
    });
    if (ids.has(entry.id)) {
      throw planError('DUPLICATE_REGION', slide, `Region id "${entry.id}" is duplicated.`);
    }
    ids.add(entry.id);
    return entry;
  });
  const regions = repairRegionCollisions(normalized, safe, slide, repairs);
  if (!regions.some((region) => region.role === 'title')) {
    throw planError('TITLE_REQUIRED', slide, 'Every slide plan requires one title region.');
  }
  const kind = String(operation.kind || 'content').toLowerCase();
  repairs.push(...spreadRegionsVertically(regions, safe, kind));
  const operationHasEvidence = Boolean(
    operation.chart
    || operation.table
    || operation.image
    || operation.imagePath
    || operation.visualText
    || strings(operation.metrics).length
    || strings(operation.steps).length
    || strings(operation.columns).length,
  );
  if (
    !['cover', 'closing', 'statement'].includes(kind)
    && operationHasEvidence
    && !regions.some((region) => EVIDENCE_ROLES.has(region.role))
  ) {
    throw planError(
      'EVIDENCE_REGION_REQUIRED',
      slide,
      'The operation contains evidence but the plan has no semantic evidence region.',
    );
  }
  const readingOrder = strings(source.readingOrder).length
    ? strings(source.readingOrder)
    : [...regions]
      .sort((left, right) => left.top - right.top || left.left - right.left)
      .map((region) => region.id);
  const unknownReadingIds = readingOrder.filter((id) => !ids.has(id));
  if (unknownReadingIds.length) {
    throw planError(
      'UNKNOWN_READING_ORDER',
      slide,
      `readingOrder references unknown regions: ${unknownReadingIds.join(', ')}.`,
    );
  }
  const evidence = strings(source.evidence).length
    ? strings(source.evidence)
    : Array.isArray(operation.metrics)
      ? operation.metrics.map((entry) => String(entry?.value ?? entry?.label ?? '')).filter(Boolean)
      : Array.isArray(operation.steps)
        ? operation.steps.map((entry) => String(entry?.title ?? entry?.label ?? '')).filter(Boolean)
        : Array.isArray(operation.columns)
          ? operation.columns.map((entry) => String(entry?.title ?? '')).filter(Boolean)
          : strings(operation.visualText || operation.body || operation.bullets).slice(0, 3);
  return {
    slide,
    name: String(source.name || ''),
    rationale: String(source.rationale || ''),
    message: String(source.message || operation.title || ''),
    evidence,
    visualType: String(source.visualType || inferredVisualType(regions)).toLowerCase(),
    sourceContract: String(source.sourceContract || 'authored'),
    variant: String(source.variant || source.name || ''),
    capacity: plainObject(source.capacity) ? { ...source.capacity } : {},
    referenceGenome: plainObject(source.referenceGenome) ? { ...source.referenceGenome } : null,
    assetIntent: plainObject(source.assetIntent) ? { ...source.assetIntent } : null,
    referenceSelection: plainObject(source.referenceSelection) ? {
      ...source.referenceSelection,
      ids: strings(source.referenceSelection.ids),
      matches: Array.isArray(source.referenceSelection.matches)
        ? source.referenceSelection.matches.map((entry) => ({ ...entry }))
        : [],
    } : null,
    freeform: plainObject(source.freeform) ? {
      ...source.freeform,
      layers: strings(source.freeform.layers),
      genericMotifs: strings(source.freeform.genericMotifs),
    } : null,
    tournament: plainObject(source.tournament) ? {
      ...source.tournament,
      metrics: plainObject(source.tournament.metrics) ? { ...source.tournament.metrics } : {},
      candidates: Array.isArray(source.tournament.candidates)
        ? source.tournament.candidates.map((candidate) => ({
            ...candidate,
            metrics: plainObject(candidate?.metrics) ? { ...candidate.metrics } : {},
            capacity: plainObject(candidate?.capacity) ? { ...candidate.capacity } : {},
            demand: plainObject(candidate?.demand) ? { ...candidate.demand } : {},
          }))
        : [],
    } : null,
    focalRegion: String(source.focalRegion || 'full').toLowerCase(),
    readingOrder,
    hierarchy: strings(source.hierarchy).length ? strings(source.hierarchy) : readingOrder,
    source: 'model',
    units: 'points',
    canvas,
    safeArea: {
      left: rounded(safe.left),
      top: rounded(safe.top),
      right: rounded(safe.right),
      bottom: rounded(safe.bottom),
    },
    repairs,
    regions: regions.map((region) => ({
      ...region,
      left: rounded(region.left),
      top: rounded(region.top),
      width: rounded(region.width),
      height: rounded(region.height),
    })),
  };
}

function regionGeometry(region) {
  return {
    left: region.left,
    top: region.top,
    width: region.width,
    height: region.height,
  };
}

const CALLOUT_MAX_SIZE = 96;
const CJK_GLYPH = /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af]/u;

// A stat callout starts at the largest size its region can hold (reference
// scale: 60-96pt hero numbers) and only shrinks when the supporting text
// underneath no longer fits. Starting small and never growing is how a
// region ends up as a sticker in a billboard.
function calloutSize(text, region, design, { fontRole = 'display', bold = true, reserve = 0.5 } = {}) {
  const value = String(text || '');
  if (!value.trim()) return 24;
  const fontName = design.tokens.typography[fontRole] || design.tokens.typography.display;
  const latin = [...value].filter((character) => !CJK_GLYPH.test(character)).join('');
  const cjkCount = value.length - latin.length;
  const unitWidth = (measureTextWidth(latin, { fontName, fontSize: 100, bold }) / 100) + (cjkCount * 1.02);
  // The text box keeps an overhang inset that scales with the size, so the
  // line has to fit the region minus that inset, never just the region.
  const byWidth = unitWidth > 0 ? (region.width * 0.94) / (unitWidth + WRAP_OVERHANG_EM) : CALLOUT_MAX_SIZE;
  const byHeight = (region.height * reserve) / 1.2;
  return Math.max(24, Math.floor(Math.min(CALLOUT_MAX_SIZE, byWidth, byHeight)));
}

const TITLE_MIN_SIZE = 24;

// Width per point of size for one line of display text; CJK glyphs are
// budgeted at a full em because the Latin display face measures them through
// a narrower fallback.
function unitLineWidth(line, fontName) {
  const value = String(line || '');
  const latin = [...value].filter((character) => !CJK_GLYPH.test(character)).join('');
  const cjkCount = value.length - latin.length;
  return (measureTextWidth(latin, { fontName, fontSize: 100, bold: true }) / 100) + (cjkCount * 1.02);
}

// Titles take the largest reference size (36-44pt) their region can hold
// instead of shrinking by character count; a long thesis in a tall region
// still leads the page. The text measured is the balanced (line-broken)
// title the renderer actually emits, so each authored line wraps on its own
// and the size only stops shrinking once every line fits the region.
function fittedTitleSize(text, region, design) {
  const preferred = region.height >= 90 ? 44 : 36;
  const fontName = design.tokens.typography.display;
  const units = String(text || '').split('\n').map((line) => unitLineWidth(line, fontName));
  for (let size = preferred; size >= TITLE_MIN_SIZE; size -= 2) {
    // Measured widths run a few percent under PowerPoint's own layout, and
    // the text box keeps a size-scaled overhang inset; the usable line width
    // subtracts both instead of trusting the exact edge.
    const usableWidth = Math.max(1, (region.width * 0.97) - Math.ceil(size * WRAP_OVERHANG_EM));
    const lines = units.reduce(
      (sum, unit) => sum + Math.max(1, Math.ceil((unit * size) / usableWidth)),
      0,
    );
    if (lines * size * 1.2 <= region.height) return size;
  }
  return TITLE_MIN_SIZE;
}

function regionStyle(region, design, {
  fontRole = 'body',
  fontSize = 16,
  colorRole = 'ink',
  bold = false,
} = {}) {
  const style = region.style || {};
  return {
    fontName: fontValue(style.fontRole, design, fontRole),
    fontSize: clamp(style.fontSize || fontSize, MIN_VISIBLE_FONT_SIZE, CALLOUT_MAX_SIZE),
    color: colorValue(style.colorRole || style.color, design, design.tokens.colors[colorRole]),
    bold: style.bold == null ? bold : style.bold === true,
    italic: style.italic === true,
    alignment: ALIGNMENTS.has(String(style.align || '').toLowerCase())
      ? String(style.align).toLowerCase()
      : 'left',
  };
}

function regionFrame(region, design) {
  const style = region.style || {};
  if (!style.fillRole && !style.fillColor && !style.lineRole && !style.lineColor) return [];
  const fill = colorValue(style.fillRole || style.fillColor, design, design.tokens.colors.surface);
  const line = colorValue(style.lineRole || style.lineColor, design, fill);
  return [pptShape(slideNumber(region), style.shapeType || 'rectangle', {
    ...regionGeometry(region),
    fillColor: fill,
    lineColor: line,
    fillTransparency: clamp(style.fillTransparency || 0, 0, 100),
    lineTransparency: clamp(style.lineTransparency || 0, 0, 100),
    rotation: Number(style.rotation) || 0,
  })];
}

function slideNumber(region) {
  return Number(region.slide) || 1;
}

function textForRegion(region, operation) {
  if (region.text != null) return String(region.text);
  if (region.role === 'eyebrow') return String(operation.eyebrow || '');
  if (region.role === 'title') return String(operation.title || '');
  if (region.role === 'subtitle') return String(operation.takeaway || operation.subtitle || '');
  if (region.role === 'meta') return strings(operation.meta).join(' · ');
  if (region.role === 'source') {
    const source = provenanceText(operation.source);
    return source ? `Source: ${source}` : '';
  }
  return '';
}

function renderTextRegion(region, operation, design, slide) {
  const frame = regionFrame({ ...region, slide }, design);
  const defaults = region.role === 'title'
    ? {
        fontRole: 'display',
        fontSize: fittedTitleSize(balancedPptTitle(textForRegion(region, operation)), region, design),
        colorRole: 'ink',
        bold: true,
      }
    : region.role === 'eyebrow'
      ? { fontRole: 'body', fontSize: 12, colorRole: 'accent', bold: true }
      : region.role === 'subtitle'
        ? { fontRole: 'body', fontSize: 18, colorRole: 'muted' }
        : region.role === 'meta'
          ? { fontRole: 'body', fontSize: MIN_VISIBLE_FONT_SIZE, colorRole: 'muted' }
        : region.role === 'source'
          ? { fontRole: 'body', fontSize: MIN_VISIBLE_FONT_SIZE, colorRole: 'muted' }
          : { fontRole: 'body', fontSize: 16, colorRole: 'ink' };
  const style = regionStyle(region, design, defaults);
  let paragraphs = null;
  let text = textForRegion(region, operation);
  if (region.role === 'title') text = balancedPptTitle(text);
  if (region.role === 'body') {
    paragraphs = pptBodyParagraphs(region.text ?? operation.body, design, {
      size: style.fontSize,
      color: style.color,
    });
    text = '';
  } else if (region.role === 'bullets') {
    paragraphs = pptBulletParagraphs(region.text ?? operation.bullets ?? operation.body, design, {
      size: style.fontSize,
      color: style.color,
    });
    text = '';
  }
  if (!text && !paragraphs?.length) return frame;
  return [
    ...frame,
    pptText(slide, text, {
      ...regionGeometry(region),
      ...style,
      marginLeft: clamp(region.style?.padding ?? 0, 0, 24),
      marginTop: clamp(region.style?.padding ?? 0, 0, 24),
      marginRight: clamp(region.style?.padding ?? 0, 0, 24),
      marginBottom: clamp(region.style?.padding ?? 0, 0, 24),
    }, paragraphs),
  ];
}

function metricAt(operation, index) {
  return operation.metric || (Array.isArray(operation.metrics) ? operation.metrics[index] : null) || {};
}

function renderMetricRegion(region, operation, design, slide) {
  const metric = metricAt(operation, region.index);
  const frame = regionFrame({ ...region, slide }, design);
  const value = metricDisplayValue(metric);
  const label = String(metric.label || '');
  const detail = String(metric.detail || '');
  const style = regionStyle(region, design, {
    fontRole: 'display',
    fontSize: calloutSize(value, region, design, { reserve: detail ? 0.45 : 0.55 }),
    colorRole: 'accent',
    bold: true,
  });
  const labelSize = clamp(region.style?.labelSize || 13, MIN_VISIBLE_FONT_SIZE, 24);
  const detailSize = clamp(region.style?.detailSize || MIN_VISIBLE_FONT_SIZE, MIN_VISIBLE_FONT_SIZE, 20);
  const stackFor = (valueSize) => packedTextStack(region, [
    { id: 'value', text: value, fontName: style.fontName, fontSize: valueSize, bold: style.bold },
    {
      id: 'label',
      text: label,
      fontName: design.tokens.typography.body,
      fontSize: labelSize,
      bold: true,
    },
    {
      id: 'detail',
      text: detail,
      fontName: design.tokens.typography.body,
      fontSize: detailSize,
    },
  ], { gap: TEXT_SHAPE_GAP });
  let valueSize = style.fontSize;
  let stack = stackFor(valueSize);
  while (stack.overflow && valueSize > 24) {
    valueSize = Math.max(24, valueSize - 4);
    stack = stackFor(valueSize);
  }
  if (stack.overflow) {
    throw planError(
      'REGION_TOO_SMALL',
      slide,
      `Region "${region.id}" cannot fit its metric value and supporting text at readable size.`,
      { region: region.id },
    );
  }
  return [
    ...frame,
    ...stack.entries.map((entry) => pptText(slide, entry.text, {
      left: region.left,
      top: entry.top,
      width: region.width,
      height: Math.ceil(entry.height),
      fontName: entry.fontName,
      fontSize: entry.fontSize,
      bold: entry.bold === true,
      color: entry.id === 'value' ? style.color : design.tokens.colors.muted,
      alignment: style.alignment,
    })),
  ];
}

function renderMetricsRegion(region, operation, design, slide) {
  const metrics = Array.isArray(operation.metrics) ? operation.metrics.slice(0, 8) : [];
  if (!metrics.length) return [];
  const direction = String(region.direction || region.layout || 'row').toLowerCase();
  const columns = direction === 'column'
    ? 1
    : direction === 'grid'
      ? Math.ceil(Math.sqrt(metrics.length))
      : metrics.length;
  const rows = Math.ceil(metrics.length / columns);
  const gutter = clamp(region.style?.gutter ?? 16, 8, 40);
  const padding = clamp(region.style?.padding ?? 16, 0, 32);
  const cards = region.style?.cards !== false;
  const cellWidth = (region.width - (gutter * (columns - 1))) / columns;
  const cellHeight = (region.height - (gutter * (rows - 1))) / rows;
  const cardFill = colorValue(
    region.style?.cardFillRole || region.style?.cardFillColor,
    design,
    design.inverse ? design.tokens.colors.onInverse : design.tokens.colors.surface,
  );
  const cardTransparency = clamp(region.style?.cardTransparency ?? (design.inverse ? 92 : 0), 0, 100);
  const output = [...regionFrame({ ...region, slide }, design)];
  metrics.forEach((metric, index) => {
    const left = region.left + ((index % columns) * (cellWidth + gutter));
    const top = region.top + (Math.floor(index / columns) * (cellHeight + gutter));
    if (cards) {
      output.push(pptShape(slide, 'rounded_rectangle', {
        left,
        top,
        width: cellWidth,
        height: cellHeight,
        fillColor: cardFill,
        lineColor: cardFill,
        fillTransparency: cardTransparency,
        lineTransparency: cardTransparency,
      }));
    }
    output.push(...renderMetricRegion({
      ...region,
      id: `${region.id}-${index + 1}`,
      index,
      left: left + padding,
      top: top + padding,
      width: cellWidth - (padding * 2),
      height: cellHeight - (padding * 2),
      style: { ...region.style, fillRole: '', fillColor: '', lineRole: '', lineColor: '' },
    }, { ...operation, metric }, design, slide));
  });
  return output;
}

function renderChartRegion(region, operation, design, slide) {
  const chart = plainObject(operation.chart) ? operation.chart : null;
  if (!chart) throw planError('MISSING_CHART', slide, `Region "${region.id}" requires operation.chart.`);
  return [
    ...regionFrame({ ...region, slide }, design),
    {
      op: 'add_chart',
      slide,
      chartType: chart.type || chart.chartType || 'column',
      title: chart.title || '',
      categories: Array.isArray(chart.categories) ? chart.categories : [],
      series: Array.isArray(chart.series) ? chart.series.map((entry, index) => ({
        ...entry,
        color: entry?.color || (
          index === 0
            ? design.tokens.colors.accent
            : index === 1
              ? design.tokens.colors.accent2
              : design.tokens.colors.muted
        ),
      })) : [],
      ...regionGeometry(region),
    },
  ];
}

function renderTableRegion(region, operation, design, slide) {
  const values = Array.isArray(operation.table) ? operation.table : operation.table?.values;
  if (!Array.isArray(values)) {
    throw planError('MISSING_TABLE', slide, `Region "${region.id}" requires operation.table values.`);
  }
  const rows = Math.max(1, values.length);
  const headerRowHeight = Math.min(38, Math.max(24, region.height / Math.max(2, rows + 0.5)));
  const bodyRowHeight = rows > 1
    ? Math.min(54, Math.max(20, (region.height - headerRowHeight) / (rows - 1)))
    : 0;
  return [
    ...regionFrame({ ...region, slide }, design),
    {
      op: 'add_table',
      slide,
      values,
      ...regionGeometry(region),
      properties: {
        fontName: design.tokens.typography.body,
        fontSize: clamp(region.style?.fontSize || MIN_VISIBLE_FONT_SIZE, MIN_VISIBLE_FONT_SIZE, 20),
        color: colorValue(region.style?.colorRole, design, design.tokens.colors.ink),
        headerFillColor: colorValue(region.style?.headerFillRole, design, design.tokens.colors.inverse),
        headerColor: colorValue(region.style?.headerColorRole, design, design.tokens.colors.onInverse),
        bodyFillColor: colorValue(region.style?.bodyFillRole, design, design.tokens.colors.surface),
        headerRowHeight,
        bodyRowHeight,
      },
    },
  ];
}

function renderImageRegion(region, operation, design, slide) {
  const path = operation.image?.path || operation.imagePath;
  if (!path) throw planError('MISSING_IMAGE', slide, `Region "${region.id}" requires operation.image or imagePath.`);
  return [
    ...regionFrame({ ...region, slide }, design),
    { op: 'add_image', slide, path, ...regionGeometry(region) },
  ];
}

function renderVisualRegion(region, operation, design, slide) {
  const frame = regionFrame({ ...region, slide }, design);
  const text = String(region.text ?? operation.visualText ?? '');
  const label = String(region.label ?? operation.visualLabel ?? '');
  const style = regionStyle(region, design, {
    fontRole: 'display',
    fontSize: calloutSize(text, region, design, { reserve: label ? 0.5 : 0.6 }),
    colorRole: 'accent',
    bold: true,
  });
  const alignment = region.style?.align ? style.alignment : 'center';
  const labelSize = clamp(region.style?.labelSize || MIN_VISIBLE_FONT_SIZE, MIN_VISIBLE_FONT_SIZE, 22);
  const stackFor = (valueSize) => packedTextStack(region, [
    {
      id: 'value',
      text,
      fontName: style.fontName,
      fontSize: valueSize,
      bold: style.bold,
      widthScale: /[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af]/u.test(text) ? 1.35 : 1.08,
    },
    {
      id: 'label',
      text: label,
      fontName: design.tokens.typography.body,
      fontSize: labelSize,
      bold: true,
    },
  ], { gap: TEXT_SHAPE_GAP });
  let valueSize = style.fontSize;
  let stack = stackFor(valueSize);
  while (stack.overflow && valueSize > 24) {
    valueSize = Math.max(24, valueSize - 4);
    stack = stackFor(valueSize);
  }
  return [
    ...frame,
    ...stack.entries.map((entry) => pptText(slide, entry.text, {
      left: region.left,
      top: entry.top,
      width: region.width,
      height: Math.ceil(entry.height),
      fontName: entry.fontName,
      fontSize: entry.fontSize,
      bold: entry.bold === true,
      color: entry.id === 'value' ? style.color : design.tokens.colors.muted,
      alignment,
    })),
  ];
}

function renderProcessRegion(region, operation, design, slide) {
  const steps = Array.isArray(operation.steps) ? operation.steps.slice(0, 8) : [];
  if (!steps.length) throw planError('MISSING_STEPS', slide, `Region "${region.id}" requires operation.steps.`);
  const direction = String(region.direction || 'row').toLowerCase();
  const horizontal = direction !== 'column';
  const stride = (horizontal ? region.width : region.height) / steps.length;
  const gutter = clamp(region.style?.gutter ?? 24, 12, 48);
  const bodyFont = design.tokens.typography.body;
  const stepTitle = (step) => String(step.title || step.label || '');
  const stepDetail = (step) => String(step.detail || step.body || '');
  const output = [...regionFrame({ ...region, slide }, design)];
  const pushMarker = (left, top, markerSize, index) => {
    output.push(pptShape(slide, 'oval', {
      left,
      top,
      width: markerSize,
      height: markerSize,
      fillColor: index === 0 ? design.tokens.colors.accent : design.tokens.colors.surface2,
      lineColor: index === 0 ? design.tokens.colors.accent : design.tokens.colors.surface2,
    }));
    output.push(pptText(slide, String(index + 1).padStart(2, '0'), {
      left,
      top: top + (markerSize * 0.2),
      width: markerSize,
      height: markerSize * 0.6,
      fontName: design.tokens.typography.data,
      fontSize: clamp(markerSize * 0.34, MIN_VISIBLE_FONT_SIZE, 18),
      bold: true,
      // Later markers sit on a light surface chip in both light and inverse
      // decks, so the digits use the always-dark inverse token for contrast.
      color: index === 0 ? design.tokens.colors.onAccent : design.tokens.colors.inverse,
      alignment: 'center',
    }));
  };
  if (horizontal) {
    // The flow scales with the field it was given: a half-canvas region gets
    // large markers and readable copy, not a thin band floating in the middle.
    const marker = clamp(region.height * 0.26, 36, 72);
    const titleSize = region.height >= 180 ? 18 : 16;
    const detailSize = region.height >= 180 ? 15 : 14;
    const contentWidth = Math.max(60, stride - gutter);
    const titleBand = Math.ceil(Math.max(titleSize * 1.3, ...steps.map((step) => measuredTextHeight(stepTitle(step), {
      fontName: bodyFont,
      fontSize: titleSize,
      bold: true,
      width: contentWidth,
    }))));
    const detailBand = Math.ceil(Math.max(0, ...steps.map((step) => measuredTextHeight(stepDetail(step), {
      fontName: bodyFont,
      fontSize: detailSize,
      width: contentWidth,
    }))));
    const bandHeight = marker + 14 + titleBand + (detailBand ? TEXT_SHAPE_GAP + detailBand : 0);
    const bandTop = region.top + Math.max(0, (region.height - bandHeight) / 2);
    steps.forEach((step, index) => {
      const left = region.left + (index * stride);
      if (index > 0) {
        // Short connector between markers: each segment stays well under the
        // decorative-stripe width so it reads as flow, not ornament.
        const previousRight = region.left + ((index - 1) * stride) + marker + 8;
        output.push(pptShape(slide, 'line', {
          left: previousRight,
          top: bandTop + (marker / 2),
          width: Math.max(0, left - 8 - previousRight),
          height: 0,
          lineColor: design.tokens.colors.surface2,
          lineWidth: 1.5,
        }));
      }
      pushMarker(left, bandTop, marker, index);
      output.push(pptText(slide, stepTitle(step), {
        left,
        top: bandTop + marker + 14,
        width: contentWidth,
        height: Math.ceil(titleBand),
        fontName: bodyFont,
        fontSize: titleSize,
        bold: true,
        color: design.tokens.colors.ink,
      }));
      const detail = stepDetail(step);
      if (detail) output.push(pptText(slide, detail, {
        left,
        top: bandTop + marker + 14 + titleBand + TEXT_SHAPE_GAP,
        width: contentWidth,
        height: Math.ceil(detailBand),
        fontName: bodyFont,
        fontSize: detailSize,
        color: design.tokens.colors.muted,
      }));
    });
    return output;
  }
  const marker = Math.min(44, region.width * 0.16);
  const textLeft = region.left + marker + 14;
  const textWidth = Math.max(60, region.width - marker - 14);
  steps.forEach((step, index) => {
    const cellTop = region.top + (index * stride);
    const titleHeight = Math.ceil(Math.max(18, measuredTextHeight(stepTitle(step), {
      fontName: bodyFont,
      fontSize: 14,
      bold: true,
      width: textWidth,
    })));
    const detail = stepDetail(step);
    const detailHeight = detail
      ? Math.ceil(measuredTextHeight(detail, {
        fontName: bodyFont,
        fontSize: MIN_VISIBLE_FONT_SIZE,
        width: textWidth,
      }))
      : 0;
    const contentHeight = Math.max(marker, titleHeight + (detailHeight ? TEXT_SHAPE_GAP + detailHeight : 0));
    const top = cellTop + Math.max(0, (stride - contentHeight) / 2);
    pushMarker(region.left, top, marker, index);
    output.push(pptText(slide, stepTitle(step), {
      left: textLeft,
      top,
      width: textWidth,
      height: Math.ceil(titleHeight),
      fontName: bodyFont,
      fontSize: 14,
      bold: true,
      color: design.tokens.colors.ink,
    }));
    if (detail) output.push(pptText(slide, detail, {
      left: textLeft,
      top: top + titleHeight + TEXT_SHAPE_GAP,
      width: textWidth,
      height: Math.ceil(detailHeight),
      fontName: bodyFont,
      fontSize: MIN_VISIBLE_FONT_SIZE,
      color: design.tokens.colors.muted,
    }));
  });
  return output;
}

function renderComparisonRegion(region, operation, design, slide) {
  const columns = Array.isArray(operation.columns) ? operation.columns.slice(0, 4) : [];
  if (!columns.length) throw planError('MISSING_COLUMNS', slide, `Region "${region.id}" requires operation.columns.`);
  const gutter = clamp(region.style?.gutter ?? 20, 12, 40);
  const width = (region.width - (gutter * (columns.length - 1))) / columns.length;
  const titleSize = clamp(region.style?.titleSize || 20, 13, 30);
  const headerBand = Math.ceil(Math.max(24, ...columns.map((column) => measuredTextHeight(String(column.title || ''), {
    fontName: design.tokens.typography.display,
    fontSize: titleSize,
    bold: true,
    width,
  }))));
  const output = [...regionFrame({ ...region, slide }, design)];
  columns.forEach((column, index) => {
    const left = region.left + ((width + gutter) * index);
    output.push(pptText(slide, String(column.title || ''), {
      left,
      top: region.top,
      width,
      height: Math.ceil(headerBand),
      fontName: design.tokens.typography.display,
      fontSize: titleSize,
      bold: true,
      color: index === 0 ? design.tokens.colors.accent : design.tokens.colors.ink,
    }));
    const paragraphs = pptBulletParagraphs(column.items || column.body, design, {
      size: clamp(region.style?.fontSize || 13, MIN_VISIBLE_FONT_SIZE, 20),
      color: design.tokens.colors.muted,
    });
    output.push(pptText(slide, '', {
      left,
      top: region.top + headerBand + 10,
      width,
      height: Math.max(24, region.height - headerBand - 10),
    }, paragraphs));
  });
  return output;
}

function renderShapeRegion(region, operation, design, slide) {
  const style = region.style || {};
  const fill = colorValue(style.fillRole || style.fillColor, design, design.tokens.colors.surface);
  const line = colorValue(style.lineRole || style.lineColor, design, fill);
  return [pptShape(slide, style.shapeType || 'rectangle', {
    ...regionGeometry(region),
    fillColor: fill,
    lineColor: line,
    fillTransparency: clamp(style.fillTransparency || 0, 0, 100),
    lineTransparency: clamp(style.lineTransparency || 0, 0, 100),
    rotation: Number(style.rotation) || 0,
    fontName: fontValue(style.fontRole, design),
    fontSize: clamp(style.fontSize || 14, MIN_VISIBLE_FONT_SIZE, 40),
    color: colorValue(style.colorRole || style.color, design, design.tokens.colors.ink),
    bold: style.bold === true,
    alignment: ALIGNMENTS.has(String(style.align || '').toLowerCase())
      ? String(style.align).toLowerCase()
      : 'center',
  }, String(region.text || ''))];
}

function renderRegion(region, operation, design, slide) {
  if (PPTX_SEMANTIC_ROLES.has(region.role)) {
    return renderPptxSemanticRegion(region, operation, design, slide);
  }
  if (TEXT_ROLES.has(region.role)) return renderTextRegion(region, operation, design, slide);
  if (region.role === 'metric') return renderMetricRegion(region, operation, design, slide);
  if (region.role === 'metrics') return renderMetricsRegion(region, operation, design, slide);
  if (region.role === 'chart') return renderChartRegion(region, operation, design, slide);
  if (region.role === 'table') return renderTableRegion(region, operation, design, slide);
  if (region.role === 'image') return renderImageRegion(region, operation, design, slide);
  if (region.role === 'visual') return renderVisualRegion(region, operation, design, slide);
  if (region.role === 'process') return renderProcessRegion(region, operation, design, slide);
  if (region.role === 'comparison') return renderComparisonRegion(region, operation, design, slide);
  if (region.role === 'shape') return renderShapeRegion(region, operation, design, slide);
  return [];
}

export function expandPptxModelSlide(operation, design, slide, backgroundSpec) {
  if (hasPptxAuthoredScene(operation)) {
    return expandPptxAuthoredScene(operation, design, slide, backgroundSpec);
  }
  const plan = normalizePptxModelPlan(operation, design, slide);
  const inverseBackground = backgroundSpec.backgroundRole === 'inverse';
  const renderDesign = inverseBackground
    ? {
        ...design,
        inverse: true,
        tokens: {
          ...design.tokens,
          colors: {
            ...design.tokens.colors,
            ink: design.tokens.colors.onInverse,
            muted: design.tokens.colors.surface2,
          },
        },
      }
    : design;
  const output = [];
  if (operation.create !== false) {
    output.push({
      op: 'add_slide',
      ...(operation.index ? { index: Number(operation.index) } : {}),
      ...(operation.layout ? { layout: operation.layout } : {}),
    });
  }
  output.push({
    op: 'set_slide_background',
    slide,
    color: backgroundSpec.color,
  });
  const motif = motifOperations({
    design,
    operation,
    slide,
    slideRole: backgroundSpec.slideRole,
    canvas: plan.canvas,
    elements: plan.regions.map((region) => ({ ...region, type: 'text' })),
    backgroundColor: backgroundSpec.color,
  });
  output.push(...motif.operations);
  if (motif.motif) plan.motif = motif.motif;
  const ordered = [...plan.regions].sort((left, right) => left.layer - right.layer);
  for (const region of ordered) output.push(...renderRegion(region, operation, renderDesign, slide));
  const source = provenanceText(operation.source);
  const notes = [
    String(operation.notes || '').trim(),
    source ? `Source: ${source}` : '',
  ].filter(Boolean).join('\r\n');
  if (notes) output.push({ op: 'set_notes', slide, text: notes });
  return { operations: output, plan };
}
