// The canonical registry is JavaScript shared with the TUI and bundled by Vite.
// @ts-ignore -- the source .mjs intentionally has no separate declaration file.
import { DEFAULT_THEME_ID, THEME_ALIASES, THEME_REGISTRY } from '../../../../src/tui/themes/index.mjs';

type ThemePalette = Record<string, string>;
type ThemeEntry = { id: string; palette: ThemePalette };

const registry = THEME_REGISTRY as Record<string, ThemeEntry>;
const aliases = THEME_ALIASES as Record<string, string>;

function themeId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (!value || typeof value !== 'object') return '';
  return String('id' in value ? (value as { id?: unknown }).id ?? '' : '');
}

function cssVariables(palette: ThemePalette): Record<string, string> {
  const deep = palette.background === 'transparent' ? palette.inverseText : palette.background;
  return {
    '--oc-bg-deep': deep,
    '--oc-bg-base': palette.mdCodeBlockBg,
    '--oc-bg-layer-1': palette.userMessageBackground,
    '--oc-bg-layer-2': palette.mdCodeSpanBg,
    '--oc-bg-layer-3': palette.userMessageBackgroundHover,
    '--oc-bg-contrast': palette.selectionBackground,
    '--oc-text': palette.text,
    '--oc-text-muted': palette.inactive,
    '--oc-text-faint': palette.subtle,
    '--oc-text-accent': palette.claude,
    '--oc-icon': palette.statusText,
    '--oc-icon-muted': palette.statusSubtle,
    '--oc-border-muted': `color-mix(in srgb, ${palette.promptBorder} 45%, transparent)`,
    '--oc-border': `color-mix(in srgb, ${palette.promptBorder} 65%, transparent)`,
    '--oc-border-strong': palette.promptBorder,
    '--oc-focus': palette.suggestion,
    '--oc-hover': `color-mix(in srgb, ${palette.text} 6%, transparent)`,
    '--oc-pressed': `color-mix(in srgb, ${palette.text} 10%, transparent)`,
    '--oc-scrim': `color-mix(in srgb, ${deep} 65%, transparent)`,
    '--oc-danger-bg': palette.mdDiffRemovedBg,
    '--oc-danger': palette.error,
    '--oc-warning-bg': `color-mix(in srgb, ${palette.warning} 16%, ${deep})`,
    '--oc-warning': palette.warning,
    '--oc-success-bg': palette.mdDiffAddedBg,
    '--oc-success': palette.success,
    '--oc-scrollbar-thumb': `color-mix(in srgb, ${palette.promptBorder} 72%, transparent)`,
    '--oc-scrollbar-thumb-hover': palette.promptBorder,
    '--base': deep,
    '--sidebar': palette.mdCodeBlockBg,
    '--surface': palette.mdCodeBlockBg,
    '--input': palette.userMessageBackground,
    '--surface-raised': palette.mdCodeSpanBg,
    '--surface-hover': `color-mix(in srgb, ${palette.text} 6%, transparent)`,
    '--border': `color-mix(in srgb, ${palette.promptBorder} 65%, transparent)`,
    '--border-strong': palette.promptBorder,
    '--muted': palette.inactive,
    '--accent': palette.claude,
    '--focus': palette.suggestion,
    '--danger': palette.error,
  };
}

// Interaction/chrome tokens are owned by opencode-v2.css and must never be
// remapped from TUI palettes: palette.suggestion (amber) and palette.claude
// (brown) produced orange focus rings and off-brand accents in the desktop UI.
const INTERACTION_TOKENS = ['--oc-focus', '--focus', '--oc-text-accent', '--accent'] as const;

// The default dark theme is fully defined by opencode-v2.css. Other palettes,
// including light, must inject their semantic surface tokens.
function opencodeNative(resolved: string): boolean {
  return resolved === DEFAULT_THEME_ID || resolved === 'dark';
}

export type DesktopThemePreference = 'system' | 'dark' | 'white';

const DESKTOP_THEME_PREFERENCE_KEY = 'mixdog.desktop-theme-preference';

function desktopThemeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getDesktopThemePreference(): DesktopThemePreference | null {
  const value = desktopThemeStorage()?.getItem(DESKTOP_THEME_PREFERENCE_KEY);
  return value === 'system' || value === 'dark' || value === 'white' ? value : null;
}

export function desktopThemePreferenceForTheme(value: unknown): DesktopThemePreference {
  const requested = themeId(value);
  const resolved = registry[requested] ? requested : aliases[requested];
  return resolved === 'light' ? 'white' : 'dark';
}

export function applyDesktopThemePreference(preference: DesktopThemePreference): string {
  const resolved = preference === 'white'
    ? 'light'
    : preference === 'system' && typeof window.matchMedia === 'function'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? DEFAULT_THEME_ID : 'light')
      : DEFAULT_THEME_ID;
  return applyDesktopTheme(resolved);
}

export function setDesktopThemePreference(preference: DesktopThemePreference): string {
  desktopThemeStorage()?.setItem(DESKTOP_THEME_PREFERENCE_KEY, preference);
  return applyDesktopThemePreference(preference);
}

export function clearDesktopThemePreference(): void {
  desktopThemeStorage()?.removeItem(DESKTOP_THEME_PREFERENCE_KEY);
}

export function applyDesktopTheme(value: unknown): string {
  const requested = themeId(value);
  const resolved = registry[requested] ? requested : (registry[aliases[requested]] ? aliases[requested] : DEFAULT_THEME_ID);
  const root = document.documentElement;
  root.dataset.mixdogTheme = resolved;
  root.style.colorScheme = resolved === 'light' ? 'light' : 'dark';
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', registry[resolved].palette.background);
  const variables = cssVariables(registry[resolved].palette);
  // Always clear previous inline overrides first so switching back to a
  // css-native theme cannot leave stale palette values behind.
  for (const name of Object.keys(variables)) root.style.removeProperty(name);
  for (const name of INTERACTION_TOKENS) root.style.removeProperty(name);
  if (!opencodeNative(resolved)) {
    for (const [name, color] of Object.entries(variables)) {
      if ((INTERACTION_TOKENS as readonly string[]).includes(name)) continue;
      root.style.setProperty(name, color);
    }
  }
  return resolved;
}
