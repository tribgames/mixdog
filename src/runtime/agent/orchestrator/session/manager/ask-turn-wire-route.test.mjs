// The session's wire is pinned at turn start, before the request boundary,
// and travels with the turn's send options.
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { resolveWireRoute } from '../../providers/wire-route.mjs';

const provider = {
  name: 'openrouter',
  config: {},
  getCachedModelInfo: () => null,
  resolveWireRoute: async (model, ctx) => resolveWireRoute('openrouter', model, ctx),
};

mock.module('../../providers/registry.mjs', {
  namedExports: { ...(await import('../../providers/registry.mjs')), getProvider: () => provider },
});
mock.module('./ask-turn-auto-effort.mjs', {
  namedExports: {
    ...(await import('./ask-turn-auto-effort.mjs')),
    resolveTurnAutoEffort: async () => ({ applied: false }),
  },
});
mock.module('./ask-turn-prepare.mjs', {
  namedExports: {
    ...(await import('./ask-turn-prepare.mjs')),
    applyTurnContextMeta: () => {},
    traceTurnContext: () => {},
    startProviderPrewarm: () => null,
    buildUserTurn: async ({ session }) => {
      const userTurnMessage = { role: 'user', content: 'go', meta: {} };
      const historyMessages = session.messages.slice();
      return { historyMessages, outgoing: [...historyMessages, userTurnMessage], userTurnMessage };
    },
  },
});
mock.module('../store.mjs', {
  namedExports: { ...(await import('../store.mjs')), saveSessionAsync: async () => {} },
});

const { prepareAskTurn } = await import('./ask-turn-execute.mjs');
const { buildRequestSendOptions } = await import('./ask-turn-loop-options.mjs');

const opened = (session) => ({
  turn: { session },
  runtime: {},
  turnSignal: new AbortController().signal,
  askGeneration: 1,
  checkpoint: { schedule() {} },
  turnToken: 't',
  startedAt: Date.now(),
  codexTurnId: null,
});

const sessionWith = (fields) => ({
  provider: 'openrouter',
  model: 'anthropic/claude-opus-4.8',
  messages: [],
  cwd: process.cwd(),
  sessionStartMetaInjected: true,
  title: 'kept',
  ...fields,
});

test('a new session pins its fresh wire at turn start and sends with it', async () => {
  const session = sessionWith({ wireRoute: null });
  await prepareAskTurn({ sessionId: 'n1', opened: opened(session), input: { prompt: 'go' } });
  assert.equal(session.wireRoute.wire, 'messages');
  assert.equal(buildRequestSendOptions({ sessionId: 'n1', session }).wireRoute, session.wireRoute);
  // Later turns reuse the pin.
  const pinned = session.wireRoute;
  await prepareAskTurn({ sessionId: 'n1', opened: opened(session), input: { prompt: 'again' } });
  assert.equal(session.wireRoute, pinned);
});

test('a new session records verified native deferred-tool support at the turn-start pin', async () => {
  const { PROFILES } = await import('../../providers/wire-route.mjs');
  const flags = PROFILES.openrouter.nativeDeferredTools;
  flags.messages = true;
  try {
    const session = sessionWith({ wireRoute: null });
    await prepareAskTurn({ sessionId: 'n2', opened: opened(session), input: { prompt: 'go' } });
    // Pinned in prepareAskTurn, before the request boundary decides the surface.
    assert.equal(session.wireRoute.nativeDeferredTools, true);
    // The next turn finds history: an answered session keeps what it pinned.
    const answered = sessionWith({ messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }], wireRoute: null });
    await prepareAskTurn({ sessionId: 'n3', opened: opened(answered), input: { prompt: 'go' } });
    assert.equal(answered.wireRoute.wire, 'messages');
    assert.equal(answered.wireRoute.nativeDeferredTools, undefined);
  } finally {
    flags.messages = false;
  }
});

test('a session started before the per-model table keeps its original wire', async () => {
  const session = sessionWith({
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ],
  });
  await prepareAskTurn({ sessionId: 'l1', opened: opened(session), input: { prompt: 'go' } });
  assert.equal(session.wireRoute.wire, 'chat');
  assert.equal(session.wireRoute.source, 'legacy');
});
