import {
  MAX_ACCENT_HUE_FAMILIES,
  MAX_FONT_FAMILIES_PER_SLIDE,
  contrastRatio,
  fontFamilyKey,
  hexToRgb,
  isDarkColor,
  requiredContrast,
  saturatedHueFamilies,
} from '../design-discipline.mjs';
import { hex } from '../design-tokens.mjs';
import { measureTextWidth } from '../../portable/text-metrics.mjs';
import { pptShape, WRAP_OVERHANG_EM } from './design-pptx-primitives.mjs';

const CHROME_ROLES = new Set(['source', 'meta', 'eyebrow', 'page-number', 'footer', 'logo']);
const HERO_ROLES = new Set(['visual', 'metric', 'hero']);
// Role floors keep support copy legible at projection distance; a 12pt body on
// a 960pt canvas reads as a footnote. Anchors follow the reference scale:
// title 36-44, section header 20-24, body 14-16, captions 10-12.
const TYPE_FLOORS = Object.freeze({
  title: 28,
  subtitle: 18,
  body: 14,
  bullets: 14,
  eyebrow: 12,
  meta: 12,
  source: 12,
});
const HOLLOW_RATIO = 0.22;
const HERO_MAX_SIZE = 96;
const CONTAINER_PADDING = 28;
const AXIS_TOLERANCE = 8;
const ROW_TOLERANCE = 6;
const BAND_OCCUPANCY_MINIMUM = 0.06;
const BLEED_AREA_RATIO = 0.35;
const IMAGE_FRAME_INSET = 6;
const SCRIM_TRANSPARENCY = 45;

function sceneError(code, slide, message, details = {}) {
  const error = new Error(`AUTHORED_SCENE_${code} slide ${slide}: ${message}`);
  error.code = `AUTHORED_SCENE_${code}`;
  error.details = { slide, ...details };
  return error;
}

function paletteValues(design) {
  return new Set(Object.values(design?.tokens?.colors || {}).map((value) => String(value).toUpperCase()));
}

// Colors enter as a token role (preferred) or as a hex that already belongs to
// the resolved palette. Anything else is a fresh color the palette never
// planned for, which is exactly how rainbow accents creep in.
export function disciplinedColor(value, design, fallback, { slide, element, field }) {
  const requested = String(value || '').trim();
  if (!requested) return fallback;
  const colors = design.tokens.colors;
  if (Object.hasOwn(colors, requested)) return colors[requested];
  const literal = hex(requested, '');
  if (literal && paletteValues(design).has(literal)) return literal;
  throw sceneError(
    'COLOR_ROLE_REQUIRED',
    slide,
    `Element "${element}" sets ${field} to "${requested}"; use a palette role (${Object.keys(colors).join(', ')}) so the deck keeps one palette.`,
    { element, field, requested },
  );
}

export function disciplinedFont(value, design, fallbackRole, { slide, element }) {
  const requested = String(value || '').trim();
  const typography = design.tokens.typography;
  if (!requested) return typography[fallbackRole] || typography.body;
  if (Object.hasOwn(typography, requested)) return typography[requested];
  const key = fontFamilyKey(requested);
  const matchedRole = Object.keys(typography).find((role) => fontFamilyKey(typography[role]) === key);
  if (matchedRole) return typography[matchedRole];
  throw sceneError(
    'FONT_ROLE_REQUIRED',
    slide,
    `Element "${element}" requests font "${requested}"; use fontRole display, body, or data (${typography.display} / ${typography.body} / ${typography.data}).`,
    { element, requested },
  );
}

function contains(outer, inner) {
  const centerX = inner.left + (inner.width / 2);
  const centerY = inner.top + (inner.height / 2);
  return centerX >= outer.left
    && centerX <= outer.left + outer.width
    && centerY >= outer.top
    && centerY <= outer.top + outer.height;
}

function overlapArea(left, right) {
  const width = Math.max(0, Math.min(left.left + left.width, right.left + right.width) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.top + left.height, right.top + right.height) - Math.max(left.top, right.top));
  return width * height;
}

function fieldBehind(element, elements, backgroundColor) {
  const backing = elements
    .filter((candidate) => candidate !== element
      && candidate.type === 'shape'
      && candidate.layer <= element.layer
      && candidate.style.fillColor
      && candidate.style.fillTransparency <= 40
      && contains(candidate, element))
    .sort((left, right) => right.layer - left.layer)[0];
  return backing ? backing.style.fillColor : backgroundColor;
}

function textElements(elements) {
  return elements.filter((element) => (
    element.type === 'text' || (element.type === 'shape' && String(element.text || '').trim())
  ));
}

export function reviewSceneTypography(elements, slide) {
  const families = new Set(textElements(elements).map((element) => fontFamilyKey(element.style.fontName)).filter(Boolean));
  if (families.size > MAX_FONT_FAMILIES_PER_SLIDE) {
    throw sceneError(
      'FONT_FAMILY_OVERUSE',
      slide,
      `The scene mixes ${families.size} font families; keep at most ${MAX_FONT_FAMILIES_PER_SLIDE} (display, body, data).`,
      { families: [...families] },
    );
  }
}

export function reviewSceneAccents(elements, slide) {
  const colors = elements.flatMap((element) => [
    element.style.color,
    element.style.fillColor,
    element.style.lineColor,
  ]).filter(Boolean);
  const families = saturatedHueFamilies(colors);
  if (families.length > MAX_ACCENT_HUE_FAMILIES) {
    throw sceneError(
      'ACCENT_HUE_OVERUSE',
      slide,
      `The scene uses ${families.length} saturated hue families; keep accents within ${MAX_ACCENT_HUE_FAMILIES} so one color dominates.`,
      { hueFamilies: families },
    );
  }
}

export function reviewSceneContrast(elements, slide, backgroundColor, design) {
  const repairs = [];
  for (const element of textElements(elements)) {
    const field = element.type === 'shape' && element.style.fillColor && element.style.fillTransparency <= 40
      ? element.style.fillColor
      : fieldBehind(element, elements, backgroundColor);
    assertContrast(element, field, slide, design, repairs);
  }
  return repairs;
}

// Accent text keeps its hue but moves to the paired tint for its field: the
// light step on a dark field, the deep step on a light one. Every other
// failing pair is an authoring error the author fixes.
function repairAccentTint(element, field, design, minimum) {
  const role = String(element.style.colorRole || '');
  if (!['accent', 'accent2'].includes(role)) return false;
  const tintRole = `${role}${isDarkColor(field) ? 'Light' : 'Deep'}`;
  const tint = design?.tokens?.colors?.[tintRole];
  const ratio = contrastRatio(tint, field);
  if (ratio == null || ratio < minimum) return false;
  element.style.color = tint;
  element.style.colorRole = tintRole;
  return true;
}

// Neutral text (ink, muted, the on-* roles) on a field it was not planned for
// flips to whichever neutral reads best there, e.g. dark ink on a light amber
// chip instead of white.
const NEUTRAL_TEXT_ROLES = new Set(['ink', 'muted', 'onAccent', 'onInverse', 'canvas', 'surface', 'surface2']);

function repairNeutralText(element, field, design, minimum) {
  if (!NEUTRAL_TEXT_ROLES.has(String(element.style.colorRole || ''))) return false;
  const colors = design?.tokens?.colors || {};
  const best = ['ink', 'onInverse', 'muted']
    .map((role) => ({ role, color: colors[role], ratio: contrastRatio(colors[role], field) || 0 }))
    .sort((left, right) => right.ratio - left.ratio)[0];
  if (!best || best.ratio < minimum) return false;
  element.style.color = best.color;
  element.style.colorRole = best.role;
  return true;
}

function assertContrast(element, field, slide, design, repairs) {
  const ratio = contrastRatio(element.style.color, field);
  if (ratio == null) return;
  const minimum = requiredContrast(element.style);
  if (ratio >= minimum) return;
  if (repairAccentTint(element, field, design, minimum) || repairNeutralText(element, field, design, minimum)) {
    repairs.push({ element: element.id, from: ratio, role: element.style.colorRole });
    return;
  }
  throw sceneError(
    'TEXT_CONTRAST',
    slide,
    `Text "${element.id}" (${element.style.color}) on ${field} measures ${ratio}:1; ${minimum}:1 is required.`,
    { element: element.id, ratio, minimum, field },
  );
}

function bandOccupancy(elements, safe) {
  const height = safe.bottom - safe.top;
  const bands = [0, 1, 2].map((index) => ({
    top: safe.top + (height * index / 3),
    bottom: safe.top + (height * (index + 1) / 3),
    area: 0,
  }));
  const canvasArea = (safe.right - safe.left) * height;
  for (const element of elements) {
    if (CHROME_ROLES.has(element.role)) continue;
    if (element.width * element.height >= canvasArea * 0.9) continue;
    for (const band of bands) {
      const overlap = overlapArea(element, {
        left: safe.left,
        top: band.top,
        width: safe.right - safe.left,
        height: band.bottom - band.top,
      });
      band.area += overlap;
    }
  }
  return bands.map((band) => band.area / (canvasArea / 3));
}

export function reviewSceneBalance(elements, slide, { kind, safe }) {
  if (['cover', 'closing', 'statement', 'section'].includes(kind)) return { bands: bandOccupancy(elements, safe) };
  const bands = bandOccupancy(elements, safe);
  const active = bands.filter((value) => value >= BAND_OCCUPANCY_MINIMUM).length;
  if (active < 2) {
    const emptiest = bands.indexOf(Math.min(...bands));
    throw sceneError(
      'UNBALANCED_COMPOSITION',
      slide,
      `Content sits in one horizontal band (${bands.map((value) => `${Math.round(value * 100)}%`).join(' / ')} top/middle/bottom); the ${['top', 'middle', 'bottom'][emptiest]} band is leftover blank space. Spread evidence or enlarge the focal element.`,
      { bands },
    );
  }
  return { bands };
}

export function typeFloor(role) {
  return TYPE_FLOORS[String(role || '').toLowerCase()] || 0;
}

// A line box with a sliver of height is a diagonal in DrawingML (the preset
// draws corner to corner), so rules snap to true horizontals or verticals.
export function snapLineGeometry(element) {
  if (element.type !== 'line') return element;
  if (element.height <= element.width * 0.08) return { ...element, height: 0 };
  if (element.width <= element.height * 0.08) return { ...element, width: 0 };
  return element;
}

function containerOf(shape, elements) {
  return elements.filter((candidate) => (
    candidate !== shape
    && candidate.layer >= shape.layer
    && contains(shape, candidate)
    && candidate.width <= shape.width
    && candidate.height <= shape.height
  ));
}

const CJK = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u;

// Latin display faces carry no Hangul or Han glyphs, so the canvas measures
// them through a fallback that is narrower than the PowerPoint substitute.
// CJK characters are budgeted at a full em each instead.
function textWidth(element) {
  const value = String(element.text || '').replace(/\n/g, ' ');
  const latin = [...value].filter((character) => !CJK.test(character)).join('');
  const cjkCount = [...value].filter((character) => CJK.test(character)).length;
  return measureTextWidth(latin, {
    fontName: element.style.fontName,
    fontSize: element.style.fontSize,
    bold: element.style.bold,
  }) + (cjkCount * element.style.fontSize * 1.02);
}

// The area a text element actually paints: a wide box around a short label
// is empty canvas, not content. Lines count as their stroke, not their box.
export function inkBox(element) {
  if (element.type === 'text') {
    const lines = Math.max(1, Math.ceil(textWidth(element) / Math.max(1, element.width)));
    const width = Math.min(element.width, textWidth(element) / lines);
    const height = Math.min(element.height, lines * element.style.fontSize * 1.2);
    const offsetX = element.style.alignment === 'center'
      ? (element.width - width) / 2
      : element.style.alignment === 'right' ? element.width - width : 0;
    return { left: element.left + offsetX, top: element.top, width, height };
  }
  if (element.type === 'line') {
    return { left: element.left, top: element.top, width: element.width, height: Math.max(element.height, 2) };
  }
  return { left: element.left, top: element.top, width: element.width, height: element.height };
}

function boundingBox(elements, measure = (element) => element) {
  const boxes = elements.map(measure);
  const left = Math.min(...boxes.map((box) => box.left));
  const top = Math.min(...boxes.map((box) => box.top));
  const right = Math.max(...boxes.map((box) => box.left + box.width));
  const bottom = Math.max(...boxes.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}

// S2 hollow rhythm: a card whose content fills under a third of its area
// reads as a billboard with a sticker. The hero figure first grows toward the
// reference 60-96pt callout scale; if the card is still hollow it shrinks to
// its content plus a generous margin.
export function repairHollowContainers(elements, canvas) {
  const repairs = [];
  const canvasArea = canvas.width * canvas.height;
  for (const shape of elements) {
    if (shape.type !== 'shape' || !shape.style.fillColor || String(shape.text || '').trim()) continue;
    if (shape.width * shape.height >= canvasArea * 0.85) continue;
    const inside = containerOf(shape, elements);
    if (!inside.length) continue;
    // Coverage is the painted ink over the card area; a bounding box would
    // count the empty space between scattered labels as content.
    const coverage = () => inside.reduce((sum, element) => {
      const ink = inkBox(element);
      return sum + (ink.width * ink.height);
    }, 0) / (shape.width * shape.height);
    let content = boundingBox(inside, inkBox);
    let ratio = coverage();
    if (ratio >= HOLLOW_RATIO) continue;
    const hero = inside
      .filter((element) => element.type === 'text' && HERO_ROLES.has(element.role))
      .sort((left, right) => right.style.fontSize - left.style.fontSize)[0];
    if (hero) {
      const previousBottom = hero.top + hero.height;
      const measured = textWidth(hero);
      const targetWidth = shape.width - (CONTAINER_PADDING * 2);
      // The text box keeps a size-scaled overhang inset, so the figure has to
      // fit the card width minus that inset.
      const byWidth = measured > 0
        ? targetWidth / ((measured / hero.style.fontSize) + WRAP_OVERHANG_EM)
        : hero.style.fontSize;
      const byHeight = (shape.height * 0.45) / 1.2;
      // Siblings below the hero move down with it, so growth stops where the
      // lowest of them would leave the card.
      const lowestSibling = Math.max(previousBottom, ...inside.filter((element) => element !== hero).map((element) => element.top + element.height));
      const room = (shape.top + shape.height - 12) - lowestSibling;
      const byRoom = (hero.height + Math.max(0, room)) / 1.25;
      const grown = Math.floor(Math.min(HERO_MAX_SIZE, byWidth, byHeight, byRoom));
      if (grown > hero.style.fontSize) {
        repairs.push({ rule: 'S2', element: hero.id, from: hero.style.fontSize, to: grown, action: 'grow-hero' });
        hero.style.fontSize = grown;
        hero.width = Math.min(
          shape.left + shape.width - CONTAINER_PADDING - hero.left,
          Math.max(hero.width, (textWidth(hero) * 1.04) + (grown * WRAP_OVERHANG_EM)),
        );
        hero.height = Math.max(hero.height, grown * 1.25);
        // Neighbours that sat below the old hero move down with its new height.
        const shift = (hero.top + hero.height) - previousBottom;
        if (shift > 0) {
          for (const sibling of inside) {
            if (sibling !== hero && sibling.top >= previousBottom - 1) sibling.top += shift;
          }
        }
        content = boundingBox(inside, inkBox);
        ratio = coverage();
      }
    }
    const spread = (content.width * content.height) / (shape.width * shape.height);
    if (ratio < HOLLOW_RATIO * 0.25 && spread < 0.4) {
      // Content is a sticker on a billboard: the card shrinks to its content.
      const shrunk = {
        left: Math.max(shape.left, content.left - CONTAINER_PADDING),
        top: Math.max(shape.top, content.top - CONTAINER_PADDING),
      };
      shrunk.width = Math.min(shape.left + shape.width, content.left + content.width + CONTAINER_PADDING) - shrunk.left;
      shrunk.height = Math.min(shape.top + shape.height, content.top + content.height + CONTAINER_PADDING) - shrunk.top;
      if (shrunk.width < shape.width * 0.92 || shrunk.height < shape.height * 0.92) {
        repairs.push({ rule: 'S2', element: shape.id, from: [shape.width, shape.height], to: [shrunk.width, shrunk.height], action: 'shrink-container' });
        Object.assign(shape, shrunk);
        continue;
      }
    }
    // Otherwise the content stays but sits on the card's vertical centre so
    // the empty area splits evenly instead of pooling underneath.
    const centre = shape.top + (shape.height / 2);
    const delta = centre - (content.top + (content.height / 2));
    const lowest = Math.max(...inside.map((element) => element.top + element.height));
    const highest = Math.min(...inside.map((element) => element.top));
    const bounded = Math.max(shape.top + 12 - highest, Math.min(delta, shape.top + shape.height - 12 - lowest));
    if (Math.abs(bounded) > 6) {
      repairs.push({ rule: 'S2', element: shape.id, action: 'centre-content', delta: Math.round(bounded) });
      for (const element of inside) element.top += bounded;
    }
  }
  return repairs;
}

// S4 alignment drift: left edges that differ by a few points were meant to
// share an axis; they snap to the most common edge of their cluster.
export function snapAlignmentAxes(elements) {
  const repairs = [];
  const targets = textElements(elements).filter((element) => element.style.alignment === 'left');
  const clusters = [];
  for (const element of [...targets].sort((left, right) => left.left - right.left)) {
    const cluster = clusters.find((entry) => Math.abs(entry.anchor - element.left) <= AXIS_TOLERANCE);
    if (cluster) cluster.members.push(element);
    else clusters.push({ anchor: element.left, members: [element] });
  }
  for (const cluster of clusters) {
    if (cluster.members.length < 2) continue;
    const counts = new Map();
    for (const member of cluster.members) counts.set(member.left, (counts.get(member.left) || 0) + 1);
    const axis = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
    for (const member of cluster.members) {
      if (member.left === axis) continue;
      repairs.push({ rule: 'S4', element: member.id, from: member.left, to: axis });
      member.width += member.left - axis;
      member.left = axis;
    }
  }
  return repairs;
}

// S5 grid uniformity: three or more peers on one row share equal gutters.
export function equalizeRows(elements) {
  const repairs = [];
  const rows = [];
  for (const element of elements) {
    if (CHROME_ROLES.has(element.role) || element.type === 'line') continue;
    const row = rows.find((entry) => (
      Math.abs(entry.top - element.top) <= ROW_TOLERANCE
      && Math.abs(entry.width - element.width) <= entry.width * 0.1
      && entry.type === element.type
    ));
    if (row) row.members.push(element);
    else rows.push({ top: element.top, width: element.width, type: element.type, members: [element] });
  }
  for (const row of rows) {
    if (row.members.length < 3) continue;
    const members = [...row.members].sort((left, right) => left.left - right.left);
    const gaps = members.slice(1).map((member, index) => member.left - (members[index].left + members[index].width));
    const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
    if (mean <= 0 || gaps.every((gap) => Math.abs(gap - mean) <= mean * 0.05)) continue;
    const first = members[0];
    const last = members[members.length - 1];
    const span = (last.left + last.width) - first.left;
    const total = members.reduce((sum, member) => sum + member.width, 0);
    const gutter = (span - total) / (members.length - 1);
    let cursor = first.left;
    for (const member of members) {
      const delta = cursor - member.left;
      if (Math.abs(delta) > 0.5) {
        repairs.push({ rule: 'S5', element: member.id, from: member.left, to: cursor });
        for (const child of member.type === 'shape' ? containerOf(member, elements) : []) child.left += delta;
        member.left = cursor;
      }
      cursor += member.width + gutter;
    }
  }
  return repairs;
}

// S8 emphasis: the element carrying the most visual weight should be the one
// the brief names as the page's primary (evidence on a proof page, the thesis
// on an opening). Reported, not repaired: rescaling someone else's hierarchy
// is a design decision the author must make.
export function emphasisReport(elements, focalPoint) {
  const weighted = elements
    .filter((element) => !CHROME_ROLES.has(element.role) && element.type !== 'line')
    .filter((element) => !(element.type === 'shape' && !String(element.text || '').trim() && containerOf(element, elements).length))
    .map((element) => {
      // Weight is painted area, so a wide text box around a short line does
      // not outweigh the chart beside it.
      const ink = inkBox(element);
      return {
        element,
        weight: ink.width * ink.height * (element.type === 'text' ? Math.min(2.5, element.style.fontSize / 24) : 1),
      };
    })
    .sort((left, right) => right.weight - left.weight);
  const primary = weighted[0]?.element || null;
  if (!primary) return { primary: '', expected: focalPoint || '', matches: true };
  const isEvidence = ['chart', 'table', 'image'].includes(primary.type) || HERO_ROLES.has(primary.role) || primary.role === 'evidence';
  const isThesis = primary.type === 'text' && ['title', 'subtitle'].includes(primary.role);
  const expected = String(focalPoint || '');
  const matches = expected === 'evidence'
    ? isEvidence
    : ['thesis', 'message', 'decision'].includes(expected)
      ? isThesis || isEvidence
      : true;
  return { primary: primary.id, primaryRole: primary.role || primary.type, expected, matches };
}

// Region plans (the semantic fallback) get the same band rule, but their
// geometry belongs to the renderer, so a top-heavy plan is spread down the
// safe area instead of rejected: tops scale apart, heights stay.
export function spreadRegionsVertically(regions, safe, kind) {
  if (['cover', 'closing', 'section'].includes(kind)) return [];
  const movable = regions.filter((region) => !CHROME_ROLES.has(region.role) || region.role === 'eyebrow');
  if (movable.length < 2) return [];
  const bands = bandOccupancy(regions, safe);
  const lowest = Math.max(...movable.map((region) => region.top + region.height));
  const reach = (lowest - safe.top) / (safe.bottom - safe.top);
  // Two active bands are not enough when everything still ends in the top
  // three quarters; the leftover is blank canvas, not breathing room.
  if (bands.filter((value) => value >= BAND_OCCUPANCY_MINIMUM).length >= 2 && reach >= 0.78) return [];
  const sorted = [...movable].sort((left, right) => left.top - right.top);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const span = last.top - first.top;
  if (span <= 0) return [];
  const target = (safe.bottom - (safe.bottom - safe.top) * 0.08) - last.height - first.top;
  const factor = Math.min(3, Math.max(1, target / span));
  if (factor <= 1.05) return [];
  const repairs = [];
  for (const region of sorted.slice(1)) {
    const top = first.top + ((region.top - first.top) * factor);
    repairs.push({ rule: 'S2', region: region.id, from: region.top, to: top, action: 'spread-vertically' });
    region.top = top;
  }
  return repairs;
}

export function alignmentAxes(elements) {
  const lefts = textElements(elements)
    .filter((element) => !CHROME_ROLES.has(element.role) && element.style.alignment === 'left')
    .map((element) => Math.round(element.left / 6) * 6);
  return [...new Set(lefts)].length;
}

function frameFill(backgroundColor) {
  return isDarkColor(backgroundColor)
    ? { fillColor: 'FFFFFF', fillTransparency: 90, lineColor: 'FFFFFF', lineTransparency: 78 }
    : { fillColor: '000000', fillTransparency: 95, lineColor: '000000', lineTransparency: 84 };
}

// Evidence images get a quiet contained frame so a raw screenshot reads as a
// deliberate exhibit, and a bleed image under text gets a scrim so the copy
// stays legible. Both are emitted as native shapes around the image.
export function imageTreatmentOperations(element, elements, slide, { canvas, backgroundColor, imageTreatment }) {
  const before = [];
  const after = [];
  const area = element.width * element.height;
  const bleed = element.allowBleed === true || area >= canvas.width * canvas.height * BLEED_AREA_RATIO;
  const coveredText = textElements(elements).filter((text) => (
    text.layer > element.layer && overlapArea(text, element) > 0
  ));
  if (bleed && coveredText.length) {
    const rgb = hexToRgb(backgroundColor);
    after.push(pptShape(slide, 'rectangle', {
      left: element.left,
      top: element.top,
      width: element.width,
      height: element.height,
      fillColor: rgb ? backgroundColor : '000000',
      fillTransparency: SCRIM_TRANSPARENCY,
      lineColor: null,
    }));
    return { before, after, treatment: 'scrim' };
  }
  if (bleed || imageTreatment === 'full-bleed-focus') return { before, after, treatment: 'bleed' };
  const backed = elements.some((candidate) => (
    candidate !== element
    && candidate.type === 'shape'
    && candidate.layer < element.layer
    && candidate.style.fillColor
    && contains(candidate, element)
    && candidate.width >= element.width
    && candidate.height >= element.height
  ));
  if (backed) return { before, after, treatment: 'authored-frame' };
  const inset = Math.min(IMAGE_FRAME_INSET, element.left, element.top);
  before.push(pptShape(slide, 'rounded_rectangle', {
    left: element.left - inset,
    top: element.top - inset,
    width: element.width + (inset * 2),
    height: element.height + (inset * 2),
    ...frameFill(backgroundColor),
    lineWidth: 0.75,
  }));
  return { before, after, treatment: 'contained-frame' };
}
