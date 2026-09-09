import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteBrowserInputQueue } from './remote-browser-input.ts';

const text = (value, documentId = 'p1:0') =>
  ({ type: 'text', text: value, frameId: 'rbf_a1', documentId });
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('remote typing is delivered in order with its original document while a send is pending', async () => {
  const gate = deferred();
  const sent = [];
  const failures = [];
  const queue = createRemoteBrowserInputQueue({
    send: async (input) => {
      sent.push(input);
      if (sent.length === 1) await gate.promise;
    },
    failure: (message) => failures.push(message),
    settled() {},
  });
  const inputs = [text('a'), text('@'), { type: 'key', key: 'Backspace', frameId: 'rbf_a1', documentId: 'p1:0' }];
  const work = inputs.map((input) => queue.enqueue(input));
  await Promise.resolve();
  assert.deepEqual(sent, [inputs[0]]);
  gate.resolve();
  await Promise.all(work);
  assert.deepEqual(sent, inputs);
  assert.deepEqual(failures, []);
});

test('an uncertain remote send is not replayed, cancels queued edits, and permits a new user attempt', async () => {
  const gate = deferred();
  const sent = [];
  const failures = [];
  const queue = createRemoteBrowserInputQueue({
    send: async (input) => {
      sent.push(input);
      if (sent.length === 1) {
        await gate.promise;
        throw new Error('connection lost after dispatch');
      }
    },
    failure: (message) => failures.push(message),
    settled() {},
  });
  const first = queue.enqueue(text('a'));
  const second = queue.enqueue(text('b'));
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(sent, [text('a')]);
  assert.match(failures[0], /connection lost after dispatch.*Pending input was not sent/);
  await queue.enqueue(text('new attempt', 'p1:1'));
  assert.deepEqual(sent, [text('a'), text('new attempt', 'p1:1')]);
});

test('closing or replacing a remote pane drops its unstarted input, even after reactivation', async () => {
  const gate = deferred();
  const sent = [];
  const queue = createRemoteBrowserInputQueue({
    send: async (input) => { sent.push(input); await gate.promise; },
    failure: assert.fail,
    settled() {},
  });
  const first = queue.enqueue(text('a'));
  await Promise.resolve();
  const second = queue.enqueue(text('b'));
  queue.dispose();
  queue.activate();
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(sent, [text('a')]);
});

test('remote input backpressure reports the unsent action instead of growing an unbounded queue', async () => {
  const gate = deferred();
  const sent = [];
  const failures = [];
  const queue = createRemoteBrowserInputQueue({
    send: async (input) => { await gate.promise; sent.push(input); },
    failure: (message) => failures.push(message),
    settled() {},
  });
  const work = Array.from({ length: 129 }, (_, index) => queue.enqueue(text(String(index))));
  gate.resolve();
  await Promise.all(work);
  assert.equal(sent.length, 128);
  assert.equal(sent.at(-1).text, '127');
  assert.match(failures[0], /busy; input was not sent/);
});
