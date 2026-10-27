import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'command-code-provider-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.COMMAND_CODE_OAUTH_CREDENTIALS_PATH = join(dir, 'command-code-oauth.json');
process.env.MIXDOG_QUIET_PROVIDER_LOG = '1';

const { CommandCodeOAuthProvider, quotaWindowsFromCredits, chooseDefaultModel, modelWire } = await import(
  './command-code-oauth.mjs'
);

test.after(() => rmSync(dir, { recursive: true, force: true }));

const signIn = (apiKey = 'cc-secret-key') =>
  writeFileSync(
    process.env.COMMAND_CODE_OAUTH_CREDENTIALS_PATH,
    JSON.stringify({ apiKey, userId: 'user-1', userName: 'alice' })
  );

function recordingFetch(handler) {
  const seen = [];
  const fetchImpl = async (input, init = {}) => {
    const url = String(input?.url || input);
    const headers = new Headers(init.headers || input?.headers || {});
    seen.push({
      url,
      method: init.method || input?.method || 'GET',
      auth: headers.get('authorization'),
      xApiKey: headers.get('x-api-key'),
    });
    return handler(url, init);
  };
  return { seen, fetchImpl };
}

const ROSTER = {
  data: [
    { id: 'deepseek/deepseek-v4-flash', context_length: 1000000 },
    { id: 'zai-org/GLM-5.3', supported_endpoints: ['/chat/completions', '/responses'] },
    { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', supported_endpoints: ['/messages'] },
    { id: 'responses-only', supported_endpoints: ['/responses'] },
  ],
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

test('quota windows map fiveHour/weekly to 5H/7D and skip a window without a cap', () => {
  const resetIso = '2030-01-01T05:00:00.000Z';
  const windows = quotaWindowsFromCredits({
    windowLimits: {
      fiveHour: { cap: 200, used: 50, resetAt: resetIso },
      weekly: { cap: 1000, used: 1000, resetAt: 1893456000 },
    },
  });
  assert.deepEqual(
    windows.map(({ label, usedPct, resetAt, status }) => ({ label, usedPct, resetAt, status })),
    [
      { label: '5H', usedPct: 25, resetAt: Date.parse(resetIso), status: 'ok' },
      { label: '7D', usedPct: 100, resetAt: 1893456000 * 1000, status: 'exhausted' },
    ]
  );
  const skipped = quotaWindowsFromCredits({
    data: { windowLimits: { fiveHour: { cap: 0, used: 0 }, weekly: { cap: 10, used: 3 } } },
  });
  assert.deepEqual(
    skipped.map((w) => [w.label, w.usedPct]),
    [['7D', 30]]
  );
  assert.deepEqual(quotaWindowsFromCredits({}), []);
  assert.deepEqual(quotaWindowsFromCredits({ windowLimits: { fiveHour: { cap: -1, used: 1 } } }), []);
});

test('usage snapshot reads billing credits from the API host with the bearer key', async () => {
  signIn();
  const api = recordingFetch(() =>
    json({ windowLimits: { fiveHour: { cap: 100, used: 40, resetAt: 1893456000000 }, weekly: { cap: 0, used: 0 } } })
  );
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  const snapshot = await provider.getUsageSnapshot();
  assert.equal(snapshot.provider, 'command-code-oauth');
  assert.equal(snapshot.accountId, 'user-1');
  assert.deepEqual(
    snapshot.quotaWindows.map((w) => [w.label, w.usedPct, w.resetAt]),
    [['5H', 40, 1893456000000]]
  );
  assert.deepEqual(api.seen, [
    {
      url: 'https://api.commandcode.ai/alpha/billing/credits',
      method: 'GET',
      auth: 'Bearer cc-secret-key',
      xApiKey: null,
    },
  ]);
});

test('a rejected key on usage requires a fresh sign-in and the error carries no key', async () => {
  signIn();
  const api = recordingFetch(() => json({ error: 'invalid key cc-secret-key' }, 401));
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  await assert.rejects(provider.getUsageSnapshot(), (err) => {
    assert.equal(err.reauthRequired, true);
    assert.equal(err.status, 401);
    assert.equal(String(err.message).includes('cc-secret-key'), false);
    return true;
  });
});

test('lists servable models from /provider/v1/models', async () => {
  signIn();
  const api = recordingFetch(() =>
    json({ data: [...ROSTER.data, { id: 'embeddings-only', supported_endpoints: ['/embeddings'] }] })
  );
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  const models = await provider.listModels();
  // Messages-only and Responses-only rows stay; a row declaring no inference wire is dropped.
  assert.deepEqual(
    models.map((m) => m.id),
    ['deepseek/deepseek-v4-flash', 'zai-org/GLM-5.3', 'claude-sonnet-5', 'responses-only']
  );
  // The persisted roster keeps every declared endpoint.
  const cached = JSON.parse(readFileSync(join(dir, 'command-code-oauth-models.json'), 'utf8')).models;
  assert.deepEqual(cached.find((row) => row.id === 'zai-org/GLM-5.3').supportedEndpoints, [
    '/chat/completions',
    '/responses',
  ]);
  assert.equal(cached.find((row) => row.id === 'deepseek/deepseek-v4-flash').supportedEndpoints, undefined);
  assert.deepEqual(api.seen, [
    {
      url: 'https://api.commandcode.ai/provider/v1/models',
      method: 'GET',
      auth: 'Bearer cc-secret-key',
      xApiKey: null,
    },
  ]);
  assert.equal(chooseDefaultModel(['a/b', 'deepseek/deepseek-v4-flash']), 'deepseek/deepseek-v4-flash');
  assert.equal(chooseDefaultModel(['a/b']), 'a/b');
});

test('modelWire: Responses for GPT/Muse/Grok when advertised, else Chat, Messages when alone', () => {
  assert.equal(modelWire({ id: 'a' }), 'chat');
  assert.equal(modelWire({ id: 'a', supported_endpoints: ['/chat/completions', '/responses'] }), 'chat');
  assert.equal(
    modelWire({ id: 'openai/gpt-5.5', supported_endpoints: ['/chat/completions', '/responses'] }),
    'responses'
  );
  assert.equal(
    modelWire({ id: 'muse-spark-1.3', supported_endpoints: ['/chat/completions', '/v1/responses'] }),
    'responses'
  );
  assert.equal(
    modelWire({ id: 'xai/grok-4.7', supported_endpoints: ['/chat/completions', '/responses'] }),
    'responses'
  );
  assert.equal(modelWire({ id: 'gpt-5.5', supported_endpoints: ['/chat/completions'] }), 'chat');
  assert.equal(modelWire({ id: 'a', supported_endpoints: ['/chat/completions', '/messages'] }), 'chat');
  assert.equal(modelWire({ id: 'a', supported_endpoints: ['/v1/messages'] }), 'messages');
  assert.equal(modelWire({ id: 'a', supported_endpoints: ['/responses'] }), 'responses');
  assert.equal(modelWire({ id: 'a', supported_endpoints: ['/embeddings'] }), null);
  assert.equal(modelWire({}), null);
});

// /models answers with the roster; every inference request gets `inference`.
const routed = (inference) => (url) => (url.endsWith('/provider/v1/models') ? json(ROSTER) : inference());
const inferenceRows = (seen) => seen.filter((row) => !row.url.endsWith('/models'));

test('a chat model posts chat completions to the API host and scrubs the key from errors', async () => {
  signIn();
  const api = recordingFetch(routed(() => json({ error: { message: 'bad request for cc-secret-key' } }, 400)));
  // A configured base URL can never redirect the key elsewhere.
  const provider = new CommandCodeOAuthProvider({
    preconnect: false,
    fetchImpl: api.fetchImpl,
    baseURL: 'https://evil.example/v1',
  });
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', [], {}),
    (err) => {
      assert.equal(String(err.message).includes('cc-secret-key'), false);
      assert.equal(JSON.stringify(err.error ?? null).includes('cc-secret-key'), false);
      return true;
    }
  );
  const rows = inferenceRows(api.seen);
  assert.ok(rows.length >= 1);
  for (const row of rows) {
    assert.equal(row.url, 'https://api.commandcode.ai/provider/v1/chat/completions');
    assert.equal(row.auth, 'Bearer cc-secret-key');
  }
});

test('an off-origin redirect is refused on both wires and no credential header is sent elsewhere', async () => {
  signIn();
  for (const model of ['deepseek/deepseek-v4-flash', 'claude-sonnet-5']) {
    const hops = [];
    // Follows a redirect like fetch would unless the caller asked for manual.
    const fetchImpl = async (input, init = {}) => {
      const url = String(input?.url || input);
      hops.push({ url, headers: new Headers(init.headers || input?.headers || {}), redirect: init.redirect });
      if (url.endsWith('/provider/v1/models')) return json(ROSTER);
      if (url.startsWith('https://evil.example')) return json({}, 200);
      const res = new Response(null, { status: 307, headers: { Location: 'https://evil.example/steal' } });
      if (init.redirect === 'manual') return res;
      return fetchImpl('https://evil.example/steal', init);
    };
    const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl, maxRetries: 0 });
    await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], model, [], {}));
    assert.equal(hops.filter((h) => !h.url.startsWith('https://api.commandcode.ai/')).length, 0);
  }
});

test('effort maps to reasoning_effort on the chat wire', async () => {
  signIn();
  const bodies = [];
  const api = recordingFetch((url, init) => {
    if (url.endsWith('/provider/v1/models')) return json(ROSTER);
    bodies.push(JSON.parse(init.body));
    return json({ error: { message: 'stop' } }, 400);
  });
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  for (const effort of ['high', undefined]) {
    await assert.rejects(
      provider.send([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', [], { effort })
    );
  }
  assert.equal(bodies[0].reasoning_effort, 'high');
  assert.equal(bodies.at(-1).reasoning_effort, undefined);
});

test('effort follows the listed model row: a declared xhigh is sent, an undeclared level is dropped', async () => {
  signIn();
  const bodies = [];
  const roster = { data: [{ id: 'gpt-5.5' }, { id: 'plain-model' }] };
  const api = recordingFetch((url, init) => {
    if (url.endsWith('/provider/v1/models')) return json(roster);
    bodies.push(JSON.parse(init.body));
    return json({ error: { message: 'stop' } }, 400);
  });
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  await provider.listModels();
  const go = (model, effort) => assert.rejects(provider.send([{ role: 'user', content: 'hi' }], model, [], { effort }));
  await go('gpt-5.5', 'xhigh');
  assert.equal(bodies.at(-1).reasoning_effort, 'xhigh');
  await go('gpt-5.5', 'bogus');
  assert.equal(bodies.at(-1).reasoning_effort, undefined);
});

test('a Messages-only model goes through the Anthropic engine at /provider/v1/messages', async () => {
  signIn();
  const saved = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = 'unrelated-env-token';
  try {
    const api = recordingFetch(routed(() => json({ type: 'error', error: { message: 'no cc-secret-key' } }, 400)));
    const provider = new CommandCodeOAuthProvider({
      preconnect: false,
      fetchImpl: api.fetchImpl,
      baseURL: 'https://evil.example/v1',
    });
    await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', [], {}), (err) => {
      assert.equal(String(err.message).includes('cc-secret-key'), false);
      assert.notEqual(err.reauthRequired, true);
      return true;
    });
    const rows = inferenceRows(api.seen);
    assert.ok(rows.length >= 1);
    for (const row of rows) {
      assert.equal(row.url, 'https://api.commandcode.ai/provider/v1/messages');
      assert.equal(row.method, 'POST');
      // The Command Code key in both forms; never the environment token.
      assert.equal(row.auth, 'Bearer cc-secret-key');
      assert.equal(row.xApiKey, 'cc-secret-key');
    }
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = saved;
  }
});

test('a GPT model advertising Responses posts to /provider/v1/responses', async () => {
  signIn();
  const roster = { data: [{ id: 'openai/gpt-5.5', supported_endpoints: ['/chat/completions', '/responses'] }] };
  const urls = [];
  const fetchImpl = async (input) => {
    const url = String(input?.url || input);
    if (url.endsWith('/provider/v1/models')) return json(roster);
    urls.push(url);
    return json({ error: { message: 'stop' } }, 400);
  };
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl });
  await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'openai/gpt-5.5', [], {}));
  assert.ok(urls.length >= 1);
  assert.ok(urls.every((url) => url === 'https://api.commandcode.ai/provider/v1/responses'));
});

test('a roster failure or miss keeps a known Messages-only model on Messages', async () => {
  signIn();
  let roster = () => json(ROSTER);
  const api = recordingFetch((url) =>
    url.endsWith('/provider/v1/models') ? roster() : json({ type: 'error', error: { message: 'stop' } }, 400)
  );
  const send = (provider) =>
    assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', [], {}));
  const messagesOnly = () => {
    const rows = inferenceRows(api.seen.splice(0));
    assert.ok(rows.length >= 1);
    assert.ok(rows.every((row) => row.url === 'https://api.commandcode.ai/provider/v1/messages'));
  };
  // Listed once: Claude is persisted as Messages-only.
  const listed = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  await listed.listModels();
  // A later roster that misses the model keeps what this key listed.
  roster = () => json({ data: [] });
  await listed.listModels();
  await send(listed);
  messagesOnly();
  // A fresh process whose roster cannot be read falls back on the persisted rows.
  writeFileSync(
    join(dir, 'command-code-oauth-models.json'),
    JSON.stringify({ version: 1, fetchedAt: 1, models: [{ id: 'claude-sonnet-5', supportedEndpoints: ['/messages'] }] })
  );
  roster = () => json({ error: 'down' }, 503);
  const fresh = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  await send(fresh);
  messagesOnly();
  assert.equal((await fresh.resolveWireRoute('claude-sonnet-5')).wire, 'messages');
  // A model nothing describes is routed by convention but never pinned.
  assert.equal((await fresh.resolveWireRoute('never-listed')).source, 'unknown');
});

test('a 401 on the Messages wire asks for a fresh sign-in', async () => {
  signIn();
  const api = recordingFetch(routed(() => json({ type: 'error', error: { message: 'unauthorized' } }, 401)));
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hi' }], 'claude-sonnet-5', [], {}),
    (err) => err.reauthRequired === true && err.status === 401
  );
  assert.equal(inferenceRows(api.seen).length, 1);
});

test('a 401 on send asks for a fresh sign-in', async () => {
  signIn();
  const api = recordingFetch(() => json({ error: { message: 'unauthorized' } }, 401));
  const provider = new CommandCodeOAuthProvider({ preconnect: false, fetchImpl: api.fetchImpl });
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hi' }], 'deepseek/deepseek-v4-flash', [], {}),
    (err) => err.reauthRequired === true
  );
});

test('send without credentials asks for sign-in', async () => {
  rmSync(process.env.COMMAND_CODE_OAUTH_CREDENTIALS_PATH, { force: true });
  const provider = new CommandCodeOAuthProvider({ preconnect: false });
  await assert.rejects(provider.send([], 'deepseek/deepseek-v4-flash', [], {}), /sign in/);
  assert.equal(await provider.isAvailable(), false);
});
