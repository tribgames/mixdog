import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const THEME = JSON.stringify({
  $schema:
    'https://raw.githubusercontent.com/tribgames/mixdog/main/apps/desktop/src/renderer/appearance/schema/mixdog-theme/v1.json',
  name: 'Harbor',
  roles: { background: { dark: '#0f1720', light: '#f6f3ea' }, text: { dark: '#e6edf3', light: '#1d232b' } },
});

async function mountPanel(t, { native = true, fonts = ['Arial', 'Fira Code', 'Inter', 'bad;name'] } = {}) {
  const dom = installTestDom(t, {
    rootId: 'root',
    expose: ['MouseEvent', 'Event', 'HTMLElement', 'MutationObserver', 'KeyboardEvent', 'FocusEvent'],
  });
  const saved = [];
  dom.window.mixdogDesktop = {
    ...(native ? { bootContext: { bootId: 'boot-1' } } : {}),
    listSystemFonts: async () => fonts,
    saveFileAs: async (source, name) => {
      saved.push({ source, name });
      return true;
    },
  };
  const desktopTheme = await import('../desktop-theme');
  desktopTheme.applyDesktopThemePreference('dark');
  const { SkinPanel: AppearancePanel } = await import('./skin-panel');
  const theme = await import('../appearance/user-theme');
  const fontSettings = await import('../appearance/font-settings');
  theme.applyStoredUserTheme();
  await act(async () => dom.root.render(React.createElement(AppearancePanel, {})));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
  const { document, window } = dom;
  const button = (text) => [...document.querySelectorAll('button')].findLast((b) => b.textContent.trim() === text);
  const pickFile = async (text, name = 'theme.json') => {
    const input = document.querySelector('input[type="file"][accept*="json"]');
    // jsdom's File has no text(); the panel only reads the picked file's text.
    Object.defineProperty(input, 'files', { value: [{ name, text: async () => text }], configurable: true });
    await act(async () => input.dispatchEvent(new window.Event('change', { bubbles: true })));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
  };
  const setValue = async (input, value) => {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, String(value));
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  return { ...dom, saved, theme, fontSettings, button, pickFile, setValue };
}

test('importing a theme file applies it live and lists it in the picker; Built-in turns it off', async (t) => {
  const { document, root, theme, button, pickFile } = await mountPanel(t);
  const html = document.documentElement;
  assert.ok(button('Import theme file'));
  assert.equal(document.querySelector('input[type="file"][accept*="json"]').accept, '.json,application/json');
  await pickFile(THEME);
  assert.ok(html.dataset.mixdogUserTheme);
  assert.match(document.getElementById('mixdog-user-theme').textContent, /--mx-bg-deep: #0f1720;/);
  assert.ok(button('Remove theme'));
  assert.ok(document.querySelector('.appearance-swatches [data-role="background"]'));
  await act(async () => document.querySelector('[aria-label="Color theme"]').click());
  const options = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent.trim());
  assert.deepEqual(options, ['Built-in', 'Harbor']);
  const builtin = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Built-in');
  await act(async () => builtin.click());
  assert.equal(html.dataset.mixdogUserTheme, undefined);
  assert.equal(theme.getActiveUserThemeId(), null);
  assert.equal(theme.listUserThemes().length, 1, 'the import stays available');
  await act(async () => root.render(null));
});

test('an invalid file shows a visible error and leaves the built-in theme', async (t) => {
  const { document, root, pickFile } = await mountPanel(t);
  await pickFile('{"name":"Broken","roles":{"accent":"#zzz"}}');
  const alert = document.querySelector('.appearance-message[role="alert"]');
  assert.ok(alert);
  assert.match(alert.textContent, /roles\.accent is not a color/);
  assert.equal(document.documentElement.dataset.mixdogUserTheme, undefined);
  await pickFile('not json');
  assert.match(document.querySelector('.appearance-message[role="alert"]').textContent, /not valid JSON/);
  await act(async () => root.render(null));
});

test('readability adjustments and ignored keys are reported under the picker', async (t) => {
  const { document, root, pickFile } = await mountPanel(t);
  await pickFile(JSON.stringify({ name: 'Dim', mood: 'x', roles: { background: '#222222', text: '#333333' } }));
  const notes = [...document.querySelectorAll('.appearance-message[data-tone="note"]')].map((n) => n.textContent);
  assert.ok(
    notes.some((note) => /Ignored unknown keys: mood/.test(note)),
    notes.join('|')
  );
  assert.ok(
    notes.some((note) => /Adjusted for readability: text #333333 → #/.test(note)),
    notes.join('|')
  );
  await act(async () => root.render(null));
});

test('export saves the current theme (or the built-in starter) through the save dialog', async (t) => {
  const { root, saved, button, pickFile } = await mountPanel(t);
  await act(async () => button('Export theme file').click());
  assert.equal(saved[0].name, 'mixdog.mixdog-theme.json');
  assert.match(saved[0].source, /^data:application\/json;charset=utf-8,/);
  const starter = JSON.parse(decodeURIComponent(saved[0].source.slice(saved[0].source.indexOf(',') + 1)));
  assert.match(starter.$schema, /mixdog-theme\/v1\.json$/);
  await pickFile(THEME);
  await act(async () => button('Export theme file').click());
  assert.equal(saved[1].name, 'harbor.mixdog-theme.json');
  assert.equal(decodeURIComponent(saved[1].source.slice(saved[1].source.indexOf(',') + 1)), THEME);
  await act(async () => root.render(null));
});

const trigger = (document, label) => document.querySelector(`button[role="combobox"][aria-label="${label}"]`);
const menuOptions = (document) => [...document.querySelectorAll('[role="listbox"] [role="option"]')];
const openFont = async (document, label) => act(async () => trigger(document, label).click());
const chooseFont = async (document, label, text) => {
  await openFont(document, label);
  await act(async () =>
    menuOptions(document)
      .find((o) => o.textContent.trim() === text)
      .click()
  );
};

test('font fields are selects: Default first, installed fonts after, a pick applies and Default resets', async (t) => {
  const { document, root, fontSettings } = await mountPanel(t);
  const html = document.documentElement;
  assert.equal(document.querySelector('input[aria-label="UI font"]'), null, 'no text input');
  assert.equal(document.querySelector('input[aria-label="Code font"]'), null, 'no text input');
  assert.equal(
    trigger(document, 'UI font').textContent.trim(),
    'Default',
    'Default is selected when nothing is stored'
  );
  await openFont(document, 'UI font');
  assert.deepEqual(
    menuOptions(document).map((o) => o.textContent),
    ['Default', 'Arial', 'Fira Code', 'Inter'],
    'Default first, installed list, unsafe names dropped'
  );
  await act(async () => menuOptions(document)[3].click());
  assert.equal(fontSettings.getFontSettings().ui, 'Inter');
  assert.equal(document.querySelector('[role="listbox"]'), null, 'a pick closes the list');
  assert.equal(html.style.getPropertyValue('--mx-font-ui-user'), '"Inter",');
  assert.equal(trigger(document, 'UI font').textContent.trim(), 'Inter');
  await chooseFont(document, 'Code font', 'Fira Code');
  assert.equal(fontSettings.getFontSettings().mono, 'Fira Code');
  await chooseFont(document, 'UI font', 'Default');
  assert.equal(fontSettings.getFontSettings().ui, '', 'Default resets');
  await act(async () => root.render(null));
});

test('a stored font that is not installed still shows as the selection, after Default', async (t) => {
  const { document, root, fontSettings } = await mountPanel(t);
  await act(async () => fontSettings.setFontSettings({ ui: 'Gone Sans' }));
  assert.equal(trigger(document, 'UI font').textContent.trim(), 'Gone Sans');
  await openFont(document, 'UI font');
  const options = menuOptions(document);
  assert.deepEqual(
    options.slice(0, 2).map((o) => o.textContent),
    ['Default', 'Gone Sans']
  );
  assert.equal(options[1].getAttribute('aria-selected'), 'true');
  await act(async () => root.render(null));
});

test('Reset to defaults and an outside change update the font selects', async (t) => {
  const { document, root, fontSettings, button } = await mountPanel(t);
  await chooseFont(document, 'UI font', 'Arial');
  await act(async () => button('Reset to defaults').click());
  assert.equal(trigger(document, 'UI font').textContent.trim(), 'Default');
  await act(async () => fontSettings.setFontSettings({ mono: 'Inter' }));
  assert.equal(trigger(document, 'Code font').textContent.trim(), 'Inter');
  await act(async () => root.render(null));
});

test('size sliders and the ligature switch apply live; reset restores fonts and leaves the theme file alone', async (t) => {
  const { document, root, fontSettings, setValue, button, pickFile } = await mountPanel(t);
  const html = document.documentElement;
  const uiSize = document.querySelector('input[type="range"][aria-label="UI size"]');
  assert.deepEqual([uiSize.min, uiSize.max, uiSize.step, uiSize.value], ['85', '120', '5', '100']);
  await setValue(uiSize, 110);
  assert.equal(html.style.getPropertyValue('--mx-ui-scale'), '1.1');
  assert.equal(uiSize.getAttribute('aria-valuetext'), '110%');
  const codeSize = document.querySelector('input[type="range"][aria-label="Code size"]');
  await setValue(codeSize, 16);
  assert.equal(fontSettings.getFontSettings().codeSize, 16);
  assert.equal(codeSize.getAttribute('aria-valuetext'), '16px');
  await act(async () => document.querySelector('input[aria-label="Code ligatures"]').click());
  assert.equal(html.dataset.mixdogMonoLigatures, 'off');
  await pickFile(THEME);
  assert.ok(html.dataset.mixdogUserTheme);
  await act(async () => button('Reset to defaults').click());
  assert.equal(html.style.getPropertyValue('--mx-ui-scale'), '');
  assert.equal(html.dataset.mixdogMonoLigatures, undefined);
  assert.ok(html.dataset.mixdogUserTheme, 'the theme file stays on');
  assert.equal(uiSize.value, '100');
  await act(async () => root.render(null));
});

test('outside the desktop app (browser, phone) the host font list is not asked for: only Default', async (t) => {
  const { document, root } = await mountPanel(t, { native: false });
  await openFont(document, 'UI font');
  assert.deepEqual(
    menuOptions(document).map((o) => o.textContent),
    ['Default']
  );
  await act(async () => root.render(null));
});

test('the installed-font list is a bounded scrolling listbox with keyboard picking', async (t) => {
  const many = Array.from({ length: 3000 }, (_, i) => `Font ${String(i).padStart(4, '0')}`);
  const { document, root, fontSettings } = await mountPanel(t, { fonts: many });
  await openFont(document, 'Code font');
  const menu = document.querySelector('[role="listbox"]');
  assert.ok(menu.classList.contains('mx-menu'), 'uses the shared bounded, scrolling menu');
  assert.equal(menu.parentElement, document.body, 'portal: not clipped by the settings card');
  assert.equal(menu.querySelectorAll('[role="option"]').length, 3001);
  assert.ok(
    Number.parseFloat(menu.style.maxHeight) > 0 && Number.parseFloat(menu.style.maxHeight) <= 240,
    `maxHeight ${menu.style.maxHeight}`
  );
  await act(async () => menuOptions(document)[2].click());
  assert.equal(fontSettings.getFontSettings().mono, 'Font 0001');
  assert.equal(document.querySelector('[role="listbox"]'), null);
  await act(async () => root.render(null));
});
