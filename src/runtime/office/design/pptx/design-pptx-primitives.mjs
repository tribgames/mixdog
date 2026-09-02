import { strings } from '../design-tokens.mjs';


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
