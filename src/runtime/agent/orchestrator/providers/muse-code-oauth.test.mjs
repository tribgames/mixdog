import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { mock } from 'node:test';

// Each credential write on Windows spawns icacls/PowerShell to lock the file to
// its owner (0.1-0.4 s). ACL enforcement has its own suites
// (shared/file-permissions.test.mjs, atomic-file.test.mjs).
mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const dir = mkdtempSync(join(tmpdir(), 'mixdog-muse-code-provider-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MUSE_CODE_OAUTH_CREDENTIALS_PATH = join(dir, 'muse-code-oauth.json');

const { MuseCodeOAuthProvider, quotaWindowsFromSubsUsage } = await import('./muse-code-oauth.mjs');
const tokens = await import('./muse-code-oauth-tokens.mjs');
const { oauthCredentialProbeState } = await import('./oauth-credential-probes.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

test('credential probe tracks the stored key', () => {
  assert.equal(oauthCredentialProbeState('muse-code-oauth'), 'absent');
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: 'u@x.y' });
  assert.equal(oauthCredentialProbeState('muse-code-oauth'), 'present');
});

test('sending uses the minted key on the Responses wire and drops tool_choice', async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  const inner = provider._ensureInner('k');
  assert.equal(inner.apiKey, 'k');
  assert.equal(inner.baseURL, 'https://api.meta.ai/v1');
  assert.equal(inner.defaultHeaders['x-api-version'], '1.0.0');
  let seen;
  inner._doSend = async (_m, model, _t, opts) => {
    seen = { model, opts };
    return { content: 'ok' };
  };
  await provider.send([], undefined, [], { toolChoice: 'none', effort: 'high' });
  assert.equal(seen.model, 'muse-spark-1.3');
  assert.equal(seen.opts.compatWireApi, 'responses');
  assert.equal('toolChoice' in seen.opts, false);
  assert.equal(seen.opts.effort, 'high');
});

test('the real Responses request builder sends reasoning.effort and the key header config', async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  const inner = provider._ensureInner('k');
  let params;
  inner.client = {
    responses: {
      create: async (p) => {
        params = p;
        throw Object.assign(new Error('stop after capture'), { status: 400 });
      },
    },
  };
  await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'muse-spark-1.3', [], { effort: 'high' }));
  assert.deepEqual(params.reasoning, { effort: 'high', summary: 'auto' });
});

// Drive the real Responses request builder and capture the wire payload + request options.
async function capture(messages, model, tools, opts = {}, setup) {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  const inner = provider._ensureInner('k');
  setup?.(inner);
  let seen;
  inner.client.responses = {
    create: async (params, reqOptions) => {
      seen = { params, reqOptions };
      throw Object.assign(new Error('stop after capture'), { status: 400 });
    },
  };
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  await assert.rejects(provider.send(messages, model, tools, opts));
  return seen;
}
const hi = [{ role: 'user', content: 'hi' }];

test('max_output_tokens is clamped to the model maximum', async () => {
  let { params } = await capture(hi, 'muse-spark-1.3', [], { maxOutputTokens: 999_999 });
  assert.equal(params.max_output_tokens, 131072);
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { maxOutputTokens: 100 }));
  assert.equal(params.max_output_tokens, 100);
  ({ params } = await capture(hi, 'muse-x', [], { maxOutputTokens: 5000 }, (inner) => {
    inner._enrichedModels = [{ id: 'muse-x', outputTokens: 1000 }];
  }));
  assert.equal(params.max_output_tokens, 1000);
});

test('the effort ladder is per model, sends max where supported, and respects discovered metadata', async () => {
  let { params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'max' });
  assert.equal(params.reasoning.effort, 'max');
  ({ params } = await capture(hi, 'muse-spark-1.3-contributor', [], { effort: 'max' }));
  assert.equal(params.reasoning.effort, 'max');
  ({ params } = await capture(hi, 'muse-spark-1.2', [], { effort: 'max' }));
  assert.equal(params.reasoning.effort, 'xhigh');
  ({ params } = await capture(hi, 'muse-spark-1.1', [], { effort: 'minimal' }));
  assert.equal(params.reasoning.effort, 'minimal');
  const discovered = (inner) => {
    inner._enrichedModels = [{ id: 'muse-new', reasoningOptions: [{ type: 'effort', values: ['low', 'high'] }] }];
  };
  ({ params } = await capture(hi, 'muse-new', [], { effort: 'medium' }, discovered));
  assert.equal('reasoning' in params, false);
  ({ params } = await capture(hi, 'muse-new', [], { effort: 'high' }, discovered));
  assert.equal(params.reasoning.effort, 'high');
});

test('reasoning carries summary auto, supports explicit off, and is absent without a request', async () => {
  let { params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'low' });
  assert.deepEqual(params.reasoning, { effort: 'low', summary: 'auto' });
  assert.ok(params.include.includes('reasoning.encrypted_content'));
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'none' }));
  assert.deepEqual(params.reasoning, { effort: 'none' });
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { forceReasoningOff: true }));
  assert.deepEqual(params.reasoning, { effort: 'none' });
  assert.equal('include' in params, false);
  // Disabling without an effort selects the lowest supported level, not `none`.
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { disableReasoning: true }));
  assert.deepEqual(params.reasoning, { effort: 'minimal' });
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'high', disableReasoning: true }));
  assert.equal('reasoning' in params, false);
  ({ params } = await capture(hi, 'muse-spark-1.3', [], {}));
  assert.equal('reasoning' in params, false);
});

test('configured reasoningEffort applies when no per-call effort is given', async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false, reasoningEffort: 'xhigh' });
  const inner = provider._ensureInner('k');
  let seen;
  inner.client.responses = {
    create: async (params) => {
      seen = params;
      throw Object.assign(new Error('stop'), { status: 400 });
    },
  };
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  await assert.rejects(provider.send(hi, 'muse-spark-1.3', [], {}));
  assert.deepEqual(seen.reasoning, { effort: 'xhigh', summary: 'auto' });
  await assert.rejects(provider.send(hi, 'muse-spark-1.3', [], { effort: 'low' }));
  assert.equal(seen.reasoning.effort, 'low');
});

test('reasoningSummary overrides: null omits, detailed/concise pass through', async () => {
  let { params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'high', reasoningSummary: null });
  assert.deepEqual(params.reasoning, { effort: 'high' });
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'high', reasoningSummary: 'detailed' }));
  assert.equal(params.reasoning.summary, 'detailed');
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'high', reasoningSummary: 'concise' }));
  assert.equal(params.reasoning.summary, 'concise');
});

test('encrypted-reasoning include follows model support and the explicit override', async () => {
  let { params } = await capture(hi, 'muse-spark-1.3', [], { effort: 'high' });
  assert.deepEqual(params.include, ['reasoning.encrypted_content']);
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { includeEncryptedReasoning: false }));
  assert.equal('include' in params, false);
  ({ params } = await capture(hi, 'muse-nr', [], {}, (inner) => {
    inner._enrichedModels = [{ id: 'muse-nr', supportsReasoning: false }];
  }));
  assert.equal('include' in params, false);
});

test('a summary request without an effort sends reasoning at medium', async () => {
  let { params } = await capture(hi, 'muse-spark-1.3', [], { reasoningSummary: 'concise' });
  assert.deepEqual(params.reasoning, { effort: 'medium', summary: 'concise' });
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { reasoningSummary: null }));
  assert.deepEqual(params.reasoning, { effort: 'medium' });
});

test('caller include entries survive, deduped, alongside encrypted reasoning', async () => {
  const include = ['message.output_text.logprobs', 'message.output_text.logprobs', 'reasoning.encrypted_content'];
  let { params } = await capture(hi, 'muse-spark-1.3', [], { include });
  assert.deepEqual(params.include, ['message.output_text.logprobs', 'reasoning.encrypted_content']);
  assert.equal(include.length, 3);
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { include: ['message.output_text.logprobs'], forceReasoningOff: true }));
  assert.deepEqual(params.include, ['message.output_text.logprobs']);
});

test('extraBody overrides win last, including over system-message instructions', async () => {
  const sys = [{ role: 'system', content: 'from system' }, { role: 'user', content: 'hi' }];
  let { params } = await capture(sys, 'muse-spark-1.3', [], { extraBody: { instructions: 'from extra' } });
  assert.equal(params.instructions, 'from extra');
  ({ params } = await capture(sys, 'muse-spark-1.3', [], {}));
  assert.equal(params.instructions, 'from system');
});

test('long prompt-cache keys become a bounded hash identity, never a truncation', async () => {
  const long = 'x'.repeat(200);
  let { params } = await capture(hi, 'muse-spark-1.3', [], { sessionId: long });
  assert.match(params.prompt_cache_key, /^pc_[0-9a-f]{32}$/);
  assert.ok(params.prompt_cache_key.length <= 64);
  const first = params.prompt_cache_key;
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { sessionId: long + 'y' }));
  assert.notEqual(params.prompt_cache_key, first);
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { sessionId: 'y'.repeat(64) }));
  assert.equal(params.prompt_cache_key, 'y'.repeat(64));
});

test('penalties and extra body fields are forwarded', async () => {
  const { params } = await capture(hi, 'muse-spark-1.3', [], {
    presencePenalty: 0.3,
    repetitionPenalty: 1.1,
    extraBody: { metadata: { a: 1 }, service_tier: 'priority' },
  });
  assert.equal(params.presence_penalty, 0.3);
  assert.equal(params.repetition_penalty, 1.1);
  assert.deepEqual(params.metadata, { a: 1 });
  assert.equal(params.service_tier, 'priority');
});

test('unknown revisioned Spark ids inherit the newest lineage; discovery names are kept', async () => {
  let { params } = await capture(hi, 'muse-spark-1.4', [], { effort: 'max', maxOutputTokens: 999_999 });
  assert.equal(params.max_output_tokens, 131072);
  assert.equal(params.reasoning.effort, 'xhigh');
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  const inner = provider._ensureInner('k');
  inner._fetchModelItems = async () => [
    { id: 'muse-spark-1.4' },
    { id: 'muse-spark-1.4-contributor' },
    { id: 'muse-spark-1.3', name: 'Custom Spark' },
  ];
  const rows = Object.fromEntries((await provider.listModels()).map((m) => [m.id, m]));
  assert.equal(rows['muse-spark-1.4'].name, 'Muse Spark 1.4');
  assert.equal(rows['muse-spark-1.4'].contextWindow, 1_048_576);
  assert.equal(rows['muse-spark-1.4'].supportsVision, true);
  assert.equal(rows['muse-spark-1.4'].inputCostPerM, 1.25);
  assert.deepEqual(rows['muse-spark-1.4'].reasoningOptions[0].values, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(rows['muse-spark-1.4-contributor'].name, 'Muse Spark 1.4 (C)');
  assert.equal(rows['muse-spark-1.4-contributor'].inputCostPerM, 0.1);
  assert.equal(rows['muse-spark-1.3'].name, 'Custom Spark');
  assert.equal(provider.getCachedModelInfo('muse-spark-1.5').outputTokens, 131072);
  assert.equal(provider.getCachedModelInfo('other-model'), null);
});

test('system prompts travel as top-level instructions, not input items', async () => {
  const { params } = await capture(
    [
      { role: 'system', content: 'be brief' },
      { role: 'system', content: 'be kind' },
      { role: 'user', content: 'hi' },
    ],
    'muse-spark-1.3',
    []
  );
  assert.equal(params.instructions, 'be brief\n\nbe kind');
  assert.equal(
    params.input.some((item) => item.role === 'system' || item.role === 'developer'),
    false
  );
});

test('sampling and prompt-cache controls are emitted; parallel_tool_calls is not', async () => {
  const tools = [{ name: 'lookup', description: 'd', inputSchema: { type: 'object', properties: {} } }];
  let { params } = await capture(hi, 'muse-spark-1.3', tools, {
    temperature: 0.4,
    topP: 0.9,
    topK: 20,
    minP: 0.05,
    sessionId: 'sess-1',
  });
  assert.equal(params.temperature, 0.4);
  assert.equal(params.top_p, 0.9);
  assert.equal(params.top_k, 20);
  assert.equal(params.min_p, 0.05);
  assert.equal(params.prompt_cache_key, 'sess-1');
  assert.ok(params.tools?.length);
  assert.equal('parallel_tool_calls' in params, false);
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { sessionId: 'sess-1', cacheRetention: 'none' }));
  assert.equal('prompt_cache_key' in params, false);
  assert.equal('temperature' in params, false);
  ({ params } = await capture(hi, 'muse-spark-1.3', [], { promptCacheKey: 'explicit', sessionId: 'sess-1' }));
  assert.equal(params.prompt_cache_key, 'explicit');
});

test('streaming asks for event-stream, discovery for json, and the SDK ignores org/project env', async () => {
  const prevOrg = process.env.OPENAI_ORG_ID;
  const prevProject = process.env.OPENAI_PROJECT_ID;
  process.env.OPENAI_ORG_ID = 'org-env';
  process.env.OPENAI_PROJECT_ID = 'proj-env';
  try {
    const provider = new MuseCodeOAuthProvider({ preconnect: false });
    const inner = provider._ensureInner('k');
    assert.equal(inner.client.organization, null);
    assert.equal(inner.client.project, null);
    assert.equal(inner.defaultHeaders.Accept, 'application/json');
    const { reqOptions } = await capture(hi, 'muse-spark-1.3', []);
    assert.equal(reqOptions.headers.Accept, 'text/event-stream');
  } finally {
    if (prevOrg === undefined) delete process.env.OPENAI_ORG_ID;
    else process.env.OPENAI_ORG_ID = prevOrg;
    if (prevProject === undefined) delete process.env.OPENAI_PROJECT_ID;
    else process.env.OPENAI_PROJECT_ID = prevProject;
  }
});

test('a discovery request sends Accept: application/json and the version header', async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), headers: init.headers };
    return new Response(JSON.stringify({ data: [{ id: 'muse-spark-1.3' }] }), { status: 200 });
  };
  try {
    await provider.listModels();
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.equal(seen.url, 'https://api.meta.ai/v1/models');
  assert.equal(seen.headers.Accept, 'application/json');
  assert.equal(seen.headers['x-api-version'], '1.0.0');
  assert.equal(seen.headers.Authorization, 'Bearer k');
});

test('surfaced errors redact the known api key and account token values', async () => {
  const { scrubMuseSecrets, requestMuseCodeKey } = tokens;
  assert.equal(scrubMuseSecrets('Invalid token: acct-secret-1', ['acct-secret-1']), 'Invalid token: [REDACTED]');
  await assert.rejects(
    requestMuseCodeKey('acct-secret-1', {
      fetchFn: async () => ({ ok: false, status: 400, text: async () => 'Invalid token: acct-secret-1' }),
    }),
    (err) => !err.message.includes('acct-secret-1') && err.message.includes('[REDACTED]')
  );
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  provider._ensureInner('sk-secret-key')._doSend = async () => {
    throw new Error('bad key sk-secret-key');
  };
  tokens.saveTokens({ accessToken: 'a', apiKey: 'sk-secret-key', accountId: 'u', email: '' });
  await assert.rejects(provider.send([], 'muse-spark-1.3', [], {}), (err) => !err.message.includes('sk-secret-key'));
});

// The Responses path retries a transient failure with the real backoff
// schedule (250 ms .. 8 s, ~15 s per send). These tests assert what the retries
// log and surface, not how long they wait, so backoff-sized timers (0.2-20 s;
// the 60 s first-byte timeout stays real) fire immediately.
async function withFastBackoff(run) {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) =>
    realSetTimeout(fn, ms >= 200 && ms < 20_000 ? 1 : ms, ...rest);
  try {
    return await run();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
}

test('retry logging on the real Responses path never writes the api key to stderr', () => withFastBackoff(async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  const inner = provider._ensureInner('sk-retry-secret');
  tokens.saveTokens({ accessToken: 'a', apiKey: 'sk-retry-secret', accountId: 'u', email: '' });
  let calls = 0;
  inner.client = {
    responses: {
      create: async () => {
        calls += 1;
        throw Object.assign(new Error('503 upstream rejected sk-retry-secret'), { status: 503 });
      },
    },
  };
  const written = [];
  const realWrite = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return true;
  };
  try {
    await assert.rejects(provider.send([{ role: 'user', content: 'hi' }], 'muse-spark-1.3', [], {}));
  } finally {
    process.stderr.write = realWrite;
  }
  assert.ok(calls > 1, 'the retry path ran');
  assert.ok(written.some((line) => line.includes('retry attempt')));
  assert.equal(written.join('').includes('sk-retry-secret'), false);
}));

test('response.failed stream events from a real SSE server never leak the key via retry logging', () => withFastBackoff(async () => {
  const { createServer } = await import('node:http');
  const { default: OpenAI } = await import('openai');
  const key = 'sk-sse-secret-key';
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = {
      type: 'response.failed',
      response: { id: 'r', status: 'failed', error: { code: 'server_error', message: `upstream rejected ${key}` } },
    };
    res.end(`event: response.failed\ndata: ${JSON.stringify(event)}\n\n`);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const provider = new MuseCodeOAuthProvider({ preconnect: false });
    const inner = provider._ensureInner(key);
    tokens.saveTokens({ accessToken: 'a', apiKey: key, accountId: 'u', email: '' });
    inner.client = new OpenAI({
      apiKey: key,
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      organization: null,
      project: null,
      maxRetries: 0,
    });
    const written = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    let failure;
    try {
      await provider.send([{ role: 'user', content: 'hi' }], 'muse-spark-1.3', [], {}).catch((e) => {
        failure = e;
      });
    } finally {
      process.stderr.write = realWrite;
    }
    assert.ok(failure, 'the failed event surfaced as an error');
    assert.ok(hits >= 1);
    assert.equal(String(failure.message).includes(key), false);
    assert.equal(written.join('').includes(key), false);
  } finally {
    await new Promise((r) => server.close(r));
  }
}));

async function leakCheck(key, handler) {
  const { createServer } = await import('node:http');
  const { default: OpenAI } = await import('openai');
  const server = createServer((req, res) => {
    req.resume();
    handler(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const provider = new MuseCodeOAuthProvider({ preconnect: false });
    const inner = provider._ensureInner(key);
    tokens.saveTokens({ accessToken: 'a', apiKey: key, accountId: 'u', email: '' });
    inner.client = new OpenAI({
      apiKey: key,
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      organization: null,
      project: null,
      maxRetries: 0,
    });
    const written = [];
    const realWrite = process.stderr.write;
    process.stderr.write = (chunk) => {
      written.push(String(chunk));
      return true;
    };
    let failure;
    try {
      await provider.send([{ role: 'user', content: 'hi' }], 'muse-spark-1.3', [], {}).catch((e) => {
        failure = e;
      });
    } finally {
      process.stderr.write = realWrite;
    }
    assert.ok(failure, 'the failure surfaced as an error');
    assert.equal(JSON.stringify({ ...failure, message: failure.message }).includes(key), false);
    assert.equal(written.join('').includes(key), false);
    return { failure, written };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test('response.done failed events never leak the key via retry logging', () => withFastBackoff(async () => {
  const key = 'sk-done-secret-key';
  await leakCheck(key, (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const event = {
      type: 'response.done',
      response: { id: 'r', status: 'failed', error: { code: 'x', message: `upstream rejected ${key}` } },
    };
    res.end(`event: response.done\ndata: ${JSON.stringify(event)}\n\n`);
  });
}));

test('normal stream output and tool arguments pass through unchanged over a real SSE server', async () => {
  const { createServer } = await import('node:http');
  const { default: OpenAI } = await import('openai');
  const key = 'sk-passthrough-key';
  const args = JSON.stringify({ key: 'Enter', code: 'console.log(42)' });
  const text = 'password: hunter2 token=abc';
  const send = (res, type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const item = { type: 'function_call', id: 'fc1', call_id: 'call1', name: 'press', arguments: args, status: 'completed' };
  const message = { type: 'message', id: 'm1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] };
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    send(res, 'response.output_item.done', { output_index: 0, item: message });
    send(res, 'response.output_item.done', { output_index: 1, item });
    send(res, 'response.completed', {
      response: {
        id: 'r',
        status: 'completed',
        output: [message, item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const provider = new MuseCodeOAuthProvider({ preconnect: false });
    const inner = provider._ensureInner(key);
    tokens.saveTokens({ accessToken: 'acct-token-long-value', apiKey: key, accountId: 'u', email: '' });
    inner.client = new OpenAI({
      apiKey: key,
      baseURL: `http://127.0.0.1:${server.address().port}/v1`,
      organization: null,
      project: null,
      maxRetries: 0,
    });
    const result = await provider.send(
      [{ role: 'user', content: 'hi' }],
      'muse-spark-1.3',
      [{ name: 'press', description: 'd', inputSchema: { type: 'object', properties: {} } }],
      {}
    );
    assert.equal(result.toolCalls?.[0]?.arguments?.key, 'Enter');
    assert.equal(result.toolCalls?.[0]?.arguments?.code, 'console.log(42)');
    assert.equal(result.content, text);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('a real HTTP 400 echoing the key is scrubbed from structured error fields too', async () => {
  const key = 'sk-http400-secret-key';
  const { failure } = await leakCheck(key, (res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `bad request for ${key}`, type: 'invalid_request_error' } }));
  });
  assert.equal(failure.status, 400);
});

test('a credential file deleted before the first ensureAuth is signed out', async () => {
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k-del', accountId: 'u', email: '' });
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  assert.equal(provider.tokens.apiKey, 'k-del');
  tokens.forgetMuseCodeOAuthCredentials();
  await assert.rejects(provider.ensureAuth(), /credentials not found/);
  assert.equal(provider.tokens, null);
});

test('credential probe uses the loader rule: an api-key-only file is signed out', async () => {
  const { writeFileSync } = await import('node:fs');
  const path = process.env.MUSE_CODE_OAUTH_CREDENTIALS_PATH;
  writeFileSync(path, JSON.stringify({ apiKey: 'only-key', accountId: 'u' }));
  assert.equal(tokens.loadTokens(), null);
  assert.equal(oauthCredentialProbeState('muse-code-oauth'), 'absent');
  writeFileSync(path, JSON.stringify({ accessToken: 'a', apiKey: 'k', accountId: 'u' }));
  assert.equal(oauthCredentialProbeState('muse-code-oauth'), 'present');
});

test('a 401 from the Model API asks for a new login and keeps the scrubbed detail', async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  tokens.saveTokens({ accessToken: 'a', apiKey: 'sk-401-key', accountId: 'u', email: '' });
  provider._ensureInner('sk-401-key')._doSend = async () => {
    throw Object.assign(new Error('unauthorized: key sk-401-key expired'), { status: 401 });
  };
  await assert.rejects(
    provider.send([], 'muse-spark-1.3', [], {}),
    (err) =>
      err.reauthRequired === true &&
      /sign in again/.test(err.message) &&
      /unauthorized: key \[REDACTED\] expired/.test(err.message) &&
      !err.message.includes('sk-401-key')
  );
});

test('model listing drops image/voice ids; failure uses seeds; an empty roster is authoritative', async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  const inner = provider._ensureInner('k');
  inner._fetchModelItems = async () => [{ id: 'muse-spark-1.3' }, { id: 'muse-image-1' }, { id: 'muse-voice-1' }];
  assert.deepEqual(
    (await provider.listModels()).map((m) => m.id),
    ['muse-spark-1.3']
  );
  inner._fetchModelItems = async () => [{ id: 'muse-image-1' }];
  assert.deepEqual(await provider.listModels(), []);
  inner._fetchModelItems = async () => [];
  assert.deepEqual(await provider.listModels(), []);
  inner._fetchModelItems = async () => {
    throw new Error('models 503');
  };
  const seeded = await provider.listModels();
  assert.deepEqual(
    seeded.map((m) => m.id),
    [
      'muse-spark-1.1',
      'muse-spark-1.2',
      'muse-spark-1.2-contributor',
      'muse-spark-1.3',
      'muse-spark-1.3-contributor',
    ]
  );
  const byId = Object.fromEntries(seeded.map((m) => [m.id, m]));
  assert.equal(byId['muse-spark-1.3'].contextWindow, 1_048_576);
  assert.equal(byId['muse-spark-1.3'].outputTokens, 131_072);
  assert.deepEqual(byId['muse-spark-1.3'].reasoningOptions[0].values, ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(byId['muse-spark-1.2'].reasoningOptions[0].values, ['minimal', 'low', 'medium', 'high', 'xhigh']);
  assert.equal(byId['muse-spark-1.3-contributor'].reasoningOptions[0].values.includes('max'), true);
  assert.equal(byId['muse-spark-1.2-contributor'].inputCostPerM, 0.1);
  assert.equal(byId['muse-spark-1.1'].supportsVision, true);
});

test('seed contributor names survive discovery plain names; real renames still win', async () => {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  tokens.saveTokens({ accessToken: 'a', apiKey: 'k', accountId: 'u', email: '' });
  const inner = provider._ensureInner('k');
  inner._fetchModelItems = async () => [
    { id: 'muse-spark-1.3-contributor', name: 'Muse Spark 1.3' },
    { id: 'muse-spark-1.2-contributor', name: 'Muse Spark 1.2' },
    { id: 'muse-spark-1.3', name: 'Custom Spark' },
  ];
  const rows = Object.fromEntries((await provider.listModels()).map((m) => [m.id, m]));
  assert.equal(rows['muse-spark-1.3-contributor'].name, 'Muse Spark 1.3 (C)');
  assert.equal(rows['muse-spark-1.2-contributor'].name, 'Muse Spark 1.2 (C)');
  assert.equal(rows['muse-spark-1.3'].name, 'Custom Spark');
});

async function usageProvider(handler) {
  const provider = new MuseCodeOAuthProvider({ preconnect: false });
  tokens.saveTokens({ accessToken: 'acct', apiKey: 'k', accountId: 'u-1', email: 'me@x.y' });
  const realFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return handler(calls.length);
  };
  return { provider, calls, restore: () => (globalThis.fetch = realFetch) };
}
const jsonReply = (status, body) => new Response(JSON.stringify(body), { status });

test('usage reports duration, tier, remaining fraction and status per window', async () => {
  const { provider, calls, restore } = await usageProvider(() =>
    jsonReply(200, {
      api_key: 'secret',
      user_id: 'u-1',
      is_subs_active: true,
      subs_tier_name: 'Pro',
      subs_usage: {
        window: { used_percent: 95, resets_at: '2030-01-01T00:00:00Z', window_duration_mins: 300 },
        weekly: { used_percent: 100, resets_at: 1893456000 },
      },
    })
  );
  try {
    const snap = await provider.getUsageSnapshot();
    assert.equal(calls[0].init.body, '{}');
    assert.equal(snap.tier, 'Pro');
    assert.equal('api_key' in snap.raw, false);
    const [rolling, weekly] = snap.quotaWindows;
    assert.equal(rolling.label, '5H');
    assert.equal(rolling.longLabel, '5 Hours');
    assert.equal(rolling.durationMs, 300 * 60_000);
    assert.equal(rolling.status, 'warning');
    assert.ok(Math.abs(rolling.remainingFraction - 0.05) < 1e-9);
    assert.equal(rolling.tier, 'Pro');
    assert.equal(weekly.label, '7D');
    assert.equal(weekly.longLabel, 'Weekly');
    assert.equal(weekly.durationMs, 7 * 24 * 3600_000);
    assert.equal(weekly.status, 'exhausted');
    assert.equal(weekly.remainingFraction, 0);
  } finally {
    restore();
  }
});

test('usage 401, 403 and an inactive subscription raise reauth errors', async () => {
  for (const [res, status] of [
    [() => jsonReply(401, { error: 'no' }), 401],
    [() => jsonReply(403, { error: 'no' }), 403],
    [() => jsonReply(200, { is_subs_active: false }), 403],
  ]) {
    const { provider, restore } = await usageProvider(res);
    try {
      await assert.rejects(
        provider.getUsageSnapshot(),
        (err) => err.reauthRequired === true && err.status === status
      );
    } finally {
      restore();
    }
  }
});

test('usage failures back off for five minutes with ±25% jitter', async () => {
  const realRandom = Math.random;
  for (const [random, cooldown] of [
    [0.5, 5 * 60_000],
    [0, 5 * 60_000 * 0.75],
    [0.999999, 5 * 60_000 * 1.25],
  ]) {
    const { provider, calls, restore } = await usageProvider(() => jsonReply(500, { error: 'boom' }));
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;
    Math.random = () => random;
    try {
      assert.equal(await provider.getUsageSnapshot(), null);
      assert.equal(await provider.getUsageSnapshot(), null);
      assert.equal(calls.length, 1);
      clock += cooldown - 10;
      assert.equal(await provider.getUsageSnapshot(), null);
      assert.equal(calls.length, 1);
      clock += 20;
      assert.equal(await provider.getUsageSnapshot(), null);
      assert.equal(calls.length, 2);
    } finally {
      Date.now = realNow;
      Math.random = realRandom;
      restore();
    }
  }
});

test('usage keeps the last good snapshot through transient failures and is keyed by credential', async () => {
  let mode = 'ok';
  const { provider, calls, restore } = await usageProvider(() =>
    mode === 'ok'
      ? jsonReply(200, { user_id: 'u-1', is_subs_active: true, subs_usage: { weekly: { used_percent: 10 } } })
      : jsonReply(500, { error: 'boom' })
  );
  const realNow = Date.now;
  const realRandom = Math.random;
  let clock = realNow();
  Date.now = () => clock;
  Math.random = () => 0.5;
  try {
    const good = await provider.getUsageSnapshot();
    assert.equal(good.quotaWindows.length, 1);
    mode = 'fail';
    clock += 1;
    assert.equal(await provider.getUsageSnapshot(), good);
    assert.equal(calls.length, 2);
    assert.equal(await provider.getUsageSnapshot(), good);
    assert.equal(calls.length, 2);
    clock += 5 * 60_000 + 10;
    assert.equal(await provider.getUsageSnapshot(), good);
    assert.equal(calls.length, 3);
    // A replaced login ignores the old cooldown and the old snapshot.
    tokens.saveTokens({ accessToken: 'other-token', apiKey: 'k2', accountId: 'u-2', email: '' });
    provider.tokens = tokens.loadTokens();
    assert.equal(await provider.getUsageSnapshot(), null);
    assert.equal(calls.length, 4);
    // Forgetting the credential clears the cached state.
    tokens.forgetMuseCodeOAuthCredentials();
    await assert.rejects(provider.getUsageSnapshot(), /credentials not found/);
    assert.equal(provider._usageFailure, null);
    assert.equal(provider._usageLastGood, null);
  } finally {
    Date.now = realNow;
    Math.random = realRandom;
    restore();
  }
});

test('subs_usage maps to quota windows', () => {
  const windows = quotaWindowsFromSubsUsage({
    window: { used_percent: 12.5, resets_at: '2030-01-01T00:00:00Z', window_duration_mins: 300 },
    weekly: { used_percent: 40, resets_at: 1893456000 },
  });
  assert.deepEqual(
    windows.map((w) => [w.label, w.usedPct]),
    [
      ['5H', 12.5],
      ['7D', 40],
    ]
  );
  assert.equal(windows[1].resetAt, 1893456000 * 1000);
});



