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

test('a session the desktop window also shows keeps the desktop tail, and a joining window re-reads it', () => {
  const sources = new Map([['remote:phone', new Set([id])]]);
  const windows = new SessionTranscriptWindows(sources);
  windows.send(id);
  sources.set('desktop', new Set([id]));
  assert.equal(windows.stale(id), true, 'the held phone tail is shorter than the desktop pane needs');
  assert.deepEqual(windows.send(id), {
    transcriptItemLimit: DESKTOP_TRANSCRIPT_TAIL_ITEMS,
    transcriptByteBudget: DESKTOP_TRANSCRIPT_TAIL_BYTES,
  });
  // A read for a session no view registered yet keeps the desktop tail.
  assert.equal(new SessionTranscriptWindows(new Map()).request(id).transcriptItemLimit, DESKTOP_TRANSCRIPT_TAIL_ITEMS);
});
