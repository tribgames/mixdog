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

export function applyDesktopTheme(value: unknown): string {
  const requested = themeId(value);
  const resolved = registry[requested] ? requested : (registry[aliases[requested]] ? aliases[requested] : DEFAULT_THEME_ID);
  const root = document.documentElement;
  root.dataset.mixdogTheme = resolved;
  root.style.colorScheme = resolved === 'light' ? 'light' : 'dark';
  for (const [name, color] of Object.entries(cssVariables(registry[resolved].palette))) {
    root.style.setProperty(name, color);
  }
  return resolved;
}
