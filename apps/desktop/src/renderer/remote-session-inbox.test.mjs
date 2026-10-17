import assert from 'node:assert/strict';
import test from 'node:test';
import { createRemoteSessionInbox } from './remote-session-inbox.ts';

const frame = (sessionId, text) => ({
  sessionId,
  snapshot: { sessionId, items: [{ id: `${sessionId}-user`, kind: 'user', text }] },
  frameSource: 'live',
});

test('startup frames reach a late mounted store without another host publication', () => {
  const inbox = createRemoteSessionInbox({ onGap: () => assert.fail('no lost frames') });
  inbox.publish(frame('a', 'sent from phone'));
  inbox.publish(frame('a', 'latest prompt'));
  inbox.publish(frame('b', 'another session'));
  const received = [];
  const unsubscribe = inbox.subscribe((update) => received.push(update));
  assert.deepEqual(received, [frame('a', 'latest prompt'), frame('b', 'another session')]);
  inbox.publish(frame('a', 'live update'));
  assert.deepEqual(received.at(-1), frame('a', 'live update'));
  unsubscribe();
  inbox.publish(frame('b', 'while switching'));
  const reopened = [];
  inbox.subscribe((update) => reopened.push(update));
  assert.deepEqual(reopened, [frame('b', 'while switching')]);
});

test('a new connection discards undelivered old frames without clearing mounted stores', () => {
  const inbox = createRemoteSessionInbox({ onGap: () => assert.fail('no lost frames') });
  inbox.publish(frame('a', 'old connection'));
  inbox.reset();
  const received = [];
  inbox.subscribe((update) => received.push(update));
  assert.deepEqual(received, []);
  inbox.publish(frame('a', 'restored connection'));
  inbox.reset();
  assert.deepEqual(received, [frame('a', 'restored connection')]);
});

function manualFrames() {
  const callbacks = new Map();
  let next = 1;
  return {
    frames: {
      request(callback) {
        callbacks.set(next, callback);
        return next++;
      },
      cancel(handle) {
        callbacks.delete(handle);
      },
    },
    run() {
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) callback();
    },
    get pending() {
      return callbacks.size;
    },
  };
}

const items = [{ id: 'user', kind: 'user', text: 'question' }];
const live = (sessionId, text, fields = {}) => ({
  sessionId,
  frameSource: 'live',
  snapshot: { busy: true, items, streamingTail: { id: 'tail', kind: 'assistant', text }, ...fields },
});

test('streaming text appends reach the store at most once per animation frame, latest text intact', () => {
  const clock = manualFrames();
  const inbox = createRemoteSessionInbox({ onGap: () => assert.fail('no lost frames'), frames: clock.frames });
  const received = [];
  inbox.subscribe((update) => received.push(update));
  inbox.publish(live('a', ''));
  assert.equal(received.length, 1);
  inbox.publish(live('a', '한'));
  inbox.publish(live('a', '한글'));
  inbox.publish(live('b', 'other'));
  inbox.publish(live('b', 'other lane'));
  assert.equal(received.length, 2);
  assert.equal(clock.pending, 1);
  clock.run();
  assert.deepEqual(
    received.slice(2).map((update) => [update.sessionId, update.snapshot.streamingTail.text]),
    [
      ['a', '한글'],
      ['b', 'other lane'],
    ]
  );
  assert.equal(clock.pending, 0);
});

test('a non-append frame is delivered at once and supersedes a held append', () => {
  const clock = manualFrames();
  const inbox = createRemoteSessionInbox({ onGap: () => assert.fail('no lost frames'), frames: clock.frames });
  const received = [];
  inbox.subscribe((update) => received.push(update));
  inbox.publish(live('a', ''));
  inbox.publish(live('a', 'partial'));
  const settled = {
    sessionId: 'a',
    frameSource: 'live',
    snapshot: { busy: false, items: [...items, { id: 'tail', kind: 'assistant', text: 'partial answer' }] },
  };
  inbox.publish(settled);
  assert.deepEqual(received, [live('a', ''), settled]);
  clock.run();
  assert.deepEqual(received, [live('a', ''), settled]);
  // A finished turn is no base for an append: the next frame is delivered at once.
  inbox.publish(live('a', 'partial answer!'));
  assert.equal(received.length, 3);
});

test('reset drops held appends from the old connection', () => {
  const clock = manualFrames();
  const inbox = createRemoteSessionInbox({ onGap: () => assert.fail('no lost frames'), frames: clock.frames });
  const received = [];
  inbox.subscribe((update) => received.push(update));
  inbox.publish(live('a', ''));
  inbox.publish(live('a', 'old'));
  inbox.reset();
  assert.equal(clock.pending, 0);
  clock.run();
  assert.equal(received.length, 1);
  inbox.publish(live('a', 'old text'));
  assert.equal(received.length, 2);
});

test('a bounded startup inbox requests recovery only when its consumer can receive it', () => {
  let recovery = 0;
  const inbox = createRemoteSessionInbox({
    maxEntries: 2,
    onGap: () => {
      recovery += 1;
    },
  });
  for (const id of ['a', 'b', 'c']) inbox.publish(frame(id, id));
  assert.equal(recovery, 0);
  const received = [];
  inbox.subscribe((update) => received.push(update.sessionId));
  assert.deepEqual(received, ['b', 'c']);
  assert.equal(recovery, 1);
  inbox.subscribe(() => {});
  assert.equal(recovery, 1);
});
