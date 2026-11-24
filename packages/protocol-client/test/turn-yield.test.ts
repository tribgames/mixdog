import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { connect } from '../src/client.ts';
import { MockNetwork } from '../src/mock.ts';
import { sessionReducer } from '../src/session-state.ts';
import type { SessionFold } from '../src/session-state.ts';

const options = JSON.parse(readFileSync(new URL('../conformance/options.json', import.meta.url), 'utf8'));
const thread = (id: string) => ({
  id,
  preview: '',
  title: '',
  updatedAt: 1,
  messageCount: 0,
  cwd: '/w',
  classification: {},
  projectPath: null,
});

test('a page whose timers are throttled (hidden) still folds what arrives, turn after turn', {
  timeout: 20_000,
}, async () => {
  const realImmediate = globalThis.setImmediate;
  const realTimeout = globalThis.setTimeout;
  const macrotask = () => new Promise<void>((r) => realImmediate(r));
  let applied = 0;
  let t = 0;
  const net = new MockNetwork();
  const connecting = connect<SessionFold>({
    target: { id: 'local' },
    connector: net,
    clientInfo: options.clientInfo,
    capabilities: options.capabilities,
    threadReducer: {
      ...sessionReducer,
      apply(state) {
        applied++;
        return state;
      },
    },
    clock: { sleep: () => Promise.resolve() },
    random: () => 0,
    // Every ask after a turn's first finds the budget spent: each frame past the first waits for a turn of its own.
    turn: { budgetMs: 0, now: () => ++t },
  });
  const conn = await net.accept();
  const init = JSON.parse(await conn.nextSent());
  conn.serverSend({ id: init.id, result: { ...options.initializeResult, serverInstanceId: 's1' } });
  await conn.nextSent();
  const client = await connecting;
  const resumed = client.resumeThread('t0', { lastItems: 50 });
  const req = JSON.parse(await conn.nextSent());
  conn.serverSend({
    id: req.id,
    result: { thread: thread('t0'), subscription: { id: 'sub-t0', mode: 'snapshot', epoch: 'e1', startSeq: 1 } },
  });
  await resumed;
  await macrotask();
  conn.serverSend({
    method: 'thread/snapshot',
    params: { thread: thread('t0'), items: [], state: { title: 'T' }, hasOlder: false },
    feed: { id: 't0', epoch: 'e1', seq: 0 },
  });
  for (let i = 0; i < 8; i++) await macrotask();
  assert.ok(client.store.thread('t0'), 'the snapshot folded');

  // A page: no setImmediate, and a hidden one's timers are held back; here none fires at all.
  const page = globalThis as { setImmediate?: unknown; setTimeout: unknown };
  page.setImmediate = undefined;
  page.setTimeout = () => 0;
  try {
    const FRAMES = 40;
    for (let seq = 1; seq <= FRAMES; seq++)
      conn.serverSend({
        method: 'thread/name/updated',
        params: { threadId: 't0', title: `n${seq}` },
        feed: { id: 't0', epoch: 'e1', seq },
      });
    for (let turn = 0; applied < FRAMES && turn < 10_000; turn++) await macrotask();
    assert.equal(applied, FRAMES, `${applied} of ${FRAMES} frames folded with no timer firing`);
  } finally {
    page.setImmediate = realImmediate;
    page.setTimeout = realTimeout;
    client.close();
  }
});
