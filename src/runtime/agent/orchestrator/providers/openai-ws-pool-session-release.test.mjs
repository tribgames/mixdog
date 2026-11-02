// A closed session leaves no pooled socket behind, even when an account pool
// keyed its connections by account-scoped ids, and a pooled socket never keeps
// the request that opened it (its session, transcript, tools) reachable.
// Import before runtime modules: several paths are captured at module load.
import '../tools/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { EventEmitter } from 'node:events';
import { mock, test } from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';

// Account-store writes on Windows would spawn icacls for each file.
mock.module(new URL('../../../shared/file-permissions.mjs', import.meta.url).href, {
  namedExports: { enforceOwnerOnlyAclWin32() {}, async enforceOwnerOnlyAclWin32Async() {} },
});

const { registerProviderAccount, changeProviderAccounts, newProviderAccountId, accountScopedSessionIdsOf } =
  await import('../../../shared/provider-accounts.mjs');
const { createAccountPoolProvider } = await import('./account-pool.mjs');
const { _wsPool, acquireWebSocket, releaseWebSocket, _clearWebSocketPoolForTest, _setOpenSocketForTest } = await import(
  './openai-ws-pool.mjs'
);
const { _anchorResponseChain, _computeDelta } = await import('./openai-ws-delta.mjs');
const { createSocketHandlers } = await import('./openai-ws-stream/socket-handlers.mjs');
const { abortSessionTurn, closeSession, unloadSessionRuntime } = await import('../session/manager/session-close.mjs');
const { _clearSessionRuntime, _touchRuntime } = await import('../session/manager/runtime-liveness.mjs');
const { deleteSession } = await import('../session/store/session-delete.mjs');
const { runWithProviderRequestToolsScope } = await import('../runtime-core/provider-request-tools.mjs');

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc');

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.readyState = 1;
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }

  terminate() {
    this.close();
  }
}

const AUTH = { type: 'openai-direct', apiKey: 'k' };

function useFakeSockets(t, onOpen = () => {}) {
  const opened = [];
  _clearWebSocketPoolForTest();
  _setOpenSocketForTest(async () => {
    const socket = new FakeSocket();
    onOpen(socket);
    opened.push(socket);
    return { socket };
  });
  t.after(() => {
    _clearWebSocketPoolForTest();
    _setOpenSocketForTest();
  });
  return opened;
}

// One connected account: every send runs under an account-scoped transport key.
const ACCOUNT_PROVIDER = 'openai-oauth';
{
  const accountId = newProviderAccountId();
  await registerProviderAccount(ACCOUNT_PROVIDER, accountId, { label: 'Only' });
  await changeProviderAccounts(ACCOUNT_PROVIDER, { selectedId: accountId, policy: 'limit', useCredits: false });
}

/** The account pool over a transport that keys, chains and anchors its pooled
 *  socket the way the WS transport does (openai-oauth.mjs, openai-ws-delta.mjs). */
const pooled = createAccountPoolProvider(ACCOUNT_PROVIDER, () => ({
  async send(messages, model, _tools, opts) {
    const poolKey = opts.transportScope || opts.sessionId;
    const { entry, reused } = await acquireWebSocket({ auth: AUTH, poolKey, cacheKey: 'cache', codexHeaders: {} });
    const input = messages.map(({ role, content }) => ({
      type: 'message',
      role,
      content: [{ type: 'input_text', text: content }],
    }));
    const body = { model, input };
    const { mode, frame } = _computeDelta({ entry, body, traceProvider: ACCOUNT_PROVIDER });
    _anchorResponseChain(entry, { responseId: `resp-${messages.length}`, requestBody: body, responseItems: [] });
    releaseWebSocket({ entry, poolKey, keep: true });
    return {
      content: 'ok',
      reused,
      mode,
      previousResponseId: frame.previous_response_id ?? null,
      socket: entry.socket,
      poolKey,
    };
  },
}));
const userTurns = (count) => Array.from({ length: count }, (_, i) => ({ role: 'user', content: `turn ${i + 1}` }));
const send = (sessionId, turns = 1) => pooled.send(userTurns(turns), 'gpt-test', [], { sessionId });

function useDeltaTransport(t) {
  const prior = process.env.MIXDOG_OAI_TRANSPORT;
  process.env.MIXDOG_OAI_TRANSPORT = 'ws-delta';
  t.after(() => {
    if (prior == null) delete process.env.MIXDOG_OAI_TRANSPORT;
    else process.env.MIXDOG_OAI_TRANSPORT = prior;
  });
}

test('unloading a settled turn keeps the session socket; the follow-up is a delta on it', async (t) => {
  useFakeSockets(t);
  useDeltaTransport(t);
  const id = 'sess_release_settled';
  const first = await send(id, 1);
  assert.notEqual(first.poolKey, id, 'the account pool scopes the transport key');
  assert.equal(first.mode, 'full');

  assert.equal(unloadSessionRuntime(id, 'agent-turn-complete'), true);
  assert.equal(first.socket.readyState, 1, 'the settled session keeps its socket');
  assert.deepEqual(accountScopedSessionIdsOf(id), [first.poolKey], 'and its record');

  const followUp = await send(id, 2);
  assert.equal(followUp.reused, true);
  assert.equal(followUp.socket, first.socket);
  assert.equal(followUp.mode, 'delta');
  assert.equal(followUp.previousResponseId, 'resp-1');
});

test('closing a session closes its account-scoped sockets and drops its record; a live session keeps reusing its own', async (t) => {
  useFakeSockets(t);
  const closing = await send('sess_release_closing');
  const live = await send('sess_release_live');
  assert.equal(_wsPool.has(closing.poolKey), true);

  assert.equal(closeSession('sess_release_closing', 'test-delete'), true);
  assert.equal(closing.socket.readyState, 3, 'the closed session socket is closed');
  assert.equal(_wsPool.has(closing.poolKey), false, 'the pool keeps no entry for the closed session');
  assert.deepEqual(accountScopedSessionIdsOf('sess_release_closing'), []);

  assert.equal(live.socket.readyState, 1);
  const again = await send('sess_release_live');
  assert.equal(again.reused, true, 'the live session reuses its socket');
  assert.equal(again.socket, live.socket);
});

test('reaping a stored session closes its account-scoped sockets and drops its record', async (t) => {
  useFakeSockets(t);
  const reaped = await send('sess_release_reaped');
  assert.equal(deleteSession('sess_release_reaped', { deferSummaryUpdate: true }), true);
  assert.equal(reaped.socket.readyState, 3);
  assert.equal(_wsPool.has(reaped.poolKey), false);
  assert.deepEqual(accountScopedSessionIdsOf('sess_release_reaped'), []);
});

test('a turn abort closes the in-flight socket only; a healthy idle one stays', async (t) => {
  useFakeSockets(t);
  const id = 'sess_release_abort';
  t.after(() => _clearSessionRuntime(id));
  const idle = await send(id);
  _touchRuntime(id);
  assert.equal(abortSessionTurn(id, 'user-cancel'), true);
  assert.equal(idle.socket.readyState, 1, 'the idle socket survives the abort');
  assert.deepEqual(accountScopedSessionIdsOf(id), [idle.poolKey]);

  const { entry } = await acquireWebSocket({ auth: AUTH, poolKey: idle.poolKey, cacheKey: 'cache', codexHeaders: {} });
  assert.equal(entry.socket, idle.socket);
  assert.equal(abortSessionTurn(id, 'user-cancel'), true);
  assert.equal(entry.socket.readyState, 3, 'the in-flight socket is closed');
  releaseWebSocket({ entry, poolKey: idle.poolKey, keep: false });
});

test('a pooled socket and its timers do not keep the session of the request that opened it', async (t) => {
  const handles = [];
  // Stands in for the transport handle a real socket holds for its whole life.
  const opened = useFakeSockets(t, () => handles.push(setInterval(() => {}, 60_000).unref()));
  t.after(() => handles.forEach(clearInterval));
  const args = { auth: AUTH, poolKey: 'sess_context', cacheKey: 'cache', codexHeaders: {} };

  let session = { id: 'sess_context', messages: [{ role: 'user', content: 'x'.repeat(1024) }] };
  const collected = new WeakRef(session);
  await runWithProviderRequestToolsScope(
    { session, provider: 'openai-oauth', messages: session.messages, requestTools: [] },
    async () => {
      const { entry } = await acquireWebSocket(args);
      releaseWebSocket({ entry, poolKey: args.poolKey, keep: true });
    }
  );
  session = null;
  for (let i = 0; i < 5 && collected.deref(); i++) {
    await new Promise((resolve) => setImmediate(resolve));
    gc();
  }
  assert.equal(collected.deref(), undefined, 'the finished request session is collectable');

  const again = await acquireWebSocket(args);
  assert.equal(again.reused, true);
  assert.equal(again.entry.socket, opened[0]);
  releaseWebSocket({ entry: again.entry, poolKey: args.poolKey, keep: true });
});

test('a reused socket delivers each stream its own request context', () => {
  const request = new AsyncLocalStorage();
  const socket = new FakeSocket();
  const seen = [];
  const handlersFor = (name) =>
    request.run(name, () =>
      createSocketHandlers({
        socket,
        entry: {},
        externalSignal: null,
        midState: { sessionId: null },
        response: { model: 'gpt-test' },
        errLabel: 'OpenAI WS',
        maxIncomingFrameBytes: 0,
        watchdogs: { resetIdle() {} },
        traceProvider: 'openai',
        onEvent: () => seen.push(request.getStore()),
        outcome: {},
        finish() {},
      })
    );
  const frame = JSON.stringify({ type: 'response.output_text.delta', delta: 'x' });
  for (const name of ['first-request', 'second-request']) {
    const handlers = handlersFor(name);
    handlers.attach();
    socket.emit('message', frame);
    handlers.detach();
  }
  assert.deepEqual(seen, ['first-request', 'second-request']);
  assert.equal(socket.listenerCount('message'), 0);
});
