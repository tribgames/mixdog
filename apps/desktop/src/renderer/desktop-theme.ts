// The canonical registry is JavaScript shared with the TUI and bundled by Vite.
// @ts-ignore -- the source .mjs intentionally has no separate declaration file.
import { DEFAULT_THEME_ID, THEME_ALIASES, THEME_ORDER, THEME_REGISTRY } from '../../../../src/tui/themes/index.mjs';

import { refreshTitleBarDim } from './titlebar-dim';

type ThemePalette = Record<string, string>;
type ThemeEntry = { id: string; label: string; palette: ThemePalette };

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
    '--mx-bg-deep': deep,
    '--mx-bg-base': palette.mdCodeBlockBg,
    '--mx-bg-layer-1': palette.userMessageBackground,
    '--mx-bg-layer-2': palette.mdCodeSpanBg,
    '--mx-bg-layer-3': palette.userMessageBackgroundHover,
    '--mx-bg-contrast': palette.selectionBackground,
    // Shell chrome derives from the same depth axis as the built-in themes
    // (deep → band → sheet → base); without these the titlebar, side rails,
    // and workspace sheet stayed on the default warm-dark for registry themes.
    '--mx-window-band': `color-mix(in srgb, ${palette.mdCodeBlockBg} 30%, ${deep})`,
    '--mx-workspace-sheet': `color-mix(in srgb, ${palette.mdCodeBlockBg} 65%, ${deep})`,
    '--mx-surface-plate': `color-mix(in srgb, ${palette.text} 4%, transparent)`,
    '--mx-text': palette.text,
    '--mx-text-muted': palette.inactive,
    '--mx-text-faint': palette.subtle,
    '--mx-text-accent': palette.claude,
    '--mx-icon': palette.text,
    '--mx-icon-muted': palette.inactive,
    '--mx-border-muted': `color-mix(in srgb, ${palette.promptBorder} 45%, transparent)`,
    '--mx-border': `color-mix(in srgb, ${palette.promptBorder} 65%, transparent)`,
    '--mx-border-strong': palette.promptBorder,
    '--mx-focus': palette.suggestion,
    '--mx-hover': `color-mix(in srgb, ${palette.text} 6%, transparent)`,
    '--mx-pressed': `color-mix(in srgb, ${palette.text} 10%, transparent)`,
    '--mx-scrim': `color-mix(in srgb, ${deep} 65%, transparent)`,
    '--mx-danger-bg': palette.mdDiffRemovedBg,
    '--mx-danger': palette.error,
    '--mx-warning-bg': `color-mix(in srgb, ${palette.warning} 16%, ${deep})`,
    '--mx-warning': palette.warning,
    '--mx-success-bg': palette.mdDiffAddedBg,
    '--mx-success': palette.success,
    // Status ACCENTS follow the palette, so their companion plates must too:
    // without these a registry theme drew everforest/nord greens inside a
    // default-dark green hairline and an amber approval ring.
    '--mx-success-border': `color-mix(in srgb, ${palette.success} 45%, transparent)`,
    '--mx-approval-ring': `color-mix(in srgb, ${palette.warning} 50%, transparent)`,
    '--mx-scrollbar-thumb': `color-mix(in srgb, ${palette.promptBorder} 72%, transparent)`,
    '--mx-scrollbar-thumb-hover': palette.promptBorder,
    // The highlight ramp belongs to the palette too: without these a registry
    // theme repainted every surface except the inside of its own code card,
    // which kept the VS Code Dark+ hues from desktop.css. Fallbacks mirror the
    // TUI renderer (comment → subtle, the rest → the flat code-body ink) so a
    // palette without a full syntax ramp still lands in-theme.
    '--mx-syntax-comment': palette.syntaxComment || palette.subtle,
    '--mx-syntax-keyword': palette.syntaxKeyword || palette.mdCodeBlock,
    '--mx-syntax-control': palette.syntaxKeyword || palette.mdCodeBlock,
    '--mx-syntax-string': palette.syntaxString || palette.mdCodeBlock,
    '--mx-syntax-number': palette.syntaxNumber || palette.mdCodeBlock,
    '--mx-syntax-type': palette.syntaxType || palette.mdCodeBlock,
    '--mx-syntax-function': palette.syntaxFunction || palette.mdCodeBlock,
    '--mx-syntax-variable': palette.syntaxVariable || palette.mdCodeBlock,
    '--mx-syntax-meta': palette.syntaxComment || palette.subtle,
  };
}

// Interaction/chrome tokens are owned by desktop.css and must never be
// remapped from TUI palettes: palette.suggestion (amber) and palette.claude
// (brown) produced orange focus rings and off-brand accents in the desktop UI.
const INTERACTION_TOKENS = ['--mx-focus', '--mx-text-accent'] as const;

// Transition freeze during a swap (desktop.css owns the rule).
const THEME_SWAP_ATTRIBUTE = 'data-mixdog-theme-swap';
let themeSwapFrame = 0;

function suppressThemeSwapTransitions(root: HTMLElement): void {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') return;
  root.setAttribute(THEME_SWAP_ATTRIBUTE, '');
  if (themeSwapFrame) window.cancelAnimationFrame(themeSwapFrame);
  // Two frames: the first commits the new variables, the second restores the
  // hover/collapse transitions once that repaint has landed.
  themeSwapFrame = window.requestAnimationFrame(() => {
    themeSwapFrame = window.requestAnimationFrame(() => {
      themeSwapFrame = 0;
      root.removeAttribute(THEME_SWAP_ATTRIBUTE);
    });
  });
}

// The default dark theme is fully defined by desktop.css. Other palettes,
// including light, must inject their semantic surface tokens.
function builtinTheme(resolved: string): boolean {
  return resolved === DEFAULT_THEME_ID
    || resolved === 'dark'
    || resolved === 'light';
}

// Android standalone browsers reuse theme-color for both system bars. Keep
// those OS-owned bars black independently of the selected in-app surface ramp.
function pwaSystemBarColor(): string {
  return '#000000';
}

// 'system' | 'dark' | 'white' are the desktop surface modes; any TUI registry
// theme id (nord, dracula, …) is also accepted as a desktop-local preference.
export type DesktopThemePreference = 'system' | 'dark' | 'white' | (string & {});

const DESKTOP_THEME_PREFERENCE_KEY = 'mixdog.desktop-theme-preference';

function desktopThemeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function getDesktopThemePreference(): DesktopThemePreference | null {
  const value = desktopThemeStorage()?.getItem(DESKTOP_THEME_PREFERENCE_KEY) || '';
  // The retired Gray theme collapsed into Dark: its ramp IS the dark ramp now.
  if (value === 'gray') return 'dark';
  if (value === 'system' || value === 'dark' || value === 'white') return value;
  return registry[value] ? value : null;
}

export function desktopThemePreferenceForTheme(value: unknown): DesktopThemePreference {
  const requested = themeId(value);
  const resolved = registry[requested] ? requested : aliases[requested];
  return resolved === 'light' ? 'white' : 'dark';
}

/** Settings picker options — Desktop owns System + White/Dark.
 * The TUI registry themes (nord, dracula, …) stay
 * TUI-only; a previously stored registry id still resolves for rendering,
 * it just is not offered here anymore. */
export function desktopThemeOptions(): Array<{ value: DesktopThemePreference; label: string }> {
  return [
    { value: 'system', label: 'System' },
    { value: 'white', label: 'White' },
    { value: 'dark', label: 'Dark' },
  ];
}

/** Onboarding theme cards: raw registry palette for the mini chrome preview.
 *  Aliases resolve; unknown ids return null and the card stays neutral. */
export function themePreviewPalette(value: unknown): Record<string, string> | null {
  const requested = themeId(value);
  const resolved = registry[requested] ? requested : aliases[requested];
  return resolved && registry[resolved] ? { ...registry[resolved].palette } : null;
}

export function applyDesktopThemePreference(preference: DesktopThemePreference): string {
  systemPreferenceActive = preference === 'system';
  const resolved = preference === 'white'
    ? 'light'
    : preference === 'system' && typeof window.matchMedia === 'function'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? DEFAULT_THEME_ID : 'light')
      : preference !== 'system' && preference !== 'dark' && registry[preference]
        ? preference
        : DEFAULT_THEME_ID;
  return applyDesktopTheme(resolved);
}

// Whether the LAST applied preference was 'system': the main process then
// keeps nativeTheme on 'system' instead of pinning light/dark, so
// prefers-color-scheme keeps reporting the real OS theme. When a pin is
// released and the OS truth differs, the matchMedia change listener in
// App.tsx re-resolves the theme — the one-beat stale read self-heals.
let systemPreferenceActive = false;

export function setDesktopThemePreference(preference: DesktopThemePreference): string {
  desktopThemeStorage()?.setItem(DESKTOP_THEME_PREFERENCE_KEY, preference);
  return applyDesktopThemePreference(preference);
}

export function clearDesktopThemePreference(): void {
  desktopThemeStorage()?.removeItem(DESKTOP_THEME_PREFERENCE_KEY);
}

export function applyDesktopTheme(value: unknown): string {
  const requested = themeId(value);
  const resolved = registry[requested]
    ? requested
    : (registry[aliases[requested]] ? aliases[requested] : DEFAULT_THEME_ID);
  const root = document.documentElement;
  suppressThemeSwapTransitions(root);
  root.dataset.mixdogTheme = resolved;
  root.style.colorScheme = resolved === 'light' ? 'light' : 'dark';
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute('content', pwaSystemBarColor());
  // The Windows caption overlay (min/max/close) is native chrome: its symbol
  // color lives in the MAIN process. Without this notification a light theme
  // kept white symbols on a near-white band — the buttons "disappeared".
  try {
    (window as unknown as {
      mixdogDesktop?: { applyTitleBarTheme?: (theme: string, systemPreference?: boolean) => Promise<void> };
    }).mixdogDesktop?.applyTitleBarTheme?.(resolved, systemPreferenceActive)?.catch?.(() => undefined);
  } catch { /* theme application must never fail on bridge absence */ }
  const variables = cssVariables(
    registry[resolved]?.palette ?? registry[DEFAULT_THEME_ID].palette,
  );
  // Always clear previous inline overrides first so switching back to a
  // css-native theme cannot leave stale palette values behind.
  for (const name of Object.keys(variables)) root.style.removeProperty(name);
  for (const name of INTERACTION_TOKENS) root.style.removeProperty(name);
  if (!builtinTheme(resolved)) {
    for (const [name, color] of Object.entries(variables)) {
      if ((INTERACTION_TOKENS as readonly string[]).includes(name)) continue;
      root.style.setProperty(name, color);
    }
  }
  // A theme swap while a modal is open must recompute the dimmed WCO band.
  refreshTitleBarDim();
  return resolved;
}
