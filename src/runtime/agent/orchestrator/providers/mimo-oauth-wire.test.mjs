import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'mimo-wire-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.MIMO_OAUTH_CREDENTIALS_PATH = join(dir, 'mimo-oauth.json');

const { MimoOAuthProvider } = await import('./mimo-oauth.mjs');
const { OpenAICompatProvider } = await import('./openai-compat.mjs');
const { consumeCompatChatCompletionStream } = await import('./openai-compat-stream.mjs');
const { effortOptionsFor } = await import('../runtime-core/effort.mjs');
const { loadTokens, ensureTokenPlanBaseUrl, probeTokenPlanBaseUrl, TOKEN_PLAN_BASE_URLS } = await import(
  './mimo-oauth-tokens.mjs'
);
const profile = await import('./mimo-oauth-profile.mjs');
const { providerCachedModelsSync } = await import('./provider-catalog-cache.mjs');
const { getModelMetadataSync } = await import('./model-catalog.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const OK_STREAM =
  chunk({ role: 'assistant', reasoning_content: 'thinking' }) +
  chunk({ content: 'done' }) +
  chunk({}, 'stop') +
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\ndata: [DONE]\n\n`;

// Local gateway: records every request, answers per `respond(req, body, res)`.
async function gateway(respond) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      respond(req, body, res, requests.length);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  return { requests, baseUrl, close: () => server.close() };
}

const streamOk = (_req, _body, res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.end(OK_STREAM);
};
const json = (res, status, doc) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(doc));
};

function signIn(baseUrl, apiKey = 'sk-wire') {
  writeFileSync(process.env.MIMO_OAUTH_CREDENTIALS_PATH, JSON.stringify({ apiKey, uid: 'u', baseUrl }));
}
const newProvider = (config = {}) => new MimoOAuthProvider({ preconnect: false, ...config });
const chatRequests = (gw) => gw.requests.filter((r) => r.url.endsWith('/chat/completions'));

const HISTORY = [
  { role: 'user', content: 'go' },
  {
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call_1', name: 'read', arguments: { path: 'a' } }],
    reasoningContent: 'plan the read',
  },
  { role: 'tool', toolCallId: 'call_1', content: 'file text' },
];
const TOOLS = [{ name: 'read', description: 'read a file', inputSchema: { type: 'object', properties: {} } }];

test('tool-call turns replay the stored reasoning_content and never invent one', async () => {
  const gw = await gateway(streamOk);
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    const result = await provider.send(HISTORY, 'mimo-v2.6-pro', TOOLS, {});
    const assistant = chatRequests(gw)[0].body.messages.find((m) => m.role === 'assistant');
    assert.equal(assistant.reasoning_content, 'plan the read');
    // The model's own reasoning from this turn is captured for the next replay.
    assert.equal(result.reasoningContent, 'thinking');

    const bare = HISTORY.map(({ reasoningContent: _drop, ...m }) => m);
    await provider.send(bare, 'mimo-v2.6-pro', TOOLS, {});
    const replayed = chatRequests(gw)[1].body.messages.find((m) => m.role === 'assistant');
    assert.equal('reasoning_content' in replayed, false);
  } finally {
    gw.close();
  }
});

test('effort maps to thinking + reasoning_effort and levels are advertised on rows', async () => {
  const gw = await gateway((req, body, res) =>
    req.url.endsWith('/models') ? json(res, 200, { data: [{ id: 'mimo-v2.6-pro' }] }) : streamOk(req, body, res)
  );
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    const send = (opts) => provider.send([{ role: 'user', content: 'hi' }], 'mimo-v2.6-pro', [], opts);
    await send({ effort: 'minimal' });
    await send({ effort: 'xhigh' });
    await send({ effort: 'none' });
    await send({ thinking: false });
    await send({});
    const bodies = chatRequests(gw).map((r) => r.body);
    assert.deepEqual([bodies[0].thinking, bodies[0].reasoning_effort], [{ type: 'enabled' }, 'minimal']);
    assert.deepEqual([bodies[1].thinking, bodies[1].reasoning_effort], [{ type: 'enabled' }, 'high']);
    assert.deepEqual([bodies[2].thinking, bodies[2].reasoning_effort], [{ type: 'disabled' }, undefined]);
    assert.deepEqual([bodies[3].thinking, bodies[3].reasoning_effort], [{ type: 'disabled' }, undefined]);
    assert.deepEqual([bodies[4].thinking, bodies[4].reasoning_effort], [undefined, undefined]);

    const [row] = await provider.listModels();
    assert.deepEqual(row.reasoningLevels, ['minimal', 'low', 'medium', 'high']);
    assert.deepEqual(effortOptionsFor('mimo-oauth', row), ['minimal', 'low', 'medium', 'high']);
  } finally {
    gw.close();
  }
});

test('sampling defaults, output ceiling clamp and tool_choice', async () => {
  const gw = await gateway((req, body, res) =>
    req.url.endsWith('/models')
      ? json(res, 200, { data: [{ id: 'mimo-small', max_output_tokens: 64000, context_window: 100000 }] })
      : streamOk(req, body, res)
  );
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    const hi = [{ role: 'user', content: 'hi' }];
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, {});
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, { temperature: 0.2, maxOutputTokens: 500, toolChoice: 'required' });
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, { toolChoice: { name: 'read' } });
    await provider.send(hi, 'mimo-v2.6-pro', TOOLS, { toolChoice: 'none' });
    await provider.send(hi, 'mimo-v2.6-pro', [], { toolChoice: 'required' });
    const [a, b, c, d, e] = chatRequests(gw).map((r) => r.body);
    assert.equal(a.temperature, 1);
    // MiMo documents max_completion_tokens (never max_tokens) and tool_choice auto only.
    assert.equal(a.max_completion_tokens, 128000);
    assert.equal(Object.hasOwn(a, 'max_tokens'), false);
    assert.equal(a.tool_choice, undefined);
    assert.equal(b.temperature, 0.2);
    assert.equal(b.max_completion_tokens, 500);
    assert.equal(b.tool_choice, undefined);
    assert.equal(c.tool_choice, undefined);
    assert.equal(c.tools.length, TOOLS.length);
    // `none` is honored by dropping the tools, since the backend ignores it.
    assert.equal(d.tool_choice, undefined);
    assert.equal(Object.hasOwn(d, 'tools'), false);
    assert.equal(e.tool_choice, undefined);

    await provider.listModels();
    await provider.send(hi, 'mimo-small', [], {});
    assert.equal(chatRequests(gw).at(-1).body.max_completion_tokens, 64000);
  } finally {
    gw.close();
  }
});

test('default model comes from the discovered roster', async () => {
  let roster = [{ id: 'mimo-v2.5' }, { id: 'mimo-v2.6-pro' }];
  const gw = await gateway((req, body, res) =>
    req.url.endsWith('/models') ? json(res, 200, { data: roster }) : streamOk(req, body, res)
  );
  try {
    const hi = [{ role: 'user', content: 'hi' }];
    signIn(gw.baseUrl);
    await newProvider().send(hi, undefined, [], {});
    roster = [{ id: 'mimo-v2.5-tts' }, { id: 'mimo-x' }, { id: 'mimo-y' }];
    signIn(gw.baseUrl, 'sk-other');
    await newProvider().send(hi, undefined, [], {});
    roster = [];
    signIn(gw.baseUrl, 'sk-third');
    await newProvider().send(hi, undefined, [], {});
    assert.deepEqual(
      chatRequests(gw).map((r) => r.body.model),
      ['mimo-v2.6-pro', 'mimo-x', 'mimo-v2.6-pro']
    );
    assert.equal(profile.chooseDefaultModel(['a-asr', 'mimo-z']), 'mimo-z');
    assert.equal(profile.chooseDefaultModel([]), 'mimo-v2.6-pro');
  } finally {
    gw.close();
  }
});

test('discovery drops speech models, keeps display names, falls back to the seed roster', async () => {
  let mode = 'ok';
  const gw = await gateway((req, _body, res) => {
    if (mode === 'down') return json(res, 500, { error: { message: 'boom' } });
    json(res, 200, {
      data:
        mode === 'empty'
          ? []
          : [
              { id: 'mimo-v2.6-pro', display_name: 'MiMo Pro' },
              { id: 'mimo-v2.5-tts' },
              { id: 'mimo-v2-asr' },
              { id: 'mimo-v2.6-flash', context_window: 5000, max_output_tokens: 700 },
            ],
    });
  });
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    const rows = await provider.listModels();
    assert.deepEqual(rows.map((r) => r.id).sort(), ['mimo-v2.6-flash', 'mimo-v2.6-pro']);
    assert.equal(rows.find((r) => r.id === 'mimo-v2.6-pro').name, 'MiMo Pro');
    const flash = rows.find((r) => r.id === 'mimo-v2.6-flash');
    assert.equal(flash.contextWindow, 5000);
    assert.equal(flash.outputTokens, 700);
    assert.equal(gw.requests[0].headers.accept, 'application/json');
    assert.equal(gw.requests[0].headers['x-mimo-source'], 'mimocode-cli');

    // The discovered roster is persisted for the sync lookup, without seed values.
    const cached = Object.fromEntries(providerCachedModelsSync('mimo-oauth').map((m) => [m.id, m]));
    assert.deepEqual(Object.keys(cached).sort(), ['mimo-v2.6-flash', 'mimo-v2.6-pro']);
    assert.equal(cached['mimo-v2.6-pro'].contextWindow, undefined);
    assert.equal(getModelMetadataSync('mimo-v2.6-flash', 'mimo-oauth').contextWindow, 5000);
    assert.equal(getModelMetadataSync('mimo-v2.6-pro', 'mimo-oauth').contextWindow, 1_048_576, 'seed fills the gap');

    for (mode of ['empty', 'down']) {
      const seeded = await newProvider().listModels();
      const ids = seeded.map((r) => r.id);
      assert.ok(ids.includes('mimo-v2.6-pro') && ids.includes('mimo-v2.5'), mode);
      const pro = seeded.find((r) => r.id === 'mimo-v2.6-pro');
      assert.equal(pro.contextWindow, 1_048_576);
      assert.equal(pro.outputTokens, 131_072);
      // The seed roster never overrides limits an earlier discovery fetched.
      const fallbackFlash = seeded.find((r) => r.id === 'mimo-v2.6-flash');
      assert.equal(fallbackFlash.contextWindow, 5000, mode);
      assert.equal(fallbackFlash.outputTokens, 700, mode);
    }
  } finally {
    gw.close();
  }
});

test('a stale or other-credential discovery response is not published', async () => {
  const held = [];
  const gw = await gateway((_req, _body, res) => held.push(res));
  const until = async (n) => {
    while (held.length < n) await new Promise((r) => setTimeout(r, 5));
  };
  const answer = (i, id) => json(held[i], 200, { data: [{ id, context_window: 7000 }] });
  const cachedIds = () => providerCachedModelsSync('mimo-oauth').map((m) => m.id);
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    // The older request answers last and must not overwrite the newer roster.
    const older = provider.listModels();
    await until(1);
    const newer = provider.listModels();
    await until(2);
    answer(1, 'mimo-v2.6-flash');
    await newer;
    answer(0, 'mimo-v2.6-pro');
    await older;
    assert.deepEqual(cachedIds(), ['mimo-v2.6-flash']);
    const liveIds = () => (provider._inner._enrichedModels || []).map((m) => m.id);
    assert.deepEqual(liveIds(), ['mimo-v2.6-flash']);
    assert.deepEqual(
      provider._rosterItems.map((m) => m.id),
      ['mimo-v2.6-flash']
    );

    // The active key changed while the request was in flight.
    const switched = provider.listModels();
    await until(3);
    signIn(gw.baseUrl, 'sk-other');
    answer(2, 'mimo-v2.6-pro');
    const rows = await switched;
    assert.deepEqual(
      rows.map((m) => m.id),
      ['mimo-v2.6-pro']
    );
    assert.deepEqual(cachedIds(), ['mimo-v2.6-flash']);
    assert.deepEqual(liveIds(), ['mimo-v2.6-flash']);
    assert.deepEqual(
      provider._rosterItems.map((m) => m.id),
      ['mimo-v2.6-flash']
    );

    // Supersession during catalog enrichment (after the fetch settled) must not
    // publish either. `name` is read once more right after enrichment finishes.
    signIn(gw.baseUrl);
    const base = provider.listModels();
    await until(4);
    answer(3, 'mimo-v2.6-flash');
    await base;
    const inner = provider._inner;
    const innerIds = () => (inner._enrichedModels || []).map((m) => m.id);
    const rosterIds = () => provider._rosterItems.map((m) => m.id);
    assert.deepEqual(innerIds(), ['mimo-v2.6-flash']);
    const innerName = inner.name;
    let onEnriched = null;
    let reads = 0;
    Object.defineProperty(inner, 'name', {
      configurable: true,
      get() {
        if (onEnriched && ++reads === 2) onEnriched();
        return innerName;
      },
    });
    const duringEnrichment = async (action, heldIndex) => {
      reads = 0;
      onEnriched = action;
      const pending = provider.listModels();
      await until(heldIndex + 1);
      answer(heldIndex, 'mimo-v2.6-pro');
      const got = await pending;
      onEnriched = null;
      return got;
    };
    // A newer request claims the roster while the older one is enriching.
    let newerFetch;
    const gotOlder = await duringEnrichment(() => {
      newerFetch = inner._fetchModelItems({});
    }, 4);
    assert.deepEqual(
      gotOlder.map((m) => m.id),
      ['mimo-v2.6-pro']
    );
    await until(6);
    answer(5, 'mimo-v2.6-flash');
    await newerFetch;
    assert.deepEqual(innerIds(), ['mimo-v2.6-flash']);
    assert.deepEqual(rosterIds(), ['mimo-v2.6-flash']);
    // The key switches while the request is enriching.
    const gotSwitched = await duringEnrichment(() => signIn(gw.baseUrl, 'sk-other'), 6);
    assert.deepEqual(
      gotSwitched.map((m) => m.id),
      ['mimo-v2.6-pro']
    );
    assert.deepEqual(innerIds(), ['mimo-v2.6-flash']);
    assert.deepEqual(rosterIds(), ['mimo-v2.6-flash']);
  } finally {
    gw.close();
  }
});

test('Token Plan key without a URL probes SGP → AMS → CN and persists the working one', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, signal: init.signal, auth: init.headers.Authorization });
    if (calls.length === 1) throw new Error('region down');
    if (calls.length === 2) return new Response('{"error":"denied"}', { status: 401 });
    return new Response('{}', { status: 200 });
  };
  assert.equal(await probeTokenPlanBaseUrl('tp-abc', { fetchImpl }), TOKEN_PLAN_BASE_URLS[2]);
  assert.deepEqual(
    calls.map((c) => c.url),
    [
      'https://token-plan-sgp.xiaomimimo.com/v1/chat/completions',
      'https://token-plan-ams.xiaomimimo.com/v1/chat/completions',
      'https://token-plan-cn.xiaomimimo.com/v1/chat/completions',
    ]
  );
  assert.equal(new Set(calls.map((c) => c.signal)).size, 3, 'each region gets its own timeout signal');
  assert.equal(calls[0].auth, 'Bearer tp-abc');

  signIn('', 'tp-abc');
  calls.length = 0;
  const tokens = await ensureTokenPlanBaseUrl(loadTokens(), { fetchImpl });
  assert.equal(tokens.baseUrl, TOKEN_PLAN_BASE_URLS[2]);
  assert.equal(loadTokens().baseUrl, TOKEN_PLAN_BASE_URLS[2]);
  // A non-Token-Plan key, or one with a known URL, is never probed.
  calls.length = 0;
  await ensureTokenPlanBaseUrl({ apiKey: 'sk-1', uid: '', baseUrl: '' }, { fetchImpl });
  await ensureTokenPlanBaseUrl({ apiKey: 'tp-1', uid: '', baseUrl: 'https://x.test/v1' }, { fetchImpl });
  assert.equal(calls.length, 0);
  // A non-auth refusal is a real failure, not a reason to try the next region.
  await assert.rejects(
    probeTokenPlanBaseUrl('tp-abc', { fetchImpl: async () => new Response('nope', { status: 500 }) }),
    /\(500\)/
  );
});

test('a caller cannot move MiMo onto the Responses wire', async () => {
  const gw = await gateway(streamOk);
  try {
    signIn(gw.baseUrl);
    await newProvider().send([{ role: 'user', content: 'hi' }], 'mimo-v2.6-pro', [], {
      compatWireApi: 'responses',
      responsesTransport: 'ws',
    });
    assert.deepEqual(
      gw.requests.map((r) => r.url),
      ['/v1/chat/completions']
    );
  } finally {
    gw.close();
  }
});

test('requests carry session affinity headers and a client User-Agent', async () => {
  const gw = await gateway(streamOk);
  try {
    signIn(gw.baseUrl, 'sk-hdr');
    const provider = newProvider();
    const hi = [{ role: 'user', content: 'hi' }];
    await provider.send(hi, 'mimo-v2.6-pro', [], { sessionId: 'sess-1', parentSessionId: 'sess-0' });
    await provider.send(hi, 'mimo-v2.6-pro', [], { sessionId: 'sess-2', ephemeral: true });
    const [a, b] = chatRequests(gw).map((r) => r.headers);
    assert.equal(a['x-session-affinity'], 'sess-1');
    assert.equal(a['x-parent-session-id'], 'sess-0');
    assert.match(a['user-agent'], /^mimocode\/\d/);
    assert.equal(a.authorization, 'Bearer sk-hdr');
    assert.equal(a['x-mimo-source'], 'mimocode-cli');
    assert.equal(b['x-session-affinity'], undefined);
    assert.match(b['user-agent'], /^mimocode\//);
  } finally {
    gw.close();
  }
});

test('gateway failures keep their detail; 421/441 are relabeled; quota is not retried', async () => {
  let reply = null;
  const gw = await gateway((_req, _body, res) => reply(res));
  try {
    signIn(gw.baseUrl, 'sk-secret-key');
    const provider = newProvider();
    const hi = [{ role: 'user', content: 'hi' }];

    reply = (res) => json(res, 400, { error: { code: 441, message: 'generic', param: 'prompt flagged' } });
    await assert.rejects(provider.send(hi, 'm', [], {}), (err) => {
      assert.match(err.message, /Request blocked by risk control: prompt flagged/);
      assert.equal(err.mimoGatewayCode, '441');
      return true;
    });
    reply = (res) => json(res, 400, { error: { code: '421', message: 'x' } });
    await assert.rejects(provider.send(hi, 'm', [], {}), /Request blocked by content moderation/);
    reply = (res) => json(res, 400, { error: { code: 'bad', message: 'plain text', param: 'temperature' } });
    await assert.rejects(provider.send(hi, 'm', [], {}), /plain text: temperature/);

    reply = (res) => json(res, 401, { error: { message: 'key sk-secret-key is revoked' } });
    await assert.rejects(provider.send(hi, 'm', [], {}), (err) => {
      assert.equal(err.reauthRequired, true);
      assert.equal(err.status, 401);
      assert.match(err.message, /sign in again: .*revoked/);
      assert.equal(err.message.includes('sk-secret-key'), false);
      return true;
    });

    gw.requests.length = 0;
    reply = (res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(
        `data: ${JSON.stringify({ error: { code: 'insufficient_quota', message: 'out of quota' } })}\n\ndata: [DONE]\n\n`
      );
    };
    await assert.rejects(provider.send(hi, 'm', [], {}), (err) => {
      assert.equal(err.code, 'insufficient_quota');
      assert.match(err.message, /out of quota/);
      return true;
    });
    assert.equal(gw.requests.length, 1, 'quota refusal is not replayed');
  } finally {
    gw.close();
  }
});

test('MiMo widens the stream waits; the shared default stays untouched', async () => {
  const stall = await import('../stall-policy.mjs');
  assert.ok(profile.MIMO_FIRST_BYTE_TIMEOUT_MS > stall.PROVIDER_FIRST_BYTE_TIMEOUT_MS);
  assert.ok(profile.MIMO_SEMANTIC_IDLE_TIMEOUT_MS >= stall.PROVIDER_SEMANTIC_IDLE_TIMEOUT_MS);
  assert.equal(profile.MIMO_CHAT_PROFILE.firstByteTimeoutMs, profile.MIMO_FIRST_BYTE_TIMEOUT_MS);
  assert.equal(profile.MIMO_CHAT_PROFILE.semanticIdleTimeoutMs, profile.MIMO_SEMANTIC_IDLE_TIMEOUT_MS);

  // The stream reader honors an explicit first-byte allowance.
  const silent = { [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: async () => ({}) }) };
  // The stream's own timers are unref'd, so hold the loop open for the check.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      consumeCompatChatCompletionStream(silent, { label: 'x', providerName: 'x', firstByteTimeoutMs: 30 }),
      /first byte timed out after 30ms/
    );
  } finally {
    clearInterval(keepAlive);
  }

  // And a send only picks the profile up when the provider opts in.
  const gw = await gateway(streamOk);
  try {
    const plain = new OpenAICompatProvider('deepseek', { baseURL: gw.baseUrl, apiKey: 'k', preconnect: false });
    await plain.send([{ role: 'user', content: 'hi' }], 'deepseek-chat', [], {});
    const body = chatRequests(gw)[0].body;
    assert.equal(body.temperature, undefined);
    assert.equal(body.max_tokens, undefined);
  } finally {
    gw.close();
  }
});

test('regional probe continues past any failure and reports the last one', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return calls.length === 1 ? new Response('busy', { status: 503 }) : new Response('{}', { status: 200 });
  };
  assert.equal(await probeTokenPlanBaseUrl('tp-abc', { fetchImpl }), TOKEN_PLAN_BASE_URLS[1]);
  const down = async () => new Response('gone', { status: 503 });
  await assert.rejects(probeTokenPlanBaseUrl('tp-abc', { fetchImpl: down }), /\(503\).*gone/);
  const ctl = new AbortController();
  ctl.abort();
  await assert.rejects(
    probeTokenPlanBaseUrl('tp-abc', {
      signal: ctl.signal,
      fetchImpl: async (_u, init) => {
        init.signal.throwIfAborted();
      },
    })
  );
});

test('topP/topK are forwarded and absent otherwise', async () => {
  const gw = await gateway(streamOk);
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    const hi = [{ role: 'user', content: 'hi' }];
    await provider.send(hi, 'mimo-v2.6-pro', [], { topP: 0.9, topK: 40 });
    await provider.send(hi, 'mimo-v2.6-pro', [], {});
    const [a, b] = chatRequests(gw).map((r) => r.body);
    assert.equal(a.top_p, 0.9);
    assert.equal(a.top_k, 40);
    assert.equal(b.top_p, undefined);
    assert.equal(b.top_k, undefined);
  } finally {
    gw.close();
  }
});

test('seeds include ultraspeed; bare rows inherit seed limits by id or lineage', async () => {
  assert.ok(profile.SEED_MODELS.some((m) => m.id === 'mimo-v2.6-pro-ultraspeed' && m.max_output_tokens === 131_072));
  const gw = await gateway((req, body, res) =>
    req.url.endsWith('/models')
      ? json(res, 200, {
          data: [{ id: 'mimo-v2.6-pro-ultraspeed' }, { id: 'mimo-v2.6-flash-20260101' }, { id: 'other' }],
        })
      : streamOk(req, body, res)
  );
  try {
    signIn(gw.baseUrl);
    const rows = await newProvider().listModels();
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(by['mimo-v2.6-pro-ultraspeed'].contextWindow, 1_048_576);
    assert.equal(by['mimo-v2.6-flash-20260101'].contextWindow, 1_048_576);
    assert.equal(by['mimo-v2.6-flash-20260101'].outputTokens, 131_072);
    assert.equal(by['mimo-v2.6-flash-20260101'].reasoning, true);
    assert.equal(by.other.contextWindow || 0, 0);
  } finally {
    gw.close();
  }
});

test('organization/project env vars are never sent', async () => {
  const gw = await gateway(streamOk);
  process.env.OPENAI_ORG_ID = 'org-x';
  process.env.OPENAI_PROJECT_ID = 'proj-x';
  try {
    signIn(gw.baseUrl);
    await newProvider().send([{ role: 'user', content: 'hi' }], 'mimo-v2.6-pro', [], {});
    const h = chatRequests(gw)[0].headers;
    assert.equal(h['openai-organization'], undefined);
    assert.equal(h['openai-project'], undefined);
  } finally {
    delete process.env.OPENAI_ORG_ID;
    delete process.env.OPENAI_PROJECT_ID;
    gw.close();
  }
});
test('three regional 401s yield a typed reauth error; setup failures are shaped on send/list', async () => {
  const rejected = async () => new Response('{"error":{"message":"bad key tp-secret"}}', { status: 401 });
  const err = await probeTokenPlanBaseUrl('tp-secret', { fetchImpl: rejected }).catch((e) => e);
  assert.equal(err.status, 401);
  assert.equal(err.httpStatus, 401);
  assert.equal(err.reauthRequired, true);
  assert.match(err.message, /sign in again/);
  const busy = await probeTokenPlanBaseUrl('tp-secret', {
    fetchImpl: async () => new Response('x', { status: 503 }),
  }).catch((e) => e);
  assert.equal(busy.status, 503);
  assert.equal(busy.reauthRequired, undefined);

  signIn('https://api.xiaomimimo.com/v1', 'tp-secret');
  const provider = newProvider({ fetchImpl: rejected });
  for (const call of [
    () => provider.send([{ role: 'user', content: 'hi' }], 'm', [], {}),
    () => provider.listModels(),
  ]) {
    const e = await call().catch((x) => x);
    assert.equal(e.reauthRequired, true);
    assert.equal(e.status, 401);
  }
});
async function captureStderr(run) {
  const lines = [];
  const original = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => {
    lines.push(String(chunk));
    return typeof rest.at(-1) === 'function' ? rest.at(-1)() : true;
  };
  try {
    return { result: await run(), stderr: lines.join('') };
  } finally {
    process.stderr.write = original;
  }
}

test('the stored key is redacted from retry logs and from a 400 error', async () => {
  const KEY = 'sk-very-secret-key-123';
  let n = 0;
  const gw = await gateway((req, _body, res) => {
    if (req.url.endsWith('/models')) return json(res, 200, { data: [] });
    n += 1;
    if (n === 1) return json(res, 503, { error: { message: `upstream rejected ${KEY}` } });
    if (n === 2) return streamOk(req, _body, res);
    return json(res, 400, { error: { message: `bad request for ${KEY}`, param: `key ${KEY}` } });
  });
  try {
    signIn(gw.baseUrl, KEY);
    const provider = newProvider();
    const hi = [{ role: 'user', content: 'hi' }];
    const { stderr } = await captureStderr(() => provider.send(hi, 'mimo-v2.6-pro', [], {}));
    assert.match(stderr, /retry attempt/);
    assert.equal(stderr.includes(KEY), false);
    const err = await provider.send(hi, 'mimo-v2.6-pro', [], {}).catch((e) => e);
    assert.ok(err instanceof Error);
    assert.equal(JSON.stringify([err.message, err.error, err.mimoGatewayParam]).includes(KEY), false);
  } finally {
    gw.close();
  }
});

test('a probe finishing after a newer sign-in does not overwrite it', async () => {
  signIn('https://api.xiaomimimo.com/v1', 'tp-old');
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const pending = ensureTokenPlanBaseUrl(loadTokens(), {
    fetchImpl: async () => {
      await gate;
      return new Response('{}', { status: 200 });
    },
  });
  signIn('https://new.example/v1', 'sk-new');
  release();
  await pending;
  const stored = loadTokens();
  assert.equal(stored.apiKey, 'sk-new');
  assert.equal(stored.baseUrl, 'https://new.example/v1');
});

test('a deleted token file signs the provider out', async () => {
  const gw = await gateway(streamOk);
  try {
    signIn(gw.baseUrl);
    const provider = newProvider();
    await provider.send([{ role: 'user', content: 'hi' }], 'mimo-v2.6-pro', [], {});
    rmSync(process.env.MIMO_OAUTH_CREDENTIALS_PATH);
    await assert.rejects(
      provider.send([{ role: 'user', content: 'hi' }], 'mimo-v2.6-pro', [], {}),
      /credentials not found/
    );
    assert.equal(provider.tokens, null);
    assert.equal(await provider.isAvailable(), false);
  } finally {
    gw.close();
  }
});

test('aborting a send during the regional probe surfaces cancellation, not reauth', async () => {
  signIn('https://api.xiaomimimo.com/v1', 'tp-abort');
  const ctl = new AbortController();
  const reason = new Error('caller cancelled');
  reason.name = 'CallerCancel';
  const urls = [];
  const provider = newProvider({
    fetchImpl: (url, init) => {
      urls.push(String(url));
      // First region refuses; the second hangs until the send is aborted.
      if (urls.length === 1) return Promise.resolve(new Response('{}', { status: 503 }));
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
        setTimeout(() => ctl.abort(reason), 20);
      });
    },
  });
  const err = await provider.send([{ role: 'user', content: 'hi' }], 'm', [], { signal: ctl.signal }).catch((e) => e);
  assert.equal(err, reason);
  assert.equal(err.name, 'CallerCancel');
  assert.equal(err.reauthRequired, undefined);
  assert.equal(urls.length, 2, 'no regional probe after the abort');
  assert.ok(urls[0].includes('token-plan-sgp') && urls[1].includes('token-plan-ams'));
});
