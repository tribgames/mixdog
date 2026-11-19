import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import type { Json, StoreChange } from '../src/api.ts';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { type SessionFold, sessionReducer, sessionStateOf } from '../src/session-state.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));

test('session state joins thread updates, host shell jobs and pending approvals on the same surface', { timeout: 5000 }, async (t) => {
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: sessionReducer,
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent(); // initialized
  const client = await connecting;
  t.after(() => client.close());

  const answer = async (result: Json): Promise<void> => conn.serverSend({ id: JSON.parse(await conn.nextSent()).id, result });
  const thread = { id: 'lead' };
  const resumed = client.resumeThread(thread.id, { lastItems: 50 });
  await answer({ thread, subscription: { id: 'sub', mode: 'snapshot', epoch: 'e1', startSeq: 1 } });
  await resumed;
  const app = client.subscribeApp();
  await answer({ subscription: { id: 'as', mode: 'snapshot', epoch: 'ae', startSeq: 1 } });
  await app;

  const nextChange = (matches: (change: StoreChange) => boolean) =>
    new Promise<void>((resolve) => {
      const unsubscribe = client.store.subscribe((change) => {
        if (!matches(change)) return;
        unsubscribe();
        resolve();
      });
    });
  const nextThreadChange = () => nextChange((change) => change.type === 'thread' && change.threadId === thread.id);
  let seq = 0;
  const feed = (method: string, params: Record<string, Json>) => {
    const folded = nextThreadChange();
    conn.serverSend({ method, params: { threadId: thread.id, ...params }, feed: { id: thread.id, epoch: 'e1', seq: seq++ } });
    return folded;
  };
  const session = () => {
    const state = sessionStateOf(client, thread.id);
    assert.ok(state);
    return state;
  };

  assert.equal(sessionStateOf(client, thread.id), undefined);
  await feed('thread/snapshot', {
    thread,
    items: [],
    state: { title: 'Review', route: { sessionProvider: 'provider-a', sessionModel: 'model-a', fast: true } },
    hasOlder: true,
  });
  assert.equal(session().desktopSessionTitle, 'Review');
  assert.equal(session().transcriptHasOlder, true);
  assert.equal(session().fast, true);
  assert.equal(session().toolApproval, null);
  assert.equal(session().toolApprovalsWaiting, 0);

  await feed('thread/route/updated', { value: { sessionProvider: 'provider-b', sessionModel: 'model-b' } });
  assert.equal(session().sessionProvider, 'provider-b');
  assert.equal(session().sessionModel, 'model-b');
  assert.equal(session().fast, undefined, 'a replacement route drops fields the server omitted');
  assert.equal(session().desktopSessionTitle, 'Review');

  const appFolded = nextChange((change) => change.type === 'appSnapshot');
  const hostShellJobs = { count: 1, elapsedLabel: '2s', jobs: [{ id: 'host-job' }], finished: [] };
  conn.serverSend({
    method: 'app/snapshot',
    params: { sections: [{ section: 'hostShellJobs', key: null, revision: 1, value: hostShellJobs }] },
    feed: { id: 'app', epoch: 'ae', seq: 0 },
  });
  await appFolded;
  const shellJobs = { count: 1, elapsedLabel: '1s', jobs: [{ id: 'thread-job' }], finished: [] };
  await feed('thread/shellJobs/updated', { value: shellJobs });
  assert.deepEqual(session().hostShellJobs, hostShellJobs);
  assert.deepEqual(session().shellJobs, shellJobs);

  // Wire order is not presentation order; the worker's request belongs to the surface that owns the card.
  const offer = (id: string, order: number, threadId: string, command: string, surfaceThreadId?: string) =>
    conn.serverSend({
      id,
      method: 'item/tool/requestApproval',
      params: { threadId, surfaceThreadId, requestedAt: 1, order, kind: 'shell', tool: 'shell', request: { command } },
    });
  const workerThreadId = 'worker';
  offer('second', 2, thread.id, 'npm test');
  offer('first', 1, workerThreadId, 'npm run typecheck', thread.id);
  offer('unrelated', 0, 'other', 'git status');
  assert.deepEqual(session().toolApproval, { id: 'first', tool: 'shell', command: 'npm run typecheck' });
  assert.equal(session().toolApprovalsWaiting, 1);

  const resolve = async (requestId: string, ownerThreadId: string) => {
    const leadRefreshed = nextThreadChange();
    conn.serverSend({ method: 'serverRequest/resolved', params: { threadId: ownerThreadId, requestId, resolution: { kind: 'cancelled', at: 3 } } });
    await leadRefreshed;
  };
  await resolve('first', workerThreadId);
  assert.deepEqual(session().toolApproval, { id: 'second', tool: 'shell', command: 'npm test' });
  assert.equal(session().toolApprovalsWaiting, 0);
  await resolve('second', thread.id);
  assert.equal(session().toolApproval, null);
  assert.deepEqual(session().hostShellJobs, hostShellJobs);
});
