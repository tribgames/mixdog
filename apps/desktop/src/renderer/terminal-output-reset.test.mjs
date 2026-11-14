import assert from 'node:assert/strict';
import test from 'node:test';

import { attachTerminalOutput } from './terminal-output-subscription.ts';

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
      writeReplay: async (data) => {
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
