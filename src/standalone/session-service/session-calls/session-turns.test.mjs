// The daemon intake is the single send point for the desktop composer and for
// paired phones: whichever device sends, the message metadata records the
// attachments by content hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.MIXDOG_DATA_DIR = mkdtempSync(join(tmpdir(), 'mixdog-turns-'));
const { createSessionTurnCalls } = await import('./session-turns.mjs');

const b64 = (text) => Buffer.from(text).toString('base64');

function harness() {
  const submitted = [];
  const runtime = {
    provider: 'anthropic',
    submitAsync: async (prompt, options) => {
      submitted.push({ prompt, options });
      return true;
    },
  };
  const entry = { runtime };
  const calls = createSessionTurnCalls({
    log: () => {},
    readStoredGoal: () => null,
    listStoredActiveGoalSessionIds: () => [],
    hasAgentSession: () => false,
    sessionResult: (_entry, _step, _base, extra) => extra,
    advanceForCaller: () => ({}),
    retention: { retainUnwatched: () => {} },
    entries: { entryForSession: async () => entry },
  });
  return { calls, submitted };
}

const send = (calls, options = {}) =>
  calls.submitSession({
    sessionId: 's1',
    prompt: [
      { type: 'text', text: 'look [Pasted text #1 +3 lines]' },
      { type: 'image', data: b64('png bytes'), mimeType: 'image/png' },
      { type: 'file', data: b64('docx bytes'), mimeType: 'application/octet-stream', filename: 'plan.docx' },
    ],
    options: {
      pastedImages: {
        2: { id: 2, type: 'image', mediaType: 'image/png', filename: 'shot.png', content: b64('png bytes') },
      },
      pastedTexts: {
        1: { id: 1, text: 'pasted '.repeat(200), source: 'paste', filename: 'Pasted text #1', mimeType: 'text/plain' },
      },
      ...options,
    },
  });

test('a desktop send and a paired-device send both record their attachments in the message metadata', async () => {
  const { calls, submitted } = harness();
  await send(calls, { transcriptMeta: { messageId: 'msg_desktop', device: 'This PC' } });
  await send(calls, { transcriptMeta: { messageId: 'msg_phone', device: 'Pixel 8' } });
  assert.equal(submitted.length, 2);
  for (const { options } of submitted) {
    const names = options.transcriptMeta.attachments.map((entry) => entry.name).sort();
    assert.deepEqual(names, ['Pasted text #1', 'plan.docx', 'shot.png']);
    for (const entry of options.transcriptMeta.attachments) assert.equal(entry.id, entry.attachmentRef);
  }
  // The sender's own metadata survives next to them.
  assert.equal(submitted[1].options.transcriptMeta.device, 'Pixel 8');
  // Identical bytes from either device are the same ids (one blob).
  assert.deepEqual(
    submitted[0].options.transcriptMeta.attachments.map((entry) => entry.id),
    submitted[1].options.transcriptMeta.attachments.map((entry) => entry.id)
  );
});

test('a prompt without attachments adds no attachment metadata', async () => {
  const { calls, submitted } = harness();
  await calls.submitSession({ sessionId: 's1', prompt: 'plain', options: { transcriptMeta: { messageId: 'm' } } });
  assert.equal('attachments' in submitted[0].options.transcriptMeta, false);
});
