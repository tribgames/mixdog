import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createProviderSetupPicker } from './provider-setup-picker.mjs';

// The Provider setup picker cluster against a fake store: what the main list
// and the per-provider action panels paint, where Enter/Esc navigate, which
// prompts open, and how daemon acks (forget, OAuth login) settle.

const flush = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) {
    await delay(0);
    await nextTurn();
  }
};

const SETUP = {
  api: [
    { id: 'openai', name: 'OpenAI', authenticated: true, stored: true, envName: 'OPENAI_API_KEY' },
    { id: 'opencode-go', name: 'OpenCode Go', authenticated: false, url: 'https://opencode.ai/keys' },
  ],
  oauth: [{ id: 'anthropic-oauth', name: 'Anthropic', authenticated: false }],
  local: [],
};

function createHarness({ store: overrides = {}, setup = SETUP } = {}) {
  supersedePanelEpoch();
  let live = null;
  const painted = [];
  const notices = [];
  const prompts = [];
  const cacheClears = [];
  const surface = createPanelSurface({
    setPicker: (next) => {
      const previous = live;
      live = typeof next === 'function' ? next(previous) : next;
      if (shouldSupersedePanelEpoch(previous, live)) supersedePanelEpoch();
      painted.push(live);
    },
    setContextPanel: () => {},
    setUsagePanel: () => {},
  });
  const store = {
    pushNotice: (message, tone) => notices.push([message, tone]),
    getProviderSetup: async () => setup,
    ...overrides,
  };
  const { openProviderSetupPicker } = createProviderSetupPicker({
    store,
    surface,
    setProviderPrompt: (prompt) => prompts.push(prompt),
    setSettingsPrompt: () => {},
    closeUsagePanel: () => {},
    oauthSubmitRef: { current: false },
    clearModelCaches: (scope) => cacheClears.push(scope),
  });
  const current = () => live;
  const select = (item) => current().onSelect(item.value, item);
  const row = (value) => current().items.find((item) => item.value === value);
  return { openProviderSetupPicker, current, select, row, painted, notices, prompts, cacheClears };
}

test('main list: continue row first when a return target exists, then API-key and OAuth providers', async () => {
  const h = createHarness();
  await h.openProviderSetupPicker({ returnTo: () => {} });
  await flush();
  const list = h.current();
  assert.equal(list.title, 'Providers');
  assert.equal(list.pickerKey, 'providers-main:root');
  assert.equal(list.items[0].value, 'continue-setup');
  assert.deepEqual(
    list.items
      .slice(1)
      .map((item) => item.value)
      .sort(),
    ['api:openai', 'api:opencode-go', 'oauth:anthropic-oauth']
  );
  assert.equal(h.row('api:openai')._type, 'api-key');
  assert.equal(h.row('oauth:anthropic-oauth')._type, 'oauth');
  assert.equal(list.footer(h.row('api:openai'))[0].glyph, '●', 'authenticated provider is active');
  assert.equal(list.footer(h.row('oauth:anthropic-oauth'))[0].glyph, '○');
  assert.equal(list.footer({}), '');
});

test('Esc on the main list closes the surface and prefers onCancel over returnTo', async () => {
  const h = createHarness();
  const calls = [];
  await h.openProviderSetupPicker({ returnTo: () => calls.push('returnTo'), onCancel: () => calls.push('onCancel') });
  await flush();
  h.current().onCancel();
  assert.deepEqual(calls, ['onCancel']);
  assert.equal(h.current(), null);

  const g = createHarness();
  const returned = [];
  await g.openProviderSetupPicker({ returnTo: () => returned.push(1) });
  await flush();
  g.current().onCancel();
  assert.deepEqual(returned, [1]);
});

test('API-key actions: replace/delete for a stored key, add/get for OpenCode Go', async () => {
  const h = createHarness();
  await h.openProviderSetupPicker({});
  await flush();

  h.select(h.row('api:openai'));
  let panel = h.current();
  assert.equal(panel.title, 'Provider · OpenAI');
  assert.equal(panel.pickerKey, 'providers-action:api:openai');
  assert.deepEqual(
    panel.items.map((item) => [item.value, item.label, item.description]),
    [
      ['set-key', 'Replace API key', 'masked input · OPENAI_API_KEY'],
      ['forget-key', 'Delete API key', 'remove stored key for this provider'],
    ]
  );
  assert.equal(panel.footer()[0].glyph, '●');

  // Esc returns to the main list with the row remembered.
  panel.onCancel();
  await flush();
  assert.equal(h.current().title, 'Providers');
  assert.equal(h.current().pickerKey, 'providers-main:api:openai');
  assert.equal(h.current().items[h.current().initialIndex].value, 'api:openai');

  h.select(h.row('api:opencode-go'));
  panel = h.current();
  assert.deepEqual(
    panel.items.map((item) => item.value),
    ['set-key', 'get-key']
  );
  assert.equal(panel.items[0].label, 'Add API key');
  assert.equal(panel.items[0].description, 'masked input · stored in OS keychain');
  assert.equal(panel.items[1].description, 'https://opencode.ai/keys');
});

test('set-key hands the surface to the API-key prompt with mode and console URL', async () => {
  const h = createHarness();
  await h.openProviderSetupPicker({});
  await flush();
  h.select(h.row('api:opencode-go'));
  h.select(h.row('set-key'));
  assert.equal(h.current(), null, 'surface released to the prompt');
  const prompt = h.prompts.at(-1);
  assert.equal(prompt.kind, 'api-key');
  assert.equal(prompt.providerId, 'opencode-go');
  assert.equal(prompt.mode, 'set');
  assert.equal(prompt.keyUrl, 'https://opencode.ai/keys');
  assert.equal(prompt.envName, '');

  h.openProviderSetupPicker({});
  await flush();
  h.select(h.row('api:openai'));
  h.select(h.row('set-key'));
  assert.equal(h.prompts.at(-1).mode, 'replace');
  assert.equal(h.prompts.at(-1).envName, 'OPENAI_API_KEY');
  assert.equal(h.prompts.at(-1).keyUrl, '');
});

test('forget-key: the ack clears model caches and reopens the list; a failure returns to the actions', async () => {
  const gate = Promise.withResolvers();
  const forgotten = [];
  const h = createHarness({
    store: {
      forgetProviderAuth: (id) => {
        forgotten.push(id);
        return gate.promise;
      },
    },
  });
  await h.openProviderSetupPicker({});
  await flush();
  h.select(h.row('api:openai'));
  h.select(h.row('forget-key'));
  assert.deepEqual(forgotten, ['openai']);
  assert.equal(h.current(), null, 'nothing navigates before the ack');
  gate.resolve();
  await flush();
  assert.deepEqual(h.cacheClears, ['all']);
  assert.equal(h.current().title, 'Providers');

  const failing = createHarness({ store: { forgetProviderAuth: async () => Promise.reject(new Error('boom')) } });
  await failing.openProviderSetupPicker({});
  await flush();
  failing.select(failing.row('api:openai'));
  failing.select(failing.row('forget-key'));
  await flush();
  assert.deepEqual(failing.notices.at(-1), ['auth-forget failed: boom', 'error']);
  assert.equal(failing.current().title, 'Provider · OpenAI');
  assert.deepEqual(failing.cacheClears, []);
});

test('OAuth actions: Login only when signed out, legacy login shows progress then a result panel', async () => {
  const gate = Promise.withResolvers();
  const h = createHarness({ store: { loginOAuthProvider: () => gate.promise } });
  await h.openProviderSetupPicker({});
  await flush();
  h.select(h.row('oauth:anthropic-oauth'));
  let panel = h.current();
  assert.equal(panel.title, 'Provider · Anthropic');
  assert.deepEqual(
    panel.items.map((item) => [item.value, item.label]),
    [['login-oauth', 'Login']]
  );

  h.select(h.row('login-oauth'));
  panel = h.current();
  assert.equal(panel.pickerKey, 'providers-oauth-progress:oauth:anthropic-oauth');
  assert.equal(panel.items[0].value, 'waiting');
  gate.resolve();
  await flush();
  panel = h.current();
  assert.equal(panel.pickerKey, 'providers-oauth-result:oauth:anthropic-oauth:ok');
  assert.equal(panel.description, 'Anthropic login complete.');
  assert.equal(panel.help, 'Enter Refresh Providers · Esc Providers');
  assert.deepEqual(h.cacheClears, ['all']);
  h.select(panel.items[0]);
  await flush();
  assert.equal(h.current().title, 'Providers');

  const failing = createHarness({ store: { loginOAuthProvider: async () => Promise.reject(new Error('denied')) } });
  await failing.openProviderSetupPicker({});
  await flush();
  failing.select(failing.row('oauth:anthropic-oauth'));
  failing.select(failing.row('login-oauth'));
  await flush();
  panel = failing.current();
  assert.equal(panel.pickerKey, 'providers-oauth-result:oauth:anthropic-oauth:fail');
  assert.equal(panel.description, 'OAuth login failed: denied');
  failing.select(panel.items[0]);
  assert.equal(failing.current().pickerKey, 'providers-action:oauth:anthropic-oauth');
});

test('OAuth progress Back returns to the actions and turns the late ack into a notice', async () => {
  const gate = Promise.withResolvers();
  const h = createHarness({ store: { loginOAuthProvider: () => gate.promise } });
  await h.openProviderSetupPicker({});
  await flush();
  h.select(h.row('oauth:anthropic-oauth'));
  h.select(h.row('login-oauth'));
  h.select(h.row('back'));
  assert.equal(h.current().pickerKey, 'providers-action:oauth:anthropic-oauth');
  gate.resolve();
  await flush();
  assert.equal(h.current().pickerKey, 'providers-action:oauth:anthropic-oauth', 'no result panel after Back');
  assert.deepEqual(h.notices.at(-1), ['Anthropic login complete', 'info']);
});

test('interactive OAuth login hands over to the code prompt and the callback shows the result', async () => {
  const callback = Promise.withResolvers();
  const h = createHarness({
    store: {
      beginOAuthProviderLogin: async () => ({
        completeCode: async () => {},
        manualUrl: 'https://example.test/auth',
        waitForCallback: callback.promise,
      }),
    },
  });
  await h.openProviderSetupPicker({});
  await flush();
  h.select(h.row('oauth:anthropic-oauth'));
  h.select(h.row('login-oauth'));
  await flush();
  assert.equal(h.current(), null, 'surface released to the code prompt');
  const prompt = h.prompts.at(-1);
  assert.equal(prompt.kind, 'oauth-code');
  assert.equal(prompt.providerName, 'Anthropic');
  assert.equal(prompt.detail, 'https://example.test/auth');
  assert.match(prompt.hint, /open the URL below manually/);
  assert.equal(h.notices.at(-1)[1], 'info');

  callback.resolve({ ok: true });
  await flush();
  assert.deepEqual(h.cacheClears, ['all']);
  assert.equal(h.current().pickerKey, 'providers-oauth-result:oauth:anthropic-oauth:ok');
  assert.equal(h.current().description, 'Anthropic login complete');
});

test('a provider fetch failure reports and leaves the loading panel', async () => {
  const h = createHarness({
    store: {
      getProviderSetup: async () => {
        throw new Error('offline');
      },
    },
  });
  await h.openProviderSetupPicker({});
  await flush();
  assert.deepEqual(h.notices, [['providers failed: offline', 'error']]);
  assert.equal(h.current().pickerKey, 'providers-loading');
});
