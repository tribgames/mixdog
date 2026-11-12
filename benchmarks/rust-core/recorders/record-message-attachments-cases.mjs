#!/usr/bin/env node
// Recording of runtime/attachments/message-attachments.test.mjs (b6f10295a), the case whose behaviour stays in the product: the
// persisted and restored user row keep the attachments, and malformed ones are dropped. Node's own submission intake, metadata
// writer, normaliser and transcript restore run unchanged over the data directory the recorder gives them.
//
//   node benchmarks/rust-core/recorders/record-message-attachments-cases.mjs --tree <export of b6f10295a with node_modules>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openSet } from './lib/case-set.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'message-attachments-'));
process.env.MIXDOG_DATA_DIR = dataDir;
const set = openSet('message-attachments-cases', import.meta.url);
const { attachmentsForIntake, materializePromptSubmission } = await set.load('src/runtime/attachments/store.mjs');
const { persistedUserTranscriptMetadata, normalizeMessageAttachments } = await set.load('src/runtime/shared/transcript-metadata.mjs');
const { restoreTranscriptItems } = await set.load('src/runtime/agent/orchestrator/session/transcript-restore/restore.mjs');

const b64 = (text) => Buffer.from(text).toString('base64');
// What the desktop composer sends (use-composer-submission.ts), exactly as the Node test submits it.
const parts = [
  { type: 'text', text: 'see [Pasted text #1 +3 lines] and [File #2: notes.md]' },
  { type: 'image', data: b64('png bytes'), mimeType: 'image/png' },
  { type: 'file', data: b64('%PDF-1.7\nbody'), mimeType: 'application/pdf', filename: 'spec.pdf' },
  { type: 'file', data: b64('docx bytes'), mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', filename: 'plan.docx' },
];
const side = {
  pastedImages: { 3: { id: 3, type: 'image', mediaType: 'image/png', filename: 'shot.png', content: b64('png bytes') } },
  pastedTexts: {
    1: { id: 1, text: 'pasted body '.repeat(80), source: 'paste', filename: 'Pasted text #1', mimeType: 'text/plain' },
    2: { id: 2, text: 'file body '.repeat(80), source: 'file', filename: 'notes.md', mimeType: 'text/markdown' },
  },
};

try {
  await set.run('the persisted and restored user row keep the attachments, and drop malformed ones', () => {
    const intake = materializePromptSubmission(parts, side);
    const attachments = attachmentsForIntake(intake.prompt, intake.options);
    const meta = persistedUserTranscriptMetadata({ messageId: 'msg_1', at: 1, attachments });
    const malformed = [{ id: '../etc/passwd', name: 'x' }, { id: 'a'.repeat(63) }, null];
    const [row] = restoreTranscriptItems([{ role: 'user', content: 'hello', meta: { transcript: meta } }]);
    const [plain] = restoreTranscriptItems([{ role: 'user', content: 'legacy', meta: { transcript: { messageId: 'm' } } }]);
    return {
      attachments, malformed, persistedMeta: meta,
      normalized: normalizeMessageAttachments([...attachments, ...malformed]),
      restoredKind: row.kind, restoredAttachments: row.attachments,
      legacyKind: plain.kind, legacyHasAttachments: 'attachments' in plain,
    };
  });
  await set.finish({
    entry: { runs: 'attachments/store.mjs materializePromptSubmission and attachmentsForIntake; shared/transcript-metadata.mjs persistedUserTranscriptMetadata and normalizeMessageAttachments; transcript-restore/restore.mjs restoreTranscriptItems' },
    replay: { entry: 'normalize_attachments over the recorded list with the malformed entries, and the stored-message restore of a user row with and without meta.transcript.attachments; compare the attachment list and its presence', normalised: {} },
  });
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
process.exit(0);
