import assert from 'node:assert/strict';
import test from 'node:test';

import {
  directHandshakeError,
  OpenAIOAuthProvider,
  sendViaWebSocket,
} from './_shared.mjs';

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

test('OpenAI OAuth handshake 404 falls back to HTTP once without catalog or WS retries', async (t) => {
  withOpenAiTransportEnv(t);
  const provider = oauthProvider();
  let acquires = 0;
  let httpCalls = 0;
  let catalogRefreshes = 0;
  provider._refreshModelCache = async () => { catalogRefreshes += 1; };

  const result = await provider.send([], 'gpt-5.6-sol', [], {
    sessionId: 'oauth-handshake-404',
    _prebuiltBody: prebuiltBody,
    _sendViaWebSocketFn: (args) => sendViaWebSocket({
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
  provider._refreshModelCache = async () => { catalogRefreshes += 1; };

  await assert.rejects(provider.send([], 'gpt-5.6-sol', [], {
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
  }), /model_not_found/u);

  assert.equal(wsCalls, 2, 'one catalog refresh retry remains allowed');
  assert.equal(httpCalls, 0);
  assert.equal(catalogRefreshes, 1);
});
