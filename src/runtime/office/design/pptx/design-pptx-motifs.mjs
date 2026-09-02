import { MOTIF_SHAPE_PREFIX, isDarkColor } from '../design-discipline.mjs';
import { pptShape, pptText } from './design-pptx-primitives.mjs';
import { inkBox } from './design-pptx-scene-discipline.mjs';

// A motif is the one composition device a style repeats on its anchor pages
// (cover, section, closing) so the deck reads as a designed system instead of
// a stack of unrelated slides. Content slides never receive one: there the
// evidence is the composition. Every renderer is collision-aware and yields
// nothing rather than sitting on top of authored text.
const MOTIF_ROLES = new Set(['cover', 'section', 'closing']);

function overlapArea(left, right) {
  const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
  return width * height;
}

// Collision is judged against what an element paints (its ink), so a wide
// footer text box does not veto the whole bottom band.
function collides(box, elements, tolerance = 0.12) {
  return elements.some((element) => {
    if (!['text', 'chart', 'table', 'image'].includes(element.type)) return false;
    const ink = element.style && String(element.text || '').trim() ? inkBox(element) : element;
    const overlap = overlapArea(box, ink);
    return overlap > Math.min(box.width * box.height, ink.width * ink.height) * tolerance;
  });
}

function firstFreeBox(candidates, elements, tolerance) {
  return candidates.find((box) => !collides(box, elements, tolerance)) || null;
}

// Footer chrome (source lines, page meta) marks the floor a motif must stay above.
function chromeFloor(elements, canvas) {
  const tops = elements
    .filter((element) => ['source', 'meta', 'page-number', 'footer'].includes(String(element.role || '')))
    .filter((element) => element.top > canvas.height * 0.7)
    .map((element) => element.top);
  return tops.length ? Math.min(...tops) - 6 : canvas.height;
}

function fieldTone(backgroundColor, design) {
  const dark = isDarkColor(backgroundColor);
  return {
    dark,
    ink: dark ? design.tokens.colors.onInverse : design.tokens.colors.ink,
    accent: design.tokens.colors.accent,
  };
}

// Swiss grid: one oversized geometric plane zoning the page plus a small
// square-mark register. Large, exact, sparse.
function gridMarks({ slide, canvas, elements, backgroundColor, design }) {
  const tone = fieldTone(backgroundColor, design);
  const floor = chromeFloor(elements, canvas);
  const plane = firstFreeBox([
    { left: canvas.width * 0.72, top: 0, width: canvas.width * 0.28, height: canvas.height },
    { left: 0, top: floor - (canvas.height * 0.2), width: canvas.width, height: canvas.height * 0.2 },
  ], elements, 0.04);
  const operations = [];
  if (plane) {
    operations.push(pptShape(slide, 'rectangle', {
      ...plane,
      fillColor: tone.accent,
      fillTransparency: tone.dark ? 82 : 90,
      lineColor: null,
    }));
  }
  const size = 5;
  const gap = 9;
  const origin = plane && plane.left > 0
    ? { left: plane.left + 24, top: canvas.height - 24 - (gap * 3) - size }
    : { left: canvas.width - 24 - (gap * 3) - size, top: 24 };
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      operations.push(pptShape(slide, 'rectangle', {
        left: origin.left + (column * gap),
        top: origin.top + (row * gap),
        width: size,
        height: size,
        fillColor: tone.ink,
        fillTransparency: (row + column) % 2 ? 70 : 40,
        lineColor: null,
      }));
    }
  }
  return operations;
}

// Editorial: an oversized low-opacity numeral or glyph floating behind the
// content layer — the slide number on a section, the deck's strongest figure
// on a cover.
function oversizedNumeral({ slide, canvas, elements, backgroundColor, design, glyph }) {
  const tone = fieldTone(backgroundColor, design);
  const text = String(glyph || '').trim();
  if (!text) return [];
  const fontSize = text.length <= 2 ? 300 : text.length <= 4 ? 210 : 150;
  const width = Math.min(canvas.width * 0.62, fontSize * 0.62 * text.length + 40);
  const height = fontSize * 1.05;
  const floor = chromeFloor(elements, canvas);
  const box = firstFreeBox([
    { left: canvas.width - width - 12, top: floor - height, width, height },
    { left: canvas.width - width - 12, top: 8, width, height },
    { left: 12, top: floor - height, width, height },
  ], elements, 0.15);
  if (!box) return [];
  // Text runs carry no alpha, so the numeral takes the field's neighbouring
  // ladder step: one tone lighter on dark, one tone darker on light.
  const ghost = tone.dark
    ? (design.tokens.colors.inverse2 || tone.ink)
    : (design.tokens.colors.surface2 || tone.ink);
  return [pptText(slide, text, {
    ...box,
    fontName: design.tokens.typography.display,
    fontSize,
    bold: true,
    color: ghost,
    alignment: 'right',
    verticalAlignment: 'bottom',
  })];
}

// Immersive signal: deep field with one luminous halo, the accent doing the
// work of attention through a single localized glow rather than decoration.
function haloField({ slide, canvas, elements, backgroundColor, design }) {
  const tone = fieldTone(backgroundColor, design);
  const radius = canvas.height * 0.72;
  const halo = firstFreeBox([
    { left: canvas.width - (radius * 0.66), top: canvas.height * 0.5 - (radius / 2), width: radius, height: radius },
    { left: canvas.width - (radius * 0.66), top: -radius * 0.45, width: radius, height: radius },
    { left: -radius * 0.4, top: canvas.height - (radius * 0.55), width: radius, height: radius },
  ], elements, 0.3);
  if (!halo) return [];
  const inner = radius * 0.58;
  return [
    pptShape(slide, 'oval', {
      ...halo,
      fillColor: tone.accent,
      fillTransparency: tone.dark ? 88 : 92,
      lineColor: null,
    }),
    pptShape(slide, 'oval', {
      left: halo.left + ((radius - inner) / 2),
      top: halo.top + ((radius - inner) / 2),
      width: inner,
      height: inner,
      fillColor: tone.accent,
      fillTransparency: tone.dark ? 80 : 86,
      lineColor: null,
    }),
  ];
}

const RENDERERS = Object.freeze({
  'grid-marks': gridMarks,
  'oversized-numeral': oversizedNumeral,
  'halo-field': haloField,
});

export const MOTIF_IDS = Object.freeze(Object.keys(RENDERERS));

export function coverGlyph(operation, slide) {
  const metric = Array.isArray(operation?.metrics) ? operation.metrics[0] : null;
  const value = String(metric?.display ?? metric?.value ?? '').trim();
  if (value) return value.slice(0, 6);
  const scene = operation?.plan?.authoredScene?.elements || [];
  const hero = scene.find((element) => element.type === 'text' && ['visual', 'metric'].includes(String(element.role || '').toLowerCase()));
  if (hero && /\d/.test(String(hero.text || ''))) return String(hero.text).trim().slice(0, 6);
  return String(slide).padStart(2, '0');
}

export function motifOperations({
  design,
  operation,
  slide,
  slideRole,
  canvas,
  elements = [],
  backgroundColor,
}) {
  const style = design?.artDirection?.selected?.style;
  const renderer = RENDERERS[String(style?.motif || '')];
  if (!renderer || !MOTIF_ROLES.has(String(slideRole || ''))) return { operations: [], motif: '' };
  if (design?.deck?.motifs === false || operation?.motif === false) return { operations: [], motif: '' };
  const operations = renderer({
    slide,
    canvas,
    elements,
    backgroundColor,
    design,
    glyph: coverGlyph(operation, slide),
  }).map((entry, index) => ({ ...entry, name: `${MOTIF_SHAPE_PREFIX} ${style.motif} ${index + 1}` }));
  return { operations, motif: operations.length ? style.motif : '' };
}
