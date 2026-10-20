// The Workflows page lists agents (delegation roles) only: shipped roles and
// ones made here (`kind: agent`), never bots (agent-mode contacts). Built-in
// helpers keep their own group.
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

const AGENTS = [
  { id: 'maintainer', label: 'Maintainer', locked: true, disabled: true, route: {} },
  { id: 'worker', custom: true, label: 'Worker', kind: null, route: {} },
  { id: 'triage', custom: true, label: 'Triage', kind: 'agent', route: {} },
  { id: 'github-watcher', custom: true, label: 'GitHub Watcher', kind: null, route: {} },
];

test('the Workflows page lists workflow agents, not bots; built-in agents are their own group', async (t) => {
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
  updateSidebarReference('workflows', []);
  updateSidebarReference('agents', AGENTS);
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
  });
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
  });
  const section = (label) => host.querySelector(`section.workflows-models[aria-label="${label}"]`);
  const names = (label) =>
    [...section(label).querySelectorAll('.sidebar-resource-row')].map((row) =>
      row.getAttribute('aria-label').replace(/^Edit /, '')
    );
  assert.deepEqual(names('Built-in agents'), ['Web Search', 'Maintainer']);
  assert.deepEqual(names('Agents'), ['Worker', 'Triage']);
});

test('the Lead agent row sits above the built-in agents and edits the Main route', async (t) => {
  const routes = [];
  const api = {
    async invokeCapability() {
      return { value: undefined };
    },
    async listProviderModels() {
      return [];
    },
    async getSnapshot() {
      return { provider: 'anthropic', model: 'claude-test', effort: 'high' };
    },
    async setModelRoute(selection) {
      routes.push(selection);
      return { ...selection };
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('workflows', []);
  updateSidebarReference('agents', AGENTS);
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
  });
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
  });
  const sections = [...host.querySelectorAll('section.workflows-models')].map((s) => s.getAttribute('aria-label'));
  assert.deepEqual(sections, ['Work rules', 'Lead agent', 'Built-in agents', 'Agents']);
  const row = host.querySelector('section[aria-label="Lead agent"] .sidebar-resource-row');
  assert.equal(row.getAttribute('aria-label'), 'Edit Lead');
  assert.equal(row.querySelectorAll('.sidebar-resource-row, [aria-label="Delete"]').length, 0);
  await act(async () => row.click());
  const dialog = document.querySelector('[role="dialog"]');
  assert.equal(dialog.querySelector('input[type="checkbox"]'), null, 'Lead has no on/off');
  await act(async () =>
    dialog.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].provider, 'anthropic');
  assert.equal(routes[0].model, 'claude-test');
});
