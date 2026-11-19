// The phone's chat adapter over the real protocol client (mock transport): what it asks the core for and what it hands the page.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { connect, sessionReducer } from '../../../../packages/protocol-client/src/index.ts';
import { MockNetwork } from '../../../../packages/protocol-client/src/mock.ts';
import { phoneChatAdapter } from './remote-protocol-chat.ts';
import { createRemoteSessionInbox } from './remote-session-inbox.ts';

const protocolOptions = JSON.parse(readFileSync(new URL('../../../../packages/protocol-client/conformance/options.json', import.meta.url), 'utf8'));
const settled = () => new Promise((resolve) => setTimeout(resolve, 20));

/** The next connection a client opens over `net`: its handshake answered, then every request served. */
async function accepted(net, serve) {
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...protocolOptions.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  void (async () => {
    for (;;) serve(JSON.parse(await conn.nextSent()), conn);
  })();
  return conn;
}

/** A client of the library whose core answers every request with `serve(request, conn)`; `redial()` ends its connection and
 *  serves the one it opens next. */
async function realClient(serve) {
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
  let conn = await accepted(net, serve);
  const client = await connecting;
  return {
    client,
    conn: () => conn,
    async redial() {
      conn.serverClose(1006);
      conn = await accepted(net, serve);
    },
  };
}

const row = (id) => ({ id, preview: '', title: '', updatedAt: 1, messageCount: 0, cwd: '/w', classification: {}, projectPath: null });

/** A core: `thread/start` starts a new thread each time, `thread/resume` answers with a subscription and the thread's snapshot
 *  (`threadNotFound` for a thread in `gone`), and `thread/read` with an empty thread; anything else answers `{}`. */
function core() {
  const sent = [];
  const gone = new Set();
  // Methods whose requests wait in `held` until `answerHeld()` answers them `{}`.
  const holding = new Set();
  const held = [];
  let threads = 0;
  let epochs = 0;
  const epochOf = new Map();
  const items = [];
  const serve = (request, conn) => {
    sent.push(request);
    const { method, params } = request;
    if (holding.has(method)) return void held.push({ request, conn });
    if (method === 'thread/start') {
      const id = `t${++threads}`;
      return conn.serverSend({ id: request.id, result: { thread: row(id), subscription: { id: `s${id}`, mode: 'snapshot', epoch: 'e0', startSeq: 1 } } });
    }
    if (method === 'thread/resume' && gone.has(params.threadId)) {
      return conn.serverSend({ id: request.id, error: { code: -32004, message: 'not found', data: { reason: 'threadNotFound' } } });
    }
    if (method === 'thread/resume') {
      const epoch = `e${++epochs}`;
      epochOf.set(params.threadId, epoch);
      conn.serverSend({ id: request.id, result: { thread: row(params.threadId), subscription: { id: `s${epochs}`, mode: 'snapshot', epoch, startSeq: 1 } } });
      return conn.serverSend({
        method: 'thread/snapshot',
        params: { thread: row(params.threadId), items, state: { title: 'T' }, hasOlder: false },
        feed: { id: params.threadId, epoch, seq: 1 },
      });
    }
    if (method === 'thread/read') return conn.serverSend({ id: request.id, result: { thread: row(params.threadId), items: [], state: {}, hasOlder: false } });
    conn.serverSend({ id: request.id, result: {} });
  };
  const answerHeld = () => {
    for (const { request, conn } of held.splice(0)) conn.serverSend({ id: request.id, result: {} });
  };
  return { serve, sent, epochOf, gone, holding, answerHeld, items };
}

/** A page served by the adapter: its host hands it `client` and each client `replace` hands it later. `viewSettled()` is what the
 *  page's `setVisibleSessions` tells once it settles (remote-shim-api.ts). `seen` is what the page's session inbox delivered. */
const pageOf = (first) => {
  const ctx = {
    sessionsCatalog: { publish() {} },
    sessionInbox: createRemoteSessionInbox({ onGap() {} }),
    viewSettledListeners: new Set(),
    phone: { start: () => new Promise(() => undefined) },
  };
  let client = first;
  const clientListeners = new Set();
  const host = {
    ctx,
    client: () => client,
    declareLane() {},
    onClient: (listener) => (clientListeners.add(listener), listener(client), () => clientListeners.delete(listener)),
  };
  const seen = [];
  ctx.sessionInbox.subscribe((update) => seen.push(update));
  return {
    ctx,
    host,
    seen,
    replace(next) {
      client = next;
      for (const listener of [...clientListeners]) listener(next);
    },
    viewSettled() {
      for (const listener of [...ctx.viewSettledListeners]) listener();
    },
  };
};
const GONE = (sessionId) => ({ sessionId, snapshot: null, frameSource: 'live', laneEnd: 'gone' });
const UNLOADED = (sessionId) => ({ sessionId, snapshot: null, frameSource: 'live', laneEnd: 'unloaded' });
const frame = (conn, c, threadId, title, seq) => {
  conn.serverSend({ method: 'thread/name/updated', params: { threadId, title }, feed: { id: threadId, epoch: c.epochOf.get(threadId), seq } });
  conn.serverSend({ method: 'thread/frame', params: { threadId, structureChanged: false }, feed: { id: threadId, epoch: c.epochOf.get(threadId), seq: seq + 1 } });
};
const shownOf = (seen, threadId) => seen.filter((update) => update.sessionId === threadId);

test("the phone's calls that name no session ask the core for a control thread once per connection, however many calls the page makes", async () => {
  const c = core();
  const { client } = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const { host } = pageOf(client);
  // A page load reads its settings in several calls at once, then more later; each call makes its own lane.
  const reads = [{ capability: 'getAutoClear', args: [] }, { capability: 'getCompactionSettings', args: [] }];
  await Promise.all([adapter.calls.readCapabilities([reads], host), adapter.calls.readCapabilities([reads], host)]);
  await adapter.calls.readCapabilities([reads], host);
  await adapter.calls.setFast([true], host);
  const starts = c.sent.filter((request) => request.method === 'thread/start');
  assert.deepEqual(starts.map((request) => request.params.kind), ['control']);
  const addressed = new Set(c.sent.filter((request) => request.params?.threadId).map((request) => request.params.threadId));
  assert.deepEqual([...addressed], ['t1'], 'every call was addressed to that one thread');
  await client.close();
});

test('the page is handed each state of a thread the phone follows: its first fold, every frame, and a resume that replaces the fold', async () => {
  const c = core();
  const phone = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(phone.client);
  const stop = adapter.install(page.host);
  // The pane's thread is opened (the view's `thread/resume`): its first fold is the page's state of it.
  await phone.client.resumeThread('t9', { lastItems: 50 });
  await settled();
  assert.equal(page.seen.length, 1);
  assert.equal(page.seen[0].sessionId, 't9');
  assert.equal(page.seen[0].frameSource, 'live');
  // A read of more rows resumes the thread again: its new fold is published, though no frame has come on either fold.
  await adapter.calls.prefetchSession(['t9', 200], page.host);
  await settled();
  assert.equal(page.seen.length, 2);
  // A turn's frame on the thread's feed (a finished answer) reaches the page with no call of its own.
  frame(phone.conn(), c, 't9', 'Answered', 2);
  await settled();
  assert.equal(page.seen.length, 3);
  assert.equal(page.seen[2].snapshot.desktopSessionTitle, 'Answered');
  stop();
  await phone.client.close();
});

test('a large tool result reaches the page bounded with its truncation note, and "show full output" still returns all of it', async () => {
  const c = core();
  const whole = `${'head-'.repeat(2000)}${'x'.repeat(40_000)}-the-end`;
  c.items.push({ id: 'call1', type: 'toolCall', name: 'read', input: { path: 'a.txt' }, output: whole, meta: { status: 'completed', at: 1 } });
  const phone = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(phone.client);
  const stop = adapter.install(page.host);
  await phone.client.resumeThread('t1', { lastItems: 50 });
  await settled();
  const tool = page.seen[0].snapshot.items.find((item) => item.kind === 'tool');
  assert.ok(tool.result.length <= 8192, `result is ${tool.result.length} chars`);
  assert.ok(tool.remoteOutputTruncated >= whole.length, 'the row says how long the output was');
  assert.equal(tool.remoteOutputNotes.result.kind, 'omitted');
  assert.equal((await adapter.calls.readTranscriptItem(['t1', 'call1'], page.host)).result, whole);
  stop();
  await phone.client.close();
});

test('a thread the core lost while the phone was away ends on the page as gone, once; a released one as unloaded, once', async () => {
  const c = core();
  const phone = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(phone.client);
  const stop = adapter.install(page.host);
  await phone.client.resumeThread('t1', { lastItems: 50 });
  await phone.client.resumeThread('t2', { lastItems: 50 });
  await settled();
  // Mid-answer the phone drops; meanwhile `t1` is deleted on the PC. The redial's restore finds it gone.
  c.gone.add('t1');
  await phone.redial();
  await settled();
  assert.deepEqual(shownOf(page.seen, 't1').at(-1), { sessionId: 't1', snapshot: null, frameSource: 'live', laneEnd: 'gone' });
  assert.equal(shownOf(page.seen, 't1').filter((update) => update.snapshot === null).length, 1);
  // The pane stops following `t2` (the view unsubscribes it, and the page's `setVisibleSessions` settles): its lane ends once,
  // however often the view settles after that.
  const before = shownOf(page.seen, 't2').length;
  page.viewSettled();
  assert.equal(shownOf(page.seen, 't2').length, before, 'a thread still followed is not released');
  await phone.client.unsubscribeThread('t2');
  page.viewSettled();
  page.viewSettled();
  assert.deepEqual(shownOf(page.seen, 't2').slice(before), [UNLOADED('t2')]);
  // Followed again later, it is the page's again from its first fold.
  await phone.client.resumeThread('t2', { lastItems: 50 });
  await settled();
  assert.notEqual(shownOf(page.seen, 't2').at(-1).snapshot, null);
  stop();
  await phone.client.close();
});

test('a replaced client publishes nothing more; the client that replaced it publishes its own threads', async () => {
  const c = core();
  const first = await realClient(c.serve);
  const second = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(first.client);
  const stop = adapter.install(page.host);
  await first.client.resumeThread('t1', { lastItems: 50 });
  await settled();
  assert.equal(shownOf(page.seen, 't1').length, 1);
  // A re-pairing dials a new client in the same page.
  page.replace(second.client);
  frame(first.conn(), c, 't1', 'late', 2);
  first.conn().serverSend({ method: 'thread/deleted', params: { threadId: 't1' } });
  await first.client.unsubscribeThread('t1');
  page.viewSettled();
  await settled();
  assert.equal(shownOf(page.seen, 't1').length, 1, 'nothing of the old client reaches the page');
  await second.client.resumeThread('t2', { lastItems: 50 });
  await settled();
  assert.equal(shownOf(page.seen, 't2').length, 1);
  stop();
  await first.client.close();
  await second.client.close();
});

test('two pages served at once are each handed their own client threads only', async () => {
  const c = core();
  const a = await realClient(c.serve);
  const b = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const pageA = pageOf(a.client);
  const pageB = pageOf(b.client);
  const stopA = adapter.install(pageA.host);
  const stopB = adapter.install(pageB.host);
  await a.client.resumeThread('ta', { lastItems: 50 });
  await b.client.resumeThread('tb', { lastItems: 50 });
  await settled();
  assert.deepEqual(pageA.seen.map((update) => update.sessionId), ['ta']);
  assert.deepEqual(pageB.seen.map((update) => update.sessionId), ['tb']);
  // One page's release or close leaves the other page's follower as it was.
  stopA();
  frame(b.conn(), c, 'tb', 'still', 2);
  await settled();
  assert.equal(pageB.seen.length, 2);
  assert.equal(pageA.seen.length, 1);
  stopB();
  await a.client.close();
  await b.client.close();
});

test('an approval recovery publishes one state per baseline: the held fold once, a resumed one only as the feed delivers it', async () => {
  const c = core();
  const phone = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(phone.client);
  const stop = adapter.install(page.host);
  // Not folded: the recovery resumes it, and its snapshot reaches the page once.
  assert.equal(await adapter.calls.refreshSessionState(['t1'], page.host), true);
  await settled();
  assert.equal(shownOf(page.seen, 't1').length, 1);
  // Folded: the feed has nothing new, so the recovery itself publishes the current state, once.
  assert.equal(await adapter.calls.refreshSessionState(['t1'], page.host), true);
  await settled();
  assert.equal(shownOf(page.seen, 't1').length, 2);
  assert.equal(c.sent.filter((request) => request.method === 'thread/resume').length, 1, 'a held fold is not resumed');
  stop();
  await phone.client.close();
});

test('a thread deleted from another device while the phone stays connected ends its lane as gone, once', async () => {
  const c = core();
  const phone = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(phone.client);
  const stop = adapter.install(page.host);
  await phone.client.resumeThread('t1', { lastItems: 50 });
  await settled();
  // The PC deletes it; this connection hears the deletion (no redial, no call of this page).
  phone.conn().serverSend({ method: 'thread/deleted', params: { threadId: 't1' } });
  phone.conn().serverSend({ method: 'thread/deleted', params: { threadId: 't1' } });
  await settled();
  assert.deepEqual(shownOf(page.seen, 't1').slice(1), [GONE('t1')]);
  // A deletion of a thread this page was never shown tells it nothing.
  phone.conn().serverSend({ method: 'thread/deleted', params: { threadId: 'other' } });
  await settled();
  assert.equal(shownOf(page.seen, 'other').length, 0);
  stop();
  await phone.client.close();
});

test('a deletion after an unload still ends the retained lane as gone; a newer follow of the id is ended by its own deletion only', async () => {
  const c = core();
  const phone = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(phone.client);
  const stop = adapter.install(page.host);
  await phone.client.resumeThread('t1', { lastItems: 50 });
  await settled();
  await phone.client.unsubscribeThread('t1');
  page.viewSettled();
  // Released, then deleted elsewhere: the page's kept baseline is invalidated (`gone` after `unloaded`).
  phone.conn().serverSend({ method: 'thread/deleted', params: { threadId: 't1' } });
  await settled();
  assert.deepEqual(shownOf(page.seen, 't1').slice(1), [UNLOADED('t1'), GONE('t1')]);
  // Released, then followed again: the newer follow is live, a later view settle leaves it, and its deletion ends it once.
  await phone.client.resumeThread('t2', { lastItems: 50 });
  await settled();
  await phone.client.unsubscribeThread('t2');
  page.viewSettled();
  await phone.client.resumeThread('t2', { lastItems: 50 });
  await settled();
  page.viewSettled();
  assert.equal(shownOf(page.seen, 't2').at(-1).laneEnd, undefined, 'the newer follow is not ended by the earlier release');
  phone.conn().serverSend({ method: 'thread/deleted', params: { threadId: 't2' } });
  await settled();
  assert.deepEqual(shownOf(page.seen, 't2').filter((update) => update.snapshot === null), [UNLOADED('t2'), GONE('t2')]);
  stop();
  await phone.client.close();
});

test("this page's delete ends its client's lane as gone; an answer that arrives after the client was replaced leaves the new client's lane", async () => {
  const c = core();
  const first = await realClient(c.serve);
  const second = await realClient(c.serve);
  const adapter = phoneChatAdapter();
  const page = pageOf(first.client);
  const stop = adapter.install(page.host);
  await first.client.resumeThread('t1', { lastItems: 50 });
  await settled();
  assert.equal(await adapter.calls.deleteSession(['t1'], page.host), null);
  await settled();
  assert.deepEqual(shownOf(page.seen, 't1').slice(1), [GONE('t1')]);
  // A delete whose answer is held while a re-pairing replaces the client, and the new client follows the same id.
  await first.client.resumeThread('t5', { lastItems: 50 });
  await settled();
  c.holding.add('thread/delete');
  const deleting = adapter.calls.deleteSession(['t5'], page.host);
  await settled();
  page.replace(second.client);
  await second.client.resumeThread('t5', { lastItems: 50 });
  await settled();
  const before = shownOf(page.seen, 't5').length;
  c.answerHeld();
  await deleting;
  await settled();
  assert.deepEqual(shownOf(page.seen, 't5').slice(before), [], "the old client's answer does not end the new client's lane");
  stop();
  await first.client.close();
  await second.client.close();
});
