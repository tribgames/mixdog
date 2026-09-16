import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { _streamResponse } from '../../src/runtime/agent/orchestrator/providers/openai-ws-stream.mjs';
import { classifyError } from '../../src/runtime/agent/orchestrator/providers/retry-classifier.mjs';

import { directHandshakeError, OpenAIOAuthProvider, sendViaWebSocket } from './_shared.mjs';

function withOpenAiTransportEnv(t) {
  const names = [
    'MIXDOG_AGENT_TRACE_DISABLE',
    'MIXDOG_OAI_TRANSPORT',
    'MIXDOG_OPENAI_HTTP_FALLBACK',
    'MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK',
    'MIXDOG_QUIET_PROVIDER_LOG',
  ];
  const saved = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    MIXDOG_AGENT_TRACE_DISABLE: '1',
    MIXDOG_OAI_TRANSPORT: 'auto',
    MIXDOG_OPENAI_HTTP_FALLBACK: '1',
    MIXDOG_OPENAI_OAUTH_HTTP_FALLBACK: '1',
    MIXDOG_QUIET_PROVIDER_LOG: '1',
  });
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value == null) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function oauthProvider() {
  const provider = new OpenAIOAuthProvider({});
  provider.ensureAuth = async () => ({ access_token: 'fixture-token' });
  return provider;
}

const prebuiltBody = Object.freeze({
  model: 'gpt-5.6-sol',
  instructions: 'fixture',
  input: [],
  tools: [],
  stream: true,
});

function streamEntry() {
  const socket = new EventEmitter();
  socket.readyState = 1;
  socket.close = () => {
    socket.readyState = 3;
  };
  socket.terminate = socket.close;
  return { socket, ephemeral: true };
}

function closeAfterReasoning(args, type) {
  const pending = _streamResponse({ ...args, logSuppressedReasoningDeltas: false });
  const socket = args.entry.socket;
  for (const event of [
    { type: 'response.created', response: { id: 'reasoning-response', model: prebuiltBody.model } },
    { type, delta: 'hidden reasoning' },
  ]) {
    socket.emit('message', Buffer.from(JSON.stringify(event)));
  }
  socket.close();
  socket.emit('close', 1006, Buffer.alloc(0));
  return pending;
}

for (const type of [
  'response.reasoning_text.delta',
  'response.reasoning_summary_text.delta',
  'response.reasoning.summary.delta',
]) {
  test(`suppressed ${type} permits a fresh WS retry without relaying text`, async (t) => {
    withOpenAiTransportEnv(t);
    const fresh = [];
    const progress = [];
    const text = [];
    let streams = 0;
    const result = await sendViaWebSocket({
      auth: { access_token: 'fixture-token' },
      body: prebuiltBody,
      useModel: prebuiltBody.model,
      onStreamDelta: (kind) => progress.push(kind),
      onTextDelta: (delta) => text.push(delta),
      _acquireWithRetryFn: async ({ forceFresh }) => {
        fresh.push(forceFresh);
        return { entry: streamEntry(), reused: false };
      },
      _sendFrameFn: async () => {},
      _streamFn: async (args) => {
        streams += 1;
        if (streams === 1) return closeAfterReasoning(args, type);
        args.state.sawCompleted = true;
        return { content: 'ws-recovered', toolCalls: [] };
      },
      _sleepFn: async () => {},
      _sendSpanTraceFn: () => {},
      _agentTraceFn: () => {},
    });
    assert.equal(result.content, 'ws-recovered');
    assert.deepEqual(fresh, [false, true]);
    assert.ok(progress.includes('reasoning'), 'suppression must not remove liveness progress');
    assert.deepEqual(text, [], 'hidden reasoning never reaches the text callback');
  });
}

test('reasoning-only WS closes exhaust the bounded WS budget and switch the session to HTTP', async (t) => {
  withOpenAiTransportEnv(t);
  const provider = oauthProvider();
  let acquires = 0;
  let httpCalls = 0;
  const delays = [];
  const opts = {
    sessionId: 'oauth-reasoning-close-fallback',
    _prebuiltBody: prebuiltBody,
    _sendViaWebSocketFn: (args) =>
      sendViaWebSocket({
        ...args,
        _acquireWithRetryFn: async () => {
          acquires += 1;
          return { entry: streamEntry(), reused: false };
        },
        _sendFrameFn: async () => {},
        _streamFn: (request) => closeAfterReasoning(request, 'response.reasoning_summary_text.delta'),
        _sleepFn: async (ms) => {
          delays.push(ms);
        },
        _sendSpanTraceFn: () => {},
        _agentTraceFn: () => {},
      }),
    _sendViaHttpSseFn: async () => {
      httpCalls += 1;
      return { content: 'http-recovered', toolCalls: [] };
    },
  };
  assert.equal((await provider.send([], prebuiltBody.model, [], opts)).content, 'http-recovered');
  assert.equal(acquires, 6, 'one initial connection plus five WS retries');
  assert.equal(delays.length, 5);
  for (const [index, base] of [200, 400, 800, 1600, 3200].entries()) {
    assert.ok(delays[index] >= base * 0.9 && delays[index] <= base * 1.1);
  }
  assert.equal(httpCalls, 1);
  await provider.send([], prebuiltBody.model, [], opts);
  assert.equal(acquires, 6, 'the next send must keep the HTTP fallback');
  assert.equal(httpCalls, 2);
});

for (const authRetry of [false, true]) {
  for (const [label, fields, classification] of [
    ['401', { httpStatus: 401 }, 'auth'],
    ['403', { httpStatus: 403 }, 'auth'],
    ['429', { httpStatus: 429, retryAfterMs: 15000 }, 'permanent'],
    ['503', { httpStatus: 503 }, 'transient'],
    ['unknown', {}, 'unknown'],
    ['cancelled', { name: 'AbortError' }, 'permanent'],
    ['visible text', { liveTextEmitted: true, unsafeToRetry: true }, 'permanent'],
    ['dispatched tool', { emittedToolCall: true, unsafeToRetry: true }, 'permanent'],
  ]) {
    test(`HTTP ${label} remains the current failure after ${authRetry ? 'auth recovery and ' : ''}WS fallback`, async (t) => {
      withOpenAiTransportEnv(t);
      const provider = oauthProvider();
      const wsError = Object.assign(new Error('WS disconnected'), {
        wsCloseCode: 1006,
        code: 'ECONNRESET',
        retryClassifier: 'ws_1006',
        wsRetriesExhausted: true,
      });
      const httpCause = new Error('current HTTP cause');
      const httpError = Object.assign(new Error('current HTTP failure', { cause: httpCause }), fields);
      let wsCalls = 0;
      let httpCalls = 0;
      let failHttp = true;
      const opts = {
        sessionId: `oauth-current-http-${authRetry}-${label}`,
        _prebuiltBody: prebuiltBody,
        _sendViaWebSocketFn: async () => {
          wsCalls += 1;
          if (authRetry && wsCalls === 1) throw Object.assign(new Error('expired auth'), { httpStatus: 401 });
          throw wsError;
        },
        _sendViaHttpSseFn: async () => {
          httpCalls += 1;
          if (failHttp) throw httpError;
          return { content: 'http-ok', toolCalls: [] };
        },
      };
      await assert.rejects(provider.send([], prebuiltBody.model, [], opts), (error) => {
        assert.equal(error, httpError);
        assert.equal(error.cause, httpCause, 'the current cause must not be replaced');
        assert.equal(error.previousTransportError, wsError, 'keep diagnostic WS history');
        assert.equal(classifyError(error), classification, 'stale WS history must not change the decision');
        return true;
      });
      assert.equal(wsCalls, authRetry ? 2 : 1);
      assert.equal(httpCalls, 1);
      failHttp = false;
      await provider.send([], prebuiltBody.model, [], opts);
      assert.equal(wsCalls, authRetry ? 2 : 1, 'HTTP failure must not reset the sticky transport');
      assert.equal(httpCalls, 2);
    });
  }
}

test('OpenAI OAuth handshake 404 falls back to HTTP once without catalog or WS retries', async (t) => {
  withOpenAiTransportEnv(t);
  const provider = oauthProvider();
  let acquires = 0;
  let httpCalls = 0;
  let catalogRefreshes = 0;
  provider._refreshModelCache = async () => {
    catalogRefreshes += 1;
  };

  const result = await provider.send([], 'gpt-5.6-sol', [], {
    sessionId: 'oauth-handshake-404',
    _prebuiltBody: prebuiltBody,
    _sendViaWebSocketFn: (args) =>
      sendViaWebSocket({
        ...args,
        _acquireWithRetryFn: async () => {
          acquires += 1;
          throw directHandshakeError(404);
        },
        _sleepFn: async () => {},
        _sendSpanTraceFn: () => {},
        _agentTraceFn: () => {},
      }),
    _sendViaHttpSseFn: async () => {
      httpCalls += 1;
      return { content: 'http-ok', toolCalls: [] };
    },
  });

  assert.equal(result.content, 'http-ok');
  assert.equal(acquires, 1);
  assert.equal(httpCalls, 1);
  assert.equal(catalogRefreshes, 0);
});

test('OpenAI OAuth application 404 remains a model error and never enters HTTP fallback', async (t) => {
  withOpenAiTransportEnv(t);
  const provider = oauthProvider();
  let wsCalls = 0;
  let httpCalls = 0;
  let catalogRefreshes = 0;
  provider._refreshModelCache = async () => {
    catalogRefreshes += 1;
  };

  await assert.rejects(
    provider.send([], 'gpt-5.6-sol', [], {
      sessionId: 'oauth-application-404',
      _prebuiltBody: prebuiltBody,
      _sendViaWebSocketFn: async () => {
        wsCalls += 1;
        throw Object.assign(new Error('model_not_found'), { httpStatus: 404 });
      },
      _sendViaHttpSseFn: async () => {
        httpCalls += 1;
        return { content: 'must-not-fallback', toolCalls: [] };
      },
    }),
    /model_not_found/u
  );

  assert.equal(wsCalls, 2, 'one catalog refresh retry remains allowed');
  assert.equal(httpCalls, 0);
  assert.equal(catalogRefreshes, 1);
});
