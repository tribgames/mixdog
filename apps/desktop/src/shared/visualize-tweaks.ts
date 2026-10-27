/**
 * Tweaks: adjustable parameters a visualize page declares in
 * `<script type="application/json" id="mx-tweaks">`. The panel draws one
 * control each and applies a change live, by setting a CSS custom property
 * (`var`) or a `data-*` attribute (`attr`) on the page's root element; the
 * file on disk never changes. The page's CSS / script reads those.
 *
 * The block is project content: it is parsed defensively here (types,
 * lengths, names, ranges) and every value is sanitized before it is applied
 * or queued. A malformed block is a page problem (`tweaks: <reason>`).
 */

export type VisualizeTweakType = 'color' | 'range' | 'select' | 'toggle';

export interface VisualizeTweak {
  id: string;
  label: string;
  type: VisualizeTweakType;
  /** Exactly one of these names what the control sets on the page root. */
  var?: string;
  attr?: string;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: Array<{ value: string; label: string }>;
  /** Normalized like any applied value: `#rrggbb`-style color, a number,
   *  an option value, `true` / `false`. */
  default: string;
}

/** One change of the root the panel asks the page for; `value: null` removes
 *  the override (the page's own CSS applies again). */
export interface VisualizeTweakOp {
  var?: string;
  attr?: string;
  value: string | null;
}

export const MAX_VISUALIZE_TWEAKS = 16;
/** Longest `mx-tweaks` text the page sends. */
export const MAX_VISUALIZE_TWEAKS_CHARS = 20_000;
const MAX_OPTIONS = 12;

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const VAR = /^--[a-z0-9-]{1,40}$/;
const ATTR = /^data-[a-z0-9-]{1,40}$/;
const UNIT = /^[a-z%]{0,4}$/;
const OPTION_VALUE = /^[\w .,#%/-]{1,40}$/;
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(0|1|0?\.\d{1,3}|1\.0+)\s*)?\)$/i;

/** `value` as a lower-case hex or `rgb()` / `rgba()` color, else null. */
export function sanitizeTweakColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (HEX.test(text)) return text.toLowerCase();
  const rgb = RGB.exec(text);
  if (!rgb || [rgb[1], rgb[2], rgb[3]].some((part) => Number(part) > 255)) return null;
  return text.toLowerCase().replace(/\s+/g, '');
}

/** The `#rrggbb` an `<input type="color">` shows for a tweak color. */
export function tweakColorInputValue(value: string): string {
  const hex = /^#([0-9a-f]{3,4})$/.exec(value);
  if (hex) return `#${[...hex[1].slice(0, 3)].map((digit) => digit + digit).join('')}`;
  if (/^#[0-9a-f]{6}/.test(value)) return value.slice(0, 7);
  const rgb = RGB.exec(value);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((part) => Number(part).toString(16).padStart(2, '0')).join('')}`;
  return '#000000';
}

const clipText = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : null;

const finiteNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;

/** `raw` clamped into the range and snapped to its step. */
function rangeValue(tweak: VisualizeTweak, raw: number): string {
  const min = tweak.min ?? 0;
  const max = tweak.max ?? 100;
  const step = tweak.step ?? 1;
  const clamped = Math.min(max, Math.max(min, raw));
  const snapped = Math.min(max, min + Math.round((clamped - min) / step) * step);
  return String(Math.round(snapped * 1e6) / 1e6);
}

/** The normalized value `raw` stands for on `tweak`, or null when it is not
 *  an acceptable one (never applied). Numbers are clamped, not refused. */
export function sanitizeTweakValue(tweak: VisualizeTweak, raw: unknown): string | null {
  if (tweak.type === 'color') return sanitizeTweakColor(raw);
  if (tweak.type === 'range') {
    const number = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
    const finite = finiteNumber(number);
    return finite === null ? null : rangeValue(tweak, finite);
  }
  if (tweak.type === 'toggle') {
    if (raw === true || raw === 'true') return 'true';
    if (raw === false || raw === 'false') return 'false';
    return null;
  }
  return typeof raw === 'string' && tweak.options?.some((option) => option.value === raw) ? raw : null;
}

function parseOne(raw: unknown, index: number): { tweak: VisualizeTweak } | { error: string } {
  const where = `control ${index + 1}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${where} is not an object` };
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'string' || !ID.test(item.id))
    return { error: `${where} needs an id of letters, digits, - or _ (max 32)` };
  const name = `control "${item.id}"`;
  const label = item.label === undefined ? item.id : clipText(item.label, 40);
  if (!label) return { error: `${name} has an empty or too long label (max 40)` };
  const type = item.type;
  if (type !== 'color' && type !== 'range' && type !== 'select' && type !== 'toggle') {
    return { error: `${name} type must be color, range, select or toggle` };
  }
  if ((item.var === undefined) === (item.attr === undefined))
    return { error: `${name} needs exactly one of "var" or "attr"` };
  if (item.var !== undefined && (typeof item.var !== 'string' || !VAR.test(item.var))) {
    return { error: `${name} var must look like --my-name (lower-case letters, digits, -)` };
  }
  if (item.attr !== undefined && (typeof item.attr !== 'string' || !ATTR.test(item.attr))) {
    return { error: `${name} attr must look like data-my-name (lower-case letters, digits, -)` };
  }
  const tweak: VisualizeTweak = {
    id: item.id,
    label,
    type,
    ...(typeof item.var === 'string' ? { var: item.var } : { attr: item.attr as string }),
    default: '',
  };
  if (type === 'range') {
    const min = finiteNumber(item.min);
    const max = finiteNumber(item.max);
    const step = item.step === undefined ? 1 : finiteNumber(item.step);
    if (min === null || max === null || max <= min) return { error: `${name} needs numeric min < max` };
    if (step === null || step <= 0) return { error: `${name} step must be a positive number` };
    if (item.unit !== undefined && (typeof item.unit !== 'string' || !UNIT.test(item.unit))) {
      return { error: `${name} unit must be up to 4 letters or %` };
    }
    Object.assign(tweak, { min, max, step, unit: item.unit ?? '' });
  }
  if (type === 'select') {
    const options = Array.isArray(item.options) ? item.options : null;
    if (!options?.length || options.length > MAX_OPTIONS) return { error: `${name} needs 1-${MAX_OPTIONS} options` };
    const parsed: Array<{ value: string; label: string }> = [];
    for (const option of options) {
      const entry = option && typeof option === 'object' ? (option as Record<string, unknown>) : {};
      if (typeof entry.value !== 'string' || !OPTION_VALUE.test(entry.value)) {
        return { error: `${name} option values use letters, digits and . , # % / - _ (max 40)` };
      }
      const optionLabel = entry.label === undefined ? entry.value : clipText(entry.label, 40);
      if (!optionLabel) return { error: `${name} has an option with an empty or too long label` };
      parsed.push({ value: entry.value, label: optionLabel });
    }
    tweak.options = parsed;
  }
  const fallback =
    type === 'range'
      ? tweak.min
      : type === 'select'
        ? tweak.options?.[0]?.value
        : type === 'toggle'
          ? false
          : undefined;
  const given = item.default === undefined ? fallback : item.default;
  const value = sanitizeTweakValue(tweak, given);
  if (value === null) return { error: `${name} has no valid default for type ${type}` };
  tweak.default = value;
  return { tweak };
}

/** The controls a page declared (`raw` is the block's text), or the reason
 *  it is malformed. */
export function parseVisualizeTweaks(raw: string): { tweaks: VisualizeTweak[] } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { error: 'the block is not valid JSON' };
  }
  if (!Array.isArray(data) || !data.length) return { error: 'the block must be a non-empty JSON array of controls' };
  if (data.length > MAX_VISUALIZE_TWEAKS)
    return { error: `at most ${MAX_VISUALIZE_TWEAKS} controls (got ${data.length})` };
  const tweaks: VisualizeTweak[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of data.entries()) {
    const parsed = parseOne(entry, index);
    if ('error' in parsed) return parsed;
    if (seen.has(parsed.tweak.id)) return { error: `duplicate id "${parsed.tweak.id}"` };
    seen.add(parsed.tweak.id);
    tweaks.push(parsed.tweak);
  }
  return { tweaks };
}

/** The CSS value / attribute text a normalized value stands for on the page. */
export function tweakAppliedValue(tweak: VisualizeTweak, value: string): string {
  if (tweak.type === 'range') return `${value}${tweak.unit ?? ''}`;
  if (tweak.type === 'toggle') return tweak.var ? (value === 'true' ? '1' : '0') : value;
  return value;
}

/** What a value reads as in the chip and the prompt. */
export const tweakDisplayValue = (tweak: VisualizeTweak, value: string): string =>
  tweak.type === 'range' ? `${value}${tweak.unit ?? ''}` : value;

/** `values` (by id; a missing or unacceptable one is the default). */
export function tweakValueOf(tweak: VisualizeTweak, values: Readonly<Record<string, string>>): string {
  return sanitizeTweakValue(tweak, values[tweak.id]) ?? tweak.default;
}

/** One op per control: the sanitized override, or removal at its default. */
export function tweakOps(
  tweaks: readonly VisualizeTweak[],
  values: Readonly<Record<string, string>>
): VisualizeTweakOp[] {
  return tweaks.map((tweak) => {
    const value = tweakValueOf(tweak, values);
    return {
      ...(tweak.var ? { var: tweak.var } : { attr: tweak.attr }),
      value: value === tweak.default ? null : tweakAppliedValue(tweak, value),
    };
  });
}

export interface VisualizeTweakChange {
  id: string;
  /** The `--var` or `data-attr` it sets. */
  target: string;
  value: string;
  was: string;
}

/** The controls moved off their defaults. */
export function tweakChanges(
  tweaks: readonly VisualizeTweak[],
  values: Readonly<Record<string, string>>
): VisualizeTweakChange[] {
  const changes: VisualizeTweakChange[] = [];
  for (const tweak of tweaks) {
    const value = tweakValueOf(tweak, values);
    if (value === tweak.default) continue;
    changes.push({
      id: tweak.id,
      target: (tweak.var ?? tweak.attr) as string,
      value: tweakDisplayValue(tweak, value),
      was: tweakDisplayValue(tweak, tweak.default),
    });
  }
  return changes;
}
