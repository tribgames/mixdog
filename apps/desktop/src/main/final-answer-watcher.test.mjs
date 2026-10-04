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
  const answers = {
    read: async (id) => ({ id: `done-${id}`, at: Date.now(), status: 'done', text: `Final answer ${id}` }),
  };
  const watcher = createFinalAnswerWatcher({
    isEnabled: () => enabled.value,
    readFinalAnswer: async (id, startedAt) => {
      reads.push({ id, startedAt });
      return answers.read(id, startedAt);
    },
    onFinalAnswer: (completion) => delivered.push(completion),
    onError: (detail) => errors.push(detail),
  });
  t.after(() => watcher.dispose());
  const tick = async (ms) => {
    t.mock.timers.tick(ms);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };
  return { watcher, delivered, answers, reads, errors, tick };
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
  assert.equal(delivered[0].sourceType, 'schedule');
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

test('failed, cancelled and deleted sessions never substitute an older assistant answer', async (t) => {
  const { watcher, delivered, answers, tick } = harness(t);
  for (const status of ['failed', 'cancelled']) {
    answers.read = async () => ({ id: status, at: Date.now(), status, text: '' });
    watcher.onSessions([session('a', { working: true })]);
    watcher.onSessions([session('a')]);
    await tick(2_500);
  }
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
