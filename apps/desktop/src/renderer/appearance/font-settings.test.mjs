import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from '../test-support/test-dom.mjs';
import { DEFAULT_FONT_SETTINGS, normalizeFontSettings, sanitizeFontFamily, userFontPrefix } from './font-settings';

test('family names are sanitized before they reach CSS', () => {
  assert.equal(sanitizeFontFamily('  Inter  '), 'Inter');
  assert.equal(sanitizeFontFamily('"Fira Code"'), 'Fira Code');
  assert.equal(sanitizeFontFamily("'JetBrains Mono'"), 'JetBrains Mono');
  assert.equal(sanitizeFontFamily('Source   Han Sans'), 'Source Han Sans');
  assert.equal(sanitizeFontFamily('맑은 고딕'), '맑은 고딕');
  assert.equal(sanitizeFontFamily('ヒラギノ角ゴ ProN W3'), 'ヒラギノ角ゴ ProN W3');
  assert.equal(sanitizeFontFamily('Noto Sans CJK KR.Bold-2 & Co+'), 'Noto Sans CJK KR.Bold-2 & Co+');
  // Anything that could close the string or the declaration is refused outright.
  for (const hostile of [
    'Inter"; color: red; --x: "',
    'Inter;}body{display:none',
    'a\\"b',
    'url(https://evil.test/x)',
    'Inter, monospace',
    '<style>',
    'Inter\u0000',
    'x'.repeat(65),
    '',
    '   ',
    42,
    null,
  ]) {
    assert.equal(sanitizeFontFamily(hostile), '', JSON.stringify(hostile));
  }
  // Quoted generic / wide keywords name no installed font.
  for (const reserved of ['monospace', 'Sans-Serif', 'system-ui', 'inherit', 'initial']) {
    assert.equal(sanitizeFontFamily(reserved), '');
  }
});

test('the user family is prepended to the built-in stack, which stays as the fallback', () => {
  assert.equal(userFontPrefix('Inter'), '"Inter",');
  assert.equal(userFontPrefix('bad;name'), '');
  assert.equal(userFontPrefix(''), '');
});

test('stored values are clamped to the capped ranges', () => {
  assert.deepEqual(normalizeFontSettings(null), DEFAULT_FONT_SETTINGS);
  assert.deepEqual(normalizeFontSettings({ ui: 'x;y', mono: 'Fira Code', uiScale: 9, codeSize: 2, ligatures: 0 }), {
    ui: '',
    mono: 'Fira Code',
    uiScale: 1.2,
    codeSize: 10,
    ligatures: true,
  });
  assert.equal(normalizeFontSettings({ uiScale: 0.1 }).uiScale, 0.85);
  assert.equal(normalizeFontSettings({ uiScale: 1.07 }).uiScale, 1.05);
  assert.equal(normalizeFontSettings({ codeSize: 99 }).codeSize, 20);
  assert.equal(normalizeFontSettings({ codeSize: 'big' }).codeSize, 13);
  assert.equal(normalizeFontSettings({ ligatures: false }).ligatures, false);
});

test('settings paint the root, persist on this device, and reset clears every property', async (t) => {
  const { window, document } = installTestDom(t, { actEnvironment: false });
  const fonts = await import('./font-settings');
  const root = document.documentElement;
  let events = 0;
  const stop = fonts.subscribeFontSettings(() => events++);
  fonts.setFontSettings({ ui: 'Inter', mono: '"Fira Code"', uiScale: 1.1, codeSize: 15, ligatures: false });
  assert.equal(root.style.getPropertyValue('--mx-font-ui-user'), '"Inter",');
  assert.equal(root.style.getPropertyValue('--mx-font-mono-user'), '"Fira Code",');
  assert.equal(root.style.getPropertyValue('--mx-ui-scale'), '1.1');
  assert.equal(root.style.getPropertyValue('--mx-code-scale'), String(Math.round((15 / 13) * 1e4) / 1e4));
  assert.equal(root.dataset.mixdogMonoLigatures, 'off');
  assert.equal(events, 1);
  assert.deepEqual(JSON.parse(window.localStorage.getItem('mixdog.desktop.fonts.v1')), {
    ui: 'Inter',
    mono: 'Fira Code',
    uiScale: 1.1,
    codeSize: 15,
    ligatures: false,
  });
  // A hostile stored record never reaches CSS.
  window.localStorage.setItem('mixdog.desktop.fonts.v1', JSON.stringify({ ui: 'a"; x: y', mono: 'Fira Code' }));
  fonts.applyFontSettings();
  assert.equal(root.style.getPropertyValue('--mx-font-ui-user'), '');
  fonts.resetFontSettings();
  for (const name of ['--mx-font-ui-user', '--mx-font-mono-user', '--mx-ui-scale', '--mx-code-scale']) {
    assert.equal(root.style.getPropertyValue(name), '', name);
  }
  assert.equal(root.dataset.mixdogMonoLigatures, undefined);
  assert.equal(window.localStorage.getItem('mixdog.desktop.fonts.v1'), null);
  stop();
});

