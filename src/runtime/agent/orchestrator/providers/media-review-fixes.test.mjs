import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-review-fixes-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const media = await import('./media-normalization.mjs');
const { toGeminiContents } = await import('./gemini-schema.mjs');
const { materializePromptSubmission, preparePromptSubmissionForProvider, clearAttachmentBufferCache } = await import(
  '../../../attachments/store.mjs'
);

function writeBlob(bytes) {
  const ref = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ref), bytes);
  return { ref, path: join(dir, ref), sizeBytes: bytes.length };
}

test('a Gemini tool result with a missing stored file lowers to the placeholder instead of throwing', () => {
  const gone = writeBlob(Buffer.from('gone sheet'));
  rmSync(gone.path);
  const history = [
    { role: 'user', content: 'open it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: {} }] },
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: 'downloaded' },
        { type: 'file', mimeType: 'text/csv', filename: 'rows.csv', attachmentRef: gone.ref, sizeBytes: gone.sizeBytes },
      ],
    },
  ];
  const body = JSON.stringify(toGeminiContents(history, 'gemini-3-pro-preview'));
  assert.match(body, /\[attachment unavailable: rows\.csv\]/);
});

test('estimation tolerates every permanent failure, like lowering, but not a transient one', (t) => {
  const corrupt = writeBlob(Buffer.from('original notes'));
  writeFileSync(corrupt.path, 'tampered!!!!!');
  const part = {
    type: 'file',
    mimeType: 'text/plain',
    filename: 'n.txt',
    attachmentRef: corrupt.ref,
    sizeBytes: corrupt.sizeBytes,
  };
  clearAttachmentBufferCache();
  assert.doesNotThrow(() => media.contentToEstimateText([part]));
  assert.match(media.contentToText([part]), /\[attachment unavailable: n\.txt\]/);

  const fine = writeBlob(Buffer.from('fine notes'));
  const ok = { ...part, attachmentRef: fine.ref, sizeBytes: fine.sizeBytes };
  clearAttachmentBufferCache();
  const realStat = fs.statSync;
  t.mock.method(fs, 'statSync', (path, ...rest) => {
    if (String(path).endsWith(fine.ref)) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return realStat(path, ...rest);
  });
  syncBuiltinESMExports();
  assert.throws(() => media.contentToEstimateText([ok]), { code: 'EBUSY' });
  assert.throws(() => media.contentToText([ok]), { code: 'EBUSY' });
  t.mock.restoreAll();
  syncBuiltinESMExports();
});

test('a mislabelled PDF meets the PDF limits and conversion at intake', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(21 * 1024 * 1024, 0x20)]);
  const intake = materializePromptSubmission([
    { type: 'file', data: pdf.toString('base64'), mimeType: 'application/octet-stream', filename: 'report' },
  ]);
  assert.equal(intake.prompt[0].mimeType, 'application/pdf');
  await assert.rejects(preparePromptSubmissionForProvider(intake, 'anthropic'), /PDF exceeds/);
});

test('office text is memoized by attachment ref and is identical to the inline extraction', async () => {
  const JSZip = (await import('jszip')).default;
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>By ref</w:t></w:r></w:p></w:body></w:document>'
  );
  const data = (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
  const live = [{ type: 'file', data, mimeType: 'application/octet-stream', filename: 'a.docx' }];
  const stored = media.sanitizeContentForStoredHistory(live);
  assert.ok(stored[0].attachmentRef);
  const a = JSON.stringify(media.normalizeContentForAnthropic(stored));
  const b = JSON.stringify(media.normalizeContentForAnthropic(live));
  assert.equal(a, b);
  assert.match(a, /By ref/);
});
