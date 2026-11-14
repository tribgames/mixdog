import assert from 'node:assert/strict';
import test from 'node:test';

import { attachTerminalOutput } from './terminal-output-subscription.ts';

test('a reset event clears the view and writes the replay as a replay write, unacknowledged', async () => {
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
  attachTerminalOutput(view, (listener) => {
    emit = listener;
    return () => {};
  });
  emit({ id: 'other', data: 'x', reset: true });
  emit({ id: 't1', data: 'screen', reset: true });
  emit({ id: 't1', data: 'live' });
  assert.deepEqual(calls, ['echo.reset', 'term.reset', 'replay:screen', 'push:live']);
  await view.replayPending;
  assert.equal(view.replayPending, null);
});
