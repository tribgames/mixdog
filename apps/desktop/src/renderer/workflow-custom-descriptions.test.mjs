import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installTestDom } from './test-support/test-dom.mjs';

const { dom } = installTestDom(null, {
  html: '<!doctype html><html><body></body></html>',
  jsdom: { url: 'https://mixdog.test/' },
  expose: ['HTMLElement'],
  actEnvironment: false,
});
globalThis.React = React;
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLElement.prototype.attachEvent = () => {};
window.HTMLElement.prototype.detachEvent = () => {};
window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
window.mixdogDesktop = { setTitleBarDimmed() {}, rendererDiagnostic() {} };

const { WorkflowsPane } = await import('./WorkflowsView.tsx');
const { adoptSidebarReferenceHost, resetSidebarReferenceCache, updateSidebarReference } = await import(
  './sidebar-reference-cache.ts'
);
const { initUiLanguage, setUiLanguagePreference } = await import('./i18n.ts');

// "History" is an app catalog key (ko: 기록), used here as a stand-in for any
// translatable text. Only a positively known built-in source (the backend's
// 'built-in' | 'user' union) may translate a description; names are identity
// and always stay literal; unknown sources are preserved.
const workflows = [
  { id: 'default', name: 'Default', source: 'built-in', description: 'History' },
  { id: 'default-user', name: 'Default', source: 'user', description: 'History' },
  { id: 'other', name: 'Other', source: 'plugin', description: 'History' },
  { id: 'nosource', name: 'Nosource', description: 'History' },
];

test('only built-in workflow descriptions translate; names and other sources stay literal', async (t) => {
  setUiLanguagePreference('ko');
  await initUiLanguage();
  const api = {
    async invokeCapability() {
      return { value: undefined };
    },
    async listProviderModels() {
      return [];
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('workflows', workflows);
  updateSidebarReference('agents', []);
  updateSidebarReference('webSearchRoute', {});
  updateSidebarReference('webSearchModels', []);
  updateSidebarReference('providerSetup', {});
  updateSidebarReference('quickProviderModels', []);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
    setUiLanguagePreference('en');
    await initUiLanguage();
  });
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
  });
  const rows = [...host.querySelectorAll('.workflows-packs .schedules-row')];
  assert.equal(rows.length, 4);
  const summary = rows.map((row) => ({
    name: row.querySelector('b').textContent,
    description: row.getAttribute('data-tooltip'),
  }));
  const named = (name) => summary.filter((entry) => entry.name === name);
  // Built-in Default and a user pack with the same name both keep the name.
  assert.deepEqual(
    named('Default').map((entry) => entry.description).sort(),
    ['History', '기록']
  );
  assert.deepEqual(named('Other'), [{ name: 'Other', description: 'History' }]);
  assert.deepEqual(named('Nosource'), [{ name: 'Nosource', description: 'History' }]);
});
