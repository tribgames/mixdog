import assert from 'node:assert/strict';
import test from 'node:test';
import { REMOTE_TRANSCRIPT_ROW_MAX_BYTES } from './remote-transcript.ts';
import * as support from './desktop-support.ts';
import * as shared from '../shared/desktop-transcript-limits.ts';

// Node's own byte count (Buffer.byteLength) is the reference: the web-safe count must be identical for every string.
const SAMPLES = ['', 'plain', 'héllo wörld', '日本語のテキスト', '😀 pair', 'a\u2028b', '\ud800 lone', 'x'.repeat(1000) + '\u{1F600}'.repeat(50)];
test('the transcript byte count equals Buffer.byteLength for every kind of text', () => {
  const encoder = new TextEncoder();
  for (const text of SAMPLES) {
    const serialized = JSON.stringify(text);
    assert.equal(encoder.encode(serialized).length, Buffer.byteLength(serialized, 'utf8'));
  }
  assert.equal(REMOTE_TRANSCRIPT_ROW_MAX_BYTES, 128_000);
});

test('desktop-support still exports what moved to shared, unchanged', () => {
  assert.equal(support.DESKTOP_TRANSCRIPT_TAIL_ITEMS, shared.DESKTOP_TRANSCRIPT_TAIL_ITEMS);
  assert.equal(support.REMOTE_TRANSCRIPT_TAIL_BYTES, shared.REMOTE_TRANSCRIPT_TAIL_BYTES);
  assert.equal(support.normalizedProviderModels, shared.normalizedProviderModels);
});
