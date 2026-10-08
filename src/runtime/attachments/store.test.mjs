import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
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
  normalizeContentForOpenAIChat,
  normalizeContentForOpenAIResponses,
  sanitizeContentForStoredHistory,
} = await import('../agent/orchestrator/providers/media-normalization.mjs');
const { imageResizeCacheStats, openAIImagePatchCount, resizeImageBuffer } = await import(
  '../agent/orchestrator/tools/builtin/read-image-resize.mjs'
);

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
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
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

  const hydrated = hydratePastedAttachments(intake.options.pastedImages, intake.options.pastedTexts);
  assert.equal(hydrated.pastedImages[1].content, imageData);
  assert.equal(hydrated.pastedTexts[7].text, pastedText);
  assert.ok(attachmentStoreCacheStats().bytes <= attachmentStoreCacheStats().maxBytes);
});

test('attachment reads reject content that no longer matches its sha256 reference', async () => {
  const stored = materializePromptSubmission([
    {
      type: 'file',
      data: Buffer.from('original attachment').toString('base64'),
      mimeType: 'application/octet-stream',
    },
  ]).prompt[0];
  const blobPath = join(
    dataDir,
    'prompt-attachments',
    'sha256',
    stored.attachmentRef.slice(0, 2),
    stored.attachmentRef
  );
  writeFileSync(blobPath, 'tampered attachment');
  const freshStore = await import(`./store.mjs?integrity=${Date.now()}`);
  assert.throws(() => freshStore.readAttachmentBuffer(stored), /integrity check failed/);
});

test('image resize output is reused from the bounded hash LRU', async () => {
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64'
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
  })
    .png()
    .toBuffer();
  const anthropic = await resizeImageBuffer(source, 'png', { profile: 'anthropic' });
  const openai = await resizeImageBuffer(source, 'png', { profile: 'openai' });
  // Each profile answers to its own vision billing: Anthropic tiles 28px
  // patches under a 1568-patch budget with a 1568px edge ceiling, OpenAI tiles
  // 32px patches under 1536. Both keep the picture's shape.
  const anthropicPatches =
    Math.ceil(anthropic.dimensions.displayWidth / 28) * Math.ceil(anthropic.dimensions.displayHeight / 28);
  assert.ok(anthropicPatches <= 1568, `anthropic spent ${anthropicPatches} patches`);
  assert.ok(anthropic.dimensions.displayWidth <= 1568 && anthropic.dimensions.displayHeight <= 1568);
  assert.equal(
    (anthropic.dimensions.displayWidth / anthropic.dimensions.displayHeight).toFixed(2),
    (1600 / 1200).toFixed(2)
  );
  // The reported size is what the caller maps coordinates through, so it has
  // to be the size of the image that was actually produced.
  for (const rendition of [anthropic, openai]) {
    const rendered = await sharp(Buffer.from(rendition.data, 'base64')).metadata();
    assert.equal(rendered.width, rendition.dimensions.displayWidth);
    assert.equal(rendered.height, rendition.dimensions.displayHeight);
  }
  assert.ok(openAIImagePatchCount(openai.dimensions.displayWidth, openai.dimensions.displayHeight) <= 1536);
});

function pagedPdf(pageCount) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  objects.push(`<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(' ')}] /Count ${pageCount} >>`);
  for (let i = 0; i < pageCount; i += 1) objects.push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>');
  let body = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}

test('PDF intake only validates: every provider keeps the PDF reference', async () => {
  const data = minimalPdf('Provider parity').toString('base64');
  const intake = () =>
    materializePromptSubmission([{ type: 'file', data, mimeType: 'application/pdf', filename: 'a.pdf' }]);
  for (const provider of [{ nativePdf: true }, { nativePdf: false }, undefined]) {
    const prepared = await preparePromptSubmissionForProvider(intake(), provider);
    assert.equal(prepared.prompt[0].type, 'file');
    assert.equal(prepared.prompt[0].pageCount, 1);
    assert.ok(prepared.prompt[0].attachmentRef);
    assert.equal(JSON.stringify(prepared).includes('Provider parity'), false, 'no text conversion at intake');
  }
});

test('a PDF over the page cap is refused for a native provider and accepted for one that reads text', async () => {
  const data = pagedPdf(101).toString('base64');
  const intake = () => materializePromptSubmission([{ type: 'file', data, mimeType: 'application/pdf', filename: 'long.pdf' }]);
  await assert.rejects(preparePromptSubmissionForProvider(intake(), { nativePdf: true }), /101 pages/);
  const accepted = await preparePromptSubmissionForProvider(intake(), { nativePdf: false });
  assert.equal(accepted.prompt[0].pageCount, 101);
});

test('an unreadable PDF is refused at intake for every provider', async () => {
  const data = Buffer.from('%PDF-1.4 nonsense').toString('base64');
  const intake = materializePromptSubmission([{ type: 'file', data, mimeType: 'application/pdf', filename: 'bad.pdf' }]);
  await assert.rejects(preparePromptSubmissionForProvider(intake, { nativePdf: false }));
});

test('stored history keeps tool-result images as refs that lower to the same provider bytes', () => {
  const screenshot = Buffer.from('tool screenshot bytes').toString('base64');
  const downloaded = Buffer.from('downloaded image bytes').toString('base64');
  const live = {
    content: [
      { type: 'text', text: 'Screenshot captured.' },
      { type: 'image', data: screenshot, mimeType: 'image/jpeg' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: downloaded } },
    ],
  };

  const stored = sanitizeContentForStoredHistory(live);
  const reloaded = JSON.parse(JSON.stringify(stored));

  assert.doesNotMatch(JSON.stringify(stored), new RegExp(`${screenshot}|${downloaded}`));
  assert.deepEqual(normalizeContentForAnthropic(reloaded), normalizeContentForAnthropic(live));
  assert.deepEqual(normalizeContentForOpenAIResponses(reloaded), normalizeContentForOpenAIResponses(live));
  assert.equal(sanitizeContentForStoredHistory(live).content[1], stored.content[1], 'repeat projections reuse the part');

  const nonCanonical = { type: 'image', data: `${screenshot.slice(0, 8)}\n${screenshot.slice(8)}`, mimeType: 'image/png' };
  assert.deepEqual(sanitizeContentForStoredHistory([nonCanonical]), [
    { type: 'text', text: '[Image omitted from stored history: image/png]' },
  ]);
});

test('stored history keeps inline PDFs as refs that lower to the same provider bytes', () => {
  const pdf = minimalPdf('Stored PDF').toString('base64');
  const other = minimalPdf('Other PDF').toString('base64');
  const live = {
    content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf } },
      { type: 'document', title: 'Titled.pdf', source: { type: 'base64', media_type: 'application/pdf', data: other } },
      { type: 'file', data: pdf, mimeType: 'application/pdf', filename: 'inline.pdf' },
    ],
  };

  const stored = sanitizeContentForStoredHistory(live);
  const reloaded = JSON.parse(JSON.stringify(stored));

  assert.doesNotMatch(JSON.stringify(stored), /omitted/);
  for (const part of stored.content) {
    assert.equal(part.type, 'file');
    assert.ok(part.attachmentRef);
  }
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(`${pdf}|${other}`));
  assert.deepEqual(normalizeContentForAnthropic(reloaded), normalizeContentForAnthropic(live));
  assert.deepEqual(normalizeContentForOpenAIResponses(reloaded), normalizeContentForOpenAIResponses(live));
  assert.deepEqual(normalizeContentForOpenAIChat(reloaded), normalizeContentForOpenAIChat(live));
  const again = sanitizeContentForStoredHistory(live);
  stored.content.forEach((part, i) => assert.equal(again.content[i], part));
});

test('attachment GC preserves durable refs and the safety window while deleting stale orphans', async () => {
  const makeFile = (text) =>
    materializePromptSubmission([
      {
        type: 'file',
        data: Buffer.from(text).toString('base64'),
        mimeType: 'application/octet-stream',
      },
    ]).prompt[0];
  const referenced = makeFile('durably referenced attachment');
  const orphan = makeFile('stale orphan attachment');
  const fresh = makeFile('fresh orphan attachment');
  const blobPath = (part) =>
    join(dataDir, 'prompt-attachments', 'sha256', part.attachmentRef.slice(0, 2), part.attachmentRef);
  mkdirSync(join(dataDir, 'sessions'), { recursive: true });
  writeFileSync(
    join(dataDir, 'sessions', 'sess_attachment_gc.json'),
    JSON.stringify({ id: 'sess_attachment_gc', messages: [{ content: [referenced] }] })
  );
  // Blobs from the earlier tests in this file are orphans too; a wide safety
  // window keeps them out of the count regardless of how slowly the file ran.
  const old = new Date(Date.now() - 120_000);
  utimesSync(blobPath(referenced), old, old);
  utimesSync(blobPath(orphan), old, old);

  const result = await collectPromptAttachments({ now: Date.now(), minAgeMs: 60_000 });
  assert.equal(existsSync(blobPath(referenced)), true);
  assert.equal(existsSync(blobPath(fresh)), true);
  assert.equal(existsSync(blobPath(orphan)), false);
  assert.equal(result.deleted, 1);
});

const blobDir = (ref) => join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
const blobFile = (ref) => join(blobDir(ref), ref);
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

test('GC keeps blobs referenced only by a turn-checkpoint journal and sweeps stale temp files', async () => {
  const journaled = materializePromptSubmission([
    { type: 'file', data: Buffer.from('journal only attachment').toString('base64'), mimeType: 'application/octet-stream' },
  ]).prompt[0];
  mkdirSync(join(dataDir, 'turn-checkpoints'), { recursive: true });
  writeFileSync(
    join(dataDir, 'turn-checkpoints', 'sess_journal.jsonl'),
    `${JSON.stringify({ kind: 'user', content: [journaled] })}\n`
  );
  const old = new Date(Date.now() - 120_000);
  utimesSync(blobFile(journaled.attachmentRef), old, old);
  const staleTemp = `${blobFile(journaled.attachmentRef)}.123.abcdef.tmp`;
  const freshTemp = `${blobFile(journaled.attachmentRef)}.456.fedcba.tmp`;
  writeFileSync(staleTemp, 'partial');
  writeFileSync(freshTemp, 'partial');
  utimesSync(staleTemp, old, old);

  await collectPromptAttachments({ now: Date.now(), minAgeMs: 60_000 });
  assert.equal(existsSync(blobFile(journaled.attachmentRef)), true, 'journal reference protects the blob');
  assert.equal(existsSync(staleTemp), false, 'stale temp file is swept');
  assert.equal(existsSync(freshTemp), true, 'a temp file inside the safety window may still be in flight');
});

test('a failed publish leaves no temp file behind', () => {
  const bytes = Buffer.from('publish will fail');
  const ref = sha256(bytes);
  // A directory at the content address makes the final rename fail.
  mkdirSync(blobFile(ref), { recursive: true });
  assert.throws(() =>
    materializePromptSubmission([{ type: 'file', data: bytes.toString('base64'), mimeType: 'application/octet-stream' }])
  );
  assert.deepEqual(
    readdirSync(blobDir(ref)).filter((name) => name.endsWith('.tmp')),
    []
  );
});

test('caps use the real blob size, not the client-claimed sizeBytes', async () => {
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(21 * 1024 * 1024, 0x20)]);
  const intake = materializePromptSubmission([
    { type: 'file', data: pdf.toString('base64'), mimeType: 'application/pdf', filename: 'huge.pdf' },
  ]);
  intake.prompt[0].sizeBytes = 1;
  await assert.rejects(preparePromptSubmissionForProvider(intake, 'anthropic'), /PDF exceeds/);

  const big = Buffer.from('x'.repeat(1024 * 1024 + 10));
  try {
    materializePromptSubmission(big.toString('utf8'));
  } catch {}
  assert.throws(
    () =>
      materializePromptSubmission('[Pasted text #1 +1 lines]', {
        pastedTexts: { 1: { id: 1, attachmentRef: sha256(big), sizeBytes: 1 } },
      }),
    /1 MiB/
  );
});

test('pasted image metadata pairs to parts by identity, not by position', () => {
  const restored = materializePromptSubmission([
    { type: 'image', data: Buffer.from('restored image').toString('base64'), mimeType: 'image/png' },
  ]).prompt[0];
  const fresh = Buffer.from('fresh image').toString('base64');
  const intake = materializePromptSubmission(
    [
      { type: 'image', data: fresh, mimeType: 'image/png' },
      { type: 'image', attachmentRef: restored.attachmentRef, sizeBytes: restored.sizeBytes, mimeType: 'image/png' },
    ],
    {
      pastedImages: {
        1: { id: 1, type: 'image', attachmentRef: restored.attachmentRef, sizeBytes: restored.sizeBytes },
        2: { id: 2, type: 'image', mediaType: 'image/png' },
      },
    }
  );
  assert.equal(intake.options.pastedImages[1].attachmentRef, restored.attachmentRef);
  assert.equal(intake.options.pastedImages[2].attachmentRef, intake.prompt[0].attachmentRef);
  assert.notEqual(intake.options.pastedImages[2].attachmentRef, restored.attachmentRef);

  const tagged = materializePromptSubmission(
    [
      { type: 'image', data: fresh, mimeType: 'image/png', pasteId: 3 },
      { type: 'image', data: Buffer.from('other image').toString('base64'), mimeType: 'image/png', pasteId: 4 },
    ],
    { pastedImages: { 4: { id: 4, type: 'image' }, 3: { id: 3, type: 'image' } } }
  );
  assert.equal(tagged.options.pastedImages[3].attachmentRef, tagged.prompt[0].attachmentRef);
  assert.equal(tagged.options.pastedImages[4].attachmentRef, tagged.prompt[1].attachmentRef);
});

test('hydration can drop an unreadable attachment alone', () => {
  const kept = materializePromptSubmission([
    { type: 'image', data: Buffer.from('kept image').toString('base64'), mimeType: 'image/png' },
  ]).prompt[0];
  const gone = { attachmentRef: sha256(Buffer.from('never stored')), sizeBytes: 12 };
  const images = { 1: { id: 1, ...kept }, 2: { id: 2, ...gone } };
  assert.throws(() => hydratePastedAttachments(images, null), { code: 'ENOENT' });
  const dropped = [];
  const out = hydratePastedAttachments(images, null, { onUnreadable: (kind, key) => dropped.push(`${kind}:${key}`) });
  assert.deepEqual(Object.keys(out.pastedImages), ['1']);
  assert.deepEqual(dropped, ['image:2']);
});

test.after(() => {
  rmSync(dataDir, { recursive: true, force: true });
});
