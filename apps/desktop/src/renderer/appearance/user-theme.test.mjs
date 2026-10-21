import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from '../test-support/test-dom.mjs';
import { contrastRatio, fitAccent, plateTones } from '../skin-color';
import { SKIN_MANIFEST } from '../skin-manifest';
import { THEME_SCHEMA_URL } from './theme-file';

const PAIR_THEME = JSON.stringify({
  $schema: THEME_SCHEMA_URL,
  name: 'Harbor',
  defs: { night: '#0f1720', paper: '#f6f3ea', violet: '#8a63d2' },
  roles: {
    background: { dark: 'night', light: 'paper' },
    text: { dark: '#e6edf3', light: '#1d232b' },
    'accent-fill': 'violet',
  },
});
const LIGHT_ONLY = JSON.stringify({
  $schema: THEME_SCHEMA_URL,
  name: 'Paper only',
  appearance: 'light',
  roles: { background: '#fbf7ee', text: '#2a2620' },
});

async function themeDom(t) {
  const dom = installTestDom(t, { actEnvironment: false, expose: ['MutationObserver'] });
  const root = dom.document.documentElement;
  const theme = await import('./user-theme');
  const desktopTheme = await import('../desktop-theme');
  desktopTheme.applyDesktopThemePreference('dark');
  theme.applyStoredUserTheme();
  const sheet = () => dom.document.getElementById('mixdog-user-theme')?.textContent ?? '';
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { ...dom, root, theme, desktopTheme, sheet, settle };
}

test('importing a theme stores it on this device, turns it on and paints its sheet', async (t) => {
  const { root, theme, sheet, window } = await themeDom(t);
  assert.equal(sheet(), '', 'built-in theme: no sheet');
  let events = 0;
  theme.subscribeUserTheme(() => events++);
  const result = theme.importUserTheme(PAIR_THEME);
  assert.ok(result.ok);
  assert.equal(events, 1);
  assert.equal(root.dataset.mixdogUserTheme, result.id);
  assert.match(sheet(), /--mx-bg-deep: #0f1720;/);
  assert.match(sheet(), /--mx-text: #e6edf3;/);
  assert.equal(JSON.parse(window.localStorage.getItem('mixdog.desktop.user-themes.v1'))[0].name, 'Harbor');
  // Re-importing the same name replaces it instead of piling up copies.
  assert.equal(theme.importUserTheme(PAIR_THEME).id, result.id);
  assert.equal(theme.listUserThemes().length, 1);
});

test('a {dark, light} theme follows the app setting and repaints when it flips', async (t) => {
  const { theme, desktopTheme, sheet, settle } = await themeDom(t);
  theme.importUserTheme(PAIR_THEME);
  assert.match(sheet(), /--mx-bg-deep: #0f1720;/);
  desktopTheme.setDesktopThemePreference('white');
  await settle();
  assert.match(sheet(), /--mx-bg-deep: #f6f3ea;/);
  assert.match(sheet(), /--mx-text: #1d232b;/);
  desktopTheme.setDesktopThemePreference('dark');
  await settle();
  assert.match(sheet(), /--mx-bg-deep: #0f1720;/);
});

test('a single-appearance theme switches the app to its appearance while on, and back when off', async (t) => {
  const { root, theme, sheet } = await themeDom(t);
  const dark = root.dataset.mixdogTheme;
  assert.notEqual(dark, 'light');
  const result = theme.importUserTheme(LIGHT_ONLY);
  assert.equal(root.dataset.mixdogTheme, 'light');
  assert.equal(theme.activeUserThemeAppearance(), 'light');
  assert.match(sheet(), /--mx-bg-deep: #fbf7ee;/);
  theme.setActiveUserTheme(null);
  assert.equal(root.dataset.mixdogTheme, dark);
  assert.equal(root.dataset.mixdogUserTheme, undefined);
  assert.equal(sheet(), '');
  theme.setActiveUserTheme(result.id);
  assert.equal(root.dataset.mixdogTheme, 'light');
  theme.removeUserTheme(result.id);
  assert.equal(root.dataset.mixdogTheme, dark);
  assert.deepEqual(theme.listUserThemes(), []);
});

test('an invalid file changes nothing; a stored theme that no longer reads shows the built-in theme and the error', async (t) => {
  const { root, theme, sheet, window } = await themeDom(t);
  const bad = theme.importUserTheme('{"name": "Broken", "roles": {"text": "#12"}}');
  assert.deepEqual(bad, { ok: false, error: { code: 'color', detail: 'roles.text' } });
  assert.deepEqual(theme.listUserThemes(), []);
  assert.equal(sheet(), '');
  // A stored theme corrupted outside the app (or by an older build).
  window.localStorage.setItem(
    'mixdog.desktop.user-themes.v1',
    JSON.stringify([{ id: 'old', name: 'Old', source: '{"name":"Old","defs":{"a":"b","b":"a"}}' }])
  );
  window.localStorage.setItem('mixdog.desktop.user-theme.v1', 'old');
  theme.applyStoredUserTheme();
  assert.equal(sheet(), '', 'built-in theme');
  assert.equal(root.dataset.mixdogUserTheme, undefined);
  assert.deepEqual(theme.userThemeReport().error, { code: 'cycle', detail: 'a → b → a' });
});

test('adjustments and warnings are reported for the active theme', async (t) => {
  const { theme } = await themeDom(t);
  const result = theme.importUserTheme(
    JSON.stringify({ name: 'Low contrast', extra: 1, roles: { background: '#222222', text: '#3a3a3a' } })
  );
  assert.ok(result.ok);
  assert.deepEqual(result.warnings, [{ code: 'unknown-keys', detail: 'extra' }]);
  assert.ok(result.adjustments.some((entry) => entry.role === 'text'));
  const report = theme.userThemeReport();
  assert.equal(report.name, 'Low contrast');
  assert.ok(contrastRatio(report.adjustments.find((entry) => entry.role === 'text').to, '#222222') >= 4.5);
});

test('export writes the active theme as imported, else the built-in starter', async (t) => {
  const { theme } = await themeDom(t);
  const starter = theme.exportThemeFile();
  assert.equal(starter.name, 'mixdog.mixdog-theme.json');
  assert.equal(JSON.parse(starter.text).$schema, THEME_SCHEMA_URL);
  theme.importUserTheme(PAIR_THEME);
  assert.deepEqual(theme.exportThemeFile(), { name: 'harbor.mixdog-theme.json', text: PAIR_THEME });
});

test('skin interplay: the theme accent is the skin default, the override wins, the guard runs last', async (t) => {
  const { root, theme, sheet } = await themeDom(t);
  const skin = await import('../desktop-skin');
  skin.applyStoredSkin();
  const glass = SKIN_MANIFEST.find((entry) => entry.id === 'glass-flow');
  skin.setSkin('glass-flow');
  const tint = plateTones('light', 'dark', glass.cast).tint;
  const accent = () => root.style.getPropertyValue('--mx-skin-accent');
  assert.equal(accent(), fitAccent(glass.accent, tint), 'no theme: the picture accent');
  theme.importUserTheme(PAIR_THEME);
  assert.equal(accent(), fitAccent('#8a63d2', tint), 'theme accent through the guard');
  assert.ok(contrastRatio(accent(), tint) >= 3);
  skin.setSkinAccent('#e9799a');
  assert.equal(accent(), fitAccent('#e9799a', tint), 'the skin override wins');
  skin.setSkinAccent(null);
  theme.setActiveUserTheme(null);
  assert.equal(accent(), fitAccent(glass.accent, tint), 'theme off: back to the picture');
  // The skin keeps its picture and plates; the theme yields the tokens a skin owns.
  theme.importUserTheme(PAIR_THEME);
  assert.equal(root.dataset.mixdogSkin, 'glass-flow');
  assert.ok(root.style.getPropertyValue('--mx-skin-image').startsWith('url('));
  assert.match(sheet(), /:not\(\[data-mixdog-skin\]\) \{[^}]*--mx-accent-bg: #8a63d2;/);
  assert.match(sheet(), /:not\(\[data-mixdog-skin\]\) \{[^}]*--mx-text: #e6edf3;/);
  // None (no skin): the Settings preview shows the theme's accent fill.
  const none = skin.skinVars(
    'none',
    { outerTransparency: 50, mainTransparency: 50, plate: 'tint', accent: null },
    'dark'
  );
  assert.equal(none['--mx-skin-accent'], fitAccent('#8a63d2', plateTones('dark', 'dark', { hue: 0, sat: 0 }).tint));
  skin.resetSkin();
});
