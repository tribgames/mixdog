// The side Webhooks list (WebhooksView): routine rows with the owner bot's
// face, sort chips (최근 이벤트 / 봇별) remembered per view, and the editor.
// Stored webhook rows may carry no parser (the column is nullable and the
// store's reader substitutes 'github'); the editor must read that legacy row as
// the same parser, or the next save silently rewrites it.
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import React, { act } from 'react';
import { JSDOM } from 'jsdom';

const DOM_GLOBALS = ['window', 'document', 'navigator', 'Node', 'HTMLElement', 'Event', 'FormData', 'localStorage'];
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
  const row = host.querySelector('.routines-open');
  assert.ok(row);
  await act(async () => row.click());
  const edited = document.querySelector('[aria-label="Webhook payload format"] .mx-select-value').textContent;
  assert.equal(edited, 'GitHub');
});

/** Mount the pane over `webhooks` and a catalog holding one user agent; records every capability call. */
async function mountWithAgents(t, webhooks) {
  const calls = [];
  const agents = [
    {
      id: 'github-watcher',
      label: 'GitHub Watcher',
      definition: { name: 'GitHub Watcher' },
      custom: true,
      kind: 'bot',
    },
  ];
  const api = {
    async invokeCapability(request) {
      calls.push(request);
      if (request.capability === 'listAgents') return { value: agents };
      if (request.capability === 'getChannelSetup') return { value: setup };
      return { value: undefined };
    },
  };
  const setup = { webhook: { publicUrl: 'https://hooks.mixdog.test' }, webhooks };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('channelSetup', setup);
  updateSidebarReference('projects', []);
  updateSidebarReference('workflows', []);
  updateSidebarReference('agents', agents);
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
const pickerValue = () => document.querySelector('[aria-label="Webhook bot"] .mx-select-value').textContent;
const optionLabels = () => [...document.querySelectorAll('[role="option"]')].map((o) => o.textContent.trim());

test('a new webhook picks its agent, Mixy by default, and saves as an agent run', async (t) => {
  const { calls } = await mountWithAgents(t, []);
  await act(async () => document.querySelector('.webhooks-add').click());
  assert.equal(document.querySelector('[aria-label="Webhook model"]'), null, 'no model picker');
  assert.equal(pickerValue(), 'Mixy');
  await act(async () => document.querySelector('[aria-label="Webhook bot"]').click());
  const labels = optionLabels();
  assert.deepEqual(labels, ['Mixy', 'GitHub Watcher']);
  assert.ok(document.querySelector('[role="option"] .automation-agent-face'), 'options show the agent face');
  const name = document.querySelector('input[name="webhook-name"]');
  name.value = 'issues';
  document.querySelector('textarea[name="webhook-instructions"]').value = 'Triage';
  await act(async () => document.querySelector('.webhooks-editor-dialog form').requestSubmit());
  const save = calls.find((call) => call.capability === 'saveWebhook');
  assert.equal(save.args[0].owner, 'lead');
  assert.equal(Object.hasOwn(save.args[0], 'model'), false);
  assert.equal(Object.hasOwn(save.args[0], 'runAsAgent'), false);
});

test("a model-only webhook from before opens as Mixy's and saves with no model", async (t) => {
  const { host, calls } = await mountWithAgents(t, [
    { name: 'legacy', instructions: 'Triage', enabled: true, secretSet: true, model: 'anthropic/claude-sonnet-4-6' },
  ]);
  await act(async () => host.querySelector('.routines-open').click());
  assert.equal(pickerValue(), 'Mixy');
  await act(async () => document.querySelector('[aria-label="Webhook bot"]').click());
  assert.deepEqual(optionLabels(), ['Mixy', 'GitHub Watcher'], 'no stored-model choice');
  const watcher = [...document.querySelectorAll('[role="option"]')].find(
    (o) => o.textContent.trim() === 'GitHub Watcher'
  );
  await act(async () => watcher.click());
  await act(async () => document.querySelector('.webhooks-editor-dialog form').requestSubmit());
  const moved = calls.findLast((call) => call.capability === 'saveWebhook').args[0];
  assert.deepEqual([moved.owner, Object.hasOwn(moved, 'model')], ['github-watcher', false]);
});

const HOOKS = [
  { name: 'sentry', owner: 'github-watcher', enabled: true, secretSet: true, parser: 'sentry' },
  {
    name: 'billing',
    enabled: true,
    secretSet: true,
    lastEventAt: '2030-01-01T09:00:00.000Z',
    lastFailedAt: '2030-01-01T09:00:01.000Z',
  },
  {
    name: 'github',
    owner: 'github-watcher',
    enabled: true,
    secretSet: true,
    lastEventAt: '2030-01-03T09:00:00.000Z',
    hasLastPayload: true,
  },
];
const rowNames = (host) => [...host.querySelectorAll('.routines-row b')].map((b) => b.textContent);
const chip = (host, label) =>
  [...host.querySelectorAll('.routine-sort-chips > button')].find((b) => b.textContent === label);

test('최근 이벤트 (default): latest event first, each row with its bot face, status and 실패 tag', async (t) => {
  localStorage.removeItem('mixdog.sidebar-sort.webhooks.v1');
  const { host } = await mountWithAgents(t, HOOKS);
  assert.deepEqual(
    [...host.querySelectorAll('.routine-sort-chips > button')].map((b) => [
      b.textContent,
      b.getAttribute('aria-selected'),
    ]),
    [
      ['Latest event', 'true'],
      ['By bot', 'false'],
    ]
  );
  assert.deepEqual(rowNames(host), ['github', 'billing', 'sentry']);
  const rows = [...host.querySelectorAll('.routines-row')];
  assert.ok(
    rows.every((row) => row.querySelector('.automation-agent-face')),
    'a face per row'
  );
  assert.deepEqual(
    rows.map((row) => row.dataset.state),
    ['ok', 'failed', 'ok']
  );
  assert.equal(rows[1].querySelector('.routines-tag').textContent, 'Failed');
  assert.match(rows[0].querySelector('.routines-sub').textContent, /^GitHub Watcher · /);
  assert.equal(rows[2].querySelector('.routines-sub').textContent, 'GitHub Watcher · No events');
  assert.equal(host.querySelectorAll('.routine-side-head').length, 0, 'a flat list');
});

test('봇별 groups under each bot (face, name, count) and is remembered', async (t) => {
  localStorage.removeItem('mixdog.sidebar-sort.webhooks.v1');
  const { host, calls } = await mountWithAgents(t, HOOKS);
  await act(async () => chip(host, 'By bot').click());
  assert.equal(localStorage.getItem('mixdog.sidebar-sort.webhooks.v1'), 'bot');
  assert.deepEqual(
    [...host.querySelectorAll('.routine-side-head')].map((head) => [
      Boolean(head.querySelector('.automation-agent-face')),
      head.textContent,
    ]),
    [
      [true, 'Mixy1'],
      [true, 'GitHub Watcher2'],
    ]
  );
  assert.deepEqual(rowNames(host), ['billing', 'github', 'sentry']);
  assert.equal(host.querySelector('.routines-row .automation-agent-face'), null, 'no face per row');
  // The ⋯ menu runs the latest event again in the bot's chat.
  const more = host.querySelectorAll('.routines-row .row-overflow-trigger')[1];
  await act(async () => more.click());
  const runNow = [...document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === 'Run now');
  await act(async () => runNow.click());
  assert.deepEqual(
    calls.find((call) => call.capability === 'runWebhookNow'),
    { capability: 'runWebhookNow', args: ['github'] }
  );
});

test('with no bot at all: no chips, no "+", one line and the representative bot action', async (t) => {
  const { resetMixyStatus } = await import('./mixy-identity.ts');
  resetMixyStatus({ created: false });
  t.after(() => resetMixyStatus(null));
  const calls = [];
  const api = {
    async invokeCapability(request) {
      calls.push(request);
      return { value: undefined };
    },
  };
  resetSidebarReferenceCache();
  adoptSidebarReferenceHost(api);
  updateSidebarReference('channelSetup', { webhooks: HOOKS.slice(1, 2) });
  updateSidebarReference('projects', []);
  updateSidebarReference('workflows', []);
  updateSidebarReference('agents', []);
  const host = document.createElement('main');
  document.body.append(host);
  const root = createRoot(host);
  t.after(async () => {
    await act(async () => root.unmount());
    host.remove();
    resetSidebarReferenceCache();
  });
  await act(async () => root.render(React.createElement(WebhooksPane, { api, active: true })));
  assert.equal(host.querySelector('.routine-sort-chips'), null);
  assert.equal(document.querySelector('.webhooks-add'), null);
  const empty = host.querySelector('.routine-needs-bot');
  assert.equal(empty.querySelector('p').textContent, 'Create the representative bot first.');
  assert.equal(empty.querySelector('button').textContent, 'Create representative bot');
});

test('the remembered chip applies on the next mount', async (t) => {
  localStorage.setItem('mixdog.sidebar-sort.webhooks.v1', 'bot');
  const { host } = await mountWithAgents(t, HOOKS);
  assert.equal(chip(host, 'By bot').getAttribute('aria-selected'), 'true');
  localStorage.removeItem('mixdog.sidebar-sort.webhooks.v1');
});

test('without a cryptographic random source, regenerating a signing secret reports an error instead of a weak secret', async (t) => {
  const { host, render } = await mountLegacyWebhookPane(t);
  t.mock.method(globalThis.crypto, 'getRandomValues', () => {
    throw new Error('entropy source unavailable');
  });

  await render();
  await act(async () => host.querySelector('.routines-open').click());
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
  await act(async () => host.querySelector('.routines-open').click());
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
  await act(async () => host.querySelector('.routines-open').click());
  await act(async () => buttonByText('Send test').click());
  assert.equal(document.querySelector('.webhook-test-result').textContent, 'Test failed (HTTP 401): bad signature');
});

test('Send test renders a status-0 failure without an HTTP code', async (t) => {
  const { host } = await mountForTest(t, { ok: false, status: 0, error: 'connect refused' });
  await act(async () => host.querySelector('.routines-open').click());
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
    await act(async () => host.querySelector('.routines-open').click());
    await act(async () => buttonByText('Send test').click());
    assert.equal(document.querySelector('.webhook-test-result').textContent, text);
  });
}

test('Send test shows Sending… while the request is in flight', async (t) => {
  let release;
  const { host } = await mountForTest(t, new Promise((resolve) => (release = resolve)));
  await act(async () => host.querySelector('.routines-open').click());
  await act(async () => buttonByText('Send test').click());
  const sending = buttonByText('Sending…');
  assert.ok(sending);
  assert.equal(sending.disabled, true);
  await act(async () => release({ ok: true, status: 200 }));
  assert.ok(buttonByText('Send test'));
});

test('Send test is disabled while the payload format has unsaved changes', async (t) => {
  const { host } = await mountForTest(t, { ok: true, status: 200 });
  await act(async () => host.querySelector('.routines-open').click());
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
  await act(async () => host.querySelector('.routines-open').click());
  assert.equal(buttonByText('Send test').disabled, false);
  await act(async () => buttonByText('Regenerate secret').click());
  assert.equal(buttonByText('Send test').disabled, true);
  assert.ok(
    [...document.querySelectorAll('.webhook-connection small')].some(
      (s) => s.textContent === 'Save first to test the new secret.'
    )
  );
});
