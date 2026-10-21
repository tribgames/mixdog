// The ONE place a theme role becomes --mx-* tokens. Private: theme files speak
// roles (theme-file.ts), never token names, so the ~280 tokens can keep
// changing without breaking anyone's theme.
import { blend } from '../skin-color';
import type { ResolvedTheme, ThemeRole } from './theme-file';

/** `skin`: a skin owns the token while it is on (33-skin.css re-declares it
    on the root: the plate's ink and the paper that ink is read on, which the
    whole window shares, plus the accent fill, user bubble and code plates). */
type Owner = 'skin';
type TokenRule = { token: string; value?: (colors: Record<ThemeRole, string>) => string; owner?: Owner };

const mix = (a: string, percent: number, b: string) => `color-mix(in srgb, ${a} ${percent}%, ${b})`;
/** Alpha washes flattened over a plate, for rows that need an opaque fill. */
const over = (wash: string, plate: string) =>
  wash.length === 9 ? blend(wash.slice(0, 7), plate.slice(0, 7), parseInt(wash.slice(7), 16) / 255) : wash;

const ROLE_TOKENS: Record<ThemeRole, TokenRule[]> = {
  background: [
    { token: '--mx-bg-deep', owner: 'skin' },
    { token: '--mx-workspace-sheet', owner: 'skin' },
  ],
  surface: [{ token: '--mx-bg-base', owner: 'skin' }],
  'surface-raised': [
    { token: '--mx-bg-layer-1', owner: 'skin' },
    { token: '--mx-bg-layer-2', value: (c) => mix(c['surface-raised'], 95, c.text), owner: 'skin' },
    { token: '--mx-bg-layer-3', value: (c) => mix(c['surface-raised'], 90, c.text), owner: 'skin' },
  ],
  sidebar: [{ token: '--mx-window-band', owner: 'skin' }],
  text: [{ token: '--mx-text', owner: 'skin' }],
  'text-muted': [{ token: '--mx-text-muted', owner: 'skin' }],
  border: [
    { token: '--mx-border', owner: 'skin' },
    { token: '--mx-border-muted', value: (c) => mix(c.border, 72, 'transparent'), owner: 'skin' },
  ],
  'border-strong': [{ token: '--mx-border-strong', owner: 'skin' }],
  accent: [{ token: '--mx-text-accent' }],
  'accent-fill': [{ token: '--mx-accent-bg', owner: 'skin' }],
  'accent-text': [{ token: '--mx-accent-fg', owner: 'skin' }],
  link: [{ token: '--mx-md-code' }],
  selection: [{ token: '--mx-selection' }],
  'focus-ring': [{ token: '--mx-focus', owner: 'skin' }],
  hover: [
    { token: '--mx-hover', owner: 'skin' },
    { token: '--mx-hover-opaque', value: (c) => over(c.hover, c.surface), owner: 'skin' },
  ],
  selected: [
    { token: '--mx-pressed', owner: 'skin' },
    { token: '--mx-pressed-opaque', value: (c) => over(c.selected, c.surface), owner: 'skin' },
  ],
  danger: [{ token: '--mx-danger' }, { token: '--mx-danger-bg', value: (c) => mix(c.danger, 16, c.background) }],
  warning: [{ token: '--mx-warning' }, { token: '--mx-warning-bg', value: (c) => mix(c.warning, 16, c.background) }],
  success: [
    { token: '--mx-success' },
    { token: '--mx-success-bg', value: (c) => mix(c.success, 16, c.background) },
    { token: '--mx-success-border', value: (c) => mix(c.success, 45, 'transparent') },
  ],
  'code-background': [{ token: '--mx-code-surface', owner: 'skin' }],
  'code-text': [{ token: '--mx-code-ink', owner: 'skin' }],
  'user-bubble': [{ token: '--mx-user-bubble', owner: 'skin' }],
  scrollbar: [
    { token: '--mx-scrollbar-thumb', owner: 'skin' },
    { token: '--mx-scrollbar-thumb-hover', value: (c) => mix(c.scrollbar, 70, c.text), owner: 'skin' },
  ],
  scrim: [{ token: '--mx-scrim' }],
  'terminal-background': [{ token: '--mx-terminal-bg' }],
  'terminal-text': [{ token: '--mx-terminal-fg' }],
};

/* Specificity, not source order, decides: (0,3,0) beats the light block's
   (0,2,0) wherever the injected sheet lands, and the skin's own root rules
   win through the :not() exclusions (a skin keeps its plates and the guarded
   inks; its contrast guards run on top of the theme). */
const BASE = ':root[data-mixdog-user-theme][data-mixdog-theme]';
const SELECTORS: Record<Owner | 'base', string> = {
  base: BASE,
  skin: `${BASE}:not([data-mixdog-skin])`,
};

/** The token declarations a resolved theme paints (only its supplied roles). */
export function themeTokens(resolved: ResolvedTheme): Array<{ token: string; value: string; owner: Owner | 'base' }> {
  const out: Array<{ token: string; value: string; owner: Owner | 'base' }> = [];
  for (const role of resolved.supplied) {
    for (const rule of ROLE_TOKENS[role]) {
      out.push({
        token: rule.token,
        value: rule.value ? rule.value(resolved.colors) : resolved.colors[role],
        owner: rule.owner ?? 'base',
      });
    }
  }
  return out;
}

/** The style sheet text for a resolved theme. */
export function themeStyleText(resolved: ResolvedTheme): string {
  const groups = new Map<string, string[]>();
  for (const { token, value, owner } of themeTokens(resolved)) {
    const lines = groups.get(owner) ?? [];
    lines.push(`  ${token}: ${value};`);
    groups.set(owner, lines);
  }
  return [...groups]
    .map(([owner, lines]) => `${SELECTORS[owner as Owner | 'base']} {\n${lines.join('\n')}\n}`)
    .join('\n');
}
