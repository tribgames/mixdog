import assert from 'node:assert/strict';
import test from 'node:test';
import { installTestDom } from './test-support/test-dom.mjs';

const THEME_KEY = 'mixdog.desktop-theme-preference';
const LANGUAGE_KEY = 'mixdog.desktop.ui-language.v1';

const { setDesktopThemePreference, getDesktopThemePreference } = await import('./desktop-theme.ts');
const { setUiLanguagePreference, getUiLanguagePreference } = await import('./i18n.ts');
const { applyHostDisplayPreferences, followHostDisplay, installHostDisplaySync } = await import(
  './host-display-sync.ts'
);
const { readHostWindowDisplayPreferences } = await import('../main/host-display-preferences.ts');

function browser(t, { stored = {} } = {}) {
  const dom = installTestDom(t, { expose: ['navigator'], actEnvironment: false });
  for (const [key, value] of Object.entries(stored)) dom.window.localStorage.setItem(key, value);
  return dom;
}

function recorder() {
  const reloads = [];
  return { reloads, reload: () => reloads.push(true) };
}

test('a browser with no local choice adopts the host theme and language', (t) => {
  const { window } = browser(t);
  const { reloads, reload } = recorder();
  applyHostDisplayPreferences({ theme: 'white', language: 'ko' }, reload);
  assert.equal(getDesktopThemePreference(), 'white');
  assert.equal(window.document.documentElement.dataset.mixdogTheme, 'light');
  assert.equal(getUiLanguagePreference(), 'ko');
  assert.equal(reloads.length, 1, 'a different language reloads once');
  // After the reload the adopted language is the stored one: nothing more to do.
  applyHostDisplayPreferences({ theme: 'white', language: 'ko' }, reload);
  assert.equal(reloads.length, 1);
});

test('host changes are followed while nothing was chosen locally', (t) => {
  browser(t);
  const { reload } = recorder();
  applyHostDisplayPreferences({ theme: 'white', language: 'ko' }, reload);
  applyHostDisplayPreferences({ theme: 'dark', language: 'ja' }, reload);
  assert.equal(getDesktopThemePreference(), 'dark');
  assert.equal(getUiLanguagePreference(), 'ja');
});

test('a local choice wins over the host and persists', (t) => {
  const { window } = browser(t);
  const { reloads, reload } = recorder();
  setDesktopThemePreference('dark');
  setUiLanguagePreference('de');
  applyHostDisplayPreferences({ theme: 'white', language: 'ko' }, reload);
  assert.equal(getDesktopThemePreference(), 'dark');
  assert.equal(window.localStorage.getItem(THEME_KEY), 'dark');
  assert.equal(getUiLanguagePreference(), 'de');
  assert.equal(reloads.length, 0);
});

test('a local choice made after adopting stops following the host', (t) => {
  browser(t);
  const { reload } = recorder();
  applyHostDisplayPreferences({ theme: 'white', language: null }, reload);
  setDesktopThemePreference('system');
  applyHostDisplayPreferences({ theme: 'dark', language: null }, reload);
  assert.equal(getDesktopThemePreference(), 'system');
});

test('each setting is overridden independently', (t) => {
  browser(t);
  const { reload } = recorder();
  setUiLanguagePreference('de');
  applyHostDisplayPreferences({ theme: 'white', language: 'ko' }, reload);
  assert.equal(getDesktopThemePreference(), 'white', 'theme still follows');
  assert.equal(getUiLanguagePreference(), 'de', 'language was chosen locally');
});

test('values stored before the marker count as local only when not default', (t) => {
  browser(t, { stored: { [THEME_KEY]: 'white', [LANGUAGE_KEY]: 'fr' } });
  const { reload } = recorder();
  applyHostDisplayPreferences({ theme: 'dark', language: 'ko' }, reload);
  assert.equal(getDesktopThemePreference(), 'white');
  assert.equal(getUiLanguagePreference(), 'fr');
});

test('a legacy default dark theme and no language are not local choices', (t) => {
  browser(t, { stored: { [THEME_KEY]: 'dark' } });
  const { reload } = recorder();
  applyHostDisplayPreferences({ theme: 'white', language: 'ko' }, reload);
  assert.equal(getDesktopThemePreference(), 'white');
  assert.equal(getUiLanguagePreference(), 'ko');
});

test('unknown host values are ignored', (t) => {
  browser(t);
  const { reloads, reload } = recorder();
  applyHostDisplayPreferences({ theme: 'no-such-theme', language: 'xx' }, reload);
  applyHostDisplayPreferences(null, reload);
  assert.equal(getDesktopThemePreference(), null);
  assert.equal(getUiLanguagePreference(), 'system');
  assert.equal(reloads.length, 0);
});

test('the sync reads on connect and on every host settings change', async (t) => {
  browser(t);
  const { reload } = recorder();
  let host = { theme: 'white', language: null };
  let announce = () => {};
  const api = {
    readHostDisplayPreferences: async () => host,
    subscribeSettingsChanged: (listener) => {
      announce = listener;
      return () => {
        announce = () => {};
      };
    },
  };
  const stop = installHostDisplaySync(api, reload);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getDesktopThemePreference(), 'white');
  host = { theme: 'dark', language: null };
  announce({ scope: 'desktop' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getDesktopThemePreference(), 'dark');
  stop();
  host = { theme: 'white', language: null };
  announce({ scope: 'desktop' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(getDesktopThemePreference(), 'dark', 'stopped syncs no longer follow');
});

test('a host that cannot answer leaves the local look alone', async (t) => {
  browser(t);
  const stop = installHostDisplaySync({
    readHostDisplayPreferences: () => Promise.reject(new Error('unknown method')),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop();
  assert.equal(getDesktopThemePreference(), null);
});

test('following the host again replaces a local choice', async (t) => {
  browser(t);
  const { reload } = recorder();
  setDesktopThemePreference('dark');
  await followHostDisplay({ readHostDisplayPreferences: async () => ({ theme: 'white', language: null }) }, reload);
  assert.equal(getDesktopThemePreference(), 'white');
  applyHostDisplayPreferences({ theme: 'dark', language: null }, reload);
  assert.equal(getDesktopThemePreference(), 'dark', 'following resumed');
});

test('the host reads its window display choice and resolves the language', async () => {
  const code = [];
  const window = {
    isDestroyed: () => false,
    webContents: {
      executeJavaScript: async (script) => {
        code.push(script);
        return { theme: 'nord', language: null, locales: ['ko-KR'] };
      },
    },
  };
  assert.deepEqual(await readHostWindowDisplayPreferences(window, 'en-US'), { theme: 'nord', language: 'ko' });
  assert.ok(code[0].includes(THEME_KEY) && code[0].includes(LANGUAGE_KEY));
  assert.equal(await readHostWindowDisplayPreferences(null, 'en-US'), null);
  assert.equal(await readHostWindowDisplayPreferences({ ...window, isDestroyed: () => true }, 'en-US'), null);
});
