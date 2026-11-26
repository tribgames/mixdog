// A streamed reply folds delta by delta and projects as Node's turn stream cut it (turn-stream.mjs `partialNow`): the completed
// lines are `streamingTail`, the unfinished line after them `streamingPartial`, whatever the deltas' boundaries.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { JsonRpcNotification } from '../src/api.ts';
import { desktopSessionState, sessionReducer } from '../src/session-state.ts';

const delta = (text: string): JsonRpcNotification =>
  ({
    method: 'item/agentMessage/delta',
    params: { threadId: 't', itemId: 'a1', delta: text },
  }) as unknown as JsonRpcNotification;

test('a reply streamed in deltas projects its completed lines and its unfinished line, cut at the last newline of the text so far', () => {
  const chunks = ['  ', 'Hel', 'lo wor', 'ld\nsec', 'ond line\n', '\n', 'third\nfourth\nfif', 'th', ' ', '\n', 'end'];
  let fold = sessionReducer.initial({ thread: { id: 't' }, state: {}, items: [], hasOlder: false });
  let text = '';
  let partialShown = false;
  for (const chunk of chunks) {
    fold = sessionReducer.apply(fold, delta(chunk));
    text += chunk;
    const state = desktopSessionState(fold, []);
    const cut = text.lastIndexOf('\n') + 1;
    const rest = text.slice(cut);
    const identity = { id: 'a1', kind: 'assistant', streaming: true };
    let partial: { id: string; from: number; text: string; tail?: typeof identity } | null = null;
    if (cut > 0) {
      if (rest) partial = { id: 'a1', from: cut, text: rest };
    } else if (text.trim()) {
      partial = { id: 'a1', from: 0, text, tail: identity };
    }
    if (partial) partialShown = true;
    assert.deepEqual(
      state.streamingTail,
      cut > 0 ? { ...identity, text: text.slice(0, cut) } : null,
      `tail after ${JSON.stringify(text)}`
    );
    assert.deepEqual(state.streamingPartial ?? null, partial, `partial after ${JSON.stringify(text)}`);
    assert.equal('streamingPartial' in state, partialShown, 'the field is held from the first unfinished line on');
  }
});
