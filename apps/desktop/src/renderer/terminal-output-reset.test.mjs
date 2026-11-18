import assert from 'node:assert/strict';
import test from 'node:test';

import { attachTerminalOutput } from './terminal-output-subscription.ts';
import { TerminalWritePump } from './terminal-write-pump.ts';
import { followTerminalOutput } from './remote-protocol-terminal.ts';

test('a reset event clears the view, writes the replay as a replay write and acknowledges it once written', async () => {
  const calls = [];
  let emit = null;
  const view = {
    id: 't1',
    replayPending: null,
    term: { reset: () => calls.push('term.reset') },
    localEcho: { onIncoming: (d) => d, reset: () => calls.push('echo.reset') },
    writer: {
      push: (id, data) => calls.push(`push:${data}`),
      writeReplay: async (data, before) => {
        before?.();
        calls.push(`replay:${data}`);
      },
    },
  };
  const acks = [];
  attachTerminalOutput(
    view,
    (listener) => {
      emit = listener;
      return () => {};
    },
    (id, charCount) => acks.push([id, charCount])
  );
  emit({ id: 'other', data: 'x', reset: true });
  emit({ id: 't1', data: 'screen', reset: true });
  emit({ id: 't1', data: 'live' });
  assert.deepEqual(calls, ['echo.reset', 'term.reset', 'replay:screen', 'push:live']);
  assert.deepEqual(acks, [], 'the replay is acknowledged only after it is written');
  await view.replayPending;
  assert.equal(view.replayPending, null);
  // main's TerminalDataBufferer.reset counts the replay in flight: it is acknowledged in full
  assert.deepEqual(acks, [['t1', 'screen'.length]]);
});

test('a parked terminal redraws after queued writes and receives only the relay bytes past the replay cut', async () => {
  const writes = [];
  const complete = [];
  const view = {
    id: 'tab',
    replayPending: null,
    localEcho: null,
    term: { reset: () => writes.push('reset') },
    writer: new TerminalWritePump((text, done) => { writes.push(text); complete.push(done); }, () => {}),
  };
  let notify;
  let answer;
  attachTerminalOutput(view, (listener) => (notify = listener, () => {}));
  const output = followTerminalOutput(() => new Promise((resolve) => { answer = resolve; }), notify, () => true);
  const chunk = (offset, text) => ({
    processHandle: 'tab', outputStream: 'stream', outputOffset: offset, bytesB64: Buffer.from(text).toString('base64'),
  });
  output.hold('tab');
  output.frame('tab', chunk(0, 'old'));
  output.gap();
  output.frame('tab', chunk(3, 'éafter'));
  answer({ id: 'tab', replay: 'oldé', replayCut: { stream: 'stream', offset: 5 } });
  await Promise.resolve();
  output.frame('tab', chunk(0, 'old'));
  assert.deepEqual(writes, ['old'], 'the reset waits for already submitted parser work');
  complete.shift()();
  assert.deepEqual(writes, ['old', 'reset', 'oldé']);
  complete.shift()();
  assert.deepEqual(writes, ['old', 'reset', 'oldé', 'after']);
  complete.shift()();
  assert.deepEqual(writes, ['old', 'reset', 'oldé', 'after'], 'a pre-cut frame delivered after the reply is also discarded');
  output.stop();
});
