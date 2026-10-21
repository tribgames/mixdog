// Theme files (Settings → Theme): the mixdog-theme/v1 format, read and
// checked without touching the DOM. The ROLES are the public contract; how a
// role lands on the app's --mx-* tokens is private to theme-tokens.ts.
import { blend, contrastRatio, fitInk, TEXT_CONTRAST } from '../skin-color';
import schema from './schema/mixdog-theme/v1.json';

export type Appearance = 'dark' | 'light';

/** The schema shipped with the app; exported files point their `$schema` at it. */
export const THEME_SCHEMA_URL: string = schema.$id;
export const THEME_FORMAT = 'mixdog-theme/v1';

export const THEME_ROLES = [
  'background',
  'surface',
  'surface-raised',
  'sidebar',
  'text',
  'text-muted',
  'border',
  'border-strong',
  'accent',
  'accent-fill',
  'accent-text',
  'link',
  'selection',
  'focus-ring',
  'hover',
  'selected',
  'danger',
  'warning',
  'success',
  'code-background',
  'code-text',
  'user-bubble',
  'scrollbar',
  'scrim',
  'terminal-background',
  'terminal-text',
] as const;
export type ThemeRole = (typeof THEME_ROLES)[number];

const ROLE_SET = new Set<string>(THEME_ROLES);

/** The built-in theme as role colors (desktop/01-tokens.css, both appearances). */
export const BUILTIN_ROLES: Readonly<Record<Appearance, Readonly<Record<ThemeRole, string>>>> = {
  dark: {
    background: '#111113',
    surface: '#222225',
    'surface-raised': '#2a2a2d',
    sidebar: '#18181b',
    text: '#e9e9e9',
    'text-muted': '#a8a8a8',
    border: '#ffffff20',
    'border-strong': '#ffffff3d',
    accent: '#5bb0ff',
    'accent-fill': '#1967d2',
    'accent-text': '#ffffff',
    link: '#5bb0ff',
    selection: '#5bb0ff52',
    'focus-ring': '#ffffff3d',
    hover: '#ffffff14',
    selected: '#ffffff1f',
    danger: '#ff6e69',
    warning: '#ffb52e',
    success: '#3ddc6e',
    'code-background': '#e9e9e90a',
    'code-text': '#e9e9e9',
    'user-bubble': '#232326',
    scrollbar: '#e9e9e93d',
    scrim: '#00000080',
    'terminal-background': '#121215',
    'terminal-text': '#e9e9e9',
  },
  light: {
    background: '#fcfcfc',
    surface: '#ffffff',
    'surface-raised': '#f3f3f3',
    sidebar: '#f7f7f7',
    text: '#222222',
    'text-muted': '#606060',
    border: '#14141426',
    'border-strong': '#1414144d',
    accent: '#0a5fd1',
    'accent-fill': '#1967d2',
    'accent-text': '#ffffff',
    link: '#0a5fd1',
    selection: '#0a5fd152',
    'focus-ring': '#1414144d',
    hover: '#77777717',
    selected: '#7777772b',
    danger: '#c8201f',
    warning: '#a35200',
    success: '#077528',
    'code-background': '#2222220a',
    'code-text': '#222222',
    'user-bubble': '#eeeeee',
    scrollbar: '#2222223d',
    scrim: '#14141480',
    'terminal-background': '#121215',
    'terminal-text': '#e9e9e9',
  },
};

/** An optional role the theme leaves out takes its sibling's color (when the
    theme sets that one) before the built-in color. */
const ROLE_FALLBACK: Partial<Record<ThemeRole, ThemeRole>> = {
  'accent-fill': 'accent',
  link: 'accent',
  'code-text': 'text',
  'focus-ring': 'border-strong',
};

/** Ink roles and the backgrounds each is read on: guarded at 4.5:1. */
const CONTRAST_PAIRS: ReadonlyArray<readonly [ThemeRole, readonly ThemeRole[]]> = [
  ['text', ['background', 'surface', 'surface-raised', 'sidebar', 'user-bubble']],
  ['text-muted', ['background', 'surface', 'sidebar']],
  ['accent', ['background']],
  ['link', ['background', 'user-bubble']],
  ['accent-text', ['accent-fill']],
  ['code-text', ['code-background']],
  ['danger', ['background']],
  ['warning', ['background']],
  ['success', ['background']],
  ['terminal-text', ['terminal-background']],
];

export type ThemeProblemCode =
  | 'json'
  | 'shape'
  | 'section'
  | 'version'
  | 'name'
  | 'appearance'
  | 'color'
  | 'reference'
  | 'cycle'
  | 'pair'
  | 'unknown-keys';
export type ThemeProblem = { code: ThemeProblemCode; detail?: string };

export type ParsedTheme = {
  name: string;
  /** Declared by a single-appearance theme; absent = follows the app. */
  appearance?: Appearance;
  roles: Partial<Record<ThemeRole, Partial<Record<Appearance, string>>>>;
};

export type ThemeParseResult =
  | { ok: true; theme: ParsedTheme; warnings: ThemeProblem[] }
  | { ok: false; error: ThemeProblem };

const TOP_KEYS = new Set(['$schema', 'name', 'appearance', 'defs', 'roles']);
const DEF_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const NAME_MAX = 64;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** #rgb / #rrggbb / #rrggbbaa → lowercase #rrggbb(aa); an opaque alpha is dropped. */
export function normalizeHex(value: string): string | null {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1].toLowerCase();
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  if (hex.length === 8 && hex.endsWith('ff')) hex = hex.slice(0, 6);
  return `#${hex}`;
}

/** Read a theme file. Unknown keys are warnings; anything that would paint a
    wrong color (bad hex, dangling or looping defs) rejects the whole file. */
export function parseThemeFile(text: string): ThemeParseResult {
  const fail = (code: ThemeProblemCode, detail?: string): ThemeParseResult => ({
    ok: false,
    error: detail === undefined ? { code } : { code, detail },
  });
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return fail('json');
  }
  if (!isRecord(data)) return fail('shape');
  const unknown = Object.keys(data).filter((key) => !TOP_KEYS.has(key));

  if (data.$schema !== undefined) {
    const match = typeof data.$schema === 'string' ? /mixdog-theme\/v(\d+)(?:\.json)?$/.exec(data.$schema) : null;
    if (match?.[1] !== '1') return fail('version', String(data.$schema));
  }
  const name = typeof data.name === 'string' ? data.name.trim() : '';
  if (!name || name.length > NAME_MAX) return fail('name');
  if (data.appearance !== undefined && data.appearance !== 'dark' && data.appearance !== 'light') {
    return fail('appearance');
  }
  const defs = data.defs ?? {};
  if (!isRecord(defs)) return fail('section', 'defs');
  const rolesInput = data.roles ?? {};
  if (!isRecord(rolesInput)) return fail('section', 'roles');

  const resolvedDefs = new Map<string, string>();
  const resolve = (value: unknown, path: string, trail: string[]): string | ThemeProblem => {
    if (typeof value !== 'string') return { code: 'color', detail: path };
    const hex = normalizeHex(value);
    if (hex) return hex;
    if (!DEF_NAME.test(value)) return { code: 'color', detail: path };
    if (!Object.hasOwn(defs, value)) return { code: 'reference', detail: path };
    if (trail.includes(value)) return { code: 'cycle', detail: [...trail, value].join(' → ') };
    const known = resolvedDefs.get(value);
    if (known) return known;
    const result = resolve(defs[value], `defs.${value}`, [...trail, value]);
    if (typeof result === 'string') resolvedDefs.set(value, result);
    return result;
  };
  for (const key of Object.keys(defs)) {
    if (!DEF_NAME.test(key)) return fail('reference', `defs.${key}`);
    const result = resolve(defs[key], `defs.${key}`, [key]);
    if (typeof result !== 'string') return { ok: false, error: result };
  }

  const roles: ParsedTheme['roles'] = {};
  for (const [role, value] of Object.entries(rolesInput)) {
    if (!ROLE_SET.has(role)) {
      unknown.push(`roles.${role}`);
      continue;
    }
    const pair: Partial<Record<Appearance, string>> = {};
    if (isRecord(value)) {
      for (const [side, color] of Object.entries(value)) {
        if (side !== 'dark' && side !== 'light') {
          unknown.push(`roles.${role}.${side}`);
          continue;
        }
        const result = resolve(color, `roles.${role}.${side}`, []);
        if (typeof result !== 'string') return { ok: false, error: result };
        pair[side] = result;
      }
      if (!pair.dark && !pair.light) return fail('pair', `roles.${role}`);
    } else {
      const result = resolve(value, `roles.${role}`, []);
      if (typeof result !== 'string') return { ok: false, error: result };
      pair.dark = result;
      pair.light = result;
    }
    roles[role as ThemeRole] = pair;
  }
  const theme: ParsedTheme = { name, roles };
  if (data.appearance) theme.appearance = data.appearance;
  return {
    ok: true,
    theme,
    warnings: unknown.length ? [{ code: 'unknown-keys', detail: unknown.join(', ') }] : [],
  };
}

export type ThemeAdjustment = { role: ThemeRole; from: string; to: string; against: readonly ThemeRole[] };

export type ResolvedTheme = {
  mode: Appearance;
  /** Every role's color in effect (theme, sibling fallback, else built-in). */
  colors: Record<ThemeRole, string>;
  /** Roles the theme decides (set, inherited from a set sibling, or adjusted):
      only these are painted; the rest stay on the built-in CSS. */
  supplied: Set<ThemeRole>;
  adjustments: ThemeAdjustment[];
};

/** `color` with its alpha flattened over `under` (opaque colors unchanged). */
function flatten(color: string, under: string): string {
  return color.length === 9 ? blend(color.slice(0, 7), under, parseInt(color.slice(7), 16) / 255) : color;
}

/** A theme's colors for one appearance (a single-appearance theme always uses
    its own), then the readability guard: each ink the theme touches (or that
    sits on a background it touches) is nudged to 4.5:1 and reported. */
export function resolveTheme(theme: ParsedTheme, appMode: Appearance): ResolvedTheme {
  const mode = theme.appearance ?? appMode;
  const builtin = BUILTIN_ROLES[mode];
  const colors = { ...builtin } as Record<ThemeRole, string>;
  const supplied = new Set<ThemeRole>();
  for (const role of THEME_ROLES) {
    const own = theme.roles[role]?.[mode];
    if (own) {
      colors[role] = own;
      supplied.add(role);
    }
  }
  for (const [role, sibling] of Object.entries(ROLE_FALLBACK) as Array<[ThemeRole, ThemeRole]>) {
    if (supplied.has(role) || !supplied.has(sibling)) continue;
    colors[role] = colors[sibling];
    supplied.add(role);
  }
  const base = mode === 'light' ? '#ffffff' : '#000000';
  const background = flatten(colors.background, base);
  const backdrop = (role: ThemeRole) => (role === 'background' ? background : flatten(colors[role], background));
  const adjustments: ThemeAdjustment[] = [];
  for (const [ink, against] of CONTRAST_PAIRS) {
    if (!supplied.has(ink) && !against.some((role) => supplied.has(role))) continue;
    const backdrops = against.map(backdrop);
    const color = colors[ink];
    if (backdrops.every((under) => contrastRatio(flatten(color, under), under) >= TEXT_CONTRAST)) continue;
    const fitted = fitInk(color.slice(0, 7), backdrops);
    adjustments.push({ role: ink, from: color, to: fitted, against });
    colors[ink] = fitted;
    supplied.add(ink);
  }
  return { mode, colors, supplied, adjustments };
}

/** A starter file: the built-in theme as {dark, light} pairs, pointing at the schema. */
export function builtinThemeFile(name = 'Mixdog'): string {
  const roles = Object.fromEntries(
    THEME_ROLES.map((role) => [role, { dark: BUILTIN_ROLES.dark[role], light: BUILTIN_ROLES.light[role] }])
  );
  return `${JSON.stringify({ $schema: THEME_SCHEMA_URL, name, defs: {}, roles }, null, 2)}\n`;
}

/** File name for an exported theme. */
export function themeFileName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'theme'}.mixdog-theme.json`;
}
