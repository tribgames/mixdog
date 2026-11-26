// The phone's setVisibleSessions over the real chat adapter, protocol client (mock transport) and lane store.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../packages/protocol-client/src/mock.ts';
import { installTestDom } from './test-support/test-dom.mjs';

const protocolOptions = JSON.parse(
  readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));
const row = (id) => ({ id, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null });

/** A core that answers `thread/resume` with a subscription and the thread's snapshot, and anything else with `{}`. */
const serve = (request, conn) => {
  if (request.method !== 'thread/resume') return conn.serverSend({ id: request.id, result: {} });
  const { threadId } = request.params;
  conn.serverSend({
    id: request.id,
    result: { thread: row(threadId), subscription: { id: 's1', mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
  });
  conn.serverSend({
    method: 'thread/snapshot',
    params: { thread: row(threadId), items: [], state: { title: 'T' }, hasOlder: false },
    feed: { id: threadId, epoch: 'e1', seq: 1 },
  });
};

async function connectedClient(t) {
  const net = new MockNetwork();
  const connecting = connect({
    target: { id: 'local' },
    connector: net,
    clientInfo: protocolOptions.clientInfo,
    capabilities: protocolOptions.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...protocolOptions.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  void (async () => {
    for (;;) serve(JSON.parse(await conn.nextSent()), conn);
  })();
  const client = await connecting;
  t.after(() => client.close());
  return client;
}

test('a session the first sync restored before its pane named it is current on the page once the page names it', async (t) => {
  installTestDom(t, { actEnvironment: false });
  const { phoneChatAdapter } = await import('./remote-protocol-chat.ts');
  const { createRemoteSessionInbox } = await import('./remote-session-inbox.ts');
  const { createSessionLaneStore } = await import('./session-lane-store.ts');
  const { createRemoteApi } = await import('./remote-shim-api.ts');
  const client = await connectedClient(t);
  const ctx = {
    sessionsCatalog: { publish() {} },
    sessionInbox: createRemoteSessionInbox({ onGap() {} }),
    viewSettledListeners: new Set(),
    phone: {
      start: () => Promise.resolve(),
      // The view already has the thread open, as it does for a restored one: naming it attaches nothing.
      setVisibleSessions: async () => true,
      follows: (threadId) => client.store.thread(threadId) !== undefined,
    },
  };
  const host = { ctx, client: () => client, declareLane() {}, onClient: (listener) => (listener(client), () => {}) };
  const adapter = phoneChatAdapter();
  t.after(adapter.install(host));
  ctx.call = (method, params) => adapter.calls[method](params, host);
  const store = createSessionLaneStore();
  ctx.sessionInbox.subscribe((update) => store.apply(update));
  const api = createRemoteApi(ctx);

  // The first sync of the connection restores the last visit's thread; its state reaches the page before any pane shows it.
  await client.resumeThread('t1', { lastItems: 50 }, { join: true, follow: true });
  await settled();
  // A pane shows it (use-visible-sessions.ts): the lane store learns it first, then the view is told.
  store.setShownSessionIds(['t1']);
  assert.equal(await api.setVisibleSessions(['t1']), true);
  await settled();

  assert.equal(store.liveSessionIds().has('t1'), true);
});
