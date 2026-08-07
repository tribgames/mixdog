import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-attachments-'));
process.env.MIXDOG_DATA_DIR = dataDir;

const {
  attachmentStoreCacheStats,
  collectPromptAttachments,
  hydratePastedAttachments,
  materializePromptSubmission,
  preparePromptSubmissionForProvider,
} = await import('./store.mjs');
const {
  normalizeContentForAnthropic,
  normalizeContentForOpenAIResponses,
  sanitizeContentForStoredHistory,
} = await import('../agent/orchestrator/providers/media-normalization.mjs');
const {
  imageResizeCacheStats,
  openAIImagePatchCount,
  resizeImageBuffer,
} = await import('../agent/orchestrator/tools/builtin/read-image-resize.mjs');

function minimalPdf(text = 'Hello PDF') {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${text.length + 31} >>\nstream\nBT /F1 12 Tf 40 100 Td (${text}) Tj ET\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('daemon intake stores one payload and keeps byte-free refs through history/provider lowering', () => {
  const imageData = Buffer.from('small-image').toString('base64');
  const pdfData = Buffer.from('%PDF-1.7\nsmall-pdf').toString('base64');
  const pastedText = 'large context '.repeat(100);
  const before = {
    prompt: [
      { type: 'text', text: 'Review [Pasted text #7 +100 lines]' },
      { type: 'image', data: imageData, mimeType: 'image/png' },
      { type: 'file', data: pdfData, mimeType: 'application/pdf', filename: 'notes.pdf' },
    ],
    options: {
      displayText: 'Review [Pasted text #7 +100 lines] [Image]',
      pastedImages: {
        1: { id: 1, type: 'image', mediaType: 'image/png', filename: 'shot.png', sizeBytes: 11 },
      },
      pastedTexts: {
        7: { id: 7, text: pastedText, source: 'paste' },
      },
    },
  };

  const intake = materializePromptSubmission(before.prompt, before.options);
  const encoded = JSON.stringify(intake);
  assert.doesNotMatch(encoded, new RegExp(imageData));
  assert.doesNotMatch(encoded, /small-pdf/);
  assert.doesNotMatch(encoded, /large context large context/);
  const imagePart = intake.prompt.find((part) => part.type === 'image');
  assert.match(imagePart.attachmentRef, /^[a-f0-9]{64}$/);
  assert.equal(intake.options.pastedImages[1].attachmentRef, imagePart.attachmentRef);
  assert.equal(intake.options.pastedTexts[7].text, undefined);

  const stored = sanitizeContentForStoredHistory(intake.prompt);
  assert.equal(stored, intake.prompt, 'byte-free attachment refs remain durable session content');

  const anthropic = normalizeContentForAnthropic(intake.prompt);
  assert.equal(anthropic.find((part) => part.type === 'text' && part.text === pastedText)?.text, pastedText);
  assert.equal(anthropic.find((part) => part.type === 'image')?.source.data, imageData);
  assert.equal(anthropic.find((part) => part.type === 'document')?.source.data, pdfData);
  const responses = normalizeContentForOpenAIResponses(intake.prompt);
  assert.equal(responses.find((part) => part.type === 'input_text' && part.text === pastedText)?.text, pastedText);
  assert.match(responses.find((part) => part.type === 'input_image')?.image_url, /^data:image\/png;base64,/);
  assert.match(responses.find((part) => part.type === 'input_file')?.file_data, /^data:application\/pdf;base64,/);

  const hydrated = hydratePastedAttachments(
    intake.options.pastedImages,
    intake.options.pastedTexts,
  );
  assert.equal(hydrated.pastedImages[1].content, imageData);
  assert.equal(hydrated.pastedTexts[7].text, pastedText);
  assert.ok(attachmentStoreCacheStats().bytes <= attachmentStoreCacheStats().maxBytes);
});

test('image resize output is reused from the bounded hash LRU', async () => {
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
  );
  const before = imageResizeCacheStats();
  const first = await resizeImageBuffer(onePixelPng, 'png');
  assert.ok(first?.data, 'sharp is a required image backend');
  const second = await resizeImageBuffer(onePixelPng, 'png');
  assert.equal(second.data, first.data);
  const after = imageResizeCacheStats();
  assert.equal(after.hits, before.hits + 1);
  assert.ok(after.bytes <= after.maxBytes);
});

test('OpenAI image profile respects the 2048px and 1536-patch budget', async () => {
  const sharp = (await import('sharp')).default;
  const source = await sharp({
    create: { width: 1600, height: 1200, channels: 3, background: '#abcdef' },
  }).png().toBuffer();
  const anthropic = await resizeImageBuffer(source, 'png', { profile: 'anthropic' });
  const openai = await resizeImageBuffer(source, 'png', { profile: 'openai' });
  assert.equal(anthropic.dimensions.displayWidth, 1600);
  assert.ok(openAIImagePatchCount(
    openai.dimensions.displayWidth,
    openai.dimensions.displayHeight,
  ) <= 1536);
});

test('PDF intake keeps native documents and extracts page text for compat providers', async () => {
  const data = minimalPdf('Provider parity').toString('base64');
  const native = await preparePromptSubmissionForProvider(
    materializePromptSubmission([{ type: 'file', data, mimeType: 'application/pdf', filename: 'native.pdf' }]),
    'anthropic',
  );
  assert.equal(native.prompt[0].type, 'file');
  assert.equal(native.prompt[0].pageCount, 1);
  const compat = await preparePromptSubmissionForProvider(
    materializePromptSubmission([{ type: 'file', data, mimeType: 'application/pdf', filename: 'compat.pdf' }]),
    'xai',
  );
  assert.equal(compat.prompt[0].type, 'text');
  assert.match(normalizeContentForAnthropic(compat.prompt)[0].text, /Provider parity/);
  assert.doesNotMatch(JSON.stringify(compat), new RegExp(data.slice(0, 40)));
});

test('attachment GC preserves durable refs and the safety window while deleting stale orphans', async () => {
  const makeFile = (text) => materializePromptSubmission([{
    type: 'file',
    data: Buffer.from(text).toString('base64'),
    mimeType: 'application/octet-stream',
  }]).prompt[0];
  const referenced = makeFile('durably referenced attachment');
  const orphan = makeFile('stale orphan attachment');
  const fresh = makeFile('fresh orphan attachment');
  const blobPath = (part) => join(
    dataDir,
    'prompt-attachments',
    'sha256',
    part.attachmentRef.slice(0, 2),
    part.attachmentRef,
  );
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(
    join(dataDir, 'sessions', 'sess_attachment_gc.json'),
    JSON.stringify({ id: 'sess_attachment_gc', messages: [{ content: [referenced] }] }),
  );
  const old = new Date(Date.now() - 10_000);
  utimesSync(blobPath(referenced), old, old);
  utimesSync(blobPath(orphan), old, old);

  const result = await collectPromptAttachments({ now: Date.now(), minAgeMs: 1_000 });
  assert.equal(existsSync(blobPath(referenced)), true);
  assert.equal(existsSync(blobPath(fresh)), true);
  assert.equal(existsSync(blobPath(orphan)), false);
  assert.equal(result.deleted, 1);
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
