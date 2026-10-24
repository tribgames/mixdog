import assert from 'node:assert/strict';
import test from 'node:test';

import { trackReplay, viewPaintsAtOnce } from './terminal-replay-state.ts';

function replayingView() {
  const write = Promise.withResolvers();
  return {
    view: { id: null, replayPending: null, writer: { writeReplay: () => write.promise } },
    finishWrite: () => write.resolve(),
  };
}

test('a click mid-replay: an attached view whose replay is still being written does not paint at once', async () => {
  const { view, finishWrite } = replayingView();
  // The warm-up's attach answered: the PTY id lands first, its scrollback is
  // still being written into xterm.
  view.id = 'session-terminal:a';
  const written = trackReplay(view, 'scrollback');
  assert.equal(viewPaintsAtOnce(view, true), false, 'the open must not treat a partial replay as complete');
  assert.equal(viewPaintsAtOnce(view, false), false, 'not even without a saved viewport');
  finishWrite();
  await written;
  assert.equal(view.replayPending, null);
  assert.equal(viewPaintsAtOnce(view, true), true, 'complete once the replay is written');
});

test('a newer replay keeps the view incomplete when an older one settles', async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const writes = [first.promise, second.promise];
  const view = { id: 't', replayPending: null, writer: { writeReplay: () => writes.shift() } };
  const older = trackReplay(view, 'a');
  const newer = trackReplay(view, 'b');
  first.resolve();
  await older;
  assert.equal(viewPaintsAtOnce(view, true), false);
  second.resolve();
  await newer;
  assert.equal(viewPaintsAtOnce(view, true), true);
});

test('a never-run tab paints at once; a saved but unattached one does not', () => {
  assert.equal(viewPaintsAtOnce(undefined, false), true);
  assert.equal(viewPaintsAtOnce(undefined, true), false);
  assert.equal(viewPaintsAtOnce({ id: null, replayPending: null, writer: {} }, true), false);
});
