// Esc-Esc "edit a previous message" for prompts that carried attachments: the
// stored prompt is the EXPANDED text, so the target is found by the stable
// message id and the attachments come back as the restore payload.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = mkdtempSync(join(tmpdir(), 'mixdog-session-rewind-'));
const previousDataDir = process.env.MIXDOG_DATA_DIR;
process.env.MIXDOG_DATA_DIR = root;
mkdirSync(join(root, 'sessions'));
const { drainSessionStore, loadSession, saveSessionAsync } = await import('../store.mjs');
const { rewindSessionMessagesTo } = await import('./session-crud.mjs');
const { settleSessionSummaryIndex } = await import('../store/listing.mjs');
const { materializePromptSubmission, hydratePastedAttachments, hydrateRestorableFileParts } = await import(
  '../../../../attachments/store.mjs'
);
const { restorableAttachmentsFromPrompt } = await import('../../../../attachments/prompt-restore.mjs');

test.after(async () => {
  drainSessionStore();
  await settleSessionSummaryIndex();
  if (previousDataDir === undefined) delete process.env.MIXDOG_DATA_DIR;
  else process.env.MIXDOG_DATA_DIR = previousDataDir;
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const b64 = (text) => Buffer.from(text).toString('base64');
const PASTE = 'pasted body line\n'.repeat(60);

async function plant(id, messages) {
  const session = { id, provider: 'openai', model: 'gpt-test', cwd: root, messages, generation: 0, closed: false };
  await saveSessionAsync(session, { expectedGeneration: 0 });
}

const rowText = 'look [Pasted text #1 +60 lines] and [File #2: spec.pdf] please';

function attachmentPrompt() {
  return materializePromptSubmission(
    [
      { type: 'text', text: rowText },
      { type: 'image', data: b64('png bytes'), mimeType: 'image/png', pasteId: 3 },
      { type: 'file', data: b64('%PDF-1.7\nbody'), mimeType: 'application/pdf', filename: 'spec.pdf' },
    ],
    {
      pastedImages: {
        3: { id: 3, type: 'image', mediaType: 'image/png', filename: 'shot.png', content: b64('png bytes') },
      },
      pastedTexts: { 1: { id: 1, text: PASTE, source: 'paste', filename: 'Pasted text #1', mimeType: 'text/plain' } },
    }
  ).prompt;
}

test('a message with a folded paste is found by its message id and restores the pasted text', async () => {
  const content = attachmentPrompt();
  await plant('sess_rewind_attach', [
    { role: 'user', content: 'earlier', meta: { transcript: { messageId: 'msg_a' } } },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content, meta: { transcript: { messageId: 'msg_b' } } },
    { role: 'assistant', content: 'done' },
  ]);
  // The row text (tokens) can never equal the expanded stored prompt.
  assert.equal(await rewindSessionMessagesTo('sess_rewind_attach', { text: rowText }), null);
  const result = await rewindSessionMessagesTo('sess_rewind_attach', { text: rowText, messageId: 'msg_b' });
  assert.equal(result.removed, 2);
  assert.equal(result.remaining, 2);

  const refs = restorableAttachmentsFromPrompt(result.message.content, rowText);
  const hydrated = hydratePastedAttachments(refs.pastedImages, refs.pastedTexts);
  assert.equal(hydrated.pastedTexts[1].text, PASTE);
  assert.equal(hydrated.pastedTexts[1].source, 'paste');
  assert.equal(hydrated.pastedImages[3].content, b64('png bytes'));
  assert.equal(hydrated.pastedImages[3].mediaType, 'image/png');
  const files = hydrateRestorableFileParts(result.message.content);
  assert.deepEqual(files, [
    { type: 'file', data: b64('%PDF-1.7\nbody'), mimeType: 'application/pdf', filename: 'spec.pdf' },
  ]);
});

test('a plain text message without an id still rewinds by its text, and carries no attachments', async () => {
  await plant('sess_rewind_plain', [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'second' },
  ]);
  const result = await rewindSessionMessagesTo('sess_rewind_plain', { text: 'second' });
  assert.equal(result.removed, 1);
  assert.deepEqual(restorableAttachmentsFromPrompt(result.message.content, 'second'), {
    pastedTexts: null,
    pastedImages: null,
  });
});

test('a dry-run rewind reports the target and leaves the stored history untouched', async () => {
  await plant('sess_rewind_dry', [
    { role: 'user', content: 'first', meta: { transcript: { messageId: 'msg_1' } } },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'second', meta: { transcript: { messageId: 'msg_2' } } },
    { role: 'assistant', content: 'two' },
  ]);
  const preview = await rewindSessionMessagesTo('sess_rewind_dry', { messageId: 'msg_2', dryRun: true });
  assert.equal(preview.removed, 2);
  assert.equal(preview.remaining, 2);
  assert.equal(preview.message.content, 'second');
  assert.equal(loadSession('sess_rewind_dry').messages.length, 4);
  assert.equal((await rewindSessionMessagesTo('sess_rewind_dry', { messageId: 'msg_2' })).removed, 2);
  assert.equal(loadSession('sess_rewind_dry').messages.length, 2);
});

test('a committing rewind is refused, changing nothing, when history changed since the dry run', async () => {
  await plant('sess_rewind_stale', [
    { role: 'user', content: 'first', meta: { transcript: { messageId: 'msg_1' } } },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'second', meta: { transcript: { messageId: 'msg_2' } } },
    { role: 'assistant', content: 'two' },
  ]);
  const preview = await rewindSessionMessagesTo('sess_rewind_stale', { messageId: 'msg_2', dryRun: true });
  assert.ok(preview.historyMarker);
  const changed = loadSession('sess_rewind_stale');
  changed.messages.push({ role: 'user', content: 'third' });
  await saveSessionAsync(changed, { expectedGeneration: changed.generation });
  const stale = { messageId: 'msg_2', expectedHistoryMarker: preview.historyMarker };
  assert.equal(await rewindSessionMessagesTo('sess_rewind_stale', stale), null);
  assert.equal(loadSession('sess_rewind_stale').messages.length, 5);
  // A fresh preview commits.
  const fresh = await rewindSessionMessagesTo('sess_rewind_stale', { messageId: 'msg_2', dryRun: true });
  const done = await rewindSessionMessagesTo('sess_rewind_stale', {
    messageId: 'msg_2',
    expectedHistoryMarker: fresh.historyMarker,
  });
  assert.equal(done.removed, 3);
  assert.equal(loadSession('sess_rewind_stale').messages.length, 2);
});

test('an id-less prompt that several user messages repeat is refused, not guessed', async () => {
  const messages = [
    { role: 'user', content: 'same' },
    { role: 'assistant', content: 'one' },
    { role: 'user', content: 'same' },
    { role: 'assistant', content: 'two' },
  ];
  await plant('sess_rewind_ambiguous', messages);
  assert.equal(await rewindSessionMessagesTo('sess_rewind_ambiguous', { text: 'same' }), null);
  const kept = loadSession('sess_rewind_ambiguous');
  assert.equal(kept.messages.length, 4);
  // The same prompts addressed by id stay rewindable.
  kept.messages[0].meta = { transcript: { messageId: 'msg_first' } };
  kept.messages[2].meta = { transcript: { messageId: 'msg_second' } };
  await saveSessionAsync(kept, { expectedGeneration: kept.generation });
  assert.equal((await rewindSessionMessagesTo('sess_rewind_ambiguous', { messageId: 'msg_first' })).removed, 4);
});
