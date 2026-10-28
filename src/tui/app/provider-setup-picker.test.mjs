import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldSupersedePanelEpoch, supersedePanelEpoch } from './panel-epoch.mjs';
import { createPanelSurface } from './panel-surface.mjs';
import { createProviderSetupPicker } from './provider-setup-picker.mjs';
import { waitUntil } from '../../runtime/shared/wait-until.test-support.mjs';

// The Provider setup picker cluster against a fake store: what the main list
// and the per-provider action panels paint, where Enter/Esc navigate, which
// prompts open, and how daemon acks (forget, OAuth login) settle.

// Daemon acks and reopen navigation run off the keypress; wait for the panel
// they paint rather than for a fixed number of event-loop turns.
const panelIs = (h, key) => waitUntil(() => h.current()?.pickerKey === key, { message: key });
const titleIs = (h, title) => waitUntil(() => h.current()?.title === title, { message: title });

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
  h.current().onCancel();
  assert.deepEqual(calls, ['onCancel']);
  assert.equal(h.current(), null);

  const g = createHarness();
  const returned = [];
  await g.openProviderSetupPicker({ returnTo: () => returned.push(1) });
  g.current().onCancel();
  assert.deepEqual(returned, [1]);
});

test('API-key actions: replace/delete for a stored key, add/get for OpenCode Go', async () => {
  const h = createHarness();
  await h.openProviderSetupPicker({});

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
  await panelIs(h, 'providers-main:api:openai');
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
  h.select(h.row('api:opencode-go'));
  h.select(h.row('set-key'));
  assert.equal(h.current(), null, 'surface released to the prompt');
  const prompt = h.prompts.at(-1);
  assert.equal(prompt.kind, 'api-key');
  assert.equal(prompt.providerId, 'opencode-go');
  assert.equal(prompt.mode, 'set');
  assert.equal(prompt.keyUrl, 'https://opencode.ai/keys');
  assert.equal(prompt.envName, '');

  await h.openProviderSetupPicker({});
  h.select(h.row('api:openai'));
  h.select(h.row('set-key'));
  assert.equal(h.prompts.at(-1).mode, 'replace');
  assert.equal(h.prompts.at(-1).envName, 'OPENAI_API_KEY');
  assert.equal(h.prompts.at(-1).keyUrl, '');
});

test('Vertex AI set-key asks for the key type; express mode carries authMode and the Gemini-only hint', async () => {
  const setup = { ...SETUP, api: [{ id: 'vertex-ai', name: 'Vertex AI', authenticated: false }] };
  const h = createHarness({ setup });
  await h.openProviderSetupPicker({});
  h.select(h.row('api:vertex-ai'));
  const before = h.prompts.length;
  h.select(h.row('set-key'));
  assert.equal(h.prompts.length, before, 'a key-type step comes before the prompt');
  assert.deepEqual(
    h.current().items.map((item) => item.value),
    ['service-account', 'api-key']
  );

  h.select(h.row('api-key'));
  const prompt = h.prompts.at(-1);
  assert.equal(prompt.providerId, 'vertex-ai');
  assert.equal(prompt.authMode, 'api-key');
  assert.match(prompt.hint, /Gemini models on the global location only/);
  assert.match(prompt.hint, /service-account key or the gcloud login/);

  await h.openProviderSetupPicker({});
  h.select(h.row('api:vertex-ai'));
  h.select(h.row('set-key'));
  h.select(h.row('service-account'));
  assert.equal(h.prompts.at(-1).authMode, undefined);
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
  h.select(h.row('api:openai'));
  h.select(h.row('forget-key'));
  assert.deepEqual(forgotten, ['openai']);
  assert.equal(h.current(), null, 'nothing navigates before the ack');
  gate.resolve();
  await titleIs(h, 'Providers');
  assert.deepEqual(h.cacheClears, ['all']);

  const failing = createHarness({ store: { forgetProviderAuth: async () => Promise.reject(new Error('boom')) } });
  await failing.openProviderSetupPicker({});
  failing.select(failing.row('api:openai'));
  failing.select(failing.row('forget-key'));
  await titleIs(failing, 'Provider · OpenAI');
  assert.deepEqual(failing.notices.at(-1), ['auth-forget failed: boom', 'error']);
  assert.equal(failing.current().title, 'Provider · OpenAI');
  assert.deepEqual(failing.cacheClears, []);
});

test('OAuth actions: Login only when signed out, legacy login shows progress then a result panel', async () => {
  const gate = Promise.withResolvers();
  const h = createHarness({ store: { loginOAuthProvider: () => gate.promise } });
  await h.openProviderSetupPicker({});
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
  await panelIs(h, 'providers-oauth-result:oauth:anthropic-oauth:ok');
  panel = h.current();
  assert.equal(panel.description, 'Anthropic login complete.');
  assert.equal(panel.help, 'Enter Refresh Providers · Esc Providers');
  assert.deepEqual(h.cacheClears, ['all']);
  h.select(panel.items[0]);
  await titleIs(h, 'Providers');

  const failing = createHarness({ store: { loginOAuthProvider: async () => Promise.reject(new Error('denied')) } });
  await failing.openProviderSetupPicker({});
  failing.select(failing.row('oauth:anthropic-oauth'));
  failing.select(failing.row('login-oauth'));
  await panelIs(failing, 'providers-oauth-result:oauth:anthropic-oauth:fail');
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
  h.select(h.row('oauth:anthropic-oauth'));
  h.select(h.row('login-oauth'));
  h.select(h.row('back'));
  assert.equal(h.current().pickerKey, 'providers-action:oauth:anthropic-oauth');
  gate.resolve();
  await waitUntil(() => h.notices.length > 0, { message: 'late ack notice' });
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
  h.select(h.row('oauth:anthropic-oauth'));
  h.select(h.row('login-oauth'));
  await waitUntil(() => h.prompts.length > 0, { message: 'oauth-code prompt' });
  assert.equal(h.current(), null, 'surface released to the code prompt');
  const prompt = h.prompts.at(-1);
  assert.equal(prompt.kind, 'oauth-code');
  assert.equal(prompt.providerName, 'Anthropic');
  assert.equal(prompt.detail, 'https://example.test/auth');
  assert.match(prompt.hint, /open the URL below manually/);
  assert.equal(h.notices.at(-1)[1], 'info');

  callback.resolve({ ok: true });
  await panelIs(h, 'providers-oauth-result:oauth:anthropic-oauth:ok');
  assert.deepEqual(h.cacheClears, ['all']);
  assert.equal(h.current().description, 'Anthropic login complete');
});

// canOpenBrowser reads the live environment: pin a desktop or an SSH session.
function withLoginEnv(kind, fn) {
  const keys = ['SSH_TTY', 'SSH_CONNECTION', 'DISPLAY', 'WAYLAND_DISPLAY'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  for (const key of keys) delete process.env[key];
  if (kind === 'headless') process.env.SSH_CONNECTION = '10.0.0.1 1 10.0.0.2 22';
  else process.env.DISPLAY = ':0';
  return fn().finally(() => {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
}

async function startLogin(started, kind) {
  const calls = [];
  const callback = Promise.withResolvers();
  const h = createHarness({
    store: {
      beginOAuthProviderLogin: async (id, options) => {
        calls.push([id, options]);
        return { ...started, waitForCallback: callback.promise };
      },
    },
  });
  await h.openProviderSetupPicker({});
  h.select(h.row('oauth:anthropic-oauth'));
  h.select(h.row('login-oauth'));
  return { h, calls, callback, kind };
}

test('headless start passes openBrowser:false, shows the URL and never claims a browser opened', () =>
  withLoginEnv('headless', async () => {
    const { h, calls, callback } = await startLogin({ url: 'https://example.test/poll' });
    await waitUntil(() => h.current()?.detail === 'https://example.test/poll', { message: 'url panel' });
    assert.deepEqual(calls, [['anthropic-oauth', { openBrowser: false }]]);
    assert.equal(h.current().description, 'Open this URL to sign in:');
    assert.ok(h.notices.every(([message]) => !/browser opened/.test(message)));
    callback.resolve({ ok: true });
    await panelIs(h, 'providers-oauth-result:oauth:anthropic-oauth:ok');
  }));

test('desktop URL-only polling start opens the browser and still shows the URL', () =>
  withLoginEnv('desktop', async () => {
    const { h, calls } = await startLogin({ url: 'https://example.test/poll' });
    await waitUntil(() => h.current()?.detail === 'https://example.test/poll', { message: 'url panel' });
    assert.deepEqual(calls, [['anthropic-oauth', { openBrowser: true }]]);
    assert.equal(h.current().description, 'Open this URL to sign in (browser opened):');
  }));

test('device-code start keeps the code and verification URL in the panel until completion', () =>
  withLoginEnv('headless', async () => {
    const { h, callback } = await startLogin({ url: 'https://example.test/device', userCode: 'ABCD-1234' });
    await waitUntil(() => h.current()?.description?.includes('ABCD-1234'), { message: 'device panel' });
    assert.equal(h.current().description, 'Enter code ABCD-1234 at:');
    assert.equal(h.current().detail, 'https://example.test/device');
    assert.equal(h.current().pickerKey, 'providers-oauth-progress:oauth:anthropic-oauth');
    const footer = h.current().footer();
    assert.equal(footer.length, 1, 'one footer row, like the status footer it replaces');
    assert.match(footer[0].text, /Continue only if you started this/);
    assert.match(footer[0].text, /Never enter a code someone sent you/);
    assert.ok(footer[0].text.length + 7 <= 80, 'fits 80 columns untruncated');
    callback.resolve({ ok: true });
    await panelIs(h, 'providers-oauth-result:oauth:anthropic-oauth:ok');
  }));

test('a URL-only sign-in has no device-code warning', () =>
  withLoginEnv('headless', async () => {
    const { h, callback } = await startLogin({ url: 'https://example.test/poll' });
    await waitUntil(() => h.current()?.detail === 'https://example.test/poll', { message: 'url panel' });
    assert.doesNotMatch(JSON.stringify(h.current().footer()), /someone sent you/);
    callback.resolve({ ok: true });
    await panelIs(h, 'providers-oauth-result:oauth:anthropic-oauth:ok');
  }));

test('device-code Back leaves the panel and the late completion becomes a notice', () =>
  withLoginEnv('desktop', async () => {
    const { h, callback } = await startLogin({ url: 'https://example.test/device', userCode: 'ABCD-1234' });
    await waitUntil(() => h.current()?.description?.includes('ABCD-1234'), { message: 'device panel' });
    assert.match(h.current().description, /\(browser opened\):$/);
    h.select(h.row('back'));
    callback.resolve({ ok: true });
    await waitUntil(() => h.notices.some(([message]) => /login complete/.test(message)), { message: 'notice' });
    assert.equal(h.current().pickerKey, 'providers-action:oauth:anthropic-oauth');
  }));

test('URL plus paste: a url-only start (OpenAI redirect paste) falls back to url for the prompt', () =>
  withLoginEnv('headless', async () => {
    const { h, calls } = await startLogin({ url: 'https://example.test/authorize', completeCode: async () => {} });
    await waitUntil(() => h.prompts.length > 0, { message: 'oauth-code prompt' });
    assert.deepEqual(calls[0][1], { openBrowser: false });
    const prompt = h.prompts.at(-1);
    assert.equal(prompt.detail, 'https://example.test/authorize');
    assert.match(prompt.hint, /Open the URL below.*paste the authorization code or full redirect URL/);
    assert.match(h.notices.at(-1)[0], /^open the URL shown/);
  }));

test('URL plus paste on a desktop reports the opened browser; manualUrl wins over url', () =>
  withLoginEnv('desktop', async () => {
    const { h } = await startLogin({
      url: 'https://example.test/auto',
      manualUrl: 'https://example.test/manual',
      completeCode: async () => {},
    });
    await waitUntil(() => h.prompts.length > 0, { message: 'oauth-code prompt' });
    assert.equal(h.prompts.at(-1).detail, 'https://example.test/manual');
    assert.match(h.notices.at(-1)[0], /^browser opened for Anthropic/);
  }));

test('a provider fetch failure reports and leaves the loading panel', async () => {
  const h = createHarness({
    store: {
      getProviderSetup: async () => {
        throw new Error('offline');
      },
    },
  });
  await h.openProviderSetupPicker({});
  assert.deepEqual(h.notices, [['providers failed: offline', 'error']]);
  assert.equal(h.current().pickerKey, 'providers-loading');
});

test('client-managed TUI providers are read-only, include local models, and refresh from the desktop', async () => {
  let setup = {
    ...SETUP,
    managedByClient: true,
    local: [{ id: 'mixdog-local', name: 'Local Provider', detected: true, enabled: true, usable: true }],
  };
  const reads = [];
  const forbidden = () => assert.fail('remote provider rows must not open credential mutations');
  const h = createHarness({
    store: {
      getProviderSetup: async (options) => {
        reads.push(options);
        return setup;
      },
      saveProviderApiKey: forbidden,
      forgetProviderAuth: forbidden,
      loginOAuthProvider: forbidden,
    },
  });
  await h.openProviderSetupPicker({});
  const list = h.current();
  assert.match(list.description, /local desktop window/);
  assert.ok(h.row('local:mixdog-local'));
  for (const item of list.items.filter((item) => item._providerId)) {
    h.select(item);
    assert.equal(h.current(), list, `${item.value} must stay read-only`);
  }
  assert.deepEqual(h.prompts, [null]);
  setup = { managedByClient: true, unavailable: true, api: [], oauth: [], local: [] };
  h.select(h.row('refresh-client-providers'));
  await waitUntil(() => reads.length === 2 && h.current()?.pickerKey === 'providers-main:root');
  assert.deepEqual(reads[1], { force: true });
  assert.deepEqual(
    h.current().items.map((row) => row.value),
    ['refresh-client-providers']
  );
});
