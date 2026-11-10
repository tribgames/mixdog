import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const { restoreAttachmentsFromRecord, restoreDraftHandoff } = await import('./composer-attachment-restore.ts');
const { attachmentSummary, textWithoutAttachmentTokens } = await import('./message-attachment-summary.ts');

// What Node b6f10295a's session rewind (`rewindSessionMessagesTo` through the TUI/desktop `rewindToItem` action) answered for the
// three submitted prompts below, recorded by running it over a real session store: the record the composer restores its chips from.
const REWOUND = JSON.parse(readFileSync(new URL('./test-support/message-attachment-rewound.recorded.json', import.meta.url), 'utf8'));
const b64 = (text) => Buffer.from(text).toString('base64');

/** The record Node's rewind gave for the prompt of sessionId (the prompt itself is what the recording was made from). */
async function rewindSubmitted(sessionId) {
  return structuredClone(REWOUND[sessionId]);
}

const chipsOf = (record, text) =>
  restoreAttachmentsFromRecord(record, text, { reservedIds: new Set(), sequence: { current: 10 } });

test('a PDF token before a folded paste still restores both chips', async () => {
  const body = 'pasted body line\n'.repeat(60);
  const rowText = '[File #1: spec.pdf] then [Pasted text #2 +60 lines]';
  const record = await rewindSubmitted(
    'sess_restore_pdf_first',
    rowText,
    [
      { type: 'text', text: rowText },
      { type: 'file', data: b64('%PDF-1.7\nbody'), mimeType: 'application/pdf', filename: 'spec.pdf' },
    ],
    { pastedTexts: { 2: { id: 2, text: body, source: 'paste', filename: 'Pasted text #2', mimeType: 'text/plain' } } }
  );
  assert.deepEqual(Object.keys(record.pastedTexts), ['2']);
  const restored = chipsOf(record, record.text);
  const byKind = Object.fromEntries(restored.attachments.map((attachment) => [attachment.kind, attachment]));
  assert.equal(byKind.text.token, '[Pasted text #2 +60 lines]');
  assert.equal(byKind.text.data, body);
  assert.equal(byKind.pdf.name, 'spec.pdf');
});

test('a reference-backed pasted text restores its chip with the text', async () => {
  const body = 'stored line\n'.repeat(50);
  const rowText = 'check [Pasted text #1 +50 lines]';
  const record = await rewindSubmitted('sess_restore_ref', rowText, rowText, {
  });
  const restored = chipsOf(record, record.text);
  assert.equal(restored.attachments.length, 1);
  assert.equal(restored.attachments[0].token, '[Pasted text #1 +50 lines]');
  assert.equal(restored.attachments[0].data, body);
});

test('image, text file and paste come back from a rewound message', async () => {
  const body = 'file body '.repeat(120);
  const rowText = 'see [Image #3: shot.png] [File #1: notes.md] [Pasted text #2 +3 lines]';
  const record = await rewindSubmitted(
    'sess_restore_mixed',
    rowText,
    [
      { type: 'text', text: rowText },
      { type: 'image', data: b64('png bytes'), mimeType: 'image/png', pasteId: 3 },
    ],
    {
      pastedImages: {
        3: { id: 3, type: 'image', mediaType: 'image/png', filename: 'shot.png', content: b64('png bytes') },
      },
      pastedTexts: {
        1: { id: 1, text: body, source: 'file', filename: 'notes.md', mimeType: 'text/markdown' },
        2: { id: 2, text: 'one\ntwo\nthree\n'.repeat(80), source: 'paste', filename: 'Pasted text #2' },
      },
    }
  );
  const restored = chipsOf(record, record.text);
  const texts = restored.attachments.filter((attachment) => attachment.kind === 'text');
  assert.deepEqual(
    texts.map((attachment) => [attachment.source, attachment.token]),
    [
      ['file', '[File #1: notes.md]'],
      ['paste', '[Pasted text #2 +3 lines]'],
    ]
  );
  assert.equal(texts[0].data, body);
  assert.equal(restored.attachments.find((attachment) => attachment.kind === 'image').data, b64('png bytes'));
});

test('the selector row summarizes attachment tokens instead of showing them', () => {
  const text = '[Image #1: shot.png] [File #2: spec.pdf] look [Pasted text #3 +48 lines]';
  assert.equal(attachmentSummary(text), 'Images 1 · Files 1 · Pasted 48 lines');
  assert.equal(textWithoutAttachmentTokens(text), 'look');
  assert.equal(attachmentSummary('plain message'), '');
});

test('editing a message replaces the draft text and its chips', () => {
  const oldChip = {
    id: 1,
    name: 'old.txt',
    kind: 'text',
    mimeType: 'text/plain',
    data: 'old',
    token: '[Pasted text #1]',
  };
  const composer = { draft: 'half typed', attachments: [oldChip] };
  const deps = {
    draftRef: {
      get current() {
        return composer.draft;
      },
      set current(value) {
        composer.draft = value;
      },
    },
    attachmentsRef: {
      get current() {
        return composer.attachments;
      },
    },
    replaceAttachments: (next) => {
      composer.attachments = next;
    },
    restoredAttachments: (value, text) =>
      restoreAttachmentsFromRecord(value, text, {
        reservedIds: new Set(composer.attachments.map((attachment) => attachment.id)),
        sequence: { current: 5 },
      }),
    mergeRestoredAttachments: (incoming, text) => {
      composer.attachments = [...composer.attachments, ...incoming];
      return text;
    },
    setDraft: (value) => {
      composer.draft = value;
    },
  };
  const message = {
    text: 'edit [Pasted text #1 +2 lines]',
    pastedTexts: { 1: { id: 1, text: 'a\nb', source: 'paste' } },
  };
  assert.equal(restoreDraftHandoff(deps, message, { replace: true }), true);
  assert.equal(composer.draft, 'edit [Pasted text #1 +2 lines]');
  assert.deepEqual(
    composer.attachments.map((attachment) => attachment.data),
    ['a\nb']
  );
  // A plain message replaces the chips too: only its text remains.
  composer.draft = 'half typed';
  composer.attachments = [oldChip];
  assert.equal(restoreDraftHandoff(deps, { text: 'plain edit' }, { replace: true }), true);
  assert.equal(composer.draft, 'plain edit');
  assert.deepEqual(composer.attachments, []);
  composer.attachments = [oldChip];
  // Steering keeps merging: the new message goes before the live draft.
  composer.draft = 'typing';
  assert.equal(restoreDraftHandoff(deps, { text: 'taken back' }, {}), true);
  assert.equal(composer.draft, 'taken back\ntyping');
  assert.equal(composer.attachments.length, 1);
});