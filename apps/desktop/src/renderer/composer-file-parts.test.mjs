import assert from 'node:assert/strict';
import test from 'node:test';

import { requiredPromptContent } from '../main/ipc-validation.ts';
import { restoreAttachmentsFromRecord } from './composer-attachment-restore.ts';
import { attachmentPolicyError } from './composer-attachments.ts';
import {
  ATTACHMENT_ACCEPT,
  MAX_COMPOSER_ATTACHMENTS,
  MAX_INLINE_FILE_BASE64_TOTAL,
  MAX_OFFICE_FILE_BYTES,
} from './composer-support.tsx';
import { buildSubmissionContent } from './use-composer-submission.ts';
import {
  MAX_PROMPT_FILE_BASE64_LENGTH,
  MAX_PROMPT_FILE_BASE64_TOTAL,
  MAX_PROMPT_FILES,
  OFFICE_MIME_BY_EXTENSION,
} from '../shared/prompt-limits.ts';

const base64Length = (bytes) => Math.ceil(bytes / 3) * 4;

function filePart(mimeType, data = 'UEs=') {
  return { type: 'file', data, mimeType, filename: 'a' };
}

test('the IPC validator accepts every OOXML MIME type the composer produces', () => {
  for (const [extension, mimeType] of Object.entries(OFFICE_MIME_BY_EXTENSION)) {
    assert.ok(ATTACHMENT_ACCEPT.includes(`.${extension}`));
    const content = requiredPromptContent([{ type: 'text', text: 'hi' }, filePart(mimeType)]);
    assert.equal(content[1].mimeType, mimeType);
  }
  assert.throws(() => requiredPromptContent([filePart('application/msword')]), /unsupported/);
});

test('composer file limits never exceed what the IPC validator accepts', () => {
  assert.ok(MAX_COMPOSER_ATTACHMENTS <= MAX_PROMPT_FILES);
  assert.ok(base64Length(MAX_OFFICE_FILE_BYTES) <= MAX_PROMPT_FILE_BASE64_LENGTH);
  assert.ok(MAX_INLINE_FILE_BASE64_TOTAL <= MAX_PROMPT_FILE_BASE64_TOTAL);
  const docx = OFFICE_MIME_BY_EXTENSION.docx;
  const many = Array.from({ length: MAX_COMPOSER_ATTACHMENTS }, () => filePart(docx));
  assert.equal(requiredPromptContent(many).length, MAX_COMPOSER_ATTACHMENTS);
  assert.throws(() => requiredPromptContent([...many, filePart(docx)]), /too many prompt files/);
  const half = 'A'.repeat(MAX_PROMPT_FILE_BASE64_TOTAL / 2);
  requiredPromptContent([filePart(docx, half), filePart(docx, half)]);
  assert.throws(() => requiredPromptContent([filePart(docx, half), filePart(docx, `${half}AAAA`)]), /too large/);
});

test('the composer budget rejects what the IPC combined file cap would reject', () => {
  const office = (data) => ({ id: 2, name: 'b.docx', kind: 'office', mimeType: 'x', data, token: '' });
  const existing = [{ ...office('A'.repeat(MAX_INLINE_FILE_BASE64_TOTAL)), id: 1 }];
  assert.match(attachmentPolicyError(existing, office('AAAA')), /too large together/);
  assert.equal(attachmentPolicyError([], office('AAAA')), '');
});

test('submission sends Office and PDF attachments as file parts', () => {
  const docx = OFFICE_MIME_BY_EXTENSION.docx;
  const attachments = [
    { id: 1, name: 'a.docx', kind: 'office', mimeType: docx, data: 'UEs=', token: '[File #1: a.docx]' },
    { id: 2, name: 'b.pdf', kind: 'pdf', mimeType: 'application/pdf', data: 'JVBERg==', token: '[PDF #2: b.pdf]' },
  ];
  const { content } = buildSubmissionContent('read [File #1: a.docx] [PDF #2: b.pdf]', attachments);
  assert.deepEqual(content.slice(1), [
    { type: 'file', data: 'UEs=', mimeType: docx, filename: 'a.docx' },
    { type: 'file', data: 'JVBERg==', mimeType: 'application/pdf', filename: 'b.pdf' },
  ]);
});

const ids = () => ({ reservedIds: new Set(), sequence: { current: 1 } });

test('restore returns PDF and Office file parts from the record', () => {
  const docx = OFFICE_MIME_BY_EXTENSION.docx;
  const record = {
    pastedFiles: { 3: { id: 3, filename: 'a.docx', mimeType: docx, data: 'UEs=' } },
    content: [
      { type: 'text', text: 'x' },
      { type: 'file', data: 'JVBERg==', mimeType: 'application/pdf', filename: 'b.pdf' },
    ],
  };
  const { attachments, text } = restoreAttachmentsFromRecord(
    record,
    'see [File #3: a.docx] and [PDF #4: b.pdf]',
    ids()
  );
  assert.deepEqual(
    attachments.map(({ id, kind, mimeType, token }) => ({ id, kind, mimeType, token })),
    [
      { id: 3, kind: 'office', mimeType: docx, token: '[File #3: a.docx]' },
      { id: 4, kind: 'pdf', mimeType: 'application/pdf', token: '[PDF #4: b.pdf]' },
    ]
  );
  assert.equal(text, 'see [File #3: a.docx] and [PDF #4: b.pdf]');
});

test('restore removes file tokens whose bytes are unavailable but keeps restored text chips', () => {
  const record = { pastedTexts: { 5: { id: 5, text: 'body', filename: 'n.txt', source: 'file' } } };
  const { attachments, text } = restoreAttachmentsFromRecord(
    record,
    'read [PDF #1: gone.pdf] and [File #2: gone.docx] then [File #5: n.txt]',
    ids()
  );
  assert.equal(text, 'read and then [File #5: n.txt]');
  assert.deepEqual(
    attachments.map((attachment) => attachment.kind),
    ['text']
  );
});
