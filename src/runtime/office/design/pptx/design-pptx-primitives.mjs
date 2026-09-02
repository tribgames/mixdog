import { strings } from '../design-tokens.mjs';


// PowerPoint lets a wrapped line overhang its frame by roughly 0.3em before
// it breaks, so a zero-inset box can report text bounds wider than the shape.
// The inset on the far side of the alignment absorbs that overhang; explicit
// larger insets from the caller still win.
export const WRAP_OVERHANG_EM = 0.32;

function overhangInsets(properties, paragraphs) {
  const size = Number(properties.fontSize)
    || Math.max(0, ...(paragraphs || []).map((paragraph) => Number(paragraph?.fontSize) || 0));
  const guard = Math.ceil(size * WRAP_OVERHANG_EM);
  if (!guard) return {};
  const alignment = String(properties.alignment || 'left').toLowerCase();
  const marginLeft = Math.max(Number(properties.marginLeft) || 0, alignment === 'right' ? guard : alignment === 'center' ? guard / 2 : 0);
  const marginRight = Math.max(Number(properties.marginRight) || 0, alignment === 'right' ? 0 : alignment === 'center' ? guard / 2 : guard);
  return { marginLeft, marginRight };
}

export function pptText(slide, text, properties = {}, paragraphs = null) {
  return {
    op: 'add_textbox',
    slide,
    text: String(text || ''),
    ...(paragraphs?.length ? { paragraphs } : {}),
    properties: {
      marginLeft: 0,
      marginTop: 0,
      marginRight: 0,
      marginBottom: 0,
      ...properties,
      ...overhangInsets(properties, paragraphs),
    },
  };
}


export function pptShape(slide, shapeType, properties = {}, text = '') {
  return {
    op: 'add_shape',
    slide,
    shapeType,
    text,
    properties,
  };
}


export function pptBodyParagraphs(body, design, { size, color } = {}) {
  return strings(body).map((text) => ({
    text,
    fontName: design.tokens.typography.body,
    fontSize: size || design.format.body,
    color: color || design.tokens.colors.ink,
    breakLine: true,
  }));
}


export function pptBulletParagraphs(body, design, { size, color } = {}) {
  return strings(body).map((text) => ({
    text,
    bullet: true,
    fontName: design.tokens.typography.body,
    fontSize: size || design.format.body,
    color: color || design.tokens.colors.ink,
    breakLine: true,
  }));
}


export function pptTextWeight(text) {
  return [...String(text || '').trim()].reduce(
    (total, character) => total + (/[\u2E80-\u9FFF\uAC00-\uD7AF]/u.test(character) ? 1.7 : 1),
    0,
  );
}


export function pptTitleSize(text, preferred = 34) {
  const length = pptTextWeight(text);
  if (length > 64) return Math.min(preferred, 25);
  if (length > 48) return Math.min(preferred, 28);
  if (length > 34) return Math.min(preferred, 31);
  return preferred;
}


export function balancedPptTitle(text) {
  const value = String(text || '').trim();
  const words = value.split(/\s+/).filter(Boolean);
  const total = pptTextWeight(value);
  if (words.length < 2 || total <= 34) return value;
  let bestIndex = 1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let index = 1; index < words.length; index += 1) {
    const distance = Math.abs(pptTextWeight(words.slice(0, index).join(' ')) - (total / 2));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }
  return `${words.slice(0, bestIndex).join(' ')}\n${words.slice(bestIndex).join(' ')}`;
}

export function canvasSize(design) {
  return {
    width: Math.max(1, Number(design?.format?.canvasWidth) || 960),
    height: Math.max(1, Number(design?.format?.canvasHeight) || 540),
  };
}
