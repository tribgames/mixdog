// Stored webhook rows may carry no parser (the column is nullable and the
// store's reader substitutes 'github'). The list sub-line and the editor must
// read that legacy row as the same parser, or the next save silently rewrites
// it.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const DOM_GLOBALS = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Event'];
const savedGlobals = DOM_GLOBALS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://mixdog.test/' });
for (const key of DOM_GLOBALS)
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: dom.window[key] });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, {
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  mixdogDesktop: { rendererDiagnostic() {} },
});
after(() => {
  dom.window.close();
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
});

const { createRoot } = await import('react-dom/client');
const { WebhooksPane } = await import('./WebhooksView.tsx');
const { resetSidebarReferenceCache, adoptSidebarReferenceHost, updateSidebarReference } = await import(
  './sidebar-reference-cache.ts'
);

/** A warm sidebar cache holding one legacy webhook, and a mounted WebhooksPane over it. */
async function mountLegacyWebhookPane(t) {
  const api = {
    async invokeCapability() {
      return { value: undefined };
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('channelSetup', {
    webhook: { publicUrl: 'https://hooks.mixdog.test' },
    webhooks: [{ name: 'legacy', enabled: true, secretSet: true }],
  });
  updateSidebarReference('projects', []);
  updateSidebarReference('workflows', []);
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
  const render = () => act(async () => root.render(React.createElement(WebhooksPane, { api, active: true })));
  return { host, render };
}

test('a legacy webhook without a stored parser lists and opens as the same parser', async (t) => {
  const { host, render } = await mountLegacyWebhookPane(t);
  await render();
  const row = host.querySelector('.schedules-row');
  assert.ok(row);
  const listed = row.querySelector('small').textContent;

  await act(async () => row.click());
  const edited = document.querySelector('[aria-label="Webhook payload format"] .mx-select-value').textContent;

  assert.match(listed, /^github\b/);
  assert.equal(edited, 'GitHub');
});

test('without a cryptographic random source, regenerating a signing secret reports an error instead of a weak secret', async (t) => {
  const { host, render } = await mountLegacyWebhookPane(t);
  t.mock.method(globalThis.crypto, 'getRandomValues', () => {
    throw new Error('entropy source unavailable');
  });

  await render();
  await act(async () => host.querySelector('.schedules-row').click());
  const regenerate = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'Regenerate secret'
  );
  assert.ok(regenerate);
  await act(async () => regenerate.click());

  const secrets = [...document.querySelectorAll('.webhook-connection-value code')].filter((code) =>
    /^[0-9a-f]{48}$/.test(code.textContent)
  );
  assert.deepEqual(secrets, []);
  assert.ok(document.querySelector('.schedules-dialog .error-notice'));
});

/** Mount the pane with an api that records testWebhook calls and answers with `reply`. */
async function mountForTest(t, reply) {
  const calls = [];
  const api = {
    async invokeCapability(request) {
      calls.push(request);
      if (request.capability === 'testWebhook') return { value: reply };
      return { value: undefined };
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('channelSetup', {
    webhook: { publicUrl: 'https://hooks.mixdog.test' },
    webhooks: [{ name: 'legacy', enabled: true, secretSet: true }],
  });
  updateSidebarReference('projects', []);
  updateSidebarReference('workflows', []);
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
  await act(async () => root.render(React.createElement(WebhooksPane, { api, active: true })));
  return { host, calls };
}
const buttonByText = (text) => [...document.querySelectorAll('button')].find((b) => b.textContent === text);

test('Send test is absent when creating a webhook', async (t) => {
  await mountForTest(t, { ok: true, status: 200 });
  await act(async () => document.querySelector('.webhooks-add').click());
  assert.ok(document.querySelector('.webhooks-editor-dialog'));
  assert.equal(buttonByText('Send test'), undefined);
});

test('Send test invokes testWebhook with the name and shows success', async (t) => {
  const { host, calls } = await mountForTest(t, { name: 'legacy', ok: true, status: 200, url: 'u' });
  await act(async () => host.querySelector('.schedules-row').click());
  await act(async () => buttonByText('Send test').click());
  assert.deepEqual(
    calls.find((c) => c.capability === 'testWebhook'),
    { capability: 'testWebhook', args: ['legacy'] }
  );
  assert.match(
    document.querySelector('.webhook-test-result').textContent,
    /Verified — the endpoint accepted the signature\./
  );
});

test('Send test renders HTTP and transport failures', async (t) => {
  const { host } = await mountForTest(t, { ok: false, status: 401, error: 'bad signature' });
  await act(async () => host.querySelector('.schedules-row').click());
  await act(async () => buttonByText('Send test').click());
  assert.equal(document.querySelector('.webhook-test-result').textContent, 'Test failed (HTTP 401): bad signature');
});

test('Send test renders a status-0 failure without an HTTP code', async (t) => {
  const { host } = await mountForTest(t, { ok: false, status: 0, error: 'connect refused' });
  await act(async () => host.querySelector('.schedules-row').click());
  await act(async () => buttonByText('Send test').click());
  assert.equal(document.querySelector('.webhook-test-result').textContent, 'Test failed: connect refused');
});

// One mounted pane per test: the sidebar reference cache is shared.
for (const [label, reply, text] of [
  [
    'timeout',
    { ok: false, status: 0, code: 'timeout', error: 'Request timed out after 15 seconds.' },
    'Test failed: No response within 15 seconds.',
  ],
  [
    'disabled endpoint',
    { ok: false, status: 404, code: 'rejected', error: 'disabled endpoint' },
    'Test failed (HTTP 404): This webhook is turned off. Turn it on, then test again.',
  ],
  [
    'network',
    { ok: false, status: 0, code: 'network', error: 'ECONNREFUSED' },
    'Test failed: Could not reach the endpoint: ECONNREFUSED',
  ],
]) {
  test(`Send test localizes the ${label} failure`, async (t) => {
    const { host } = await mountForTest(t, reply);
    await act(async () => host.querySelector('.schedules-row').click());
    await act(async () => buttonByText('Send test').click());
    assert.equal(document.querySelector('.webhook-test-result').textContent, text);
  });
}

test('Send test shows Sending… while the request is in flight', async (t) => {
  let release;
  const { host } = await mountForTest(t, new Promise((resolve) => (release = resolve)));
  await act(async () => host.querySelector('.schedules-row').click());
  await act(async () => buttonByText('Send test').click());
  const sending = buttonByText('Sending…');
  assert.ok(sending);
  assert.equal(sending.disabled, true);
  await act(async () => release({ ok: true, status: 200 }));
  assert.ok(buttonByText('Send test'));
});

test('Send test is disabled while the payload format has unsaved changes', async (t) => {
  const { host } = await mountForTest(t, { ok: true, status: 200 });
  await act(async () => host.querySelector('.schedules-row').click());
  await act(async () => document.querySelector('[aria-label="Webhook payload format"]').click());
  const stripe = [...document.querySelectorAll('[role="option"]')].find((o) => o.textContent.trim() === 'Stripe');
  await act(async () => stripe.click());
  assert.equal(buttonByText('Send test').disabled, true);
  assert.ok(
    [...document.querySelectorAll('.webhook-connection small')].some(
      (s) => s.textContent === 'Save first to test the new payload format.'
    )
  );
});

test('Send test is disabled once a secret has been regenerated', async (t) => {
  const { host } = await mountForTest(t, { ok: true, status: 200 });
  await act(async () => host.querySelector('.schedules-row').click());
  assert.equal(buttonByText('Send test').disabled, false);
  await act(async () => buttonByText('Regenerate secret').click());
  assert.equal(buttonByText('Send test').disabled, true);
  assert.ok(
    [...document.querySelectorAll('.webhook-connection small')].some(
      (s) => s.textContent === 'Save first to test the new secret.'
    )
  );
});
