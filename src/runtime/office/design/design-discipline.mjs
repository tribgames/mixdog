import { clamp, plainObject } from '../shared/values.mjs';

// Typefaces that ship with Microsoft Office and render true-to-width in the
// LibreOffice preview used for visual QA. Anything outside this list either
// substitutes with different metrics (so overflow checks lie) or is missing on
// older installs; both silently degrade the deck.
export const SAFE_FONT_FAMILIES = Object.freeze([
  'Arial',
  'Calibri',
  'Cambria',
  'Times New Roman',
  'Courier New',
  'Bookman Old Style',
  'Century Schoolbook',
  'Malgun Gothic',
  '맑은 고딕',
  'Batang',
  '바탕',
]);

const SAFE_FONT_KEYS = new Set(SAFE_FONT_FAMILIES.map((name) => fontFamilyKey(name)));

export const TYPOGRAPHY_ROLES = Object.freeze(['display', 'body', 'data']);
// Motif shapes are named so structural review can tell deliberate decoration
// (a ghosted numeral, a halo) from content that must stay legible.
export const MOTIF_SHAPE_PREFIX = 'Mixdog Motif';

export function isMotifShape(shape) {
  return String(shape?.name || '').startsWith(MOTIF_SHAPE_PREFIX);
}
export const MAX_FONT_FAMILIES_PER_SLIDE = 3;
export const MAX_ACCENT_HUE_FAMILIES = 2;
export const TEXT_CONTRAST_MINIMUM = 4.5;
export const LARGE_TEXT_CONTRAST_MINIMUM = 3;
export const LARGE_TEXT_POINT_SIZE = 24;
export const LARGE_BOLD_TEXT_POINT_SIZE = 18.66;

export function fontFamilyKey(name) {
  return String(name || '')
    .replace(/"/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+(?:semilight|light|semibold|medium|black|thin|extrabold|display)$/u, '');
}

export function isSafeFontFamily(name) {
  const key = fontFamilyKey(name);
  return Boolean(key) && SAFE_FONT_KEYS.has(key);
}

export function isLargeText({ fontSize = 0, bold = false } = {}) {
  const size = Number(fontSize) || 0;
  return size >= LARGE_TEXT_POINT_SIZE || (bold === true && size >= LARGE_BOLD_TEXT_POINT_SIZE);
}

export function normalizeTypographyTokens(requested, fallback) {
  const base = plainObject(fallback) ? fallback : {};
  const source = plainObject(requested) ? requested : {};
  const replaced = [];
  const typography = { ...base };
  for (const role of TYPOGRAPHY_ROLES) {
    const value = String(source[role] || '').trim();
    if (!value) continue;
    if (isSafeFontFamily(value)) {
      typography[role] = value;
      continue;
    }
    replaced.push({ role, requested: value, applied: typography[role] || base.body || 'Calibri' });
  }
  const families = new Set(TYPOGRAPHY_ROLES.map((role) => fontFamilyKey(typography[role])).filter(Boolean));
  return { typography, replaced, familyCount: families.size };
}

export function hexToRgb(value) {
  const normalized = String(value || '').replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(normalized)) return null;
  return [0, 2, 4].map((offset) => Number.parseInt(normalized.slice(offset, offset + 2), 16));
}

export function rgbToHex([red, green, blue]) {
  return [red, green, blue]
    .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

export function hexToHsl(value) {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const [red, green, blue] = rgb.map((channel) => channel / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const lightness = (maximum + minimum) / 2;
  const delta = maximum - minimum;
  if (delta === 0) return { hue: 0, saturation: 0, lightness: lightness * 100 };
  const saturation = delta / (1 - Math.abs((2 * lightness) - 1));
  let hue = maximum === red
    ? ((green - blue) / delta) % 6
    : maximum === green
      ? ((blue - red) / delta) + 2
      : ((red - green) / delta) + 4;
  hue = (hue * 60 + 360) % 360;
  return { hue, saturation: saturation * 100, lightness: lightness * 100 };
}

export function hslToHex(hue, saturation, lightness) {
  const h = ((Number(hue) % 360) + 360) % 360;
  const s = clamp(saturation, 0, 100) / 100;
  const l = clamp(lightness, 0, 100) / 100;
  const chroma = (1 - Math.abs((2 * l) - 1)) * s;
  const segment = h / 60;
  const secondary = chroma * (1 - Math.abs((segment % 2) - 1));
  const [red, green, blue] = segment < 1
    ? [chroma, secondary, 0]
    : segment < 2
      ? [secondary, chroma, 0]
      : segment < 3
        ? [0, chroma, secondary]
        : segment < 4
          ? [0, secondary, chroma]
          : segment < 5
            ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  const offset = l - (chroma / 2);
  return rgbToHex([red, green, blue].map((channel) => (channel + offset) * 255));
}

export function relativeLuminance(value) {
  const rgb = hexToRgb(value);
  if (!rgb) return null;
  const [red, green, blue] = rgb.map((channel) => {
    const scaled = channel / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return (0.2126 * red) + (0.7152 * green) + (0.0722 * blue);
}

export function contrastRatio(foreground, background) {
  const front = relativeLuminance(foreground);
  const back = relativeLuminance(background);
  if (front == null || back == null) return null;
  const lighter = Math.max(front, back);
  const darker = Math.min(front, back);
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 100) / 100;
}

export function isDarkColor(value) {
  const luminance = relativeLuminance(value);
  return luminance != null && luminance < 0.35;
}

function adjustLightnessForContrast(color, against, minimum, direction) {
  const hsl = hexToHsl(color);
  if (!hsl) return color;
  let candidate = color;
  let lightness = hsl.lightness;
  for (let step = 0; step < 40; step += 1) {
    const ratio = contrastRatio(candidate, against);
    if (ratio != null && ratio >= minimum) return candidate;
    lightness = clamp(lightness + (direction * 2.5), 0, 100);
    candidate = hslToHex(hsl.hue, hsl.saturation, lightness);
    if (lightness === 0 || lightness === 100) break;
  }
  return candidate;
}

function ensureContrast(colors, foregroundRole, backgroundRole, minimum, adjustments) {
  const foreground = colors[foregroundRole];
  const background = colors[backgroundRole];
  const ratio = contrastRatio(foreground, background);
  if (ratio == null || ratio >= minimum) return;
  const direction = relativeLuminance(background) >= 0.5 ? -1 : 1;
  const repaired = adjustLightnessForContrast(foreground, background, minimum, direction);
  if (repaired !== foreground) {
    colors[foregroundRole] = repaired;
    adjustments.push({
      role: foregroundRole,
      from: foreground,
      to: repaired,
      reason: `${foregroundRole} on ${backgroundRole} measured ${ratio}:1; ${minimum}:1 is required.`,
    });
  }
}

// Repairs only what makes text unreadable or the deck look unfinished: pure
// black fields, background tints that are too saturated, and foreground roles
// that fail WCAG against the field they sit on. Hue choices stay untouched so
// explicit brand palettes survive.
export function normalizePaletteTokens(source) {
  const colors = { ...(plainObject(source) ? source : {}) };
  const adjustments = [];
  const inverse = hexToHsl(colors.inverse);
  if (inverse && (inverse.lightness < 7 || inverse.saturation < 8)) {
    const repaired = hslToHex(
      inverse.saturation < 8 ? (hexToHsl(colors.accent)?.hue ?? 216) : inverse.hue,
      clamp(Math.max(inverse.saturation, 22), 12, 40),
      clamp(Math.max(inverse.lightness, 10), 10, 20),
    );
    adjustments.push({ role: 'inverse', from: colors.inverse, to: repaired, reason: 'Dark fields stay tinted between 10% and 20% lightness; pure black reads as unfinished.' });
    colors.inverse = repaired;
  }
  const canvas = hexToHsl(colors.canvas);
  if (canvas && (canvas.lightness < 90 || canvas.saturation > 22)) {
    const repaired = hslToHex(canvas.hue, Math.min(canvas.saturation, 18), Math.max(canvas.lightness, 95));
    adjustments.push({ role: 'canvas', from: colors.canvas, to: repaired, reason: 'Light canvases stay near-white with low saturation.' });
    colors.canvas = repaired;
  }
  ensureContrast(colors, 'ink', 'canvas', 7, adjustments);
  ensureContrast(colors, 'muted', 'canvas', TEXT_CONTRAST_MINIMUM, adjustments);
  // Muted copy also lands on surface panels, so it must clear the darkest one.
  for (const panel of ['surface', 'surface2']) {
    if (hexToRgb(colors[panel])) ensureContrast(colors, 'muted', panel, TEXT_CONTRAST_MINIMUM, adjustments);
  }
  ensureContrast(colors, 'onInverse', 'inverse', TEXT_CONTRAST_MINIMUM, adjustments);
  ensureContrast(colors, 'onAccent', 'accent', LARGE_TEXT_CONTRAST_MINIMUM, adjustments);
  // A second dark step gives panels and cards on a dark field a planned tone,
  // so authors stop inventing near-black hexes for every card.
  const darkField = hexToHsl(colors.inverse);
  if (darkField && !hexToRgb(colors.inverse2)) {
    colors.inverse2 = hslToHex(darkField.hue, darkField.saturation, clamp(darkField.lightness + 7, 14, 30));
  }
  // Accents are tuned for light canvases; on the dark field the same hue needs
  // a lighter step to stay legible, so each accent gets a paired tint.
  // Each tint clears the hardest field of its kind (the lightest dark panel,
  // the darkest light panel) so it also passes on the plain canvas or field.
  const darkPanel = hexToRgb(colors.inverse2) ? colors.inverse2 : colors.inverse;
  const lightPanel = hexToRgb(colors.surface2) ? colors.surface2 : colors.canvas;
  for (const role of ['accent', 'accent2']) {
    if (!hexToRgb(colors[role])) continue;
    if (!hexToRgb(colors[`${role}Light`]) && hexToRgb(darkPanel)) {
      colors[`${role}Light`] = adjustLightnessForContrast(colors[role], darkPanel, TEXT_CONTRAST_MINIMUM, 1);
    }
    if (!hexToRgb(colors[`${role}Deep`]) && hexToRgb(lightPanel)) {
      colors[`${role}Deep`] = adjustLightnessForContrast(colors[role], lightPanel, TEXT_CONTRAST_MINIMUM, -1);
    }
  }
  return { colors, adjustments };
}

export function paletteSlots(colors) {
  const source = plainObject(colors) ? colors : {};
  return {
    dominant: source.accent || '',
    secondary: source.accent2 || '',
    darkField: source.inverse || '',
    lightField: source.canvas || '',
    softAccent: source.surface || '',
    mutedText: source.muted || '',
  };
}

export function hueFamily(value) {
  const hsl = hexToHsl(value);
  if (!hsl) return null;
  if (hsl.saturation < 35 || hsl.lightness < 18 || hsl.lightness > 88) return null;
  return Math.floor(((hsl.hue + 15) % 360) / 30);
}

export function saturatedHueFamilies(values) {
  const families = new Set();
  for (const value of values || []) {
    const family = hueFamily(value);
    if (family != null) families.add(family);
  }
  return [...families];
}

export function requiredContrast(style = {}) {
  return isLargeText(style) ? LARGE_TEXT_CONTRAST_MINIMUM : TEXT_CONTRAST_MINIMUM;
}

export function designDisciplineBrief(tokens) {
  const typography = plainObject(tokens?.typography) ? tokens.typography : {};
  const colors = plainObject(tokens?.colors) ? tokens.colors : {};
  return {
    typographyRoles: {
      display: typography.display || '',
      body: typography.body || '',
      data: typography.data || '',
    },
    paletteSlots: paletteSlots(colors),
    colorRoles: Object.keys(colors),
    rules: [
      `Text uses fontRole display/body/data only; at most ${MAX_FONT_FAMILIES_PER_SLIDE} families per slide.`,
      'Colors use colorRole/fillRole/lineRole from the palette; free hex values are rejected.',
      `Dominant color carries 60-70% of visual weight; saturated accents stay within ${MAX_ACCENT_HUE_FAMILIES} hue families per deck and under 10% of the canvas.`,
      `Text contrast against its field is at least ${TEXT_CONTRAST_MINIMUM}:1 (${LARGE_TEXT_CONTRAST_MINIMUM}:1 from ${LARGE_TEXT_POINT_SIZE}pt).`,
      'Content slides occupy at least two of three horizontal bands; leftover blank space is a defect, not negative space.',
      'Evidence images sit in a contained frame; bleed images under text carry a scrim.',
      'No accent stripes, title underlines, or equal card grids.',
    ],
  };
}
