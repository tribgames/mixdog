// The phone's Retry of a transcript that did not arrive, through the layers a call crosses on the phone: the shim's router and its
// gate (the real view sync), the connection's call queue, then the chat adapter's handler over the real protocol client.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../packages/protocol-client/src/mock.ts';
import { createViewManager } from '../../../mobile/src/phone-view.ts';
import { phoneChatAdapter } from './remote-protocol-chat.ts';
import { createRemoteSessionInbox } from './remote-session-inbox.ts';
import { createProtocolRouter } from './remote-shim-protocol.ts';

const protocolOptions = JSON.parse(
  readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8')
);

// The router arms a per-call deadline on the page's window timers: this window never fires one.
globalThis.window = { setTimeout: () => 0, clearTimeout() {} };

const until = async (what, reached) => {
  for (let i = 0; i < 300; i += 1) {
    if (reached()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${what}`);
};
const row = (id) => ({
  id,
  preview: '',
  title: '',
  updatedAt: 1,
  messageCount: 0,
  cwd: '/w',
  classification: {},
  projectPath: null,
});

test("Retry opens the thread again while the view sync and a queued prefetch still wait for the visible thread's unanswered resume", async (t) => {
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
  const client = await connecting;

  // The core: every request is answered but a `thread/resume` while `silent`.
  const resumes = [];
  let silent = true;
  let subscriptions = 0;
  const attach = (request) => {
    const epoch = `e${++subscriptions}`;
    const { threadId } = request.params;
    conn.serverSend({
      id: request.id,
      result: { thread: row(threadId), subscription: { id: `s${subscriptions}`, mode: 'snapshot', epoch, startSeq: 1 } },
    });
    conn.serverSend({
      method: 'thread/snapshot',
      params: { thread: row(threadId), items: [], state: { title: 'T' }, hasOlder: false },
      feed: { id: threadId, epoch, seq: 1 },
    });
  };
  void (async () => {
    for (;;) {
      const request = JSON.parse(await conn.nextSent());
      if (request.method === 'thread/resume') {
        resumes.push(request);
        if (!silent) attach(request);
      } else if (request.method === 'app/subscribe') {
        conn.serverSend({ id: request.id, result: { subscription: { mode: 'snapshot', epoch: 'a1', startSeq: 1 } } });
      } else if (request.id !== undefined) conn.serverSend({ id: request.id, result: {} });
    }
  })();

  // The phone's view shows `t1`: its sync attaches the thread, and gates the page's calls until it has.
  const view = createViewManager(client, {
    restored: [],
    wanted: ['t1'],
    onSynced() {},
    syncing() {},
    error() {},
    recycle() {},
    probe() {},
    silentSince: () => false,
  });
  t.after(async () => {
    view.stop();
    await client.close();
  });
  const ctx = {
    sessionsCatalog: { publish() {} },
    sessionInbox: createRemoteSessionInbox({ onGap() {} }),
    viewSettledListeners: new Set(),
    phone: { start: () => new Promise(() => undefined) },
  };
  const router = createProtocolRouter([phoneChatAdapter()], {
    host: {
      ctx,
      client: () => client,
      declareLane() {},
      onClient: (listener) => {
        listener(client);
        return () => undefined;
      },
    },
    started: async () => undefined,
    synced: () => view.synced(),
    appSynced: () => view.appSynced(),
    probe() {},
    silentSince: () => false,
  });

  await until("the view sync's resume of the visible thread", () => resumes.length === 1);
  // One prefetch holds the queue's exclusive slot, waiting on that resume; another waits for the view sync.
  router.fire('prefetchSession', ['t1']);
  let ordinary;
  const waitingForSync = router.call('prefetchSession', ['t1']).then((value) => (ordinary = value));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(resumes.length, 1, 'neither sends a second attach');

  // The arguments the shim hands the router for the pane's Retry (remote-shim-api.ts).
  const retried = router.call('prefetchSession', ['t1', undefined, undefined, { retry: true }]);
  await until('the open the Retry makes', () => resumes.length === 2);
  const [stalled, fresh] = resumes;
  assert.notEqual(fresh.id, stalled.id);
  assert.equal(fresh.params.threadId, 't1');
  assert.equal(fresh.params.resumeFrom, undefined, 'an ordinary open with no cursor');
  assert.equal(ordinary, undefined, 'the ordinary prefetch is still behind the view sync');

  silent = false;
  attach(fresh);
  assert.equal(await retried, true);
  assert.equal(client.threadSubscription('t1').followed, true, 'the thread follows the new open');
  // The sync that lost its attach to the Retry is tried again and joins the new one; what it gated goes on.
  await waitingForSync;
  assert.equal(ordinary, true);
});
