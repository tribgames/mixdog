import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { installTestDom } from '../test-support/test-dom.mjs';

const { restore } = installTestDom(null, {
  html: '<!doctype html><html><body><main></main></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement', 'HTMLInputElement', 'Event', 'MouseEvent', 'Node', 'Element'],
  actEnvironment: false,
});
test.after(restore);
const { createRoot } = await import('react-dom/client');
const { default: i18next, t } = await import('../i18n.ts');
const controls = await import('./capability-controls.tsx');
const { ProvidersPanel } = await import('./provider-panel.tsx');
const { CategoryPanel } = await import('./capability-panels.tsx');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

// Custom names that collide with catalog keys must stay literal; app copy translates.
i18next.addResourceBundle('ko', 'translation', {
  Agent: '에이전트',
  Settings: '설정',
  History: '기록',
  Choose: '선택',
  Empty: '비어 있음',
  'Custom providers': '사용자 지정 제공자',
  'Add custom provider': '사용자 지정 제공자 추가',
});
await i18next.changeLanguage('ko');
test.after(() => i18next.changeLanguage('en'));

function mount(t, element) {
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
  });
  return act(async () => root.render(element));
}

const noop = () => {};

test('shared controls render caller strings literally', async (ctx) => {
  assert.equal(t('Agent'), '에이전트');
  const { Group, ToggleRow, SelectRow, ResourceRow, ActionButton, AutoSaveRow, Empty, ListEmpty } = controls;
  await mount(
    ctx,
    React.createElement(
      Group,
      { title: 'Agent', description: 'Settings' },
      React.createElement(ToggleRow, { title: 'History', checked: false, onChange: noop }),
      React.createElement(SelectRow, {
        title: 'Settings',
        value: 'agent',
        options: [{ value: 'agent', label: 'Agent' }],
        onChange: noop,
      }),
      React.createElement(ResourceRow, {
        title: 'Agent',
        actions: React.createElement(ActionButton, { onClick: noop }, 'History'),
      }),
      React.createElement(AutoSaveRow, { title: 'Agent', name: 'n', value: '', placeholder: 'History', onSave: noop }),
      React.createElement(Empty, { text: 'Empty' }),
      React.createElement(ListEmpty, { text: 'History' })
    )
  );
  const text = document.querySelector('main').textContent;
  for (const literal of ['Agent', 'Settings', 'History', 'Empty']) assert.ok(text.includes(literal), literal);
  for (const translated of ['에이전트', '설정', '기록', '비어 있음']) assert.ok(!text.includes(translated), translated);
  assert.equal(document.querySelector('input[name=n]').getAttribute('placeholder'), 'History');
  assert.equal(document.querySelector('input[type=checkbox]').getAttribute('aria-label'), 'History');
});

test('confirmation dialog shows caller-localized strings unchanged', async (ctx) => {
  await mount(
    ctx,
    React.createElement(controls.SettingsConfirmDialog, {
      options: { title: 'History', description: 'Agent', confirmLabel: 'Settings', onConfirm: noop },
      onClose: noop,
    })
  );
  const dialog = document.querySelector('[role=alertdialog]');
  assert.equal(dialog.querySelector('h3').textContent, 'History');
  assert.equal(dialog.querySelector('p').textContent, 'Agent');
  assert.ok([...dialog.querySelectorAll('button')].some((b) => b.textContent === 'Settings'));
});

test('custom provider names stay literal while provider section copy is localized', async (ctx) => {
  const provider = {
    id: 'custom:agent',
    name: 'Agent',
    custom: true,
    protocol: 'openai-chat',
    baseURL: 'https://agent.test/v1',
    models: [{ id: 'History' }],
    authenticated: true,
    enabled: true,
  };
  await mount(
    ctx,
    React.createElement(ProvidersPanel, {
      api: {},
      data: { providerSetup: { api: [provider], oauth: [] }, __loadedSections: ['providerSetup'] },
      pending: '',
      run: async () => undefined,
      confirm: noop,
    })
  );
  const titles = [...document.querySelectorAll('.settings-resource-title b')].map((b) => b.textContent);
  assert.ok(titles.includes('Agent'));
  assert.ok(!titles.includes('에이전트'));
  assert.ok(titles.includes('사용자 지정 제공자 추가'));
  assert.equal(document.querySelector('.settings-custom-providers h3').textContent, '사용자 지정 제공자');
});

test('custom output style named like a catalog key stays literal', async (ctx) => {
  await mount(
    ctx,
    React.createElement(CategoryPanel, {
      category: 'output-style',
      context: {
        api: {},
        data: {
          outputStyles: {
            current: { id: 'x' },
            styles: [
              { id: 'history', label: 'History', description: 'Agent' },
              { id: 'x', label: 'Settings' },
            ],
          },
          __loadedSections: ['outputStyles'],
        },
        pending: '',
        run: async () => undefined,
        confirm: noop,
      },
    })
  );
  const text = document.querySelector('main').textContent;
  assert.ok(text.includes('History') && text.includes('Settings'));
  assert.ok(!text.includes('기록') && !text.includes('설정'));
  assert.ok([...document.querySelectorAll('button')].some((b) => b.textContent === '선택'));
});

test('provider panels preserve status tones and custom names in English and Korean', async (ctx) => {
  i18next.addResourceBundle('ko', 'translation', { 'Checking…': '확인 중…', Connected: '연결됨' });
  const root = createRoot(document.querySelector('main'));
  ctx.after(async () => {
    await act(async () => root.unmount());
  });
  const render = () =>
    act(async () =>
      root.render(
        React.createElement(ProvidersPanel, {
          api: {},
          data: {
            providerSetup: {
              pendingSecrets: true,
              api: [
                { id: 'openai', name: 'Settings', authenticated: false },
                {
                  id: 'custom:agent',
                  name: 'Agent',
                  custom: true,
                  authenticated: true,
                  enabled: true,
                  protocol: 'openai-chat',
                  baseURL: 'https://agent.test/v1',
                  models: [],
                },
              ],
              oauth: [],
            },
            __loadedSections: ['providerSetup'],
          },
          pending: '',
          run: async () => undefined,
          confirm: noop,
        })
      )
    );
  const state = (name) =>
    [...document.querySelectorAll('.settings-resource-title b')]
      .find((node) => node.textContent === name)
      .closest('.settings-resource')
      .querySelector('.settings-status');
  for (const [language, checking, connected] of [
    ['en', 'Checking…', 'Connected'],
    ['ko', '확인 중…', '연결됨'],
  ]) {
    await i18next.changeLanguage(language);
    await render();
    assert.equal(state('Settings').textContent, checking);
    assert.ok(state('Settings').classList.contains('settings-status--warning'));
    assert.equal(state('Agent').textContent, connected);
    assert.ok(state('Agent').classList.contains('settings-status--positive'));
  }
  await i18next.changeLanguage('ko');
});
