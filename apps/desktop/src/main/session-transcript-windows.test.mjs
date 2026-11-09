import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DESKTOP_TRANSCRIPT_PAGE_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_BYTES,
  DESKTOP_TRANSCRIPT_TAIL_ITEMS,
  REMOTE_TRANSCRIPT_TAIL_BYTES,
  REMOTE_TRANSCRIPT_TAIL_ITEMS,
} from './desktop-support.ts';
import { SessionTranscriptWindows } from './session-transcript-windows.ts';
import { createSnapshotDeltaDecoder, createSnapshotDeltaEncoder } from './state-delta.ts';

const id = 'sess_window';

test('a session only a phone shows opens on the short remote tail and pages older rows from it', () => {
  const sources = new Map([['remote:phone', new Set([id])]]);
  const windows = new SessionTranscriptWindows(sources);
  assert.ok(REMOTE_TRANSCRIPT_TAIL_ITEMS < DESKTOP_TRANSCRIPT_TAIL_ITEMS);
  // The phone's first page crosses a 22–93 KB/s upload: a few seconds at most.
  assert.ok(REMOTE_TRANSCRIPT_TAIL_BYTES <= 128_000);
  assert.deepEqual(windows.send(id), {
    transcriptItemLimit: REMOTE_TRANSCRIPT_TAIL_ITEMS,
    transcriptByteBudget: REMOTE_TRANSCRIPT_TAIL_BYTES,
  });
  // Scrolling to the top asks for the held count plus one page.
  const held = REMOTE_TRANSCRIPT_TAIL_ITEMS;
  assert.equal(windows.grow(id, held + 64, held), true);
  assert.deepEqual(windows.request(id), {
    transcriptItemLimit: held + 64,
    transcriptByteBudget: DESKTOP_TRANSCRIPT_PAGE_BYTES,
    transcriptPageBase: held,
  });
});

test('a window grows past any former ceiling, and again from a shorter tail the daemon restarted', () => {
  const windows = new SessionTranscriptWindows(new Map([['desktop', new Set([id])]]));
  assert.equal(windows.grow(id, 20_064, 20_000), true, 'deep history keeps paging');
  assert.equal(windows.request(id).transcriptItemLimit, 20_064);
  assert.equal(windows.grow(id, 20_000, 20_000), false, 'the rows held already cover it');
  // The daemon answered a whole window as a fresh 512-row tail: the next page
  // grows from what is held, below the last limit asked.
  assert.equal(windows.grow(id, 576, 512), true);
  assert.deepEqual(windows.request(id), {
    transcriptItemLimit: 576,
    transcriptByteBudget: DESKTOP_TRANSCRIPT_PAGE_BYTES,
    transcriptPageBase: 512,
  });
});
