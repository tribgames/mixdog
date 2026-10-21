import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { contrastRatio } from '../skin-color';
import {
  BUILTIN_ROLES,
  builtinThemeFile,
  normalizeHex,
  parseThemeFile,
  resolveTheme,
  THEME_ROLES,
  THEME_SCHEMA_URL,
  themeFileName,
} from './theme-file';
import { themeStyleText, themeTokens } from './theme-tokens';

const schema = JSON.parse(readFileSync(new URL('./schema/mixdog-theme/v1.json', import.meta.url), 'utf8'));
const file = (body) => JSON.stringify({ $schema: THEME_SCHEMA_URL, name: 'Test', ...body });
const parsed = (body) => {
  const result = parseThemeFile(file(body));
  assert.ok(result.ok, JSON.stringify(result));
  return result;
};
const failure = (text) => {
  const result = parseThemeFile(text);
  assert.equal(result.ok, false);
  return result.error;
};

test('the shipped schema lists exactly the role contract and is the exported $schema', () => {
  assert.deepEqual(Object.keys(schema.properties.roles.properties), [...THEME_ROLES]);
  assert.equal(schema.$id, THEME_SCHEMA_URL);
  assert.match(THEME_SCHEMA_URL, /mixdog-theme\/v1\.json$/);
  assert.ok(THEME_ROLES.length >= 20 && THEME_ROLES.length <= 30);
  for (const mode of ['dark', 'light']) assert.deepEqual(Object.keys(BUILTIN_ROLES[mode]), [...THEME_ROLES]);
});

test('hex only: #rgb, #rrggbb and #rrggbbaa, normalized', () => {
  assert.equal(normalizeHex('#ABC'), '#aabbcc');
  assert.equal(normalizeHex('#A1B2C3'), '#a1b2c3');
  assert.equal(normalizeHex('#a1b2c380'), '#a1b2c380');
  assert.equal(normalizeHex('#a1b2c3ff'), '#a1b2c3');
  for (const bad of ['red', 'rgb(0,0,0)', '#abcd', '#12345', '#ggg', 'abc', '#1234567']) {
    assert.equal(normalizeHex(bad), null, bad);
  }
  // A bare word is a defs name, so a CSS color keyword reads as a missing palette entry.
  assert.deepEqual(failure(file({ roles: { text: 'red' } })), { code: 'reference', detail: 'roles.text' });
  assert.deepEqual(failure(file({ roles: { text: 'rgb(1,2,3)' } })), { code: 'color', detail: 'roles.text' });
  assert.deepEqual(failure(file({ roles: { text: { dark: '#12' } } })), { code: 'color', detail: 'roles.text.dark' });
  assert.deepEqual(failure(file({ roles: { text: 12 } })), { code: 'color', detail: 'roles.text' });
});

test('file shape, version and name are checked; unknown keys are ignored with a warning', () => {
  assert.deepEqual(failure('{not json'), { code: 'json' });
  assert.deepEqual(failure('[]'), { code: 'shape' });
  assert.deepEqual(failure(JSON.stringify({ $schema: 'https://x.test/mixdog-theme/v2.json', name: 'A' })), {
    code: 'version',
    detail: 'https://x.test/mixdog-theme/v2.json',
  });
  assert.deepEqual(failure(JSON.stringify({ $schema: 'https://json.test/other.json', name: 'A' })).code, 'version');
  assert.equal(parseThemeFile(JSON.stringify({ $schema: 'mixdog-theme/v1', name: 'A' })).ok, true);
  assert.equal(parseThemeFile(JSON.stringify({ name: 'No schema' })).ok, true);
  assert.deepEqual(failure(JSON.stringify({ name: '  ' })), { code: 'name' });
  assert.deepEqual(failure(JSON.stringify({ name: 'x'.repeat(65) })), { code: 'name' });
  assert.deepEqual(failure(file({ appearance: 'dim' })), { code: 'appearance' });
  assert.deepEqual(failure(file({ roles: [] })), { code: 'section', detail: 'roles' });
  assert.deepEqual(failure(file({ roles: { text: {} } })), { code: 'pair', detail: 'roles.text' });
  const { warnings, theme } = parsed({
    author: 'me',
    roles: { text: { dark: '#fff', dusk: '#000' }, 'sparkle-color': '#123456' },
  });
  assert.deepEqual(warnings, [{ code: 'unknown-keys', detail: 'author, roles.text.dusk, roles.sparkle-color' }]);
  assert.deepEqual(theme.roles, { text: { dark: '#ffffff' } });
});

test('defs references resolve (chains too); dangling references and cycles are rejected', () => {
  const { theme } = parsed({
    defs: { ink: '#eee', paper: '#101010', brand: 'blue', blue: '#3366ff' },
    roles: { text: 'ink', background: { dark: 'paper', light: '#fafafa' }, accent: 'brand' },
  });
  assert.deepEqual(theme.roles.text, { dark: '#eeeeee', light: '#eeeeee' });
  assert.deepEqual(theme.roles.background, { dark: '#101010', light: '#fafafa' });
  assert.deepEqual(theme.roles.accent, { dark: '#3366ff', light: '#3366ff' });
  assert.deepEqual(failure(file({ roles: { text: 'nope' } })), { code: 'reference', detail: 'roles.text' });
  assert.deepEqual(failure(file({ defs: { a: 'b' } })), { code: 'reference', detail: 'defs.a' });
  assert.deepEqual(failure(file({ defs: { a: 'a' } })), { code: 'cycle', detail: 'a → a' });
  assert.deepEqual(failure(file({ defs: { a: 'b', b: 'c', c: 'a' } })), { code: 'cycle', detail: 'a → b → c → a' });
  // A cycle is caught even when no role uses it.
  assert.equal(failure(file({ defs: { x: 'y', y: 'x' }, roles: { text: '#fff' } })).code, 'cycle');
  assert.deepEqual(failure(file({ defs: { a: 'rgb(0,0,0)' } })), { code: 'color', detail: 'defs.a' });
});

test('missing roles keep the built-in theme; optional roles take their sibling first', () => {
  const { theme } = parsed({ roles: { accent: '#a48cff', text: { light: '#202020' } } });
  const dark = resolveTheme(theme, 'dark');
  assert.equal(dark.colors.background, BUILTIN_ROLES.dark.background);
  assert.equal(dark.colors.text, BUILTIN_ROLES.dark.text, 'a light-only pair leaves dark built-in');
  assert.equal(dark.colors['accent-fill'], '#a48cff', 'accent fill follows the accent');
  assert.equal(dark.colors.link, '#a48cff');
  assert.ok(!dark.supplied.has('background'));
  assert.ok(!dark.supplied.has('text'));
  assert.equal(resolveTheme(theme, 'light').colors.text, '#202020');
  // Only supplied roles are painted: the rest stay on the stylesheet.
  const tokens = themeTokens(dark).map((entry) => entry.token);
  assert.ok(
    tokens.includes('--mx-text-accent') && tokens.includes('--mx-accent-bg') && tokens.includes('--mx-md-code')
  );
  assert.ok(!tokens.includes('--mx-bg-deep') && !tokens.includes('--mx-text'));
});

test('a single-appearance theme resolves to its own appearance in either app mode', () => {
  const { theme } = parsed({ appearance: 'light', roles: { background: '#fdf6e3', text: '#073642' } });
  for (const mode of ['dark', 'light']) {
    const resolved = resolveTheme(theme, mode);
    assert.equal(resolved.mode, 'light');
    assert.equal(resolved.colors.background, '#fdf6e3');
    assert.equal(resolved.colors['text-muted'], BUILTIN_ROLES.light['text-muted']);
  }
});

test('the contrast guard adjusts inks to 4.5:1 and reports each adjustment', () => {
  // The built-in theme passes untouched in both appearances.
  const builtin = parsed({
    roles: Object.fromEntries(
      THEME_ROLES.map((r) => [r, { dark: BUILTIN_ROLES.dark[r], light: BUILTIN_ROLES.light[r] }])
    ),
  });
  assert.deepEqual(resolveTheme(builtin.theme, 'dark').adjustments, []);
  assert.deepEqual(resolveTheme(builtin.theme, 'light').adjustments, []);

  const { theme } = parsed({
    roles: {
      background: '#202020',
      text: '#444444',
      accent: '#303060',
      'code-background': '#2a2a2a',
      'code-text': '#555555',
    },
  });
  const resolved = resolveTheme(theme, 'dark');
  const roles = resolved.adjustments.map((entry) => entry.role);
  assert.ok(roles.includes('text') && roles.includes('accent') && roles.includes('code-text'), roles.join());
  const text = resolved.adjustments.find((entry) => entry.role === 'text');
  assert.equal(text.from, '#444444');
  assert.equal(resolved.colors.text, text.to);
  for (const against of text.against) {
    const under = resolved.colors[against].length === 9 ? null : resolved.colors[against];
    if (under) assert.ok(contrastRatio(resolved.colors.text, under) >= 4.5, `${against} ${under}`);
  }
  assert.ok(contrastRatio(resolved.colors.accent, '#202020') >= 4.5);
  // Muted ink sits on the theme background too, so it is guarded although the theme left it built-in.
  assert.ok(contrastRatio(resolved.colors['text-muted'], '#202020') >= 4.5);
  // The adjusted value is what gets painted.
  assert.match(themeStyleText(resolved), new RegExp(`--mx-text: ${text.to};`));
  // Translucent ink is judged flattened over its background.
  const ghost = resolveTheme(parsed({ roles: { text: '#ffffff30' } }).theme, 'dark');
  assert.equal(ghost.adjustments[0].role, 'text');
  assert.equal(ghost.colors.text, '#ffffff');
  // A pale accent fill gets dark accent text.
  const pale = resolveTheme(parsed({ roles: { 'accent-fill': '#ffe680' } }).theme, 'dark');
  assert.ok(contrastRatio(pale.colors['accent-text'], '#ffe680') >= 4.5);
});

test('the token sheet: specificity over the light block, skin-owned tokens step aside', () => {
  const { theme } = parsed({
    roles: {
      background: '#101820',
      text: '#e0e6ee',
      'user-bubble': '#1c2633',
      'accent-fill': '#2f6fdf',
      border: '#ffffff26',
    },
  });
  const css = themeStyleText(resolveTheme(theme, 'dark'));
  const block = (selector) => {
    const at = css.indexOf(`${selector} {`);
    assert.ok(at >= 0, selector);
    return css.slice(at, css.indexOf('}', at));
  };
  const base = ':root[data-mixdog-user-theme][data-mixdog-theme]';
  // A skin re-declares the window's ink with its paper (every plate, the
  // portaled dialogs too), so the theme's ink and paper step aside under it.
  const skinned = block(`${base}:not([data-mixdog-skin])`);
  assert.match(skinned, /--mx-workspace-sheet: #101820;/);
  assert.match(skinned, /--mx-bg-deep: #101820;/);
  assert.match(skinned, /--mx-text: #e0e6ee;/);
  assert.match(skinned, /--mx-border-muted: color-mix\(in srgb, #ffffff26 72%, transparent\);/);
  assert.match(skinned, /--mx-user-bubble: #1c2633;/);
  assert.match(skinned, /--mx-accent-bg: #2f6fdf;/);
  assert.equal(css.indexOf(`${base} {`), -1, 'no token here outlives a skin');
});

test('every token a skin plate re-declares on the root is skin-owned in the theme sheet', () => {
  const skinCss = readFileSync(new URL('../desktop/33-skin.css', import.meta.url), 'utf8');
  const start = skinCss.indexOf(':root[data-mixdog-skin][data-mixdog-skin-plate] {');
  assert.ok(start >= 0);
  const tint = skinCss.slice(start, skinCss.indexOf('}', start));
  const skinRoot = skinCss.slice(skinCss.indexOf('html[data-mixdog-skin],\n.skin-preview {'));
  const skinTokens = new Set([
    ...[...tint.matchAll(/(--mx-[\w-]+):/g)].map((m) => m[1]),
    ...[...skinRoot.slice(0, skinRoot.indexOf('}')).matchAll(/(--mx-[\w-]+):/g)].map((m) => m[1]),
    '--mx-accent-bg',
  ]);
  const everything = parsed({
    roles: Object.fromEntries(
      THEME_ROLES.map((r) => [r, BUILTIN_ROLES.dark[r] === '#ffffff' ? '#fefefe' : BUILTIN_ROLES.dark[r]])
    ),
  });
  for (const entry of themeTokens(resolveTheme(everything.theme, 'dark'))) {
    if (skinTokens.has(entry.token)) assert.notEqual(entry.owner, 'base', `${entry.token} must yield to the skin`);
  }
});

test('the starter file is the built-in theme, references the shipped schema and reads back clean', () => {
  const text = builtinThemeFile();
  const data = JSON.parse(text);
  assert.equal(data.$schema, THEME_SCHEMA_URL);
  assert.equal(data.name, 'Mixdog');
  assert.deepEqual(Object.keys(data.roles), [...THEME_ROLES]);
  const result = parseThemeFile(text);
  assert.ok(result.ok);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(resolveTheme(result.theme, 'light').adjustments, []);
  assert.equal(themeFileName('Solarized Light!'), 'solarized-light.mixdog-theme.json');
  assert.equal(themeFileName('???'), 'theme.mixdog-theme.json');
});
