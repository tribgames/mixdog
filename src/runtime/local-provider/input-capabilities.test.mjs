import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-local-input-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { assertLocalModelInput } = await import('./input-capabilities.mjs');
const media = await import('../agent/orchestrator/providers/media-normalization.mjs');

const model = { name: 'local-test' };
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function minimalPdf(text) {
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

async function docxBase64() {
  const zip = new JSZip();
  zip.file(
    'word/document.xml',
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Local body</w:t></w:r></w:p></w:body></w:document>'
  );
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

async function history() {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'summarize' },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
        { type: 'file', data: await docxBase64(), mimeType: DOCX, filename: 'plan.docx' },
        { type: 'file', data: minimalPdf('Local PDF').toString('base64'), mimeType: 'application/pdf', filename: 'a.pdf' },
        { type: 'file', data: Buffer.from('a,b\n1,2\n').toString('base64'), mimeType: 'text/csv', filename: 'rows.csv' },
        { type: 'file', data: Buffer.from('PK\u0003\u0004zip').toString('base64'), mimeType: 'application/zip', filename: 'b.zip' },
      ],
    },
  ];
}

const LOCAL = { name: 'mixdog-local', nativePdf: false };

const reloaded = (messages) =>
  JSON.parse(JSON.stringify(messages.map((m) => ({ ...m, content: media.sanitizeContentForStoredHistory(m.content) }))));

test('a text-only local model receives the text form of documents, identically inline and after reload', async () => {
  const live = await history();
  const saved = reloaded(live);
  assert.match(JSON.stringify(saved), /attachmentRef/);
  assert.throws(() => assertLocalModelInput(model, live, []), /PDF part reached text lowering/);
  // mixdog-local is a text-lowering provider: its send prepares the messages first.
  const prepare = (messages) => media.preparePdfTextForProvider(messages, LOCAL);
  const livePrepared = await prepare(live);
  const savedPrepared = await prepare(saved);

  const liveOut = assertLocalModelInput(model, livePrepared, []);
  const savedOut = assertLocalModelInput(model, savedPrepared, []);
  assert.equal(JSON.stringify(savedOut), JSON.stringify(liveOut));
  media._clearLoweringMemos();
  assert.equal(
    JSON.stringify(assertLocalModelInput(model, await prepare(saved), [])),
    JSON.stringify(liveOut),
    'cold memos'
  );

  const texts = liveOut[0].content.map((part) => part.text);
  assert.equal(texts[1], '[image omitted: local model is text-only]');
  assert.match(texts[2], /^--- plan\.docx \(.*\) ---\nLocal body$/);
  assert.match(texts[3], /^--- a\.pdf \(application\/pdf, \d+ bytes\) ---\n--- Page 1 ---\nLocal PDF/);
  assert.match(texts[4], /^--- rows\.csv \(text\/csv, 8 bytes\) ---\na,b\n1,2\n$/);
  assert.match(texts[5], /^\[file not sent inline: b\.zip \(application\/zip, \d+ bytes\) — .*\]$/);

  // The very strings every other provider's lowering produces.
  const chat = media.normalizeContentForOpenAIChat(livePrepared[0].content, { nativePdf: false });
  const chatTexts = chat.filter((part) => part.type === 'text').map((part) => part.text);
  assert.deepEqual([texts[2], texts[3], texts[4]], [chatTexts[1], chatTexts[2], chatTexts[3]]);
});

test('an unreadable referenced document lowers to the shared placeholder; a transient error is not rewritten', () => {
  const bytes = Buffer.from('gone notes');
  const ref = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ref), 'tampered!');
  const out = assertLocalModelInput(
    model,
    [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'file', mimeType: 'text/plain', filename: 'n.txt', attachmentRef: ref, sizeBytes: 10 }] }],
    []
  );
  assert.equal(out[0].content[1].text, '[attachment unavailable: n.txt]');
});

test('a current turn made only of a readable document is accepted; only omitted media is an error', async () => {
  const pdfOnly = [{ role: 'user', content: [{ type: 'file', data: minimalPdf('Solo').toString('base64'), mimeType: 'application/pdf' }] }];
  const preparedPdf = await media.preparePdfTextForProvider(pdfOnly, LOCAL);
  assert.match(assertLocalModelInput(model, preparedPdf, [])[0].content[0].text, /Solo/);
  const zipOnly = [{ role: 'user', content: [{ type: 'file', data: Buffer.from('PK').toString('base64'), mimeType: 'application/zip' }] }];
  assert.throws(() => assertLocalModelInput(model, zipOnly, []), /text-only/);
  assert.throws(() => assertLocalModelInput(model, [{ role: 'user', content: [{ type: 'image', data: 'AA==' }] }], []), /text-only/);
});
