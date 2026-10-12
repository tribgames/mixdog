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
const { ModelRouteLabel } = await import('./provider-display.tsx');
const { displayEffortLabel, publishAutoEffort } = await import('./auto-effort-store.ts');
const { adoptSidebarReferenceHost, resetSidebarReferenceCache, updateSidebarReference } = await import(
  './sidebar-reference-cache.ts'
);

const setSwitch = (enabled) =>
  act(async () => publishAutoEffort({ autoEffort: { installed: true, enabled, supported: true } }));

test('displayEffortLabel: Auto only when on + capable + not max/ultra', () => {
  const on = { autoOn: true, capable: true };
  assert.equal(displayEffortLabel('high', on), 'Auto');
  assert.equal(displayEffortLabel('', on), 'Auto');
  assert.equal(displayEffortLabel('max', on), null);
  assert.equal(displayEffortLabel('ULTRA', on), null);
  assert.equal(displayEffortLabel('high', { autoOn: false, capable: true }), null);
  assert.equal(displayEffortLabel('high', { autoOn: true, capable: false }), null);
});

test('ModelRouteLabel follows the Auto switch live and respects capability and max/ultra', async (t) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
  });
  const text = async (props) => {
    await act(async () => root.render(React.createElement(ModelRouteLabel, { model: 'Opus', ...props })));
    return host.textContent;
  };
  await setSwitch(false);
  assert.equal(await text({ effort: 'high', autoEffortCapable: true }), 'Opus High');
  await setSwitch(true);
  assert.equal(await text({ effort: 'high', autoEffortCapable: true }), 'Opus Auto');
  assert.equal(await text({ effort: 'high', autoEffortCapable: false }), 'Opus High');
  assert.equal(await text({ effort: 'max', autoEffortCapable: true }), 'Opus Max');
  assert.equal(await text({ effort: 'ultra', autoEffortCapable: true }), 'Opus Ultra');
  await setSwitch(false);
  assert.equal(await text({ effort: 'high', autoEffortCapable: true }), 'Opus High');
});

test('Workflows sidebar rows (agents and default agents) show Auto for capable models only', async (t) => {
  const effortOptions = ['low', 'medium', 'high', 'max'].map((value) => ({ value, label: value }));
  const option = (provider, model, autoEffortCapable) => ({
    provider,
    model,
    display: model,
    effortOptions,
    fastCapable: false,
    ...(autoEffortCapable ? { autoEffortCapable: true } : {}),
  });
  const api = {
    async invokeCapability() {
      return { value: undefined };
    },
    async listProviderModels() {
      return [];
    },
  };
  const route = (provider, model, effort) => ({ provider, model, effort });
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('workflows', []);
  updateSidebarReference('agents', [
    { id: 'worker', label: 'Worker', route: route('alpha', 'capable', 'medium') },
    { id: 'heavy', label: 'Heavy', route: route('alpha', 'plain', 'high') },
    { id: 'maxed', label: 'Maxed', route: route('alpha', 'capable', 'max') },
    { id: 'maintainer', label: 'Maintainer', route: route('alpha', 'capable', 'low') },
  ]);
  updateSidebarReference('webSearchRoute', route('alpha', 'capable', 'low'));
  updateSidebarReference('webSearchModels', [option('alpha', 'capable', true)]);
  updateSidebarReference('providerSetup', { api: [{ id: 'alpha', authenticated: true }] });
  updateSidebarReference('quickProviderModels', [option('alpha', 'capable', true), option('alpha', 'plain', false)]);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
    await setSwitch(false);
  });
  await setSwitch(false);
  await act(async () => {
    root.render(React.createElement(WorkflowsPane, { api, active: true }));
  });
  const summaries = () =>
    Object.fromEntries(
      [...host.querySelectorAll('.workflows-agent-summary-row')].map((row) => [
        row.querySelector('b')?.textContent,
        row.querySelector('.agent-route-summary')?.textContent,
      ])
    );
  const off = summaries();
  assert.equal(off.Worker, 'capable Medium');
  assert.equal(off.Maintainer, 'capable Low');
  await setSwitch(true);
  const on = summaries();
  assert.equal(on.Worker, 'capable Auto');
  assert.equal(on.Heavy, 'plain High');
  assert.equal(on.Maxed, 'capable Max');
  assert.equal(on.Maintainer, 'capable Auto');
  assert.equal(on['Web Search'], 'capable Auto');
});
