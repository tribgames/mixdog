// User JSON themes (Settings → Theme): imported files kept on this
// device, one of them active. The active theme is painted as one injected
// style sheet (theme-tokens.ts) and follows the app's light/dark setting; a
// single-appearance theme switches the app to its own appearance while on.
// A skin keeps its picture, plates and transparency over it.
import { registerThemeAppearanceOverride, reapplyDesktopThemePreference } from '../desktop-theme';
import {
  type Appearance,
  builtinThemeFile,
  type ParsedTheme,
  parseThemeFile,
  type ResolvedTheme,
  resolveTheme,
  type ThemeAdjustment,
  type ThemeProblem,
  themeFileName,
} from './theme-file';
import { syncUserThemeBootSnapshot } from '../skin-boot-snapshot';
import { themeStyleText } from './theme-tokens';

export type StoredTheme = { id: string; name: string; source: string };

const THEMES_KEY = 'mixdog.desktop.user-themes.v1';
const ACTIVE_KEY = 'mixdog.desktop.user-theme.v1';
const CHANGE_EVENT = 'mixdog:user-theme-changed';
const STYLE_ID = 'mixdog-user-theme';
/** Imported themes kept per device (each is a few KB of JSON). */
const MAX_THEMES = 24;

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function listUserThemes(): StoredTheme[] {
  try {
    const parsed = JSON.parse(storage()?.getItem(THEMES_KEY) || '[]') as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is StoredTheme =>
        Boolean(entry) &&
        typeof entry.id === 'string' &&
        typeof entry.name === 'string' &&
        typeof entry.source === 'string'
    );
  } catch {
    return [];
  }
}

function saveThemes(themes: StoredTheme[]): void {
  storage()?.setItem(THEMES_KEY, JSON.stringify(themes));
}

export function getActiveUserThemeId(): string | null {
  const id = storage()?.getItem(ACTIVE_KEY) || null;
  return id && listUserThemes().some((entry) => entry.id === id) ? id : null;
}

type Active =
  | { stored: StoredTheme; theme: ParsedTheme; warnings: ThemeProblem[] }
  | { stored: StoredTheme; error: ThemeProblem };

function activeTheme(): Active | null {
  const id = getActiveUserThemeId();
  const stored = id ? listUserThemes().find((entry) => entry.id === id) : undefined;
  if (!stored) return null;
  const result = parseThemeFile(stored.source);
  return result.ok ? { stored, theme: result.theme, warnings: result.warnings } : { stored, error: result.error };
}

function appMode(): Appearance {
  return document.documentElement.dataset.mixdogTheme === 'light' ? 'light' : 'dark';
}

/** The active theme for the current appearance, or null (built-in theme). */
export function resolvedUserTheme(mode: Appearance = appMode()): ResolvedTheme | null {
  const active = activeTheme();
  return active && 'theme' in active ? resolveTheme(active.theme, mode) : null;
}

/** The active theme's accent fill (the default accent a skin starts from), or
    null when no theme is on or it leaves the accent to the built-in theme. */
export function userThemeAccent(mode: Appearance): string | null {
  const resolved = resolvedUserTheme(mode);
  return resolved?.supplied.has('accent-fill') ? resolved.colors['accent-fill'].slice(0, 7) : null;
}

export type UserThemeReport = {
  name: string | null;
  warnings: ThemeProblem[];
  adjustments: ThemeAdjustment[];
  /** The stored active theme no longer reads: the built-in theme is shown. */
  error: ThemeProblem | null;
};

export function userThemeReport(mode: Appearance = appMode()): UserThemeReport {
  const active = activeTheme();
  if (!active) return { name: null, warnings: [], adjustments: [], error: null };
  if ('error' in active) return { name: active.stored.name, warnings: [], adjustments: [], error: active.error };
  return {
    name: active.theme.name,
    warnings: active.warnings,
    adjustments: resolveTheme(active.theme, mode).adjustments,
    error: null,
  };
}

function styleElement(): HTMLStyleElement {
  const existing = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (existing) return existing;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  document.head.appendChild(style);
  return style;
}

/** Paint the active theme, then record it for the next first paint (skin-boot-snapshot.ts). */
function paint(): void {
  paintTheme();
  syncUserThemeBootSnapshot();
}

function paintTheme(): void {
  const root = document.documentElement;
  const active = activeTheme();
  if (!active || 'error' in active) {
    delete root.dataset.mixdogUserTheme;
    document.getElementById(STYLE_ID)?.remove();
    return;
  }
  root.dataset.mixdogUserTheme = active.stored.id;
  // boot.js may have injected this very sheet: identical text is left alone.
  const style = styleElement();
  const text = themeStyleText(resolveTheme(active.theme, appMode()));
  if (style.textContent !== text) style.textContent = text;
}

function changed(): void {
  // A single-appearance theme moves the app to its appearance (and back).
  reapplyDesktopThemePreference();
  paint();
  window.dispatchEvent(new window.Event(CHANGE_EVENT));
}

export function subscribeUserTheme(listener: () => void): () => void {
  window.addEventListener(CHANGE_EVENT, listener);
  return () => window.removeEventListener(CHANGE_EVENT, listener);
}

export type ImportResult =
  | { ok: true; id: string; name: string; warnings: ThemeProblem[]; adjustments: ThemeAdjustment[] }
  | { ok: false; error: ThemeProblem };

/** Keep a theme file on this device and turn it on. A file with the same
    name replaces the earlier import. An invalid file changes nothing. */
export function importUserTheme(source: string): ImportResult {
  const result = parseThemeFile(source);
  if (!result.ok) return result;
  const { theme } = result;
  const themes = listUserThemes();
  const previous = themes.find((entry) => entry.name === theme.name);
  const id = previous?.id ?? `theme-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const next = [{ id, name: theme.name, source }, ...themes.filter((entry) => entry.id !== id)].slice(0, MAX_THEMES);
  saveThemes(next);
  storage()?.setItem(ACTIVE_KEY, id);
  changed();
  return {
    ok: true,
    id,
    name: theme.name,
    warnings: result.warnings,
    adjustments: resolveTheme(theme, appMode()).adjustments,
  };
}

/** Turn an imported theme on, or back to the built-in theme with null. */
export function setActiveUserTheme(id: string | null): void {
  if (id && listUserThemes().some((entry) => entry.id === id)) storage()?.setItem(ACTIVE_KEY, id);
  else storage()?.removeItem(ACTIVE_KEY);
  changed();
}

export function removeUserTheme(id: string): void {
  saveThemes(listUserThemes().filter((entry) => entry.id !== id));
  if (storage()?.getItem(ACTIVE_KEY) === id) storage()?.removeItem(ACTIVE_KEY);
  changed();
}

/** The file "Export" writes: the active theme as imported, else the built-in
    theme as a starter (both reference the shipped schema). */
export function exportThemeFile(): { name: string; text: string } {
  const active = activeTheme();
  if (active) return { name: themeFileName(active.stored.name), text: active.stored.source };
  return { name: themeFileName('Mixdog'), text: builtinThemeFile() };
}

let observedRoot: HTMLElement | null = null;

/** A single-appearance theme's declared appearance; null for none or a {dark, light} theme. */
export function activeUserThemeAppearance(): Appearance | null {
  const active = activeTheme();
  return active && 'theme' in active ? (active.theme.appearance ?? null) : null;
}

registerThemeAppearanceOverride(() => {
  const active = activeTheme();
  if (!active || 'error' in active) return null;
  return active.theme.appearance ?? 'follow';
});

/** Boot: paint the stored theme synchronously; repaint when light/dark flips. */
export function applyStoredUserTheme(): void {
  paint();
  const root = document.documentElement;
  if (observedRoot === root || typeof MutationObserver === 'undefined') return;
  observedRoot = root;
  new MutationObserver(paint).observe(root, { attributes: true, attributeFilter: ['data-mixdog-theme'] });
}
