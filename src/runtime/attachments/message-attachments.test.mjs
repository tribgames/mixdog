// Attachments recorded in the message metadata (`meta.transcript.attachments`):
// derived once at the daemon intake for every kind, kept by the persisted and
// restored transcript row, and counted by the store's census so a blob lives
// exactly as long as a message names it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeTempDirSync } from '../../../scripts/lib/scoped-temp.mjs';

const dataDir = makeTempDirSync('message-attachments');
process.env.MIXDOG_DATA_DIR = dataDir;

const { attachmentsForIntake, collectPromptAttachments, materializePromptSubmission } = await import('./store.mjs');
const { persistedUserTranscriptMetadata, normalizeMessageAttachments } = await import(
  '../shared/transcript-metadata.mjs'
);
const { restoreTranscriptItems } = await import('../agent/orchestrator/session/transcript-restore/restore.mjs');

const b64 = (text) => Buffer.from(text).toString('base64');

/** What the desktop composer sends (use-composer-submission.ts), materialized. */
function submit() {
  return materializePromptSubmission(
    [
      { type: 'text', text: 'see [Pasted text #1 +3 lines] and [File #2: notes.md]' },
      { type: 'image', data: b64('png bytes'), mimeType: 'image/png' },
      { type: 'file', data: b64('%PDF-1.7\nbody'), mimeType: 'application/pdf', filename: 'spec.pdf' },
      {
        type: 'file',
        data: b64('docx bytes'),
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        filename: 'plan.docx',
      },
    ],
    {
      pastedImages: {
        3: { id: 3, type: 'image', mediaType: 'image/png', filename: 'shot.png', content: b64('png bytes') },
      },
      pastedTexts: {
        1: {
          id: 1,
          text: 'pasted body '.repeat(80),
          source: 'paste',
          filename: 'Pasted text #1',
          mimeType: 'text/plain',
        },
        2: { id: 2, text: 'file body '.repeat(80), source: 'file', filename: 'notes.md', mimeType: 'text/markdown' },
      },
    }
  );
}

test('every attachment kind is recorded by content hash with name, type and size', () => {
  const intake = submit();
  const attachments = attachmentsForIntake(intake.prompt, intake.options);
  const byName = Object.fromEntries(attachments.map((entry) => [entry.name, entry]));
  assert.deepEqual(Object.keys(byName).sort(), ['Pasted text #1', 'notes.md', 'plan.docx', 'shot.png', 'spec.pdf']);
  assert.equal(byName['shot.png'].kind, 'image');
  assert.equal(byName['spec.pdf'].mimeType, 'application/pdf');
  assert.equal(byName['plan.docx'].kind, 'file');
  assert.equal(byName['Pasted text #1'].kind, 'text');
  assert.equal(byName['notes.md'].mimeType, 'text/markdown');
  for (const entry of attachments) {
    assert.match(entry.id, /^[a-f0-9]{64}$/);
    assert.equal(entry.attachmentRef, entry.id, 'the id is the store reference');
    assert.ok(entry.size > 0);
  }
  // The same bytes (image part + side table) are one attachment, not two.
  assert.equal(attachments.filter((entry) => entry.kind === 'image').length, 1);
});

test('a plain long prompt is not an attachment', () => {
  const intake = materializePromptSubmission('long plain prompt '.repeat(100));
  assert.deepEqual(attachmentsForIntake(intake.prompt, intake.options), []);
});

test('the persisted and restored user row keep the attachments, and drop malformed ones', () => {
  const intake = submit();
  const attachments = attachmentsForIntake(intake.prompt, intake.options);
  const meta = persistedUserTranscriptMetadata({ messageId: 'msg_1', at: 1, attachments });
  assert.deepEqual(meta.attachments, attachments);
  assert.deepEqual(
    normalizeMessageAttachments([...attachments, { id: '../etc/passwd', name: 'x' }, { id: 'a'.repeat(63) }, null]),
    attachments
  );
  const [row] = restoreTranscriptItems([{ role: 'user', content: 'hello', meta: { transcript: meta } }]);
  assert.equal(row.kind, 'user');
  assert.deepEqual(row.attachments, attachments);
  const [plain] = restoreTranscriptItems([
    { role: 'user', content: 'legacy', meta: { transcript: { messageId: 'm' } } },
  ]);
  assert.equal('attachments' in plain, false, 'a legacy row has no attachment records');
});

test('the census keeps blobs a message record names and sweeps the unreferenced ones', async () => {
  const intake = submit();
  const attachments = attachmentsForIntake(intake.prompt, intake.options);
  const orphan = materializePromptSubmission([{ type: 'file', data: b64('orphan'), mimeType: 'text/plain' }]).prompt[0];
  const blob = (ref) => join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2), ref);
  // The session keeps only the metadata: the content parts are gone (compaction).
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(
    join(dataDir, 'sessions', 'sess_meta_only.json'),
    JSON.stringify({
      id: 'sess_meta_only',
      messages: [{ role: 'user', content: 'summary', meta: { transcript: { messageId: 'm', attachments } } }],
    })
  );
  const old = new Date(Date.now() - 120_000);
  for (const entry of attachments) utimesSync(blob(entry.id), old, old);
  utimesSync(blob(orphan.attachmentRef), old, old);
  await collectPromptAttachments({ now: Date.now(), minAgeMs: 60_000 });
  for (const entry of attachments) assert.equal(existsSync(blob(entry.id)), true, entry.name);
  assert.equal(existsSync(blob(orphan.attachmentRef)), false);
});
