import '../../../scripts/lib/isolated-test-env.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSessionFlow } from './session-flow.mjs';

const tick = () => new Promise(setImmediate);

const COMPLETION = '<task-notification><task-id>task_agent_1</task-id><status>completed</status></task-notification>';

function fixture({ busy = true } = {}) {
  const state = { busy, commandBusy: false, queued: [] };
  const pending = [];
  const turns = [];
  const items = [];
  let nextId = 0;
  const bag = {
    runtime: { id: 'session-drain-recheck' },
    flags: {},
    pending,
    pendingNotificationKeys: new Set(),
    getState: () => state,
    set: (patch) => Object.assign(state, patch),
    nextId: () => `queued-${++nextId}`,
    tuiDebug() {},
    pushUserOrSyntheticItem: (text, id, kind, extra) => items.push({ text, id, kind, ...(extra ? { extra } : {}) }),
    flushDeferredExecutionPendingResumeKick() {},
    runTurn: async (content, options) => {
      turns.push({ content, options });
      return 'done';
    },
  };
  return { state, pending, turns, items, flow: createSessionFlow(bag) };
}

test('a completion queued during a turn drains even when no release edge reaches the queue', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();

  assert.equal(f.flow.enqueue(COMPLETION, { mode: 'task-notification', priority: 'next', key: 'exec-1' }), true);
  await tick();
  assert.deepEqual(f.turns, [], 'the active turn owns the session');

  t.mock.timers.tick(10_000);
  await tick();
  assert.deepEqual(f.turns, [], 'the re-check never starts a second turn while one runs');

  // The turn settles without its busy release reaching this flow — the
  // one-shot edge the queue used to depend on.
  f.state.busy = false;
  t.mock.timers.tick(2_000);
  await tick();
  assert.equal(f.turns.length, 1);
  assert.equal(String(f.turns[0].content).includes('task_agent_1'), true);
  assert.deepEqual(f.items, [{ text: f.items[0]?.text, id: 'queued-1', kind: 'injected' }]);
  assert.deepEqual(f.pending, []);

  t.mock.timers.tick(60_000);
  await tick();
  assert.equal(f.turns.length, 1, 'an empty queue stops the re-check');
});

test('a command that takes the lock while a turn settles runs before the next queued turn starts', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture();
  assert.equal(f.flow.enqueue('first', { id: 'p1' }), true);
  assert.equal(f.flow.enqueue('second', { id: 'p2' }), true);
  // The first turn's settlement lets an in-place model switch take the lock
  // (its pre-compaction is still pending when the turn returns).
  const record = f.turns.push.bind(f.turns);
  f.turns.push = (entry) => {
    if (f.turns.length === 0) f.state.commandBusy = true;
    return record(entry);
  };
  f.state.busy = false;
  t.mock.timers.tick(2_000);
  await tick();
  await tick();
  assert.equal(f.turns.length, 1);
  assert.equal(String(f.turns[0].content), 'first');

  t.mock.timers.tick(10_000);
  await tick();
  assert.equal(f.turns.length, 1, 'no turn starts while the switch holds the lock');
  assert.equal(f.pending.length, 1);

  f.state.commandBusy = false;
  t.mock.timers.tick(10_000);
  await tick();
  await tick();
  assert.equal(f.turns.length, 2);
  assert.equal(String(f.turns[1].content), 'second');
});

test('an absolute path is an ordinary message: first, and mid-session', async () => {
  const f = fixture({ busy: false });
  const path = '/Users/example/python-learn 이 폴더 봐줘';
  assert.equal(f.flow.enqueue(path, { id: 'p1' }), true);
  await tick();
  assert.deepEqual(
    f.turns.map((turn) => String(turn.content)),
    [path],
    'a new chat\u2019s first message reaches the model'
  );
  assert.deepEqual(f.pending, []);

  f.state.busy = true;
  assert.equal(f.flow.enqueue('/var/log/app.log 확인', { id: 'p2' }), true);
  f.state.busy = false;
  await f.flow.drain();
  await tick();
  assert.equal(f.turns.length, 2, 'a path queued mid-session reaches the model too');
  assert.equal(String(f.turns[1].content), '/var/log/app.log 확인');
  assert.deepEqual(f.pending, []);
});

test('a registered command is never delivered to the model', async () => {
  const f = fixture({ busy: false });
  assert.equal(f.flow.enqueue('/compact', { id: 'c1' }), true);
  assert.equal(f.flow.enqueue('/model gpt-5', { id: 'c2' }), true);
  await tick();
  assert.deepEqual(f.turns, []);
  assert.equal(f.pending.length, 2, 'commands stay for the command dispatcher');
});

test('a prompt sent with skipSlashCommands goes out even when it names a command', async () => {
  const f = fixture({ busy: false });
  assert.equal(f.flow.enqueue('/model is the word', { id: 'b1', skipSlashCommands: true }), true);
  await tick();
  assert.equal(f.turns.length, 1);
});

test('a drained prompt row is attributed to the device that submitted it', async () => {
  const f = fixture({ busy: false });
  assert.equal(f.flow.enqueue('from the phone', { id: 'p1', transcriptMeta: { device: 'Pixel' } }), true);
  await tick();
  assert.equal(f.items[0].id, 'p1');
  assert.deepEqual(f.items[0].extra, { device: 'Pixel' });
});

test('a bot message and a user message queued together run as separate turns, each with its own sender', async () => {
  const f = fixture();
  assert.equal(f.flow.enqueue('first', { id: 'u0', transcriptMeta: { sender: 'user' } }), true);
  assert.equal(
    f.flow.enqueue('from the marketer', { id: 'b1', transcriptMeta: { sender: 'lead', fromAgent: 'agent-1' } }),
    true
  );
  assert.equal(f.flow.enqueue('from the user', { id: 'u1', transcriptMeta: { sender: 'user' } }), true);
  f.state.busy = false;
  await f.flow.drain();
  await tick();
  assert.deepEqual(
    f.turns.map((turn) => [String(turn.content), turn.options.transcriptMeta]),
    [
      ['first', { sender: 'user' }],
      ['from the marketer', { sender: 'lead', fromAgent: 'agent-1' }],
      ['from the user', { sender: 'user' }],
    ]
  );
});
