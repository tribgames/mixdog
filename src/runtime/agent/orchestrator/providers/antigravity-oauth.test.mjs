// Wire-shape checks for the Antigravity Cloud Code Assist transport. The
// backend rejects a malformed envelope with an opaque 400, so the request
// wrapper, the impersonation headers, the thinking-signature sentinel, and the
// `{ response: … }` chunk unwrapping are all pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTick } from 'node:timers/promises';

// The catalog cache lives in the data dir; isolate it so a developer's own
// cached catalog never leaks into wire-id expectations.
process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-antigravity-test-'));

import { AntigravityOAuthProvider } from './antigravity-oauth.mjs';
import {
  ANTIGRAVITY_MODELS,
  CONTENT_ENDPOINT,
  CONTENT_ENDPOINTS,
  antigravityHeaders,
  codeAssistMetadata,
  parseAntigravityManifestVersion,
  _resetAntigravityVersionForTest,
} from './antigravity-oauth-tokens.mjs';
import { createProviderReplay } from './lib/provider-replay.mjs';

function sseResponse(chunks, { status = 200 } = {}) {
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('');
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function candidateChunk(parts, finishReason = null) {
  return {
    response: {
      candidates: [{ content: { role: 'model', parts }, ...(finishReason ? { finishReason } : {}) }],
      ...(finishReason ? { usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 5 } } : {}),
    },
  };
}

function providerWith(fetchFn, overrides = {}) {
  return new AntigravityOAuthProvider({
    fetchFn,
    preconnectFn: () => {},
    ensureVersionFn: async () => {},
    ensureAuthFn: async () => ({
      accessToken: 'access-token',
      projectId: 'test-project',
      email: 'dev@example.com',
    }),
    ...overrides,
  });
}

test('same-provider signed output survives the next Antigravity request without changing history', async () => {
  const originalParts = [
    { thought: true, text: 'Summary.', thoughtSignature: 'native-thinking-signature' },
    { text: 'Answer.', thoughtSignature: 'native-text-signature' },
  ];
  const requests = [];
  const provider = providerWith(async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return sseResponse([candidateChunk(requests.length === 1 ? originalParts : [{ text: 'done' }], 'STOP')]);
  });
  const first = await provider.send([{ role: 'user', content: 'Hello.' }], 'gemini-3-flash', [], {});
  const history = [
    { role: 'user', content: 'Hello.' },
    { role: 'assistant', content: first.content, providerReplay: first.providerReplay },
    { role: 'user', content: 'Continue.' },
  ];
  const snapshot = structuredClone(history);
  await provider.send(history, 'gemini-3-flash', [], {});
  assert.deepEqual(requests[1].request.contents.find((content) => content.role === 'model').parts, originalParts);
  assert.deepEqual(history, snapshot);
  const foreign = provider._buildBody(
    [
      {
        role: 'assistant',
        content: 'Foreign.',
        providerReplay: createProviderReplay('gemini', originalParts),
      },
    ],
    'gemini-3-flash',
    [],
    {}
  );
  assert.equal(foreign.request.contents[0].parts[0].thoughtSignature, 'skip_thought_signature_validator');
});

test('Antigravity keeps bare Flash thinkingLevel without guessing Claude token budgets', () => {
  const provider = providerWith(async () => {
    throw new Error('network forbidden');
  });
  const messages = [{ role: 'user', content: 'Hello.' }];
  for (const effort of ['low', 'high']) {
    const flash = provider._buildBody(messages, 'gemini-3-flash', [], { effort });
    assert.equal(flash.model, 'gemini-3-flash');
    assert.equal(flash.request.generationConfig.thinkingConfig.thinkingLevel, effort);
  }
  assert.throws(
    () => provider._buildBody(messages, 'claude-opus-4-6-thinking', [], { effort: 'high' }),
    /uses thinkingBudget/
  );
  const claude = provider._buildBody(messages, 'claude-opus-4-6-thinking', [], {
    effort: 'high',
    thinkingBudget: 4096,
  });
  assert.equal(claude.request.generationConfig.thinkingConfig.thinkingBudget, 4096);
});

test('the stored credential (snake_case) reaches requests as a bearer token and project', async (t) => {
  const tokenPath = join(mkdtempSync(join(tmpdir(), 'mixdog-antigravity-store-')), 'antigravity-oauth.json');
  writeFileSync(
    tokenPath,
    JSON.stringify({
      access_token: 'stored-access',
      refresh_token: 'stored-refresh',
      expires_at: Date.now() + 60 * 60 * 1000,
      project_id: 'stored-project',
      email: 'stored@example.test',
    })
  );
  const previous = process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH;
  process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH = tokenPath;
  t.after(() => {
    if (previous === undefined) delete process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH;
    else process.env.ANTIGRAVITY_OAUTH_CREDENTIALS_PATH = previous;
  });
  const seen = [];
  const provider = new AntigravityOAuthProvider({
    preconnectFn: () => {},
    ensureVersionFn: async () => {},
    fetchFn: async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization, body: JSON.parse(init.body) });
      return /fetchAvailableModels$/.test(String(url))
        ? Response.json({ models: {} })
        : sseResponse([candidateChunk([{ text: 'ok' }], 'STOP')]);
    },
  });
  await assert.rejects(provider._refreshModelCache(), /listed no chat models/);
  await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-flash', [], {});
  assert.equal(seen.length, 2);
  for (const call of seen) assert.equal(call.auth, 'Bearer stored-access');
  assert.deepEqual(seen[0].body, { project: 'stored-project' });
  assert.equal(seen[1].body.project, 'stored-project');
});

test('a content-plane verification demand surfaces the link Google hides in the error details', async () => {
  const url = 'https://accounts.google.com/signin/continue?sarp=1&plt=verify-me';
  const provider = providerWith(
    async () =>
      new Response(
        JSON.stringify({
          error: {
            code: 403,
            message: 'Verify your account to continue.',
            status: 'PERMISSION_DENIED',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'VALIDATION_REQUIRED',
                metadata: { validation_url: url },
              },
            ],
          },
        }),
        { status: 403, headers: { 'content-type': 'application/json' } }
      )
  );
  await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-flash', [], {}), (error) => {
    assert.ok(error.message.includes(url), error.message);
    assert.equal(error.validationUrl, url);
    assert.equal(error.unsafeToRetry, true);
    return true;
  });
});

test('picker families send the tiered wire id and drop the effort field', async () => {
  const bodies = [];
  const provider = providerWith(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return sseResponse([candidateChunk([{ text: 'ok' }], 'STOP')]);
  });
  const messages = [{ role: 'user', content: 'Hello.' }];
  await provider.send(messages, 'gemini-3.8-flash', [], { effort: 'low' });
  await provider.send(messages, 'gemini-3.1-pro', [], { effort: 'medium' });
  await provider.send(messages, 'claude-opus-4-6-thinking', [], { effort: 'high' });
  await provider.send(messages, undefined, [], {});
  assert.deepEqual(
    bodies.map((body) => body.model),
    ['gemini-3.8-flash-low', 'gemini-3.1-pro-high', 'claude-opus-4-6-thinking', 'gemini-3.8-flash-high']
  );
  for (const body of bodies) assert.equal(body.request.generationConfig?.thinkingConfig?.thinkingLevel, undefined);
});

test('the catalog is served from the gateway and cached, with the curated list as the offline fallback', async (t) => {
  let calls = 0;
  const provider = providerWith(async (url) => {
    const href = String(url);
    if (href.includes(':retrieveUserQuotaSummary')) {
      return Response.json({
        groups: [
          {
            displayName: 'Gemini Models',
            buckets: [
              { bucketId: 'gemini-5h', window: '5h', remainingFraction: 0.5, resetTime: '2030-01-01T00:00:00Z' },
              {
                bucketId: 'gemini-weekly',
                window: 'weekly',
                remainingFraction: 0.8,
                resetTime: '2030-01-08T00:00:00Z',
              },
            ],
          },
        ],
      });
    }
    calls += 1;
    assert.match(href, /:fetchAvailableModels$/);
    return Response.json({
      models: {
        'gemini-3.8-flash-high': {
          displayName: 'Gemini 3.8 Flash (High)',
          maxTokens: 1048576,
          quotaInfo: { remainingFraction: 0.5, resetTime: '2030-01-01T00:00:00Z' },
        },
        'gemini-3.8-flash-low': {
          displayName: 'Gemini 3.8 Flash (Low)',
          maxTokens: 1048576,
          quotaInfo: { remainingFraction: 1 },
        },
      },
    });
  });
  const models = await provider.listModels();
  assert.deepEqual(
    models.map((m) => m.id),
    ['gemini-3.8-flash']
  );
  assert.deepEqual(models[0].wire, { low: 'gemini-3.8-flash-low', high: 'gemini-3.8-flash-high' });
  assert.equal(calls, 1);
  await provider.listModels();
  assert.equal(calls, 1, 'second listing is served from the disk cache');
  const usage = await provider.getUsageSnapshot();
  assert.equal(usage.source, 'antigravity-quota-summary');
  assert.deepEqual(usage.quotaWindows, [
    { label: '5H', usedPct: 50, resetAt: Date.parse('2030-01-01T00:00:00Z'), source: 'antigravity-quota-summary' },
    { label: '7D', usedPct: 20, resetAt: Date.parse('2030-01-08T00:00:00Z'), source: 'antigravity-quota-summary' },
  ]);

  const offline = providerWith(async () => {
    throw new Error('offline');
  });
  t.after(() => {
    delete process.env.MIXDOG_DATA_DIR;
  });
  process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-antigravity-offline-'));
  assert.equal(await offline.listModels(), ANTIGRAVITY_MODELS);
});

test('requests carry the Cloud Code Assist envelope and Antigravity identity', async () => {
  let seen = null;
  const provider = providerWith(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return sseResponse([candidateChunk([{ text: 'hi' }], 'STOP')]);
  });

  await provider.send(
    [
      { role: 'system', content: 'be brief' },
      { role: 'user', content: 'hello' },
    ],
    'gemini-3-pro-high',
    [],
    {}
  );

  assert.match(seen.url, /\/v1internal:streamGenerateContent\?alt=sse$/);
  assert.equal(seen.body.project, 'test-project');
  assert.equal(seen.body.model, 'gemini-3-pro-high');
  assert.equal(seen.body.requestType, 'agent');
  assert.equal(seen.body.userAgent, 'antigravity');
  assert.match(String(seen.body.requestId), /^agent-/);
  // System prompts ride as an object tagged role "user"; a bare string 400s.
  assert.equal(seen.body.request.systemInstruction.role, 'user');
  assert.equal(seen.body.request.systemInstruction.parts[0].text, 'be brief');
  assert.equal(seen.body.request.contents[0].role, 'user');
  assert.equal(seen.init.headers.Authorization, 'Bearer access-token');
  assert.equal(seen.init.headers.Accept, 'text/event-stream');
  assert.equal(seen.init.headers['User-Agent'], antigravityHeaders()['User-Agent']);
  assert.deepEqual(codeAssistMetadata(), { ideType: 'ANTIGRAVITY' });
});

test('replayed thinking parts are re-stamped with the accepted sentinel', async () => {
  let seen = null;
  const provider = providerWith(async (_url, init) => {
    seen = JSON.parse(init.body);
    return sseResponse([candidateChunk([{ text: 'done' }], 'STOP')]);
  });

  await provider.send(
    [
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'answer',
        // Thinking is replayed from the recorded provider metadata, exactly as a
        // resumed session hands it back.
        providerMetadata: {
          gemini: { thoughtParts: [{ text: 'because…', thoughtSignature: 'stale-signature' }] },
        },
        toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a.txt' } }],
      },
      { role: 'tool', toolCallId: 'call_1', name: 'read', content: 'file body' },
      { role: 'user', content: 'second' },
    ],
    'claude-opus-4-6-thinking',
    [],
    {}
  );

  const thoughtParts = seen.request.contents
    .flatMap((entry) => entry.parts || [])
    .filter((part) => part?.thought === true);
  assert.ok(thoughtParts.length > 0, 'expected a replayed thinking part');
  for (const part of thoughtParts) {
    assert.equal(part.thoughtSignature, 'skip_thought_signature_validator');
  }
});

test('Claude thinking models request the interleaved-thinking beta', async () => {
  let headers = null;
  const provider = providerWith(async (_url, init) => {
    headers = init.headers;
    return sseResponse([candidateChunk([{ text: 'ok' }], 'STOP')]);
  });

  await provider.send([{ role: 'user', content: 'hi' }], 'claude-opus-4-6-thinking', [], {});
  assert.equal(headers['anthropic-beta'], 'interleaved-thinking-2025-05-14');

  await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [], {});
  assert.equal(headers['anthropic-beta'], undefined);
});

test('nested response chunks stream text and tool calls', async () => {
  const deltas = [];
  const toolCalls = [];
  const provider = providerWith(async () =>
    sseResponse([
      candidateChunk([{ text: 'Hel' }]),
      candidateChunk([{ text: 'lo' }]),
      candidateChunk([{ functionCall: { name: 'read', args: { path: 'a.txt' } } }], 'STOP'),
    ])
  );

  const result = await provider.send(
    [{ role: 'user', content: 'hi' }],
    'gemini-3-pro-high',
    [{ name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } }],
    {
      onTextDelta: (text) => deltas.push(text),
      onToolCall: (call) => toolCalls.push(call),
    }
  );

  assert.equal(result.content, 'Hello');
  assert.equal(deltas.join(''), 'Hello');
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls[0].name, 'read');
  assert.equal(toolCalls.length, 1);
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 5);
});

const DAILY_HOST = new URL(CONTENT_ENDPOINT).host;

function firstByteTimeoutError() {
  return Object.assign(new Error('Antigravity first byte timed out'), {
    name: 'ProviderTimeoutError',
    code: 'EPROVIDERTIMEOUT',
  });
}

test('generation stays on the daily host', async () => {
  assert.deepEqual([...CONTENT_ENDPOINTS], [CONTENT_ENDPOINT]);
  assert.equal(CONTENT_ENDPOINT, 'https://daily-cloudcode-pa.googleapis.com');
  const tried = [];
  const provider = providerWith(async (url) => {
    tried.push(new URL(url).origin);
    return sseResponse([candidateChunk([{ text: 'ok' }], 'STOP')]);
  });
  const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [], {});
  assert.equal(result.content, 'ok');
  assert.deepEqual(tried, [CONTENT_ENDPOINT]);
});

for (const fixture of [
  {
    name: '5xx',
    fail: () =>
      new Response(JSON.stringify({ error: { code: 500, message: 'backend' } }), {
        status: 500,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      }),
  },
  {
    name: '429',
    fail: () =>
      new Response(JSON.stringify({ error: { code: 429, message: 'rate limited' } }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '0' },
      }),
  },
  {
    name: 'timeout',
    fail: () => {
      throw firstByteTimeoutError();
    },
  },
]) {
  test(`${fixture.name} retries the daily host and never switches hosts`, async () => {
    const tried = [];
    const provider = providerWith(async (url) => {
      tried.push(new URL(url).host);
      if (tried.length === 1) return fixture.fail();
      return sseResponse([candidateChunk([{ text: 'recovered' }], 'STOP')]);
    });
    const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [], {});
    assert.equal(result.content, 'recovered');
    assert.deepEqual(tried, [DAILY_HOST, DAILY_HOST]);
  });
}

test('an injected baseURL is the only generation host', async () => {
  const tried = [];
  const provider = providerWith(
    async (url) => {
      tried.push(new URL(url).origin);
      return sseResponse([candidateChunk([{ text: 'ok' }], 'STOP')]);
    },
    { baseURL: 'https://injected.example' }
  );
  await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [], {});
  assert.deepEqual(tried, ['https://injected.example']);
});

test('401 refreshes credentials once on the same daily host', async () => {
  const tried = [];
  const auths = [];
  let token = 'stale-token';
  const provider = providerWith(
    async (url, init) => {
      tried.push({ host: new URL(url).host, auth: init.headers.Authorization });
      if (token === 'stale-token') {
        return new Response(JSON.stringify({ error: { message: 'invalid credentials' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        });
      }
      return sseResponse([candidateChunk([{ text: 'ok' }], 'STOP')]);
    },
    {
      ensureAuthFn: async ({ force } = {}) => {
        auths.push(Boolean(force));
        if (force) token = 'fresh-token';
        return { accessToken: token, projectId: 'test-project', email: 'dev@example.com' };
      },
    }
  );
  const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [], {});
  assert.equal(result.content, 'ok');
  assert.deepEqual(tried, [
    { host: DAILY_HOST, auth: 'Bearer stale-token' },
    { host: DAILY_HOST, auth: 'Bearer fresh-token' },
  ]);
  assert.deepEqual(auths, [false, true]);
});

test('caller cancellation does not switch hosts', async () => {
  const ac = new AbortController();
  const tried = [];
  const provider = providerWith(async (url, init) => {
    tried.push(new URL(url).host);
    ac.abort(Object.assign(new Error('stop'), { name: 'AbortError' }));
    await new Promise((_, reject) => {
      const fail = () => reject(init.signal.reason instanceof Error ? init.signal.reason : new Error('stop'));
      if (init.signal.aborted) {
        fail();
        return;
      }
      init.signal.addEventListener('abort', fail, { once: true });
    });
  });
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [], { signal: ac.signal }),
    (error) => error.message === 'stop'
  );
  assert.deepEqual(tried, [DAILY_HOST]);
});

test('the hub identity tracks the version from the update manifest', async (t) => {
  t.after(() => _resetAntigravityVersionForTest());
  _resetAntigravityVersionForTest();
  let manifestFetches = 0;
  const seenAgents = [];
  const provider = new AntigravityOAuthProvider({
    preconnectFn: () => {},
    ensureAuthFn: async () => ({ accessToken: 'access-token', projectId: 'test-project' }),
    fetchFn: async (url, init) => {
      if (/manifest\/latest-arm64-mac\.yml$/.test(String(url))) {
        manifestFetches += 1;
        return new Response('version: 2.13.0\nfiles:\n  - url: https://example.test/Antigravity.zip\n');
      }
      seenAgents.push(init.headers['User-Agent']);
      return sseResponse([candidateChunk([{ text: 'ok' }], 'STOP')]);
    },
  });
  await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-flash', [], {});
  await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-flash', [], {});
  assert.equal(manifestFetches, 1, 'the manifest is read once per process');
  assert.deepEqual(
    seenAgents,
    Array(2).fill('antigravity/hub/2.13.0 (aidev_client; os_type=darwin; arch=arm64; cl=963137146)')
  );
  assert.equal(parseAntigravityManifestVersion('version: "3.0.1"'), '3.0.1');
  assert.equal(parseAntigravityManifestVersion('version: latest'), null);
});

test('a retired wire id surfaces the gateway notice instead of a truncated-stream retry', async () => {
  let calls = 0;
  const provider = providerWith(async () => {
    calls += 1;
    return sseResponse([
      candidateChunk([{ text: 'Gemini 3.5 Flash is no longer available. Please switch to Gemini 3.7 Flash.' }]),
    ]);
  });
  await assert.rejects(
    provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-flash-agent', [], { onTextDelta: () => {} }),
    (error) => {
      assert.equal(error.code, 'MODEL_RETIRED');
      assert.match(error.message, /retired gemini-3-flash-agent: Gemini 3\.5 Flash is no longer available/);
      return true;
    }
  );
  assert.equal(calls, 1, 'a retirement notice is neither retried nor failed over');
});

test('a replay minted by the other model family is rebuilt with the recovery sentinel', async () => {
  const signedParts = [
    { thought: true, text: 'Thinking.', thoughtSignature: 'claude-signature' },
    { text: 'Answer.', thoughtSignature: 'claude-text-signature' },
  ];
  const bodies = [];
  const provider = providerWith(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return sseResponse([candidateChunk(bodies.length === 1 ? signedParts : [{ text: 'done' }], 'STOP')]);
  });
  const first = await provider.send([{ role: 'user', content: 'Hello.' }], 'claude-sonnet-4-6', [], {});
  assert.deepEqual(first.providerReplay.requestContext, { model: 'claude-sonnet-4-6' });
  const history = [
    { role: 'user', content: 'Hello.' },
    { role: 'assistant', content: first.content, providerReplay: first.providerReplay },
    { role: 'user', content: 'Continue.' },
  ];
  await provider.send(history, 'claude-sonnet-4-6', [], {});
  assert.deepEqual(bodies[1].request.contents[1].parts, signedParts, 'same family replays verbatim');
  await provider.send(history, 'gemini-3-flash', [], {});
  const rebuilt = bodies[2].request.contents[1].parts;
  assert.ok(
    !rebuilt.some(
      (part) => part.thoughtSignature === 'claude-signature' || part.thoughtSignature === 'claude-text-signature'
    ),
    'foreign signatures never reach the other family'
  );
});

const STREAM_PARITY_TOOLS = [
  {
    name: 'read',
    description: 'Read a file',
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
];

test('version, authentication and request preparation overlap and bind the refreshed project', async () => {
  const versionGate = Promise.withResolvers();
  const authGate = Promise.withResolvers();
  const started = [];
  let posted;
  const provider = providerWith(
    async (_url, init) => {
      posted = JSON.parse(init.body);
      return sseResponse([candidateChunk([{ text: 'OK' }], 'STOP')]);
    },
    {
      ensureVersionFn: async () => {
        started.push('version');
        await versionGate.promise;
      },
      ensureAuthFn: async () => {
        started.push('auth');
        await authGate.promise;
        return { accessToken: 'fresh-token', projectId: 'fresh-project' };
      },
    }
  );
  provider._projectId = 'stale-project';
  const buildBody = provider._buildBody.bind(provider);
  provider._buildBody = (...args) => {
    started.push('body');
    return buildBody(...args);
  };
  const pending = provider.send([{ role: 'user', content: 'Hello.' }], 'gemini-3.8-flash', [], { effort: 'low' });
  await nextTick();
  const beforeRelease = [...started];
  const postedBeforeRelease = posted;
  versionGate.resolve();
  authGate.resolve();
  await pending;
  assert.deepEqual(beforeRelease, ['version', 'auth', 'body']);
  assert.equal(postedBeforeRelease, undefined);
  assert.equal(posted.project, 'fresh-project');
  assert.equal(posted.model, 'gemini-3.8-flash-low');
});

test('each send rewarms the daily host', async () => {
  const warmed = [];
  const requested = [];
  const provider = providerWith(
    async (url) => {
      requested.push(new URL(url).origin);
      return sseResponse([candidateChunk([{ text: 'OK' }], 'STOP')]);
    },
    { preconnectFn: (endpoint) => warmed.push(endpoint) }
  );
  const messages = [{ role: 'user', content: 'Hello.' }];
  await provider.send(messages, 'gemini-3.8-flash', [], { effort: 'low' });
  await provider.send(messages, 'gemini-3.8-flash', [], { effort: 'low' });
  assert.deepEqual(warmed, [CONTENT_ENDPOINT, CONTENT_ENDPOINT, CONTENT_ENDPOINT]);
  assert.deepEqual(requested, [CONTENT_ENDPOINT, CONTENT_ENDPOINT]);
});

test('native calls dispatch before EOF with stable IDs, signatures and no final redispatch', async () => {
  const firstProgress = Promise.withResolvers();
  const secondProgress = Promise.withResolvers();
  const encoder = new TextEncoder();
  let controller;
  let toolProgress = 0;
  const body = new ReadableStream({
    start(value) {
      controller = value;
    },
  });
  const push = (parts, finish) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(candidateChunk(parts, finish))}\n\n`));
  const calls = [];
  const parts = [
    { functionCall: { name: 'read', args: { path: 'a.txt' } }, thoughtSignature: 'first-signature' },
    { functionCall: { name: 'read', args: { path: 'b.txt' } }, thoughtSignature: 'second-signature' },
  ];
  const provider = providerWith(async () => new Response(body));
  const pending = provider.send([{ role: 'user', content: 'Read both.' }], 'gemini-3.8-flash', STREAM_PARITY_TOOLS, {
    effort: 'low',
    onToolCall: (call) => calls.push(call),
    onStreamDelta: (kind) => {
      if (kind !== 'tool') return;
      toolProgress++;
      if (toolProgress === 1) firstProgress.resolve();
      if (toolProgress === 2) secondProgress.resolve();
    },
  });
  push([parts[0]]);
  await firstProgress.promise;
  await nextTick();
  const afterFirstChunk = calls.length;
  push([parts[1]]);
  await secondProgress.promise;
  await nextTick();
  const beforeEof = calls.length;
  push([], 'STOP');
  controller.close();
  const result = await pending;
  assert.equal(afterFirstChunk, 1);
  assert.equal(beforeEof, 2);
  assert.equal(calls.length, 2);
  assert.deepEqual(result.toolCalls, calls);
  assert.notEqual(calls[0].id, calls[1].id);
  assert.deepEqual(
    calls.map((call) => call.thoughtSignature),
    ['first-signature', 'second-signature']
  );
  assert.deepEqual(result.providerReplay.items, parts);
});

test('a native call in an unterminated SSE tail is delivered exactly once', async () => {
  const part = { functionCall: { id: 'tail-call', name: 'read', args: { path: 'a.txt' } } };
  const provider = providerWith(async () => new Response(`data: ${JSON.stringify(candidateChunk([part], 'STOP'))}`));
  const calls = [];
  const result = await provider.send([{ role: 'user', content: 'Read.' }], 'gemini-3.8-flash', STREAM_PARITY_TOOLS, {
    effort: 'low',
    onToolCall: (call) => calls.push(call),
  });
  assert.deepEqual(result.toolCalls, calls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'tail-call');
});

for (const nativeFirst of [false, true]) {
  test(`native and text-recovered duplicates execute once (native first: ${nativeFirst})`, async () => {
    const native = { functionCall: { id: 'native-call', name: 'read', args: { path: 'a.txt' } } };
    const leaked = { text: '<invoke name="read"><parameter name="path">a.txt</parameter></invoke>' };
    const ordered = nativeFirst ? [native, leaked] : [leaked, native];
    const provider = providerWith(async () =>
      sseResponse([candidateChunk([ordered[0]]), candidateChunk([ordered[1]]), candidateChunk([], 'STOP')])
    );
    const calls = [];
    const result = await provider.send([{ role: 'user', content: 'Read.' }], 'gemini-3.8-flash', STREAM_PARITY_TOOLS, {
      effort: 'low',
      onToolCall: (call) => calls.push(call),
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(result.toolCalls, calls);
    assert.equal(result.content, '');
    assert.equal(result.providerReplay, undefined);
  });
}

for (const finishReason of ['SAFETY', 'MAX_TOKENS', 'MALFORMED_FUNCTION_CALL', 'FINISH_REASON_SAFETY']) {
  test(`${finishReason} blocks native and text-recovered calls in that same chunk`, async () => {
    let requests = 0;
    const provider = providerWith(async () => {
      requests++;
      return sseResponse([
        candidateChunk(
          [
            { functionCall: { id: 'blocked', name: 'read', args: { path: 'native.txt' } } },
            { text: '<invoke name="read"><parameter name="path">leaked.txt</parameter></invoke>' },
          ],
          finishReason
        ),
      ]);
    });
    const calls = [];
    await assert.rejects(
      provider.send([{ role: 'user', content: 'Read.' }], 'gemini-3.8-flash', STREAM_PARITY_TOOLS, {
        effort: 'low',
        onToolCall: (call) => calls.push(call),
      }),
      (error) => {
        assert.equal(error.code, 'PROVIDER_INCOMPLETE');
        assert.equal(error.finishReason, finishReason);
        return true;
      }
    );
    assert.equal(calls.length, 0);
    assert.equal(requests, 1);
  });
}

test('prompt blocking suppresses calls even without a candidate finish reason', async () => {
  const chunk = candidateChunk([{ functionCall: { id: 'blocked', name: 'read', args: { path: 'a.txt' } } }]);
  chunk.response.promptFeedback = { blockReason: 'SAFETY' };
  const provider = providerWith(async () => sseResponse([chunk]));
  const calls = [];
  await assert.rejects(
    provider.send([{ role: 'user', content: 'Read.' }], 'gemini-3.8-flash', STREAM_PARITY_TOOLS, {
      effort: 'low',
      onToolCall: (call) => calls.push(call),
    }),
    (error) => error.code === 'PROVIDER_INCOMPLETE' && error.finishReason === 'PROMPT_SAFETY'
  );
  assert.equal(calls.length, 0);
});

test('a later failed finish retains earlier eager calls without dispatching the rejected call', async () => {
  const provider = providerWith(async () =>
    sseResponse([
      candidateChunk([{ functionCall: { id: 'accepted', name: 'read', args: { path: 'a.txt' } } }]),
      candidateChunk([{ functionCall: { id: 'blocked', name: 'read', args: { path: 'b.txt' } } }], 'SAFETY'),
    ])
  );
  const calls = [];
  await assert.rejects(
    provider.send([{ role: 'user', content: 'Read.' }], 'gemini-3.8-flash', STREAM_PARITY_TOOLS, {
      effort: 'low',
      onToolCall: (call) => calls.push(call),
    }),
    (error) => {
      assert.equal(error.code, 'PROVIDER_INCOMPLETE');
      assert.equal(error.emittedToolCall, true);
      assert.equal(error.unsafeToRetry, true);
      assert.deepEqual(error.partialToolCalls, calls);
      return true;
    }
  );
  assert.deepEqual(
    calls.map((call) => call.id),
    ['accepted']
  );
});

test('truncation after an eager native call cannot retry or fail over and retains signed replay', async () => {
  const part = {
    functionCall: { id: 'already-ran', name: 'read', args: { path: 'a.txt' } },
    thoughtSignature: 'signed-call',
  };
  let requests = 0;
  const provider = providerWith(async () => {
    requests++;
    return sseResponse([candidateChunk([part])]);
  });
  const calls = [];
  await assert.rejects(
    provider.send([{ role: 'user', content: 'Read.' }], 'gemini-3.8-flash', STREAM_PARITY_TOOLS, {
      effort: 'low',
      onToolCall: (call) => calls.push(call),
    }),
    (error) => {
      assert.equal(error.code, 'TRUNCATED_STREAM');
      assert.equal(error.emittedToolCall, true);
      assert.equal(error.unsafeToRetry, true);
      assert.deepEqual(error.partialToolCalls, calls);
      assert.deepEqual(error.partialProviderReplay.items, [part]);
      assert.deepEqual(error.partialProviderReplay.requestContext, { model: 'gemini-3.8-flash-low' });
      return true;
    }
  );
  assert.equal(calls.length, 1);
  assert.equal(requests, 1);
});
