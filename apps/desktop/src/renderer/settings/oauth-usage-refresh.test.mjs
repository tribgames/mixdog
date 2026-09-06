import assert from 'node:assert/strict';
import test from 'node:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import {
  getUsageDashboardSnapshot,
  publishUsageDashboard,
  refreshUsageDashboard,
  subscribeUsageDashboard,
} from '../usage-dashboard-store.ts';
import { useOAuthUsageRefresh } from './use-oauth-usage-refresh.ts';
import { OAuthControl } from './provider-panel.tsx';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function dashboard(account) {
  return { rows: [{ id: 'openai-oauth', account, authenticated: true }] };
}

function harness(t) {
  const dom = new JSDOM('<!doctype html><html><body><main></main></body></html>', {
    url: 'https://mixdog.test/',
  });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.HTMLElement = dom.window.HTMLElement;
  const root = createRoot(document.querySelector('main'));
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
  });
  return async (element) => act(async () => root.render(element));
}

function Probe(props) {
  useOAuthUsageRefresh(props.api, props.flowId, props.state);
  return null;
}

test('completed OAuth refreshes fresh usage once per flow and publishes to subscribers', async (t) => {
  const render = harness(t);
  publishUsageDashboard(dashboard('old'));
  const calls = [];
  const observed = [];
  t.after(subscribeUsageDashboard((next) => observed.push(next)));
  const api = {
    async invokeCapability(request) {
      calls.push(request);
      return { value: dashboard(`account-${calls.length}`) };
    },
  };
  const show = (flowId, state) => render(
    React.createElement(React.StrictMode, null, React.createElement(Probe, { api, flowId, state })),
  );
  // Mounting an already-complete flow also exercises StrictMode effect replay.
  await show('first', 'complete');
  await show('first', 'complete');
  assert.deepEqual(calls, [{
    capability: 'getUsageDashboard',
    args: [{ refresh: true, refreshSetup: false }],
  }]);
  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].account, 'account-1');
  assert.ok(observed.some((next) => next.dashboard.rows?.[0]?.account === 'account-1'));
  await show('second', 'pending');
  assert.equal(calls.length, 1);
  await show('second', 'complete');
  assert.equal(calls.length, 2);
  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].account, 'account-2');
});

test('pending, failed, cancelled and missing OAuth flows never refresh usage', async (t) => {
  const render = harness(t);
  let calls = 0;
  const api = { async invokeCapability() { calls += 1; return { value: dashboard('new') }; } };
  for (const [flowId, state] of [
    ['', 'complete'], ['pending', 'pending'], ['failed', 'error'], ['cancelled', 'cancelled'],
  ]) {
    await render(React.createElement(Probe, { api, flowId, state }));
  }
  assert.equal(calls, 0);
});

test('OAuth refresh supersedes in-flight usage from before reauthentication', async (t) => {
  const render = harness(t);
  const old = deferred();
  const fresh = deferred();
  let calls = 0;
  const api = {
    invokeCapability() {
      calls += 1;
      return calls === 1 ? old.promise : fresh.promise;
    },
  };
  const oldRequest = refreshUsageDashboard(api, { force: true });
  await render(React.createElement(Probe, { api, flowId: 'new-login', state: 'complete' }));
  assert.equal(calls, 2);
  await act(async () => fresh.resolve({ value: dashboard('new') }));
  old.resolve({ value: dashboard('old') });
  await oldRequest;
  assert.equal(getUsageDashboardSnapshot().dashboard.rows[0].account, 'new');
  const stored = JSON.parse(window.localStorage.getItem('mixdog.desktop.sidebar-usage.v1'));
  assert.equal(stored.rows[0].account, 'new');
});

test('OAuthControl completes without waiting for usage, and usage failure does not become auth failure', async (t) => {
  const render = harness(t);
  const usage = deferred();
  let rejectUsage;
  const failed = new Promise((_, reject) => { rejectUsage = reject; });
  let calls = 0;
  let completed = 0;
  const api = { invokeCapability() { calls += 1; return usage.promise.then(() => failed); } };
  const run = async (capability) => {
    if (capability === 'beginOAuthProviderLogin') return { flowId: 'login', state: 'complete' };
    if (capability === 'getProviderSetup') return { oauth: [] };
    throw new Error(`Unexpected capability: ${capability}`);
  };
  await render(React.createElement(OAuthControl, {
    api, provider: { id: 'openai-oauth', authenticated: true }, disabled: false, run,
    onComplete: () => { completed += 1; },
  }));
  await act(async () => document.querySelector('button').click());
  assert.equal(calls, 1);
  assert.equal(completed, 1);
  assert.equal(document.querySelector('[role="dialog"]'), null);
  await act(async () => {
    usage.resolve();
    rejectUsage(new Error('Usage unavailable'));
  });
  assert.equal(completed, 1);
  assert.equal(calls, 1);
  assert.equal(document.querySelector('[role="alert"]'), null);
});
