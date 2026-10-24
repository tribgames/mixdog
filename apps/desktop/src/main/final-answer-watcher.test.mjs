import assert from 'node:assert/strict';
import test from 'node:test';

import { createFinalAnswerWatcher } from './final-answer-watcher.ts';

const session = (id, overrides = {}) => ({ id, title: `Session ${id}`, preview: 'done', ...overrides });
const lead = (id, overrides = {}) => ({
  tag: `lead:${id}`,
  sessionId: id,
  ownerSessionId: id,
  agent: 'lead',
  status: 'idle',
  stage: 'idle',
  ...overrides,
});

function harness(t, enabled = { value: true }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000 });
  const delivered = [];
  const errors = [];
  const reads = [];
  const diagnostics = [];
  const answers = {
    read: async (id) => ({ id: `done-${id}`, at: Date.now(), status: 'done', text: `Final answer ${id}` }),
  };
  const watcher = createFinalAnswerWatcher({
    isEnabled: () => enabled.value,
    readFinalAnswer: async (id, startedAt, signal) => {
      reads.push({ id, startedAt, signal });
      return answers.read(id, startedAt, signal);
    },
    onFinalAnswer: (completion) => delivered.push(completion),
    onError: (detail) => errors.push(detail),
    onDiagnostic: (event, details) => diagnostics.push([event, details.sessionId, details.reason]),
  });
  t.after(() => watcher.dispose());
  // Drains every pending microtask (setImmediate is not mocked).
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await flush();
  };
  return { watcher, delivered, answers, reads, errors, diagnostics, tick };
}

test('a Lead that finished its own turn is announced at once, with the completed turn answer', async (t) => {
  const { watcher, delivered, tick } = harness(t);
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(299);
  assert.deepEqual(delivered, []);
  await tick(1);
  assert.deepEqual(
    delivered.map((row) => [row.sessionId, row.preview]),
    [['a', 'Final answer a']]
  );
});

test('a mid-turn flicker with no new answer keeps polling and stays quiet when the turn resumes', async (t) => {
  const { watcher, delivered, answers, reads, tick } = harness(t);
  answers.read = async () => null;
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(300);
  assert.equal(reads.length, 1);
  await tick(500);
  assert.equal(reads.length, 2, 'the missing answer is re-read on the short poll');
  watcher.onSessions([session('a', { working: true })]);
  answers.read = async () => ({ id: 'mid', at: Date.now(), status: 'done', text: 'Not final' });
  await tick(5_000);
  assert.deepEqual(delivered, []);
});

test('a turn answered by a reaction alone raises no notification and stops polling', async (t) => {
  const { watcher, delivered, answers, reads, diagnostics, tick } = harness(t);
  answers.read = async () => ({ id: 'turn', at: Date.now(), status: 'done', text: '', reacted: true });
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(300);
  assert.equal(reads.length, 1);
  await tick(10_000);
  assert.equal(reads.length, 1, 'nothing more is read for it');
  assert.deepEqual(delivered, []);
  assert.ok(diagnostics.some(([event, id, reason]) => event === 'suppressed' && id === 'a' && reason === 'reaction'));
});

test('a routine "nothing new" answer raises no notification', async (t) => {
  const { watcher, delivered, answers, diagnostics, tick } = harness(t);
  answers.read = async () => ({ id: 'turn', at: Date.now(), status: 'done', text: 'ROUTINE_QUIET\n' });
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(10_000);
  assert.deepEqual(delivered, []);
  assert.ok(
    diagnostics.some(([event, id, reason]) => event === 'suppressed' && id === 'a' && reason === 'routine-quiet')
  );
});

test('a turn that resumes within the quiet period is not delivered', async (t) => {
  const { watcher, delivered, tick } = harness(t);
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  watcher.onSessions([session('a', { working: true })]);
  await tick(3_000);
  assert.deepEqual(delivered, []);
});

test('a schedule final answer keeps its origin and is delivered once', async (t) => {
  const { watcher, delivered, tick } = harness(t);
  watcher.onSessions([session('scheduled', { sourceType: 'schedule', working: true })]);
  watcher.onSessions([session('scheduled', { sourceType: 'schedule' })]);
  await tick(2_500);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].conversation.origin, 'schedule');
  assert.equal(delivered[0].event, 'finished');
  assert.equal(delivered[0].preview, 'Final answer scheduled');
  watcher.onSessions([session('scheduled', { sourceType: 'schedule' })]);
  await tick(5_000);
  assert.equal(delivered.length, 1);
});

test('schedules respect disabled notifications and disabling during the quiet period', async (t) => {
  const enabled = { value: false };
  const { watcher, delivered, reads, tick } = harness(t, enabled);
  watcher.onSessions([session('scheduled', { sourceType: 'schedule', working: true })]);
  watcher.onSessions([session('scheduled', { sourceType: 'schedule' })]);
  await tick(2_500);
  assert.deepEqual(delivered, []);
  assert.deepEqual(reads, []);
  enabled.value = true;
  watcher.onSessions([session('scheduled', { sourceType: 'schedule', working: true })]);
  watcher.onSessions([session('scheduled', { sourceType: 'schedule' })]);
  enabled.value = false;
  await tick(2_500);
  assert.deepEqual(delivered, []);
  assert.deepEqual(reads, []);
});

test('a running background shell job never holds the Lead final answer', async (t) => {
  const { watcher, delivered, tick } = harness(t);
  watcher.onSessions([session('a', { working: true })]);
  watcher.onAgentPool([lead('a', { shellJobCount: 1 })]);
  watcher.onSessions([session('a')]);
  await tick(300);
  assert.deepEqual(
    delivered.map((row) => row.sessionId),
    ['a']
  );
});

test('turning delivery off during the quiet period drops the notification', async (t) => {
  const enabled = { value: true };
  const { watcher, delivered, tick } = harness(t, enabled);
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  enabled.value = false;
  await tick(3_000);
  assert.deepEqual(delivered, []);
});

test('an answer arriving after idle is awaited instead of replaced by a preview or generic notice', async (t) => {
  const { watcher, delivered, answers, reads, tick } = harness(t);
  answers.read = async () => null;
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a', { preview: 'first user prompt' })]);
  await tick(2_500);
  assert.ok(reads.length >= 1);
  assert.deepEqual(delivered, []);
  answers.read = async () => ({ id: 'final', at: Date.now(), status: 'done', text: 'The actual final reply' });
  await tick(500);
  assert.equal(delivered[0].preview, 'The actual final reply');
  await tick(5_000);
  assert.equal(delivered.length, 1);
});

test('a late read from a previous turn cannot notify after another turn starts and finishes', async (t) => {
  const { watcher, delivered, answers, tick } = harness(t);
  let finishOld;
  answers.read = () =>
    new Promise((resolve) => {
      finishOld = resolve;
    });
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(2_500);
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  finishOld({ id: 'old', at: Date.now(), status: 'done', text: 'Obsolete reply' });
  answers.read = async () => ({ id: 'new', at: Date.now(), status: 'done', text: 'Latest reply' });
  await tick(2_500);
  assert.deepEqual(
    delivered.map((row) => row.preview),
    ['Latest reply']
  );
});

test('a failed turn is an error notification with no answer text; a cancelled one is silent', async (t) => {
  const { watcher, delivered, answers, diagnostics, tick } = harness(t);
  for (const status of ['failed', 'cancelled']) {
    answers.read = async () => ({ id: status, at: Date.now(), status, text: '' });
    watcher.onSessions([session('a', { working: true })]);
    watcher.onSessions([session('a')]);
    await tick(2_500);
  }
  assert.deepEqual(
    delivered.map((row) => [row.sessionId, row.event, row.preview]),
    [['a', 'error', '']]
  );
  assert.ok(diagnostics.some(([event, id, reason]) => event === 'suppressed' && id === 'a' && reason === 'cancelled'));
});

test('a deleted session never substitutes an older assistant answer', async (t) => {
  const { watcher, delivered, answers, tick } = harness(t);
  answers.read = async () => null;
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(2_500);
  watcher.onSessions([]);
  await tick(5_000);
  assert.deepEqual(delivered, []);
});

test('a read failure is reported and the exact answer can arrive later', async (t) => {
  const { watcher, delivered, answers, errors, tick } = harness(t);
  answers.read = async () => {
    throw new Error('temporarily disconnected');
  };
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(2_500);
  assert.deepEqual(errors, ['temporarily disconnected']);
  assert.deepEqual(delivered, []);
  answers.read = async () => ({ id: 'final', at: Date.now(), status: 'done', text: 'Recovered final reply' });
  await tick(2_500);
  assert.equal(delivered[0].preview, 'Recovered final reply');
});

test('a session whose record is gone is cancelled after one read instead of re-read forever', async (t) => {
  const { watcher, delivered, answers, reads, errors, diagnostics, tick } = harness(t);
  // The relayed service message and the desktop host's own wording.
  answers.read = async (id) => {
    throw new Error(id === 'a' ? 'session a is not available' : 'Error invoking remote method: Session is not available.');
  };
  watcher.onSessions([session('a', { working: true }), session('b', { working: true })]);
  // The catalog rows outlive the deleted records.
  for (let i = 0; i < 20; i++) {
    watcher.onSessions([session('a'), session('b')]);
    await tick(30_000);
  }
  assert.deepEqual(
    reads.map((read) => read.id),
    ['a', 'b']
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(delivered, []);
  assert.deepEqual(
    diagnostics.filter(([event]) => event === 'cancelled'),
    [
      ['cancelled', 'a', 'session-missing'],
      ['cancelled', 'b', 'session-missing'],
    ]
  );
});

test('a session reported missing by error code is terminal whatever the message says', async (t) => {
  const { watcher, answers, reads, errors, diagnostics, tick } = harness(t);
  answers.read = async () => {
    throw Object.assign(new Error('read failed'), { code: 'SESSION_NOT_AVAILABLE' });
  };
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(30_000);
  assert.equal(reads.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    diagnostics.filter(([event]) => event === 'cancelled'),
    [['cancelled', 'a', 'session-missing']]
  );
});

test('the read gets an abort signal that fires when it overruns its deadline', async (t) => {
  const { watcher, answers, reads, errors, tick } = harness(t);
  answers.read = (id, startedAt, signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  await tick(300);
  assert.equal(reads.length, 1);
  assert.ok(reads[0].signal instanceof AbortSignal);
  await tick(29_999);
  assert.equal(reads[0].signal.aborted, false);
  await tick(1);
  assert.equal(reads[0].signal.aborted, true);
  assert.match(errors[0], /timed out/);
});

test('a hung read is aborted after the deadline, counts as a transient failure and frees the slot', async (t) => {
  const { watcher, delivered, answers, reads, errors, tick } = harness(t);
  // The hung read ignores the signal entirely: the slot must still be released.
  answers.read = (id) =>
    id === 'a'
      ? new Promise(() => {})
      : Promise.resolve({ id: 'done-b', at: Date.now(), status: 'done', text: 'Final answer b' });
  watcher.onSessions([session('a', { working: true }), session('b', { working: true })]);
  watcher.onSessions([session('a'), session('b')]);
  await tick(300);
  await tick(29_000);
  assert.deepEqual(
    reads.map((read) => read.id),
    ['a'],
    'b waits behind the stuck read until the deadline'
  );
  assert.deepEqual(delivered, []);
  await tick(1_000);
  assert.equal(reads[0].signal.aborted, true);
  assert.deepEqual(
    delivered.map((row) => row.sessionId),
    ['b']
  );
  assert.equal(errors.length, 1);
  // The aborted read is retried under the ordinary backoff (2.5 s).
  answers.read = async (id) => ({ id: `done-${id}`, at: Date.now(), status: 'done', text: `Final answer ${id}` });
  await tick(2_500);
  assert.deepEqual(delivered.map((row) => row.sessionId).sort(), ['a', 'b']);
});

test('transient read failures back off and are abandoned after a bounded number of tries', async (t) => {
  const { watcher, delivered, answers, reads, errors, tick } = harness(t);
  answers.read = async () => {
    throw new Error('temporarily disconnected');
  };
  watcher.onSessions([session('a', { working: true })]);
  watcher.onSessions([session('a')]);
  const readAt = [];
  for (let elapsed = 0; elapsed <= 600_000; elapsed += 100) {
    const before = reads.length;
    await tick(100);
    if (reads.length > before) readAt.push(elapsed + 100);
  }
  // 300 ms settle, then 2.5 s doubling: 2.5, 5, 10, 20, 40 s.
  assert.deepEqual(readAt, [300, 2_800, 7_800, 17_800, 37_800, 77_800]);
  assert.equal(errors.length, 6);
  assert.deepEqual(delivered, []);
});

test('only one answer read is in flight at a time across sessions', async (t) => {
  const { watcher, delivered, answers, reads, tick } = harness(t);
  const resolvers = [];
  answers.read = (id) =>
    new Promise((resolve) => {
      resolvers.push(() => resolve({ id, at: Date.now(), status: 'done', text: `Final answer ${id}` }));
    });
  watcher.onSessions([session('a', { working: true }), session('b', { working: true })]);
  watcher.onSessions([session('a'), session('b')]);
  await tick(300);
  await tick(5_000);
  assert.deepEqual(
    reads.map((read) => read.id),
    ['a']
  );
  resolvers.shift()();
  await tick(0);
  assert.deepEqual(
    reads.map((read) => read.id),
    ['a', 'b']
  );
  resolvers.shift()();
  await tick(0);
  assert.deepEqual(delivered.map((row) => row.sessionId).sort(), ['a', 'b']);
});
