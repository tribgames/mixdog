// Fonts (Settings → Theme): the UI and code font families, the UI and
// code sizes and code ligatures. Device-local like the skin, applied on the
// root before the first paint (bootstrap.tsx). A chosen family is PREPENDED
// to the built-in stack (desktop/01-tokens.css composes
// var(--mx-font-ui-user,) var(--mx-font-prose-base)), so the bundled faces and
// OS fallbacks still cover every glyph the chosen font lacks.
export type FontSettings = {
  /** UI family; '' = the built-in stack. */
  ui: string;
  /** Code (mono) family; '' = the built-in stack. */
  mono: string;
  /** Multiplier of the whole type ramp (--mx-content-scale). */
  uiScale: number;
  /** Code text size in px at the default UI size. */
  codeSize: number;
  ligatures: boolean;
};

export const UI_SCALE_RANGE = { min: 0.85, max: 1.2, step: 0.05 } as const;
export const CODE_SIZE_RANGE = { min: 10, max: 20 } as const;
const BASE_CODE_SIZE = 13;
export const DEFAULT_FONT_SETTINGS: Readonly<FontSettings> = {
  ui: '',
  mono: '',
  uiScale: 1,
  codeSize: BASE_CODE_SIZE,
  ligatures: true,
};

const FONTS_KEY = 'mixdog.desktop.fonts.v1';
const CHANGE_EVENT = 'mixdog:fonts-changed';
const FAMILY_MAX = 64;
/** CSS generic and wide keywords: quoted they name no real font, so they are refused. */
const RESERVED = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
  'inherit',
  'initial',
  'unset',
  'revert',
  'revert-layer',
  'default',
]);

/** A family name safe to quote into CSS, or '' when it is not one: letters
    (any script), digits, spaces and - _ . & + ' only, at most 64 characters.
    Quotes around the name are dropped; anything that could close the string
    or the declaration (" \ ; { } ( ) < > , control characters) is refused. */
export function sanitizeFontFamily(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const name = raw
    .normalize('NFC')
    .replace(/^[\s"']+|[\s"']+$/g, '')
    .replace(/\s+/g, ' ');
  if (!name || name.length > FAMILY_MAX) return '';
  if (!/^[\p{L}\p{M}\p{N} _\-.&+']+$/u.test(name)) return '';
  return RESERVED.has(name.toLowerCase()) ? '' : name;
}

/** The value of --mx-font-ui-user / --mx-font-mono-user: the quoted family
    and the comma the built-in stack continues after; '' for no family. */
export function userFontPrefix(family: string): string {
  const name = sanitizeFontFamily(family);
  return name ? `"${name}",` : '';
}

function clampScale(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : 1;
  const stepped = Math.round(number / UI_SCALE_RANGE.step) * UI_SCALE_RANGE.step;
  return Math.round(Math.min(UI_SCALE_RANGE.max, Math.max(UI_SCALE_RANGE.min, stepped)) * 100) / 100;
}

function clampCodeSize(value: unknown): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : BASE_CODE_SIZE;
  return Math.min(CODE_SIZE_RANGE.max, Math.max(CODE_SIZE_RANGE.min, number));
}

/** Any stored or requested value, made valid (bad parts take their default). */
export function normalizeFontSettings(input: Partial<Record<keyof FontSettings, unknown>> | null): FontSettings {
  return {
    ui: sanitizeFontFamily(input?.ui),
    mono: sanitizeFontFamily(input?.mono),
    uiScale: clampScale(input?.uiScale),
    codeSize: clampCodeSize(input?.codeSize),
    ligatures: input?.ligatures !== false,
  };
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getFontSettings(): FontSettings {
  try {
    return normalizeFontSettings(JSON.parse(storage()?.getItem(FONTS_KEY) || 'null'));
  } catch {
    return { ...DEFAULT_FONT_SETTINGS };
  }
}

/** Paint the settings on <html>. Defaults clear their property, so the
    stylesheet's own values apply untouched. */
export function applyFontSettings(settings: FontSettings = getFontSettings()): void {
  const root = document.documentElement;
  const set = (name: string, value: string) => {
    if (value) root.style.setProperty(name, value);
    else root.style.removeProperty(name);
  };
  set('--mx-font-ui-user', userFontPrefix(settings.ui));
  set('--mx-font-mono-user', userFontPrefix(settings.mono));
  set('--mx-ui-scale', settings.uiScale === 1 ? '' : String(settings.uiScale));
  set(
    '--mx-code-scale',
    settings.codeSize === BASE_CODE_SIZE ? '' : String(Math.round((settings.codeSize / BASE_CODE_SIZE) * 1e4) / 1e4)
  );
  if (settings.ligatures) delete root.dataset.mixdogMonoLigatures;
  else root.dataset.mixdogMonoLigatures = 'off';
}

export function setFontSettings(patch: Partial<FontSettings>): FontSettings {
  const next = normalizeFontSettings({ ...getFontSettings(), ...patch });
  storage()?.setItem(FONTS_KEY, JSON.stringify(next));
  applyFontSettings(next);
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
  return next;
}

export function resetFontSettings(): void {
  storage()?.removeItem(FONTS_KEY);
  applyFontSettings({ ...DEFAULT_FONT_SETTINGS });
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

export function subscribeFontSettings(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}
