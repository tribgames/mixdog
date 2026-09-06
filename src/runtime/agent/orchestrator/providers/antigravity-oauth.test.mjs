// Wire-shape checks for the Antigravity Cloud Code Assist transport. The
// backend rejects a malformed envelope with an opaque 400, so the request
// wrapper, the impersonation headers, the thinking-signature sentinel, and the
// `{ response: … }` chunk unwrapping are all pinned here.
import test from 'node:test';
import assert from 'node:assert/strict';

import { AntigravityOAuthProvider } from './antigravity-oauth.mjs';
import { antigravityHeaders, codeAssistMetadata } from './antigravity-oauth-tokens.mjs';
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
  assert.deepEqual(requests[1].request.contents.find(content => content.role === 'model').parts, originalParts);
  assert.deepEqual(history, snapshot);
  const foreign = provider._buildBody([{
    role: 'assistant', content: 'Foreign.',
    providerReplay: createProviderReplay('gemini', originalParts),
  }], 'gemini-3-flash', [], {});
  assert.equal(foreign.request.contents[0].parts[0].thoughtSignature, 'skip_thought_signature_validator');
});

test('Antigravity uses Gemini Pro model tiers and Flash thinkingLevel without guessing Claude token budgets', () => {
  const provider = providerWith(async () => { throw new Error('network forbidden'); });
  const messages = [{ role: 'user', content: 'Hello.' }];
  for (const effort of ['low', 'high']) {
    const pro = provider._buildBody(messages, 'gemini-3-pro-high', [], { effort });
    assert.equal(pro.model, `gemini-3-pro-${effort}`);
    assert.equal(pro.request.generationConfig.thinkingConfig.thinkingLevel, effort);
    const flash = provider._buildBody(messages, 'gemini-3-flash', [], { effort });
    assert.equal(flash.model, 'gemini-3-flash');
    assert.equal(flash.request.generationConfig.thinkingConfig.thinkingLevel, effort);
  }
  assert.throws(() => provider._buildBody(messages, 'claude-opus-4-6-thinking', [], { effort: 'high' }), /uses thinkingBudget/);
  const claude = provider._buildBody(messages, 'claude-opus-4-6-thinking', [], { effort: 'high', thinkingBudget: 4096 });
  assert.equal(claude.request.generationConfig.thinkingConfig.thinkingBudget, 4096);
});

test('requests carry the Cloud Code Assist envelope and Antigravity identity', async () => {
  let seen = null;
  const provider = providerWith(async (url, init) => {
    seen = { url, init, body: JSON.parse(init.body) };
    return sseResponse([candidateChunk([{ text: 'hi' }], 'STOP')]);
  });

  await provider.send(
    [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hello' }],
    'gemini-3-pro-high',
    [],
    {},
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
  assert.equal(codeAssistMetadata().ideType, 'ANTIGRAVITY');
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
    {},
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
  const provider = providerWith(async () => sseResponse([
    candidateChunk([{ text: 'Hel' }]),
    candidateChunk([{ text: 'lo' }]),
    candidateChunk([{ functionCall: { name: 'read', args: { path: 'a.txt' } } }], 'STOP'),
  ]));

  const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [
    { name: 'read', description: 'read a file', parameters: { type: 'object', properties: {} } },
  ], {
    onTextDelta: (text) => deltas.push(text),
    onToolCall: (call) => toolCalls.push(call),
  });

  assert.equal(result.content, 'Hello');
  assert.equal(deltas.join(''), 'Hello');
  assert.equal(result.toolCalls?.length, 1);
  assert.equal(result.toolCalls[0].name, 'read');
  assert.equal(toolCalls.length, 1);
  assert.equal(result.usage.inputTokens, 11);
  assert.equal(result.usage.outputTokens, 5);
});

test('a failing endpoint fails over to the next one before surfacing an error', async () => {
  const tried = [];
  const provider = providerWith(async (url) => {
    tried.push(new URL(url).host);
    if (tried.length === 1) {
      return new Response(JSON.stringify({ error: { code: 500, message: 'backend' } }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
    return sseResponse([candidateChunk([{ text: 'recovered' }], 'STOP')]);
  });

  const result = await provider.send([{ role: 'user', content: 'hi' }], 'gemini-3-pro-high', [], {});
  assert.equal(result.content, 'recovered');
  assert.equal(tried.length, 2);
  assert.equal(tried[0], 'daily-cloudcode-pa.sandbox.googleapis.com');
  assert.notEqual(tried[1], tried[0]);
});
