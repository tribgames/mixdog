import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const dir = mkdtempSync(join(tmpdir(), 'mixdog-devin-provider-'));
process.env.MIXDOG_DATA_DIR = dir;
process.env.DEVIN_OAUTH_CREDENTIALS_PATH = join(dir, 'missing-devin-oauth.json');

const { DEVIN_ENUMS, DEVIN_SCHEMAS, decodeDevinMessage, encodeDevinMessage } = await import(
  './devin-wire-protobuf.mjs'
);
const { encodeDevinFrame } = await import('./devin-wire-transport.mjs');
const { REAUTH_GUIDANCE } = await import('./devin-auth.mjs');
const { DevinOAuthProvider, devinWireUid } = await import('./devin.mjs');
const { providerErrorKind, retryAfterMsFromError } = await import('./provider-error-kind.mjs');
const { isContextOverflowError } = await import('./retry-classifier.mjs');
const { consumeCompatChatCompletionStream } = await import('./openai-compat-stream.mjs');
const { parseDevinToolArguments } = await import('./devin-wire-tool-args.mjs');

test.after(() => rmSync(dir, { recursive: true, force: true }));

const { StopReason, ChatMessageSource } = DEVIN_ENUMS;
const enc = new TextEncoder();
const API_HOST = 'https://chat.devin-account.example.com';
const HAS_ASSIGN_SCHEMA = Boolean(DEVIN_SCHEMAS.AssignModelRequest && DEVIN_SCHEMAS.AssignModelResponse);

const MODELS = [
  {
    modelUid: 'claude-x',
    label: 'Claude X',
    maxTokens: 300_000,
    modelInfo: {
      maxOutputTokens: 32_000,
      modelFeatures: {
        supportsImages: true,
        supportsToolCalls: true,
        supportsThinking: true,
        supportsParallelToolCalls: true,
      },
    },
  },
  { modelUid: 'gpt-y', label: 'GPT Y', maxTokens: 128_000, modelInfo: { modelFeatures: { supportsToolCalls: true } } },
];

function jwt(payload) {
  const part = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

const data = (msg) => encodeDevinFrame(encodeDevinMessage('GetChatMessageResponse', msg));
const trailer = (body = {}) => encodeDevinFrame(enc.encode(JSON.stringify(body)), 2);

// A chat body that mimics fetch: aborting the request errors the body stream.
function streamReply(frames, { hang = false } = {}) {
  return (init, server) => {
    const queue = [...frames];
    const body = new ReadableStream({
      start(controller) {
        init.signal?.addEventListener('abort', () => controller.error(init.signal.reason), { once: true });
      },
      pull(controller) {
        if (queue.length) {
          server.pulled += 1;
          controller.enqueue(queue.shift());
        } else if (!hang) controller.close();
        else return new Promise(() => {});
      },
    });
    return new Response(body, { status: 200 });
  };
}

function errorReply(status, code, message, headers = {}) {
  return () =>
    new Response(JSON.stringify({ code, message }), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
}

function decodeChatRequest(body) {
  const bytes = Buffer.from(body);
  const length = bytes.readUInt32BE(1);
  return decodeDevinMessage('GetChatMessageRequest', gunzipSync(bytes.subarray(5, 5 + length)));
}

function fakeDevin(chatReplies = [], { apiHost, assignments = [], models = MODELS, defaultUid } = {}) {
  const server = { jwt: 0, models: 0, chat: [], assign: [], paths: [], pulled: 0, modelTokens: [] };
  server.fetchFn = async (input, init = {}) => {
    const url = String(input);
    server.paths.push(new URL(url).pathname);
    if (url.endsWith('/GetUserJwt')) {
      server.jwt += 1;
      return new Response(
        encodeDevinMessage('GetUserJwtResponse', {
          userJwt: jwt({ exp: Math.floor(Date.now() / 1000) + 3600, n: server.jwt }),
          ...(apiHost ? { customApiServerUrl: apiHost } : {}),
        })
      );
    }
    if (url.endsWith('/GetCliModelConfigs')) {
      server.models += 1;
      server.modelTokens.push(
        decodeDevinMessage('GetCliModelConfigsRequest', new Uint8Array(init.body)).metadata.apiKey
      );
      return new Response(
        encodeDevinMessage('GetCliModelConfigsResponse', {
          clientModelConfigs: models,
          ...(defaultUid ? { defaultOverrideModelConfig: { modelUid: defaultUid } } : {}),
        })
      );
    }
    if (url.endsWith('/AssignModel')) {
      server.assign.push({ url, request: decodeDevinMessage('AssignModelRequest', new Uint8Array(init.body)) });
      const assignment = assignments.shift();
      return new Response(encodeDevinMessage('AssignModelResponse', assignment ? { assignment } : {}));
    }
    if (url.endsWith('/GetChatMessage')) {
      server.chat.push({ url, request: decodeChatRequest(init.body) });
      const reply = chatReplies.shift();
      assert.ok(reply, 'unexpected chat request');
      return reply(init, server);
    }
    throw new Error(`unexpected URL ${url}`);
  };
  return server;
}

function provider(server, token = 'tok-A') {
  return new DevinOAuthProvider({ accessToken: token, fetchFn: server.fetchFn });
}

// A provider whose catalog is the given rows (the collapsed-family / router
// row contract), independent of discovery normalization.
function providerWithRows(server, rows) {
  const devin = provider(server);
  devin._catalog = async () => ({ rows: new Map(rows.map((row) => [row.id, row])), models: [] });
  return devin;
}

const TOOLS = [
  { name: 'read', description: 'Read', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'grep', description: 'Grep', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } },
];

test('streams text and thinking, reports usage, and keeps the native replay record', async () => {
  const server = fakeDevin(
    [
      streamReply([
        data({ messageId: 'bot-1', deltaThinking: 'Let me ' }),
        data({ deltaThinking: 'think', deltaSignature: 'sig-' }),
        data({ deltaText: 'Hel' }),
        // The rest of the signature arrives late, behind the text.
        data({ deltaSignature: 'abc', deltaSignatureType: 'anthropic' }),
        data({ deltaText: 'lo', stopReason: StopReason.STOP_PATTERN }),
        data({ usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 } }),
        trailer(),
      ]),
    ],
    { apiHost: API_HOST }
  );
  const texts = [];
  const reasoning = [];
  const result = await provider(server).send([{ role: 'user', content: 'hi' }], 'claude-x', [], {
    sessionId: 'sess-1',
    onTextDelta: (text) => texts.push(text),
    onReasoningDelta: (text) => reasoning.push(text),
  });
  assert.deepEqual(texts, ['Hel', 'lo']);
  assert.deepEqual(reasoning, ['Let me ', 'think']);
  assert.equal(result.content, 'Hello');
  assert.equal(result.stopReason, 'stop');
  assert.equal(result.reasoningContent, 'Let me think');
  assert.deepEqual(result.providerReplay.items, [
    {
      type: 'devin_assistant',
      model: 'claude-x',
      messageId: 'bot-1',
      thinking: 'Let me think',
      signature: 'sig-abc',
      signatureType: 'anthropic',
    },
  ]);
  assert.deepEqual(
    { ...result.usage, raw: undefined },
    { inputTokens: 10, outputTokens: 5, cachedTokens: 100, cacheWriteTokens: 0, promptTokens: 110, raw: undefined }
  );
  const [{ url, request }] = server.chat;
  assert.equal(url, `${API_HOST}/exa.api_server_pb.ApiServerService/GetChatMessage`);
  assert.equal(request.metadata.apiKey, 'devin-session-token$tok-A');
  assert.match(request.metadata.userJwt, /\./);
  assert.equal(request.chatModelUid, 'claude-x');
  assert.equal(request.cascadeId, 'sess-1');
  assert.equal(request.disableParallelToolCalls, undefined);
  assert.equal(request.configuration.maxTokens, 32_000n);
  assert.deepEqual(server.paths.slice(0, 2), [
    '/exa.api_server_pb.ApiServerService/GetCliModelConfigs',
    '/exa.auth_pb.AuthService/GetUserJwt',
  ]);
});

test('the served model is the latest reported uid; credit charges keep each latest nonzero value', async () => {
  const server = fakeDevin([
    streamReply([
      data({ deltaText: 'a', actualModelUid: 'claude-x-fallback', creditCost: 3 }),
      data({ deltaText: 'b', actualModelUid: 'claude-x-final', committedCreditCost: 2, committedAcuCost: 0.5 }),
      data({ creditCost: 0, committedAcuCost: 0.75 }),
      data({ usage: { inputTokens: 1, outputTokens: 2 } }),
      trailer(),
    ]),
  ]);
  const result = await provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], {});
  assert.equal(result.model, 'claude-x-final');
  assert.deepEqual(result.credits, { cost: 3, committedCost: 2, acuCost: 0.75 });
  assert.deepEqual(result.usage.credits, { cost: 3, committedCost: 2, acuCost: 0.75 });
  assert.equal(result.providerReplay.items[0].model, 'claude-x', 'replay identity stays the catalog model');
});

test('MAX_TOKENS maps to length; a stream without a usage frame reports no usage', async () => {
  const server = fakeDevin([
    streamReply([data({ deltaText: 'ok', stopReason: StopReason.MAX_TOKENS }), trailer()]),
    streamReply([data({ deltaText: 'ok', stopReason: StopReason.MAX_NEWLINES }), trailer()]),
  ]);
  const devin = provider(server);
  const result = await devin.send([{ role: 'user', content: 'hi' }], 'gpt-y', [], {});
  assert.equal(result.stopReason, 'length');
  assert.equal(result.usage, undefined);
  assert.equal(result.model, 'gpt-y', 'no reported uid: the requested model');
  assert.equal(result.credits, undefined);
  assert.deepEqual(result.providerReplay.items, [{ type: 'devin_assistant', model: 'gpt-y' }]);
  assert.equal((await devin.send([{ role: 'user', content: 'hi' }], 'gpt-y', [], {})).stopReason, 'stop');
});

test('interleaved partial tool arguments dispatch only once complete; repeated ids stay paired across turns', async () => {
  const longId = `call_${'z'.repeat(60)}`;
  const server = fakeDevin([
    streamReply([
      data({ deltaToolCalls: [{ id: 'toolu_dup', name: 'read', argumentsJson: '{"pa' }] }),
      data({ deltaToolCalls: [{ id: 'call_2', name: 'grep', argumentsJson: '{"q":' }] }),
      data({ deltaToolCalls: [{ argumentsJson: '"x"}' }] }),
      data({ deltaToolCalls: [{ id: 'toolu_dup', argumentsJson: '{"path":"a.ts"}' }] }),
      data({ deltaToolCalls: [{ id: longId, name: 'read', argumentsJson: '{}' }], stopReason: StopReason.MAX_TOKENS }),
      trailer(),
    ]),
    streamReply([data({ deltaText: 'done' }), trailer()]),
  ]);
  const history = [
    { role: 'user', content: 'earlier' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'toolu_dup', name: 'read', arguments: { path: 'old' } }] },
    { role: 'tool', toolCallId: 'toolu_dup', content: 'old contents' },
    { role: 'user', content: 'now' },
  ];
  const dispatched = [];
  const devin = provider(server);
  const result = await devin.send(history, 'claude-x', TOOLS, {
    sessionId: 'sess-tools',
    onToolCall: (call) => dispatched.push({ ...call, pulledFrames: server.pulled }),
  });
  assert.equal(result.stopReason, 'tool_calls', 'tool calls win over MAX_TOKENS');
  assert.equal(dispatched.length, 3);
  for (const call of dispatched) assert.equal(call.pulledFrames, 6, 'dispatched only after the trailer');
  assert.deepEqual(
    result.toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [
      ['toolu_dup', 'read', { path: 'a.ts' }],
      ['call_2', 'grep', { q: 'x' }],
      [longId, 'read', {}],
    ]
  );

  const next = [
    ...history,
    { role: 'assistant', content: '', toolCalls: result.toolCalls, providerReplay: result.providerReplay },
    ...result.toolCalls.map((call) => ({ role: 'tool', toolCallId: call.id, content: `out ${call.name}` })),
  ];
  await devin.send(next, 'claude-x', TOOLS, { sessionId: 'sess-tools' });
  const prompts = server.chat[1].request.chatMessagePrompts;
  assert.equal(prompts[1].toolCalls[0].id, 'toolu_dup');
  const replayed = prompts[4].toolCalls.map((call) => call.id);
  assert.deepEqual(replayed, ['toolu_dup_dup1', 'call_2', longId], 'same-model ids verbatim, repeats suffixed');
  assert.deepEqual(
    prompts.slice(5).map((prompt) => [prompt.toolCallId, prompt.prompt]),
    [
      ['toolu_dup_dup1', 'out read'],
      ['call_2', 'out grep'],
      [longId, 'out read'],
    ]
  );
  assert.equal(server.chat[1].request.cascadeId, 'sess-tools');
});

test('partial tool JSON is never executed: a cut frame fails, unparsable final arguments become a marker', async () => {
  const cut = data({ deltaToolCalls: [{ id: 'c0', name: 'read', argumentsJson: '{"path":"abc"}' }] }).subarray(0, 8);
  const server = fakeDevin([
    streamReply([cut]),
    streamReply([data({ deltaToolCalls: [{ id: 'c1', name: 'read', argumentsJson: '{"path":"a' }] }), trailer()]),
    streamReply([data({ deltaToolCalls: [{ id: 'c2', name: 'read', argumentsJson: '{"path":' }] }), trailer()]),
  ]);
  const dispatched = [];
  const opts = { onToolCall: (call) => dispatched.push(call) };
  await assert.rejects(provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', TOOLS, opts), (error) => {
    assert.equal(error.code, 'protocol');
    assert.equal(error.truncatedStream, true);
    return true;
  });
  assert.equal(dispatched.length, 0);
  for (const raw of ['{"path":"a', '{"path":']) {
    const result = await provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', TOOLS, opts);
    assert.equal(result.stopReason, 'tool_calls');
    assert.equal(result.toolCalls[0].arguments.__invalidToolArgs, true);
    assert.equal(result.toolCalls[0].arguments.__rawArguments, raw);
  }
  for (const call of dispatched) assert.equal(call.arguments.__invalidToolArgs, true, 'never real arguments');
});

test('a response cut off before its trailer is a truncated stream: its complete tool calls never dispatch', async () => {
  const call = data({ deltaToolCalls: [{ id: 'k1', name: 'read', argumentsJson: '{"path":"a.ts"}' }] });
  const server = fakeDevin([
    streamReply([data({ deltaText: 'Reading.' }), call]),
    streamReply([call, data({ stopReason: StopReason.FUNCTION_CALL })]),
  ]);
  const dispatched = [];
  const opts = { onToolCall: (entry) => dispatched.push(entry) };
  for (let i = 0; i < 2; i++) {
    await assert.rejects(provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', TOOLS, opts), (error) => {
      assert.equal(error.code, 'protocol');
      assert.match(error.message, /without an end-of-stream trailer/);
      assert.equal(error.truncatedStream, true);
      assert.equal(error.retryable, true);
      return true;
    });
  }
  assert.equal(dispatched.length, 0);
});

test('arguments the server could not parse (invalidJsonStr) are repaired or marked, never run as {}', async () => {
  const server = fakeDevin([
    streamReply([
      data({
        deltaToolCalls: [{ id: 'i1', name: 'read', invalidJsonStr: "{'path': 'a.ts'}", invalidJsonErr: 'quote' }],
      }),
      trailer(),
    ]),
    streamReply([data({ deltaToolCalls: [{ id: 'i2', name: 'read', invalidJsonStr: '{"path":' }] }), trailer()]),
  ]);
  const devin = provider(server);
  const send = () => devin.send([{ role: 'user', content: 'x' }], 'claude-x', TOOLS, {});
  assert.deepEqual((await send()).toolCalls[0].arguments, { path: 'a.ts' });
  const marked = (await send()).toolCalls[0].arguments;
  assert.equal(marked.__invalidToolArgs, true);
  assert.equal(marked.__rawArguments, '{"path":');
});

test('cancellation rejects with the caller reason and stops the stream', async () => {
  const server = fakeDevin([streamReply([data({ deltaText: 'part' })], { hang: true })]);
  const controller = new AbortController();
  const reason = new Error('user stop');
  const texts = [];
  await assert.rejects(
    provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], {
      signal: controller.signal,
      onTextDelta: (text) => {
        texts.push(text);
        controller.abort(reason);
      },
    }),
    (error) => error === reason
  );
  assert.deepEqual(texts, ['part']);
  const aborted = new AbortController();
  aborted.abort(reason);
  await assert.rejects(
    provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], { signal: aborted.signal }),
    (error) => error === reason
  );
  assert.equal(server.chat.length, 1);
});

test('every turn exchanges a fresh user JWT', async () => {
  const ok = () => streamReply([data({ deltaText: 'ok' }), trailer()]);
  const server = fakeDevin([ok(), ok()]);
  const devin = provider(server);
  await devin.send([{ role: 'user', content: 'x' }], 'claude-x', [], {});
  await devin.send([{ role: 'user', content: 'x' }], 'claude-x', [], {});
  assert.equal(server.jwt, 2);
  assert.notEqual(server.chat[0].request.metadata.userJwt, server.chat[1].request.metadata.userJwt);
});

test('an unauthenticated chat is a re-auth error with no in-place retry', async () => {
  const server = fakeDevin([errorReply(401, 'unauthenticated', 'no')]);
  await assert.rejects(provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], {}), (error) => {
    assert.equal(error.reauthRequired, true);
    assert.ok(error.message.includes(REAUTH_GUIDANCE));
    assert.equal(providerErrorKind(error).kind, 'auth');
    return true;
  });
  assert.equal(server.jwt, 1);
  assert.equal(server.chat.length, 1);
});

test('a streamed tool call keeps the last name it was given', async () => {
  const server = fakeDevin([
    streamReply([
      data({ deltaToolCalls: [{ id: 't1', name: 'read', argumentsJson: '{"q":' }] }),
      data({ deltaToolCalls: [{ id: 't1', name: 'grep', argumentsJson: '"x"}' }] }),
      trailer(),
    ]),
  ]);
  const result = await provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', TOOLS, {});
  assert.deepEqual(
    result.toolCalls.map((call) => [call.id, call.name, call.arguments]),
    [['t1', 'grep', { q: 'x' }]]
  );
});

test('a missing Devin login surfaces the re-auth error before any request', async () => {
  const server = fakeDevin();
  const devin = new DevinOAuthProvider({ fetchFn: server.fetchFn });
  await assert.rejects(devin.send([{ role: 'user', content: 'x' }], 'claude-x', [], {}), (error) => {
    assert.equal(error.reauthRequired, true);
    assert.ok(error.message.includes(REAUTH_GUIDANCE));
    return true;
  });
  assert.equal(server.paths.length, 0);
});

test('a rate limit carries its retry-after and is not retried in place', async () => {
  const server = fakeDevin([errorReply(429, 'resource_exhausted', 'slow down', { 'retry-after': '7' })]);
  await assert.rejects(provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], {}), (error) => {
    assert.equal(error.code, 'resource_exhausted');
    assert.equal(retryAfterMsFromError(error), 7000);
    assert.equal(providerErrorKind(error).kind, 'rate_limited');
    return true;
  });
  assert.equal(server.chat.length, 1);
});

test('request_too_large is a context overflow so compaction runs', async () => {
  const server = fakeDevin([errorReply(413, '', '')]);
  await assert.rejects(provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], {}), (error) => {
    assert.equal(error.code, 'request_too_large');
    assert.equal(isContextOverflowError(error), true);
    assert.equal(providerErrorKind(error).kind, 'context_overflow');
    return true;
  });
  assert.equal(server.chat.length, 1);
});

test('an opaque internal-error trailer is an overflow only for large compactable history before output', async () => {
  const opaque = trailer({ error: { code: 'invalid_argument', message: 'an internal error occurred (trace ID: t)' } });
  const large = [
    ...Array.from({ length: 4 }, (_, i) => [
      { role: 'assistant', content: '', toolCalls: [{ id: `r${i}`, name: 'read', arguments: {} }] },
      { role: 'tool', toolCallId: `r${i}`, content: String(i).repeat(160 * 1024) },
    ]).flat(),
  ];
  const hugeActive = [{ role: 'user', content: 'u'.repeat(520 * 1024) }];
  const server = fakeDevin([
    streamReply([opaque]),
    streamReply([opaque]),
    streamReply([opaque]),
    streamReply([data({ deltaText: 'partial' }), opaque]),
    streamReply([trailer({ error: { code: 'invalid_argument', message: 'unknown chat model uid' } })]),
  ]);
  const devin = provider(server);
  const send = (messages) => devin.send(messages, 'gpt-y', [], {});
  await assert.rejects(send(large), (error) => isContextOverflowError(error));
  await assert.rejects(send([{ role: 'user', content: 'hi' }]), (error) => {
    assert.equal(isContextOverflowError(error), false);
    assert.equal(providerErrorKind(error).kind, 'transient');
    return true;
  });
  await assert.rejects(send(hugeActive), (error) => {
    assert.equal(isContextOverflowError(error), false);
    assert.equal(providerErrorKind(error).kind, 'transient');
    return true;
  });
  await assert.rejects(send(large), (error) => {
    assert.equal(isContextOverflowError(error), false);
    assert.equal(error.liveTextEmitted, true);
    return true;
  });
  await assert.rejects(send(large), (error) => isContextOverflowError(error) === false);
});

test('an error trailer after partial output fails the turn without a retry or re-exchange', async () => {
  const server = fakeDevin([
    streamReply([data({ deltaText: 'partial' }), trailer({ error: { code: 'unauthenticated', message: 'x' } })]),
  ]);
  const texts = [];
  await assert.rejects(
    provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], { onTextDelta: (t) => texts.push(t) }),
    (error) => {
      assert.equal(error.code, 'unauthenticated');
      assert.equal(error.liveTextEmitted, true);
      assert.equal(error.unsafeToRetry, true);
      assert.equal(error.partialContent, 'partial');
      return true;
    }
  );
  assert.deepEqual(texts, ['partial']);
  assert.equal(server.chat.length, 1);
  assert.equal(server.jwt, 1);
});

test('HTTP 200 with an error trailer and no output is a failure', async () => {
  const server = fakeDevin([streamReply([trailer({ error: { code: 'internal', message: 'boom' } })])]);
  await assert.rejects(provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], {}), (error) => {
    assert.equal(error.code, 'internal');
    assert.equal(providerErrorKind(error).kind, 'transient');
    return true;
  });
});

test('effort picks the wire uid of a collapsed family; no effort uses the default uid', async () => {
  const row = {
    id: 'gpt-5',
    uid: 'gpt-5-medium',
    reasoningLevels: ['low', 'medium', 'high'],
    effortUids: { low: 'gpt-5-low', medium: 'gpt-5-medium', high: 'gpt-5-high' },
    defaultEffort: 'medium',
  };
  assert.equal(devinWireUid(row, 'gpt-5', 'high'), 'gpt-5-high');
  assert.equal(devinWireUid(row, 'gpt-5', undefined), 'gpt-5-medium');
  assert.equal(devinWireUid(row, 'gpt-5', 'xhigh'), 'gpt-5-medium');
  assert.equal(devinWireUid(null, 'plain', 'high'), 'plain');
  const server = fakeDevin([streamReply([data({ messageId: 'm', deltaText: 'ok' }), trailer()])]);
  const result = await providerWithRows(server, [row]).send([{ role: 'user', content: 'x' }], 'gpt-5', [], {
    effort: 'low',
  });
  assert.equal(server.chat[0].request.chatModelUid, 'gpt-5-low');
  assert.equal(result.providerReplay.items[0].model, 'gpt-5', 'replay identity is the family id');
});

test('a router row is assigned per turn before chat and the assignment rides the chat request', async () => {
  assert.ok(HAS_ASSIGN_SCHEMA);
  const router = { id: 'adaptive', uid: 'adaptive', router: true, supportsVision: false };
  const server = fakeDevin(
    [
      streamReply([data({ deltaText: 'one', actualModelUid: 'gpt-5-codex' }), trailer()]),
      streamReply([data({ deltaText: 'two' }), trailer()]),
    ],
    {
      apiHost: API_HOST,
      assignments: [
        { assignmentJwt: 'assign-1', modelUid: 'claude-sonnet-4-5' },
        { assignmentJwt: 'assign-2', modelUid: 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW' },
        { assignmentJwt: '', modelUid: '' },
      ],
    }
  );
  const devin = providerWithRows(server, [router]);
  const messages = [
    { role: 'user', content: 'older turn' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'route me' },
  ];
  const tools = [
    {
      name: 'grep',
      description: 'Search',
      inputSchema: { type: 'object', properties: { skip: { type: ['number', 'null'] } } },
    },
  ];
  const first = await devin.send(messages, 'adaptive', tools, { sessionId: 'cascade-42' });
  assert.equal(first.model, 'gpt-5-codex', 'the stream-reported uid overrides the assignment');
  assert.deepEqual(server.paths, [
    '/exa.auth_pb.AuthService/GetUserJwt',
    '/exa.api_server_pb.ApiServerService/AssignModel',
    '/exa.api_server_pb.ApiServerService/GetChatMessage',
  ]);
  const [{ url, request: assign }] = server.assign;
  assert.equal(url, `${API_HOST}/exa.api_server_pb.ApiServerService/AssignModel`);
  assert.equal(assign.modelRouterUid, 'adaptive');
  assert.equal(assign.cascadeId, 'cascade-42');
  assert.equal(assign.metadata.apiKey, 'devin-session-token$tok-A');
  assert.equal(assign.metadata.userJwt, undefined);
  assert.equal(assign.metadata.ideName, 'devin-cli');
  assert.equal(assign.chatMessagePrompt.messageId, undefined);
  assert.equal(assign.chatMessagePrompt.source, ChatMessageSource.USER);
  assert.equal(assign.chatMessagePrompt.prompt, 'route me');
  const chat = server.chat[0].request;
  assert.equal(chat.chatModelUid, 'claude-sonnet-4-5');
  assert.equal(chat.modelAssignmentJwt, 'assign-1');
  assert.equal(chat.cascadeId, 'cascade-42');
  assert.deepEqual(JSON.parse(chat.tools[0].jsonSchemaString).properties.skip, { type: ['number', 'null'] });

  // Every turn is assigned afresh; a Gemini assignment normalizes tool schemas.
  const secondResult = await devin.send(messages, 'adaptive', tools, { sessionId: 'cascade-42' });
  assert.equal(secondResult.model, 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW', 'the assigned uid served the turn');
  const second = server.chat[1].request;
  assert.equal(second.chatModelUid, 'MODEL_GOOGLE_GEMINI_3_0_FLASH_LOW');
  assert.equal(second.modelAssignmentJwt, 'assign-2');
  assert.deepEqual(JSON.parse(second.tools[0].jsonSchemaString).properties.skip, { type: 'number', nullable: true });

  // An incomplete assignment fails the turn without chatting with the router uid.
  await assert.rejects(devin.send(messages, 'adaptive', [], {}), /no assignment/);
  assert.equal(server.chat.length, 2);
});

test('a non-router model skips assignment', async () => {
  const server = fakeDevin([streamReply([data({ deltaText: 'ok' }), trailer()])]);
  await provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], { sessionId: 'session-7' });
  assert.ok(!server.paths.includes('/exa.api_server_pb.ApiServerService/AssignModel'));
  assert.equal(server.chat[0].request.modelAssignmentJwt, undefined);
  assert.equal(server.chat[0].request.cascadeId, 'session-7');
});

test('the model catalog is fetched once per account and keeps the catalog context windows', async () => {
  const server = fakeDevin();
  const devin = provider(server, 'tok-A');
  const models = await devin.listModels();
  assert.deepEqual(
    models.map((m) => [m.id, m.contextWindow, m.outputTokens, m.supportsVision, m.reasoning]),
    [
      ['claude-x', 300_000, 32_000, true, true],
      ['gpt-y', 128_000, 64_000, false, false],
    ]
  );
  await devin.listModels();
  assert.equal(server.models, 1);
  assert.equal(devin.getCachedModelInfo('gpt-y').contextWindow, 128_000);
  devin.config.accessToken = 'tok-B';
  await devin.listModels();
  assert.equal(server.models, 2);
  assert.deepEqual(server.modelTokens, ['devin-session-token$tok-A', 'devin-session-token$tok-B']);
  devin.config.accessToken = 'tok-A';
  await devin.listModels();
  assert.equal(server.models, 2, 'account A is still cached');
  await devin._refreshModelCache();
  assert.equal(server.models, 3);
});

test('effort families list their levels, default effort and required effort; sends route by effort', async () => {
  const thinking = { modelInfo: { modelFeatures: { supportsThinking: true, supportsToolCalls: true } } };
  const models = [
    'gpt-5-6-sol-none',
    'gpt-5-6-sol-low',
    'gpt-5-6-sol-high',
    'gemini-3-7-flash-low',
    'gemini-3-7-flash-medium',
  ].map((modelUid) => ({ modelUid, label: modelUid, ...thinking }));
  const server = fakeDevin(
    [streamReply([data({ deltaText: 'a' }), trailer()]), streamReply([data({ deltaText: 'b' }), trailer()])],
    { models, defaultUid: 'gpt-5-6-sol-high' }
  );
  const devin = provider(server);
  const byId = Object.fromEntries((await devin.listModels()).map((model) => [model.id, model]));
  const sol = byId['gpt-5-6-sol'];
  assert.deepEqual(sol.reasoningLevels, ['none', 'low', 'medium', 'high', 'xhigh', 'max']);
  assert.deepEqual(sol.reasoningOptions, [{ type: 'effort', values: sol.reasoningLevels }]);
  assert.equal(sol.defaultEffort, 'high', 'the account default uid sets the family default');
  assert.equal(sol.requiresEffort, undefined);
  assert.equal(sol.isDefault, true, 'the account default model is flagged');
  const flash = byId['gemini-3-7-flash'];
  assert.deepEqual(flash.reasoningLevels, ['minimal', 'low', 'medium', 'high']);
  assert.equal(flash.defaultEffort, 'medium');
  assert.equal(flash.requiresEffort, true);

  await devin.send([{ role: 'user', content: 'x' }], 'gpt-5-6-sol', [], { effort: 'low' });
  await devin.send([{ role: 'user', content: 'x' }], 'gemini-3-7-flash', [], {});
  assert.deepEqual(
    server.chat.map((entry) => entry.request.chatModelUid),
    ['gpt-5-6-sol-low', 'gemini-3-7-flash-medium']
  );
});

const HARMONY_CALL =
  'Reading.<|start|>assistant<|channel|>commentary to=functions.read <|constrain|>json<|message|>{"path":"a.ts"}<|call|>';

test('tool-call-shaped text stays text: only deltaToolCalls become calls', async () => {
  const server = fakeDevin([streamReply([data({ deltaText: HARMONY_CALL }), trailer()])]);
  const texts = [];
  const dispatched = [];
  const result = await provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', TOOLS, {
    onTextDelta: (text) => texts.push(text),
    onToolCall: (call) => dispatched.push(call),
  });
  assert.equal(result.content, HARMONY_CALL);
  assert.equal(texts.join(''), HARMONY_CALL);
  assert.equal(result.toolCalls, undefined);
  assert.equal(result.stopReason, 'stop');
  assert.equal(dispatched.length, 0);

  // The consumer default (other providers) still recovers the leaked call.
  async function* chunks() {
    yield { choices: [{ index: 0, delta: { content: HARMONY_CALL } }] };
    yield { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] };
  }
  const recovered = await consumeCompatChatCompletionStream(chunks(), {
    label: 'compat',
    providerName: 'compat',
    parseToolCalls: () => undefined,
    knownToolNames: new Set(['read']),
  });
  assert.equal(recovered.toolCalls?.[0]?.name, 'read');
});

test('final tool arguments: blank is {}, malformed JSON is repaired, unrepairable is the invalid marker', async () => {
  const cases = [
    ['  \n ', {}],
    ["{'path': 'it's.ts', mode: True,}", { path: "it's.ts", mode: true }],
    ['{"paths": src/*, "n": 0x10 // note\n}', { paths: 'src/*', n: 16 }],
    ['{"a": "x\\qy"}', { a: 'x\\qy' }],
  ];
  const server = fakeDevin(
    cases.map(([raw], i) =>
      streamReply([data({ deltaToolCalls: [{ id: `c${i}`, name: 'read', argumentsJson: raw }] }), trailer()])
    )
  );
  const devin = provider(server);
  for (const [, expected] of cases) {
    const result = await devin.send([{ role: 'user', content: 'x' }], 'claude-x', TOOLS, {});
    assert.deepEqual(result.toolCalls[0].arguments, expected);
  }
  assert.deepEqual(parseDevinToolArguments(undefined), {});
  for (const raw of ['{"a": foo "b": 1}', '{"a": 1} trailing', '{"a": NaN}', '{"a": "open']) {
    const marker = parseDevinToolArguments(raw);
    assert.equal(marker.__invalidToolArgs, true, raw);
    assert.equal(marker.__rawArguments, raw);
  }
  assert.equal(Object.getPrototypeOf(parseDevinToolArguments("{'__proto__': {x: 1}}")), Object.prototype);
});

test('bigint usage counters leave the provider as numbers', async () => {
  const server = fakeDevin([
    streamReply([data({ deltaText: 'ok', usage: { inputTokens: 2n ** 40n, outputTokens: 3n } }), trailer()]),
  ]);
  const result = await provider(server).send([{ role: 'user', content: 'x' }], 'claude-x', [], {});
  assert.equal(result.usage.inputTokens, 2 ** 40);
  assert.equal(result.usage.outputTokens, 3);
  assert.equal(typeof result.usage.raw.inputTokens, 'number');
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('the registry constructor export is the Devin provider', () => {
  const instance = new DevinOAuthProvider();
  assert.equal(instance.name, 'devin-oauth');
  assert.equal(instance.nativePdf, false);
  assert.equal(DevinOAuthProvider.inputExcludesCache, true);
});
