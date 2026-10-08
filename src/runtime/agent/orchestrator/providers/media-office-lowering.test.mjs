// Office extraction, non-native PDF text, unavailable-blob placeholders and
// store-fallback behaviour of provider lowering, plus the prompt-cache
// invariant: the same stored history lowers to byte-identical requests.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-office-lowering-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const media = await import('./media-normalization.mjs');
const { toOpenAIMessages, toXaiResponsesInput } = await import('./openai-compat-wire.mjs');
const { storeInlineDocumentPart } = await import('../../../attachments/store.mjs');

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const PRESENTATION_NS = 'http://schemas.openxmlformats.org/presentationml/2006/main';
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELATIONSHIP_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

async function zipBase64(files) {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) zip.file(name, content);
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

const FIXTURES = {
  docx: () =>
    zipBase64({
      'word/document.xml': `<w:document xmlns:w="${WORD_NS}"><w:body><w:p><w:r><w:t>Quarterly plan alpha</w:t></w:r></w:p></w:body></w:document>`,
    }),
  pptx: () =>
    zipBase64({
      'ppt/slides/slide1.xml': `<p:sld xmlns:p="${PRESENTATION_NS}" xmlns:a="${DRAWING_NS}"><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Roadmap beta</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
    }),
  xlsx: () =>
    zipBase64({
      'xl/workbook.xml': `<workbook xmlns="${SHEET_NS}" xmlns:r="${RELATIONSHIP_NS}"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      'xl/_rels/workbook.xml.rels':
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml': `<worksheet xmlns="${SHEET_NS}"><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Gamma</t></is></c><c r="B1"><v>42</v></c></row></sheetData></worksheet>`,
    }),
};
const NEEDLE = { docx: 'Quarterly plan alpha', pptx: 'Roadmap beta', xlsx: 'Gamma\t42' };

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

function lowerEverywhere(content) {
  return JSON.stringify({
    anthropic: media.normalizeContentForAnthropic(content),
    chat: media.normalizeContentForOpenAIChat(content, { provider: 'openai' }),
    responses: media.normalizeContentForOpenAIResponses(content),
    gemini: media.normalizeContentForGeminiParts(content),
  });
}

// A session reload: the stored projection, serialized and parsed back.
function reloaded(content) {
  return JSON.parse(JSON.stringify(media.sanitizeContentForStoredHistory(content)));
}

for (const kind of ['docx', 'pptx', 'xlsx']) {
  test(`${kind} lowers to extracted text on every provider, identically inline and after save/reload`, async () => {
    const data = await FIXTURES[kind]();
    const filename = `file.${kind}`;
    const content = [{ type: 'file', data, mimeType: MIME[kind], filename }];
    const live = lowerEverywhere(content);
    assert.ok(live.includes(NEEDLE[kind].replace('\t', '\\t')), live);
    assert.equal(live.includes(data), false, 'raw OOXML bytes must not reach the provider');
    assert.equal(live.includes('file not sent inline'), false);

    const stored = reloaded(content);
    assert.match(stored[0].attachmentRef, /^[a-f0-9]{64}$/);
    assert.equal(lowerEverywhere(stored), live);
    assert.equal(lowerEverywhere(stored), live, 'repeated lowering is stable');
    assert.equal(lowerEverywhere(content), live);
  });
}

test('an Office file under a generic MIME type is recognised by its extension', async () => {
  const data = await FIXTURES.docx();
  const out = media.normalizeContentForAnthropic([
    { type: 'file', data, mimeType: 'application/octet-stream', filename: 'plan.docx' },
  ]);
  assert.match(out[0].text, /Quarterly plan alpha/);
});

test('an unreadable Office container falls back to the description', () => {
  const data = Buffer.from('PK\u0003\u0004not really a zip').toString('base64');
  const out = media.normalizeContentForAnthropic([{ type: 'file', data, mimeType: MIME.docx, filename: 'bad.docx' }]);
  assert.match(out[0].text, /^\[file not sent inline: bad\.docx /);
});

test('a mislabelled PDF is stored as application/pdf so estimates do not change on save', () => {
  const data = minimalPdf().toString('base64');
  const part = { type: 'file', data, mimeType: 'application/octet-stream', filename: 'report' };
  const stored = storeInlineDocumentPart(part);
  assert.equal(stored.mimeType, 'application/pdf');
  assert.deepEqual(media.contentFileDescriptors([stored]), media.contentFileDescriptors([part]));
  assert.equal(media.contentFileDescriptors([stored]).length, 1);
  assert.equal(lowerEverywhere([stored]), lowerEverywhere([part]));
});

// A PDF with one short page per entry of `pages`.
function manyPagePdf(pages) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>'];
  const kids = pages.map((_, i) => `${6 + i * 2} 0 R`).join(' ');
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  objects.push('<< >>');
  objects.push('<< >>');
  pages.forEach((n, i) => {
    const text = `P${n}`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 3 0 R >> >> /Contents ${7 + i * 2} 0 R >>`);
    const stream = `BT /F1 12 Tf 10 50 Td (${text}) Tj ET`;
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
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

function pdfHistory(content) {
  return [
    { role: 'user', content: 'read it' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'a.pdf' } }] },
    { role: 'tool', toolCallId: 'c1', content },
  ];
}

const TEXT_PDF = { nativePdf: false };

test('a non-native provider receives bounded PDF text, identically inline and after reload', async () => {
  const data = minimalPdf('Hello PDF text').toString('base64');
  const content = [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data }, title: 'a.pdf' }];
  const history = pdfHistory(content);
  const reloadedHistory = pdfHistory(reloaded(content));
  assert.throws(() => toOpenAIMessages(history, 'deepseek', TEXT_PDF), /PDF part reached text lowering/);
  const [prepared, preparedReloaded, preparedXai] = await Promise.all([
    media.preparePdfTextForProvider(history, TEXT_PDF),
    media.preparePdfTextForProvider(reloadedHistory, TEXT_PDF),
    media.preparePdfTextForProvider(history, TEXT_PDF),
  ]);
  assert.equal(media._pdfExtractionCount(), 1, 'concurrent sends of one PDF share one extraction');
  const wire = JSON.stringify(toOpenAIMessages(prepared, 'deepseek', TEXT_PDF));
  assert.match(wire, /Hello PDF text/);
  assert.equal(wire.includes(data), false);
  assert.equal(wire.includes('"type":"file"'), false);
  assert.equal(JSON.stringify(toOpenAIMessages(prepared, 'deepseek', TEXT_PDF)), wire);
  assert.equal(JSON.stringify(toOpenAIMessages(preparedReloaded, 'deepseek', TEXT_PDF)), wire);
  assert.equal(JSON.stringify(history).includes('Hello PDF text'), false, 'the stored history is not rewritten');

  const native = JSON.stringify(toOpenAIMessages(history, 'openai'));
  assert.match(native, /"type":"file"/);
  assert.equal(native.includes('Hello PDF text'), false);

  const xaiOf = (h) => JSON.stringify(toXaiResponsesInput(h, null, { providerName: 'xai', nativePdf: false }).input);
  const xai = xaiOf(preparedXai);
  assert.match(xai, /Hello PDF text/);
  assert.equal(xai.includes('input_file'), false);
  assert.equal(xaiOf(preparedReloaded), xai);
});

test('a PDF longer than the page cap is read for its first pages instead of reported unreadable', async () => {
  const pages = Array.from({ length: 103 }, (_, i) => i + 1);
  const data = manyPagePdf(pages).toString('base64');
  const [prepared] = await Promise.all([
    media.preparePdfTextForProvider(pdfHistory([{ type: 'file', data, mimeType: 'application/pdf', filename: 'long.pdf' }]), TEXT_PDF),
  ]);
  const text = JSON.stringify(prepared);
  assert.match(text, /--- Page 1 ---/);
  assert.match(text, /--- Page 100 ---|truncated to the prompt input budget/);
  assert.equal(text.includes('--- Page 101 ---'), false);
  assert.equal(text.includes('could not be read'), false);
});

test('an unreadable PDF lowers to a fixed placeholder, never a raw file block', async () => {
  const data = Buffer.from('%PDF-1.4 truncated nonsense').toString('base64');
  const history = await media.preparePdfTextForProvider(
    pdfHistory([{ type: 'file', data, mimeType: 'application/pdf', filename: 'x.pdf' }]),
    TEXT_PDF
  );
  const wire = JSON.stringify(toOpenAIMessages(history, 'deepseek', TEXT_PDF));
  assert.match(wire, /PDF text unavailable/);
  assert.equal(wire.includes(data), false);
});

function writeBlob(bytes) {
  const ref = createHash('sha256').update(bytes).digest('hex');
  const dir = join(dataDir, 'prompt-attachments', 'sha256', ref.slice(0, 2));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ref), bytes);
  return { ref, path: join(dir, ref), sizeBytes: bytes.length };
}

test('a missing or corrupt attachment blob lowers to placeholder text on every provider', () => {
  const missing = writeBlob(Buffer.from('gone image'));
  const file = writeBlob(Buffer.from('gone notes'));
  const corrupt = writeBlob(Buffer.from('corrupt notes'));
  rmSync(missing.path);
  rmSync(file.path);
  writeFileSync(corrupt.path, 'tampered!');
  const content = [
    { type: 'image', mimeType: 'image/png', attachmentRef: missing.ref, sizeBytes: missing.sizeBytes },
    { type: 'file', mimeType: 'text/plain', filename: 'notes.txt', attachmentRef: file.ref, sizeBytes: file.sizeBytes },
    { type: 'file', mimeType: 'text/plain', filename: 'bad.txt', attachmentRef: corrupt.ref, sizeBytes: corrupt.sizeBytes },
    { type: 'text', attachmentRef: file.ref, sizeBytes: file.sizeBytes, filename: 'paste.txt' },
  ];
  const wire = lowerEverywhere(content);
  assert.match(wire, /\[attachment unavailable: image\/png\]/);
  assert.match(wire, /\[attachment unavailable: notes\.txt\]/);
  assert.match(wire, /\[attachment unavailable: bad\.txt\]/);
  assert.match(wire, /\[attachment unavailable: paste\.txt\]/);
  assert.equal(lowerEverywhere(content), wire);
  assert.match(media.contentToText([content[1]]), /attachment unavailable: notes\.txt/);
});

test('a part the store rejects falls back to its placeholder instead of failing the save', (t) => {
  const log = t.mock.method(console, 'error', () => {});
  const huge = Buffer.alloc(64 * 1024 * 1024 + 1, 1).toString('base64');
  const image = { type: 'image', data: huge, mimeType: 'image/png' };
  const file = { type: 'file', data: huge, mimeType: 'application/zip', filename: 'big.zip' };
  const small = { type: 'image', data: 'AAECAw==', mimeType: 'image/png' };
  const stored = media.sanitizeContentForStoredHistory([image, file, small]);
  assert.deepEqual(stored[0], { type: 'text', text: '[Image omitted from stored history: image/png]' });
  assert.deepEqual(stored[1], { type: 'text', text: '[File omitted from stored history: big.zip]' });
  assert.match(stored[2].attachmentRef, /^[a-f0-9]{64}$/, 'one bad part does not affect its neighbours');
  assert.equal(log.mock.callCount(), 2);
  media.sanitizeContentForStoredHistory([image]);
  assert.equal(log.mock.callCount(), 2, 'the same failure is logged once');
});
