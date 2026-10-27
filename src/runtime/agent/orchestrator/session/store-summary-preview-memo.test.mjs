// The preview memo is fed every new message's raw text (up to its text limit),
// so it must stay within a character budget however many sessions a process
// summarizes, while a repeated text keeps answering from it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { _cleanPreviewMemoStatsForTest, _sessionSummary } from './store-summary-index.mjs';
import { cleanSummaryPreview } from './store-summary-last-message.mjs';

const BUDGET_CHARS_PER_MAX = 512 * 1024;

function session(index) {
  const text = `prompt ${index} ${'x'.repeat(1990)}`;
  return {
    id: `sess_memo_${index}`,
    title: `Session ${index % 7}`,
    messages: [
      { role: 'user', content: text },
      { role: 'assistant', content: `answer ${index} ${'y'.repeat(1900)}` },
    ],
  };
}

test('summarizing many sessions keeps the preview memo within its character budget', () => {
  for (let i = 0; i < 3000; i += 1) _sessionSummary(session(i));
  const { entries, chars } = _cleanPreviewMemoStatsForTest();
  // Three `max` variants are memoized (title 100, last message 160, preview 240).
  assert.ok(chars <= 3 * BUDGET_CHARS_PER_MAX, `memo holds ${chars} chars in ${entries} entries`);
  assert.ok(entries > 0);
});

test('a kept preview does not keep its whole message alive', () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc');
  const MESSAGES = 48;
  const MESSAGE_CHARS = 1024 * 1024;
  const previews = [];
  gc();
  const before = process.memoryUsage().heapUsed;
  for (let i = 0; i < MESSAGES; i += 1) {
    const reply = `reply ${i} ${'word '.repeat(MESSAGE_CHARS / 5)}`;
    const row = _sessionSummary({
      id: `sess_pin_${i}`,
      messages: [
        { role: 'user', content: `question ${i} ${'ask '.repeat(MESSAGE_CHARS / 4)}` },
        { role: 'assistant', content: reply },
      ],
    });
    previews.push(row.preview, row.lastMessagePreview);
  }
  gc();
  const grown = process.memoryUsage().heapUsed - before;
  assert.equal(previews.length, 2 * MESSAGES);
  assert.ok(previews.every((value) => value.length > 0 && value.length <= 240));
  // Pinned whole, the messages' cleaned copies alone would be ~2 × 48 MB.
  assert.ok(grown < 16 * 1024 * 1024, `previews retain ${(grown / 1048576).toFixed(1)} MB`);
});

test('previews stay exact while the memo evicts under its budget', () => {
  const hot = session(-1);
  const expected = _sessionSummary(hot).preview;
  for (let i = 0; i < 2000; i += 1) {
    const cold = session(10_000 + i);
    assert.equal(_sessionSummary(cold).preview, cleanSummaryPreview(cold.messages[0].content, 240));
    // Fresh message objects carrying the hot text (a reload from disk).
    assert.equal(_sessionSummary({ ...hot, messages: hot.messages.map((m) => ({ ...m })) }).preview, expected);
  }
});
