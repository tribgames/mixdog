import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'opencode-go-oauth-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.OPENCODE_GO_OAUTH_CREDENTIALS_PATH = join(dir, 'opencode-go-oauth.json');
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';
const credentialPath = process.env.OPENCODE_GO_OAUTH_CREDENTIALS_PATH;

const { requestDeviceCode, pollDeviceToken, completeLogin, pickOrganization } = await import(
  './opencode-go-oauth-login.mjs'
);
const { describeOpenCodeGoOAuthCredentials, ensureFreshTokens, forgetOpenCodeGoOAuthCredentials, loadTokens } =
  await import('./opencode-go-oauth-tokens.mjs');
const { OpenCodeGoOAuthProvider, goConfigFromResponse } = await import('./opencode-go-oauth.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const SERVER = 'https://opencode.ai/console';
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function recorder(handler) {
  const seen = [];
  const fetchFn = async (input, init = {}) => {
    const url = String(input?.url || input);
    const headers = new Headers(init.headers || {});
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    const row = { url, method: init.method || 'GET', headers, body, redirect: init.redirect };
    seen.push(row);
    return handler(row, seen);
  };
  return { seen, fetchFn };
}

// A clock that only moves when the poller sleeps.
function fakeClock() {
  let t = 1_000_000;
  const sleeps = [];
  return {
    now: () => t,
    sleeps,
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

const device = (over = {}) => ({ deviceCode: 'dc-1', userCode: 'ABCD-EFGH', intervalS: 5, expiresInS: 600, ...over });

const signIn = (over = {}) =>
  writeFileSync(
    credentialPath,
    JSON.stringify({
      access_token: 'at-1',
      refresh_token: 'rt-1',
      expires_at: Date.now() + 30 * 24 * 3600_000,
      account_id: 'user-1',
      email: 'dev@example.com',
      org_id: 'org-a',
      org_name: 'Alpha',
      ...over,
    })
  );

test('device code request posts JSON client_id and resolves a relative verification URL', async () => {
  const api = recorder(() =>
    json({
      device_code: 'dc-1',
      user_code: 'ABCD-EFGH',
      verification_uri_complete: 'device?code=ABCD-EFGH',
      expires_in: 900,
      interval: 5,
    })
  );
  const started = await requestDeviceCode({ fetchFn: api.fetchFn });
  assert.equal(api.seen[0].url, `${SERVER}/auth/device/code`);
  assert.equal(api.seen[0].method, 'POST');
  assert.equal(api.seen[0].headers.get('content-type'), 'application/json');
  assert.deepEqual(api.seen[0].body, { client_id: 'opencode-cli' });
  assert.equal(api.seen[0].redirect, 'error');
  assert.equal(started.verificationUrl, `${SERVER}/device?code=ABCD-EFGH`);
  assert.deepEqual([started.userCode, started.intervalS, started.expiresInS], ['ABCD-EFGH', 5, 900]);
});

test('polling waits on authorization_pending, backs off 5 s on slow_down, then returns the grant', async () => {
  const clock = fakeClock();
  const replies = [
    json({ error: 'authorization_pending' }, 400),
    json({ error: 'slow_down' }, 400),
    json({ error: 'authorization_pending' }, 400),
    json({ access_token: 'at-new', refresh_token: 'rt-new', expires_in: 2591999 }),
  ];
  const api = recorder(() => replies.shift());
  const granted = await pollDeviceToken(device(), { fetchFn: api.fetchFn, sleep: clock.sleep, now: clock.now });
  assert.deepEqual(clock.sleeps, [5000, 10000, 10000]);
  assert.equal(granted.access_token, 'at-new');
  assert.equal(granted.refresh_token, 'rt-new');
  assert.equal(granted.expires_at, clock.now() + 2591999 * 1000);
  for (const row of api.seen) {
    assert.equal(row.url, `${SERVER}/auth/device/token`);
    assert.deepEqual(row.body, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: 'dc-1',
      client_id: 'opencode-cli',
    });
  }
});

test('polling stops on access_denied and on expired_token', async () => {
  for (const [error, code] of [
    ['access_denied', 'access_denied'],
    ['expired_token', 'expired_token'],
  ]) {
    const clock = fakeClock();
    const api = recorder(() => json({ error }, 400));
    await assert.rejects(
      pollDeviceToken(device(), { fetchFn: api.fetchFn, sleep: clock.sleep, now: clock.now }),
      (err) => err.code === code
    );
    assert.equal(api.seen.length, 1);
  }
});

test('polling gives up when the device code lifetime runs out', async () => {
  const clock = fakeClock();
  const api = recorder(() => json({ error: 'authorization_pending' }, 400));
  await assert.rejects(
    pollDeviceToken(device({ expiresInS: 12 }), { fetchFn: api.fetchFn, sleep: clock.sleep, now: clock.now }),
    (err) => err.code === 'expired_token'
  );
  assert.deepEqual(clock.sleeps, [5000, 5000, 2000]);
});

test('polling is cancellable', async () => {
  const controller = new AbortController();
  const api = recorder(() => json({ error: 'authorization_pending' }, 400));
  const sleep = async () => controller.abort();
  await assert.rejects(
    pollDeviceToken(device(), { fetchFn: api.fetchFn, sleep, signal: controller.signal }),
    (err) => err.cancelled === true
  );
});

test('login completion stores the account and the first organization by name', async () => {
  rmSync(credentialPath, { force: true });
  const api = recorder((row) => {
    assert.equal(row.headers.get('authorization'), 'Bearer at-new');
    if (row.url === `${SERVER}/api/user`) return json({ id: 'user-1', email: 'Dev@Example.com' });
    if (row.url === `${SERVER}/api/orgs`)
      return json([
        { id: 'org-z', name: 'Zeta' },
        { id: 'org-a', name: 'Alpha' },
      ]);
    return json({}, 404);
  });
  await completeLogin(
    { access_token: 'at-new', refresh_token: 'rt-new', expires_at: Date.now() + 3600_000 },
    { fetchFn: api.fetchFn }
  );
  const stored = JSON.parse(readFileSync(credentialPath, 'utf8'));
  assert.deepEqual(
    { account: stored.account_id, email: stored.email, org: stored.org_id, name: stored.org_name },
    { account: 'user-1', email: 'dev@example.com', org: 'org-a', name: 'Alpha' }
  );
  const described = describeOpenCodeGoOAuthCredentials();
  assert.equal(described.authenticated, true);
  assert.equal(described.email, 'dev@example.com');
  assert.equal(described.orgName, 'Alpha');
  assert.equal(
    pickOrganization(
      [
        { id: 'b', name: 'B' },
        { id: 'a', name: 'A' },
      ],
      'b'
    ).id,
    'b'
  );
  assert.throws(() => pickOrganization([{ id: 'a', name: 'A' }], 'missing'));
});

test('an expiring token is refreshed with a JSON refresh grant and rotated on disk', async () => {
  signIn({ expires_at: Date.now() + 1000 });
  const api = recorder(() => json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 2591999 }));
  const tokens = await ensureFreshTokens({ fetchFn: api.fetchFn });
  assert.equal(api.seen.length, 1);
  assert.equal(api.seen[0].url, `${SERVER}/auth/device/token`);
  assert.deepEqual(api.seen[0].body, { grant_type: 'refresh_token', refresh_token: 'rt-1', client_id: 'opencode-cli' });
  assert.equal(tokens.access_token, 'at-2');
  assert.equal(loadTokens().refresh_token, 'rt-2');
  assert.equal(loadTokens().org_name, 'Alpha');
  // A fresh token is used as is.
  const again = await ensureFreshTokens({ fetchFn: api.fetchFn });
  assert.equal(again.access_token, 'at-2');
  assert.equal(api.seen.length, 1);
});

test('a rejected refresh token asks for a new sign-in', async () => {
  signIn({ expires_at: Date.now() + 1000 });
  const api = recorder(() => json({ error: 'invalid_grant' }, 400));
  await assert.rejects(ensureFreshTokens({ fetchFn: api.fetchFn }), (err) => err.reauthRequired === true);
});

test('a refresh that completes after a new sign-in keeps the new account', async () => {
  signIn({ expires_at: Date.now() + 1000 });
  const api = recorder(() => {
    // The user signs in to another account while the refresh is in flight.
    signIn({ access_token: 'at-b', refresh_token: 'rt-b', account_id: 'user-2', org_id: 'org-b', org_name: 'Beta' });
    return json({ access_token: 'at-old', refresh_token: 'rt-old', expires_in: 3600 });
  });
  const tokens = await ensureFreshTokens({ fetchFn: api.fetchFn });
  assert.equal(api.seen.length, 1);
  assert.equal(tokens.account_id, 'user-2');
  assert.deepEqual([loadTokens().access_token, loadTokens().account_id], ['at-b', 'user-2']);
});

test('a refresh that completes after a sign-out does not restore the credential', async () => {
  signIn({ expires_at: Date.now() + 1000 });
  const api = recorder(() => {
    forgetOpenCodeGoOAuthCredentials();
    return json({ access_token: 'at-old', refresh_token: 'rt-old', expires_in: 3600 });
  });
  await assert.rejects(ensureFreshTokens({ fetchFn: api.fetchFn }), (err) => err.reauthRequired === true);
  assert.equal(existsSync(credentialPath), false);
});

const REMOTE = {
  providers: {
    opencode: { settings: { baseURL: 'https://opencode.ai/zen/v1' }, models: { 'zen-only': {} } },
    'opencode-go': {
      package: '@ai-sdk/openai-compatible',
      settings: { baseURL: 'https://opencode.ai/inference/go/openai/v1' },
      headers: { 'x-opencode-org-id': 'wrk-1' },
      models: {
        'glm-5.2': {
          name: 'GLM-5.2',
          limit: { context: 202752, output: 32768 },
          cost: { input: 0.6, output: 2.2, cache: { read: 0.11 } },
          capabilities: { reasoning: { supported: true, effort: ['low', 'high'] } },
        },
        'claude-fixture': {
          package: '@ai-sdk/anthropic',
          settings: { baseURL: 'https://opencode.ai/inference/go/anthropic/v1' },
          capabilities: { reasoning: { supported: false } },
        },
        'off-model': { disabled: true },
      },
    },
  },
};

test('the remote config maps to the Go catalog, base URL and headers', () => {
  const remote = goConfigFromResponse(REMOTE);
  assert.equal(remote.baseURL, 'https://opencode.ai/inference/go/openai/v1');
  assert.deepEqual(remote.headers, { 'x-opencode-org-id': 'wrk-1' });
  assert.deepEqual(remote.models, [
    {
      id: 'glm-5.2',
      provider: 'opencode-go-oauth',
      name: 'GLM-5.2',
      contextWindow: 202752,
      outputTokens: 32768,
      supportsReasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
      reasoningLevels: ['low', 'high'],
      inputCostPerM: 0.6,
      outputCostPerM: 2.2,
      cacheReadCostPerM: 0.11,
      wire: 'chat',
    },
    {
      id: 'claude-fixture',
      provider: 'opencode-go-oauth',
      name: 'claude-fixture',
      supportsReasoning: false,
      reasoningOptions: [],
      reasoningLevels: [],
      wire: 'messages',
      baseURL: 'https://opencode.ai/inference/go/anthropic/v1',
    },
  ]);
  assert.throws(() => goConfigFromResponse({ providers: { opencode: {} } }), /no OpenCode Go provider/);
});

// The console serves `models: {}` for an organization without overrides.
const EMPTY_REMOTE = {
  providers: {
    'opencode-go': { name: 'OpenCode Go', headers: { 'x-opencode-org-id': 'wrk-2' }, models: {} },
  },
};

// The raw models.dev payload (provider → models).
const MODELS_DEV = {
  'opencode-go': {
    models: {
      'kimi-fixture': {
        name: 'Kimi Fixture',
        limit: { context: 262144, output: 65536 },
        cost: { input: 0.95, output: 4, cache_read: 0.19 },
        reasoning: true,
        reasoning_options: [{ type: 'effort', values: ['low', 'high'] }],
      },
      'claude-md-fixture': {
        name: 'Claude MD Fixture',
        provider: { npm: '@ai-sdk/anthropic' },
        reasoning: false,
      },
    },
  },
};

const MODELS_DEV_URL = 'https://models.dev/api.json';

test('a config that lists no models falls back to the models.dev Go catalog rows', () => {
  // The resident catalog flattens `provider.npm` to `npm`.
  const { provider, ...claude } = MODELS_DEV['opencode-go'].models['claude-md-fixture'];
  const catalog = { ...MODELS_DEV['opencode-go'].models, 'claude-md-fixture': { ...claude, npm: provider.npm } };
  const remote = goConfigFromResponse(EMPTY_REMOTE, catalog);
  assert.equal(remote.baseURL, 'https://opencode.ai/inference/go/openai/v1');
  assert.deepEqual(remote.headers, { 'x-opencode-org-id': 'wrk-2' });
  assert.deepEqual(remote.models, [
    {
      id: 'kimi-fixture',
      provider: 'opencode-go-oauth',
      name: 'Kimi Fixture',
      contextWindow: 262144,
      outputTokens: 65536,
      supportsReasoning: true,
      reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }],
      reasoningLevels: ['low', 'high'],
      inputCostPerM: 0.95,
      outputCostPerM: 4,
      cacheReadCostPerM: 0.19,
      wire: 'chat',
    },
    {
      id: 'claude-md-fixture',
      provider: 'opencode-go-oauth',
      name: 'Claude MD Fixture',
      supportsReasoning: false,
      reasoningOptions: [],
      reasoningLevels: [],
      wire: 'messages',
    },
  ]);
  // Without a catalog there is still nothing to list.
  assert.deepEqual(goConfigFromResponse(EMPTY_REMOTE).models, []);
});

test('a config that lists models keeps its own catalog, even when every entry is disabled', () => {
  const catalog = MODELS_DEV['opencode-go'].models;
  assert.deepEqual(goConfigFromResponse(REMOTE, catalog), goConfigFromResponse(REMOTE));
  const allOff = { providers: { 'opencode-go': { models: { 'off-model': { disabled: true } } } } };
  assert.deepEqual(goConfigFromResponse(allOff, catalog).models, []);
});

// The models.dev loader is process-wide state: this test must run while it is still cold (no
// in-memory or disk copy), and it leaves a 60 s retry backoff behind (see the next test).
test('an empty config with an unavailable models.dev fails discovery and keeps the cached roster', async () => {
  signIn();
  const ok = recorder((row) => (row.url === `${SERVER}/api/v2/config` ? json(REMOTE) : json({}, 404)));
  await new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: ok.fetchFn }).listModels();
  const cachePath = join(dir, 'opencode-go-oauth-models.json');
  const before = readFileSync(cachePath, 'utf8');

  const realFetch = globalThis.fetch;
  const realWrite = process.stderr.write;
  globalThis.fetch = async () => json({}, 503);
  process.stderr.write = () => true;
  try {
    const empty = recorder((row) => (row.url === `${SERVER}/api/v2/config` ? json(EMPTY_REMOTE) : json({}, 404)));
    const provider = new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: empty.fetchFn });
    await assert.rejects(provider.listModels(), (err) => err.kind === 'catalog' && /models\.dev/.test(err.message));
    assert.equal(readFileSync(cachePath, 'utf8'), before);
    assert.deepEqual(
      JSON.parse(before).models.map((row) => row.id),
      ['glm-5.2', 'claude-fixture']
    );
    assert.equal(provider.getCachedModelInfo('glm-5.2').outputTokens, 32768);
  } finally {
    globalThis.fetch = realFetch;
    process.stderr.write = realWrite;
  }
});

test('listModels loads a cold models.dev catalog before reading it when the config lists no models', async () => {
  signIn();
  const realFetch = globalThis.fetch;
  const realNow = Date.now;
  const catalogCalls = [];
  // Past the loader's 60 s retry backoff left by the failed load above.
  Date.now = () => realNow() + 120_000;
  globalThis.fetch = async (input) => {
    catalogCalls.push(String(input?.url || input));
    return json(MODELS_DEV);
  };
  try {
    const api = recorder((row) => (row.url === `${SERVER}/api/v2/config` ? json(EMPTY_REMOTE) : json({}, 404)));
    const provider = new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: api.fetchFn });
    const rows = await provider.listModels();
    assert.deepEqual(catalogCalls, [MODELS_DEV_URL]);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['kimi-fixture', 'claude-md-fixture']
    );
    assert.equal(rows[0].contextWindow, 262144);
    assert.equal(rows[0].wire, undefined);
    assert.equal(provider.getCachedModelInfo('kimi-fixture').outputTokens, 65536);

    // A config that lists models never touches models.dev.
    catalogCalls.length = 0;
    const listed = recorder((row) => (row.url === `${SERVER}/api/v2/config` ? json(REMOTE) : json({}, 404)));
    const own = await new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: listed.fetchFn }).listModels();
    assert.deepEqual(
      own.map((row) => row.id),
      ['glm-5.2', 'claude-fixture']
    );
    assert.deepEqual(catalogCalls, []);
  } finally {
    Date.now = realNow;
    globalThis.fetch = realFetch;
  }
});

function frame(event) {
  return `data: ${JSON.stringify(event)}\n\n`;
}
const chatStream = (model) =>
  new Response(frame({ id: 'c1', model, choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] }), {
    headers: { 'content-type': 'text/event-stream' },
  });

test('listModels reads the organization config with the bearer token and x-org-id', async () => {
  signIn();
  const api = recorder((row) => (row.url === `${SERVER}/api/v2/config` ? json(REMOTE) : json({}, 404)));
  const provider = new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: api.fetchFn });
  const rows = await provider.listModels();
  assert.deepEqual(
    rows.map((row) => row.id),
    ['glm-5.2', 'claude-fixture']
  );
  assert.equal(rows[0].contextWindow, 202752);
  assert.equal(rows[0].wire, undefined);
  assert.equal(api.seen[0].headers.get('authorization'), 'Bearer at-1');
  assert.equal(api.seen[0].headers.get('x-org-id'), 'org-a');
  assert.ok(existsSync(join(dir, 'opencode-go-oauth-models.json')));
  assert.equal(provider.getCachedModelInfo('glm-5.2').outputTokens, 32768);
});

test('a chat request goes to the config base URL with the token, config headers and session id', async () => {
  signIn();
  const api = recorder((row) => {
    if (row.url === `${SERVER}/api/v2/config`) return json(REMOTE);
    return chatStream(row.body?.model);
  });
  const provider = new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: api.fetchFn });
  await provider.send([{ role: 'user', content: 'hi' }], 'glm-5.2', [], { sessionId: 'sess-1' });
  const inference = api.seen.filter((row) => !row.url.startsWith(SERVER));
  assert.equal(inference.length, 1);
  assert.equal(inference[0].url, 'https://opencode.ai/inference/go/openai/v1/chat/completions');
  assert.equal(inference[0].headers.get('authorization'), 'Bearer at-1');
  assert.equal(inference[0].headers.get('x-opencode-org-id'), 'wrk-1');
  assert.equal(inference[0].headers.get('x-opencode-session'), 'sess-1');
  assert.equal(inference[0].body.model, 'glm-5.2');
});

test('an inference 401 refreshes the token once and retries with the new bearer', async () => {
  signIn();
  let inferenceCalls = 0;
  const api = recorder((row) => {
    if (row.url === `${SERVER}/api/v2/config`) return json(REMOTE);
    if (row.url === `${SERVER}/auth/device/token`)
      return json({ access_token: 'at-9', refresh_token: 'rt-9', expires_in: 3600 });
    inferenceCalls += 1;
    if (row.headers.get('authorization') === 'Bearer at-1') return json({ error: { message: 'unauthorized' } }, 401);
    return chatStream(row.body?.model);
  });
  const provider = new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: api.fetchFn });
  await provider.send([{ role: 'user', content: 'hi' }], 'glm-5.2', [], { sessionId: 'sess-2' });
  const bearers = api.seen
    .filter((row) => row.url.includes('/inference/'))
    .map((row) => row.headers.get('authorization'));
  assert.equal(bearers.at(-1), 'Bearer at-9');
  assert.ok(inferenceCalls >= 2);
  assert.equal(loadTokens().access_token, 'at-9');
});

test('a failed config read falls back only to the catalog of the same account and organization', async () => {
  signIn();
  const ok = recorder((row) => (row.url === `${SERVER}/api/v2/config` ? json(REMOTE) : json({}, 404)));
  await new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: ok.fetchFn }).listModels();
  const configDown = () =>
    recorder((row) =>
      row.url === `${SERVER}/api/v2/config` ? json({ error: 'unavailable' }, 503) : chatStream(row.body?.model)
    );
  const inference = (api) => api.seen.filter((row) => row.url.includes('/inference/'));
  const same = configDown();
  await new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: same.fetchFn }).send(
    [{ role: 'user', content: 'hi' }],
    'glm-5.2',
    [],
    { sessionId: 'sess-3' }
  );
  assert.equal(inference(same)[0].headers.get('x-opencode-org-id'), 'wrk-1');

  // Another organization never gets the cached routing headers of org-a.
  signIn({ org_id: 'org-b', org_name: 'Beta' });
  const other = configDown();
  await assert.rejects(
    new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: other.fetchFn }).send(
      [{ role: 'user', content: 'hi' }],
      'glm-5.2',
      [],
      { sessionId: 'sess-4' }
    ),
    /config 503/
  );
  assert.equal(inference(other).length, 0);
});

test('a config 401 refreshes once and retries before asking for a new sign-in', async () => {
  const tokenGrant = (row) => row.url === `${SERVER}/auth/device/token`;
  signIn();
  const api = recorder((row) => {
    if (tokenGrant(row)) return json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
    if (row.url === `${SERVER}/api/v2/config`)
      return row.headers.get('authorization') === 'Bearer at-2' ? json(REMOTE) : json({}, 401);
    return json({}, 404);
  });
  const rows = await new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: api.fetchFn }).listModels();
  assert.equal(rows.length, 2);
  assert.equal(api.seen.filter(tokenGrant).length, 1);
  assert.equal(loadTokens().access_token, 'at-2');

  // Still refused with the refreshed token: only now is a sign-in required.
  signIn();
  const refused = recorder((row) =>
    tokenGrant(row) ? json({ access_token: 'at-3', refresh_token: 'rt-3', expires_in: 3600 }) : json({}, 401)
  );
  await assert.rejects(
    new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: refused.fetchFn }).listModels(),
    (err) => err.reauthRequired === true
  );
  assert.equal(refused.seen.filter(tokenGrant).length, 1);
});

const STATUS = {
  access: {
    meters: {
      fiveHour: { limitMicroCents: '1200000000', usedMicroCents: '300000000', resetsAt: '2030-01-01T00:00:00.000Z' },
      week: { limitMicroCents: '3000000000', usedMicroCents: '0', resetsAt: null },
    },
  },
};

test('usage reads the Go meters with the OAuth bearer and x-org-id', async () => {
  signIn();
  const api = recorder((row) => (row.url === `${SERVER}/api/go/status` ? json(STATUS) : json({}, 404)));
  const provider = new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: api.fetchFn });
  const snapshot = await provider.getUsageSnapshot();
  assert.equal(api.seen[0].headers.get('authorization'), 'Bearer at-1');
  assert.equal(api.seen[0].headers.get('x-org-id'), 'org-a');
  assert.equal(snapshot.provider, 'opencode-go-oauth');
  assert.deepEqual(
    snapshot.quotaWindows.map(({ label, usedPct, limitUsd }) => ({ label, usedPct, limitUsd })),
    [
      { label: '5H', usedPct: 25, limitUsd: 12 },
      { label: '7D', usedPct: 0, limitUsd: 30 },
    ]
  );
});

test('a usage 401 refreshes once and retries', async () => {
  signIn();
  const api = recorder((row) => {
    if (row.url === `${SERVER}/auth/device/token`)
      return json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });
    return row.headers.get('authorization') === 'Bearer at-2' ? json(STATUS) : json({}, 401);
  });
  const snapshot = await new OpenCodeGoOAuthProvider({ preconnect: false, fetchImpl: api.fetchFn }).getUsageSnapshot();
  assert.equal(snapshot.quotaWindows.length, 2);
  assert.equal(api.seen.filter((row) => row.url === `${SERVER}/auth/device/token`).length, 1);
});
