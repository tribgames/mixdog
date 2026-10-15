import assert from 'node:assert/strict';
import test from 'node:test';
import { createBtwController } from './btw-side-question.ts';
import { createSlashExecutor } from './composer-slash-executor.ts';
import { desktopComposerSlashCommands, resolveDesktopSlashCommand } from './slash-commands.ts';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness() {
  const calls = [];
  const pending = [];
  const states = [];
  const controller = createBtwController((request) => {
    calls.push(request);
    if (request.capability === 'cancelSide') return Promise.resolve({ value: {} });
    const call = deferred();
    pending.push(call);
    return call.promise;
  }, (state) => states.push(state));
  return { controller, calls, pending, states };
}

test('/btw resolves, lists in the composer, and is not turn-locked', () => {
  const command = resolveDesktopSlashCommand('btw');
  assert.equal(command.action, 'btw');
  assert.equal(command.params, '<question>');
  assert.ok(desktopComposerSlashCommands('/b').some((entry) => entry.name === 'btw'));
  assert.equal(desktopComposerSlashCommands('/')[1].name, 'btw');
});

test('/btw runs during a busy turn without submitting; empty question keeps the draft', async () => {
  const asked = [];
  const errors = [];
  const submitted = [];
  const run = createSlashExecutor({
    sessionId: 's1',
    turnBusy: true,
    setAttachmentError: (message) => errors.push(message),
    clearNotice() {},
    submit: async (...args) => submitted.push(args),
    onBtw: (sessionId, question) => asked.push([sessionId, question]),
  });
  assert.equal(await run('/btw  what is   x? '), true);
  assert.deepEqual(asked, [['s1', 'what is x?']]);
  assert.equal(await run('/btw'), false);
  assert.equal(asked.length, 1);
  assert.equal(errors.at(-1), 'Usage: /btw <question>');
  assert.equal(submitted.length, 0);
});

test('pending → answered', async () => {
  const { controller, calls, pending, states } = harness();
  const done = controller.ask('s1', 'q?');
  assert.equal(controller.current().status, 'pending');
  assert.deepEqual(calls[0], { capability: 'askSide', sessionId: 's1', args: ['q?'] });
  pending[0].resolve({ text: '**yes**' });
  await done;
  assert.deepEqual(states.at(-1), { question: 'q?', status: 'answered', text: '**yes**', error: '' });
});

test('pending → failed → ask again re-sends the same question', async () => {
  const { controller, calls, pending } = harness();
  const first = controller.ask('s1', 'q?');
  pending[0].reject(new Error('model down'));
  await first;
  assert.equal(controller.current().status, 'failed');
  assert.equal(controller.current().error, 'model down');
  const again = controller.retry('s1');
  assert.equal(controller.current().status, 'pending');
  assert.deepEqual(calls.filter((call) => call.capability === 'askSide').at(-1).args, ['q?']);
  pending[1].resolve({ text: 'ok' });
  await again;
  assert.equal(controller.current().text, 'ok');
});

test('cancel while pending calls cancelSide and ignores the late result', async () => {
  const { controller, calls, pending } = harness();
  const done = controller.ask('s1', 'q?');
  controller.close();
  assert.equal(controller.current(), null);
  assert.deepEqual(calls.at(-1), { capability: 'cancelSide', sessionId: 's1' });
  pending[0].resolve({ text: 'late' });
  await done;
  assert.equal(controller.current(), null);
});

test('ask then immediate close dispatches askSide before its cancel, both for the origin session', async () => {
  const { controller, calls, pending } = harness();
  const done = controller.ask('s1', 'q?');
  controller.close();
  assert.deepEqual(calls, [
    { capability: 'askSide', sessionId: 's1', args: ['q?'] },
    { capability: 'cancelSide', sessionId: 's1' },
  ]);
  pending[0].resolve({ text: 'late' });
  await done;
  assert.equal(controller.current(), null);
});

test('ask then immediate re-ask in another session cancels the origin session, not the new one', async () => {
  const { controller, calls, pending } = harness();
  const first = controller.ask('s1', 'one');
  const second = controller.ask('s2', 'two');
  assert.deepEqual(calls, [
    { capability: 'askSide', sessionId: 's1', args: ['one'] },
    { capability: 'cancelSide', sessionId: 's1' },
    { capability: 'askSide', sessionId: 's2', args: ['two'] },
  ]);
  pending[0].resolve({ text: 'stale' });
  pending[1].resolve({ text: 'fresh' });
  await Promise.all([first, second]);
  assert.equal(controller.current().text, 'fresh');
});

test('a new ask replaces a pending card, cancelling it', async () => {
  const { controller, calls, pending } = harness();
  const first = controller.ask('s1', 'one');
  const second = controller.ask('s1', 'two');
  assert.equal(calls[1].capability, 'cancelSide');
  pending[0].resolve({ text: 'stale' });
  pending[1].resolve({ text: 'fresh' });
  await Promise.all([first, second]);
  assert.equal(controller.current().question, 'two');
  assert.equal(controller.current().text, 'fresh');
});

test('closing an answered card does not call cancelSide', async () => {
  const { controller, calls, pending } = harness();
  const done = controller.ask('s1', 'q');
  pending[0].resolve({ text: 'a' });
  await done;
  controller.close();
  assert.equal(calls.filter((call) => call.capability === 'cancelSide').length, 0);
});
