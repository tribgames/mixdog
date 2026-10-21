// Pure colour maths for skins (no DOM, no canvas): contrast, plate tones and
// the readability guard. desktop-skin.ts applies the results as CSS variables.

export type SkinPlate = 'light' | 'dark' | 'tint';
export type SkinTheme = 'light' | 'dark';
export type SkinCast = { hue: number; sat: number };

export const TEXT_CONTRAST = 4.5;
export const UI_CONTRAST = 3;

/** Transparency sliders (0–100%; higher = more of the picture shows through).
    Two sliders: the outer one drives the frame (window frame, titlebar band,
    rail) and the panel plates (session sidebar, side dock); the main one
    drives the conversation veil and the cards on it (composer, status
    island). Each value walks its plates through piecewise-linear knots every
    25 points. The old three strengths are knots: strong = 25, normal = 50,
    soft = 75 (what an old single value migrates from); 0 and 100 extend the
    same curves within sane bounds. */
export const DEFAULT_TRANSPARENCY = 50;
/** Both panel families start at the same transparency. */
export const DEFAULT_MAIN_TRANSPARENCY = 50;
export const LEGACY_DIM_TRANSPARENCY: Record<string, number> = { strong: 25, normal: 50, soft: 75 };
const KNOT_STEP = 25;
const PLATE_KNOTS = {
  frame: [0.7, 0.55, 0.4, 0.28, 0.1],
  veil: [0.5, 0.38, 0.22, 0.14, 0.04],
  panel: [0.72, 0.58, 0.4, 0.28, 0.1],
  card: [0.98, 0.93, 0.85, 0.76, 0.62],
};
export type SkinAmounts = Record<keyof typeof PLATE_KNOTS, number>;

export function clampTransparency(value: number): number {
  return Number.isFinite(value) ? Math.round(Math.min(100, Math.max(0, value))) : DEFAULT_TRANSPARENCY;
}

/** Plate opacities at the two transparencies (`main` follows `outer` when
    omitted), before the contrast guards: frame + panel follow the outer one,
    veil + card the main one. */
export function plateAmounts(outer: number, main: number = outer): SkinAmounts {
  const lerp = (knots: number[], transparency: number) => {
    const t = clampTransparency(transparency);
    const at = Math.min(Math.floor(t / KNOT_STEP), knots.length - 2);
    return knots[at] + (knots[at + 1] - knots[at]) * ((t - at * KNOT_STEP) / KNOT_STEP);
  };
  return {
    frame: lerp(PLATE_KNOTS.frame, outer),
    panel: lerp(PLATE_KNOTS.panel, outer),
    veil: lerp(PLATE_KNOTS.veil, main),
    card: lerp(PLATE_KNOTS.card, main),
  };
}

/** Minimum contrast of the ink-drawn marks against the plate they sit on
    (and, through the stacked backdrops, the picture under it), and the
    highest ink opacity each may use. */
export const MARK_TARGETS = { rule: 1.5, edge: 2, edgeStrong: 3, fill: 1.15, fillStrong: 1.3 };
const MARK_CAPS = { rule: 0.5, edge: 0.6, edgeStrong: 0.75, fill: 0.3, fillStrong: 0.4 };
export type SkinMarks = Record<keyof typeof MARK_TARGETS, number>;

const LIGHT_INK = '#ffffff';
const DARK_INK = '#1a1a1a';

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

function rgbToHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

export function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** `top` laid over `bottom` at `alpha`, in sRGB like CSS color-mix. */
export function blend(top: string, bottom: string, alpha: number): string {
  const t = hexToRgb(top);
  const b = hexToRgb(bottom);
  return rgbToHex(t.map((v, i) => v * alpha + b[i] * (1 - alpha)) as Rgb);
}

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToHex(h: number, s: number, l: number): string {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const channel = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))));
  return `#${[channel(0), channel(8), channel(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

function hexToHsl(hex: string): [number, number, number] {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r / 255, g / 255, b / 255);
}

/** Readable ink on a fill: whichever of white / near-black contrasts more. */
export function inkOn(hex: string): string {
  return contrastRatio(hex, LIGHT_INK) >= contrastRatio(hex, DARK_INK) ? LIGHT_INK : DARK_INK;
}

/** Hue/saturation of a colour, for skins saved before the cast existed. */
export function castOfColor(hex: string): SkinCast {
  const [h, s] = hexToHsl(hex);
  return { hue: Math.round(h), sat: Math.round(s * 100) };
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** CSS background-position for a subject point (fractions 0–1 of the picture). */
export function focalOfPoint(x: number, y: number): string {
  const pct = (v: number) => Math.round(clamp(Number.isFinite(v) ? v : 0.5, 0, 1) * 100);
  return `${pct(x)}% ${pct(y)}%`;
}

export type PlateTones = { tint: string; ink: string; muted: string };

/** The plate colour and its ink. `tint` follows the picture's cast and the
    theme; `light` / `dark` are cream / charcoal glass with a faint cast. */
export function plateTones(plate: SkinPlate, theme: SkinTheme, cast: SkinCast): PlateTones {
  const { hue, sat } = cast;
  const tone = plate === 'tint' ? (theme === 'light' ? 'light' : 'dark') : plate;
  if (plate === 'tint') {
    return tone === 'light'
      ? {
          tint: hslToHex(hue, clamp(sat * 0.6, 25, 50) / 100, 0.94),
          ink: hslToHex(hue, 0.45, 0.17),
          muted: hslToHex(hue, 0.25, 0.36),
        }
      : {
          tint: hslToHex(hue, clamp(sat * 0.45, 18, 38) / 100, 0.13),
          ink: hslToHex(hue, 0.3, 0.93),
          muted: hslToHex(hue, 0.18, 0.72),
        };
  }
  return tone === 'light'
    ? {
        tint: hslToHex(hue, clamp(sat * 0.3, 15, 30) / 100, 0.97),
        ink: hslToHex(hue, 0.4, 0.13),
        muted: hslToHex(hue, 0.22, 0.3),
      }
    : {
        tint: hslToHex(hue, clamp(sat * 0.3, 12, 26) / 100, 0.1),
        ink: hslToHex(hue, 0.25, 0.94),
        muted: hslToHex(hue, 0.15, 0.74),
      };
}

/** Lowest plate opacity at which every ink stays ≥ 4.5:1 even over the worst
    picture pixel (black under a light plate, white under a dark one). */
export function minPlateAlpha(tint: string, ...inks: string[]): number {
  const worst = luminance(tint) > luminance(inks[0]) ? '#000000' : '#ffffff';
  return minAlphaOver(tint, worst, inks);
}

/** Lowest opacity of the `tint` plate over `picture` that keeps every ink at 4.5:1. */
export function minAlphaOver(tint: string, picture: string, inks: string[]): number {
  for (let alpha = 0; alpha <= 100; alpha++) {
    const plate = blend(tint, picture, alpha / 100);
    if (inks.every((ink) => contrastRatio(plate, ink) >= TEXT_CONTRAST)) return alpha / 100;
  }
  return 1;
}

/** Nudge the accent's lightness away from the plate (darker on a light plate,
    lighter on a dark one) until it is ≥ 3:1 against the plate as a border /
    focus ring AND its own text (inkOn) is ≥ 4.5:1 as a fill. */
export function fitAccent(accent: string, plate: string): string {
  const [h, s, l] = hexToHsl(accent);
  const direction = luminance(plate) > 0.4 ? -1 : 1;
  const ok = (hex: string) =>
    contrastRatio(hex, plate) >= UI_CONTRAST && contrastRatio(hex, inkOn(hex)) >= TEXT_CONTRAST;
  let candidate = accent;
  for (let step = 0; step <= 100 && !ok(candidate); step++) {
    candidate = hslToHex(h, s, clamp(l + direction * step * 0.01, 0, 1));
  }
  return candidate;
}

/** Luminance where white and black ink contrast equally: lighter backdrops
    take darker ink, darker ones lighter ink. */
const INK_PIVOT = 0.179;

/** Nudge an ink's lightness away from its backdrops (same hue) until it
    holds `target` against every one of them; white or black (whichever holds
    better) when no lightness does. A passing ink comes back unchanged. */
export function fitInk(ink: string, backdrops: string[], target = TEXT_CONTRAST): string {
  const ok = (hex: string) => backdrops.every((backdrop) => contrastRatio(hex, backdrop) >= target);
  if (ok(ink)) return ink;
  const [h, s, l] = hexToHsl(ink);
  const average = backdrops.reduce((sum, backdrop) => sum + luminance(backdrop), 0) / backdrops.length;
  const direction = average > INK_PIVOT ? -1 : 1;
  for (let step = 1; step <= 100; step++) {
    const candidate = hslToHex(h, s, clamp(l + direction * step * 0.01, 0, 1));
    if (ok(candidate)) return candidate;
  }
  const worst = (hex: string) => Math.min(...backdrops.map((backdrop) => contrastRatio(hex, backdrop)));
  return worst('#ffffff') >= worst('#000000') ? '#ffffff' : '#000000';
}

/** What lies under each plate once they stack: the frame over the picture
    (average colour), the sidebar / main veil over the frame, the message and
    prompt card over the veil. [frame, panel, veil, card] */
export function plateBackdrops(tint: string, picture: string, amounts: SkinAmounts): string[] {
  const frame = blend(tint, picture, amounts.frame);
  const veil = blend(tint, frame, amounts.veil);
  return [frame, blend(tint, frame, amounts.panel), veil, blend(tint, veil, amounts.card)];
}

/** Lowest opacity of `ink` laid on every backdrop that keeps it at `target`
    contrast against that backdrop; `cap` when the target is out of reach. */
function inkAlpha(ink: string, backdrops: string[], target: number, cap: number): number {
  for (let percent = 0; percent < cap * 100; percent++) {
    const alpha = percent / 100;
    if (backdrops.every((backdrop) => contrastRatio(blend(ink, backdrop, alpha), backdrop) >= target)) return alpha;
  }
  return cap;
}

export type SkinPalette = PlateTones & {
  accent: string;
  onAccent: string;
  /** Plate opacities after the card's contrast guard. */
  amounts: SkinAmounts;
  cardAmount: number;
  /** Ink opacity of the plate's rules, outlines and fills (see MARK_TARGETS). */
  marks: SkinMarks;
  /** Ink of rail / chrome icons and labels, and its muted step: both hold
      4.5:1 against the frame plate over the picture's average (so icons clear
      their 3:1 with room to spare). */
  chromeInk: string;
  chromeMuted: string;
};

/** Everything a skin paints. `picture` is the picture's average colour: the
    marks and the chrome ink are guarded against the plates stacked over it.
    Card rule: the text plates (messages, prompt card) are never thinner than
    the opacity that keeps every ink at 4.5:1 over the worst picture pixel, so
    at high transparency the card amount is clamped there while the other
    plates keep thinning. Chrome rule: the frame plate (under the rail, the
    tab strip and every other plate) is never thinner than the opacity that
    keeps the ink at 4.5:1 over the picture's average (the muted step falls
    back to the full ink where it cannot hold 4.5:1), so rail / chrome icons
    and labels stay readable where plate and picture disagree. The marks only ever strengthen as transparency rises (the
    largest guard over the way up from 0 to the two transparencies applies).
    The frame guard belongs to the outer family, the card guard to the main
    one, so each slider's plates hold their contrast at any value. */
export function resolvePalette(input: {
  accent: string;
  cast: SkinCast;
  plate: SkinPlate;
  theme: SkinTheme;
  outerTransparency: number;
  mainTransparency: number;
  picture: string;
}): SkinPalette {
  const tones = plateTones(input.plate, input.theme, input.cast);
  const accent = fitAccent(input.accent, tones.tint);
  const cardFloor = minPlateAlpha(tones.tint, tones.ink, tones.muted);
  const frameFloor = minAlphaOver(tones.tint, input.picture, [tones.ink]);
  const amountsAt = (outer: number, main: number): SkinAmounts => {
    const amounts = plateAmounts(outer, main);
    return { ...amounts, frame: Math.max(amounts.frame, frameFloor), card: Math.max(amounts.card, cardFloor) };
  };
  const outer = clampTransparency(input.outerTransparency);
  const main = clampTransparency(input.mainTransparency);
  const chromeInk = tones.ink;
  const marks: SkinMarks = { rule: 0, edge: 0, edgeStrong: 0, fill: 0, fillStrong: 0 };
  const steps = new Set<number>([Math.max(outer, main)]);
  for (let step = 0; step < Math.max(outer, main); step += 5) steps.add(step);
  for (const step of steps) {
    const backdrops = plateBackdrops(tones.tint, input.picture, amountsAt(Math.min(step, outer), Math.min(step, main)));
    for (const name of Object.keys(marks) as Array<keyof SkinMarks>) {
      marks[name] = Math.max(marks[name], inkAlpha(chromeInk, backdrops, MARK_TARGETS[name], MARK_CAPS[name]));
    }
  }
  const amounts = amountsAt(outer, main);
  return {
    ...tones,
    accent,
    onAccent: inkOn(accent),
    amounts,
    cardAmount: amounts.card,
    marks,
    chromeInk,
    // The muted step is used only while it still holds 4.5:1; else the full ink.
    chromeMuted: plateBackdrops(tones.tint, input.picture, amounts)
      .slice(0, 3)
      .every((backdrop) => contrastRatio(tones.muted, backdrop) >= TEXT_CONTRAST)
      ? tones.muted
      : tones.ink,
  };
}
