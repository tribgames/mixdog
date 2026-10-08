// Provider prompt-cache parity: the same history must lower to byte-identical
// request bodies from live messages, from the session-save projection after a
// JSON round trip, and from a cold process (no memos, no cached blob buffers).
import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-lowering-parity-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const { toAnthropicMessages } = await import('./anthropic-messages.mjs');
const { toGeminiContents } = await import('./gemini-schema.mjs');
const { toOpenAIMessages, toXaiResponsesInput } = await import('./openai-compat-wire.mjs');
const { convertMessagesToResponsesInput } = await import('./openai-responses-payload.mjs');
const media = await import('./media-normalization.mjs');
const { _messagesForDisk } = await import('../session/store/serialize.mjs');
const { clearAttachmentBufferCache } = await import('../../../attachments/store.mjs');

const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
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
    `<w:document xmlns:w="${WORD_NS}"><w:body><w:p><w:r><w:t>Parity body</w:t></w:r></w:p></w:body></w:document>`
  );
  return (await zip.generateAsync({ type: 'nodebuffer' })).toString('base64');
}

async function history() {
  const docx = await docxBase64();
  const pdf = minimalPdf('Parity PDF').toString('base64');
  return [
    { role: 'system', content: 'rules' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'look at these' },
        { type: 'image', data: 'AAECAw==', mimeType: 'image/png' },
        { type: 'file', data: docx, mimeType: DOCX, filename: 'plan.docx' },
        { type: 'file', data: docx, mimeType: 'application/octet-stream', filename: 'again.docx' },
        { type: 'file', data: pdf, mimeType: 'application/octet-stream', filename: 'mislabelled' },
        { type: 'file', data: Buffer.from('a,b\n1,2\n').toString('base64'), mimeType: 'text/csv', filename: 'rows.csv' },
      ],
    },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: { file_path: 'x.pdf' } }] },
    {
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: 'read ok' },
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf }, title: 'x.pdf' },
        { type: 'file', data: docx, mimeType: DOCX, filename: 'tool.docx' },
      ],
    },
    { role: 'user', content: 'thanks' },
  ];
}

// A provider that takes a PDF as text declares nativePdf = false; its request
// builder runs the awaited pre-send step first and lowers what it returns.
const TEXT_PDF = { nativePdf: false };

const BUILDERS = {
  anthropic: async (messages) => toAnthropicMessages(messages),
  openaiResponses: async (messages) => convertMessagesToResponsesInput(messages),
  openaiChat: async (messages) => toOpenAIMessages(messages, 'openai'),
  customChat: async (messages) =>
    toOpenAIMessages(await media.preparePdfTextForProvider(messages, TEXT_PDF), 'my-custom-gateway', TEXT_PDF),
  xaiResponses: async (messages) =>
    toXaiResponsesInput(await media.preparePdfTextForProvider(messages, TEXT_PDF), null, {
      providerName: 'xai',
      nativePdf: false,
    }).input,
  gemini: async (messages) => toGeminiContents(messages, 'gemini-3-pro-preview'),
  antigravity: async (messages) => toGeminiContents(messages, 'gemini-3-pro-high', { repairToolSignatures: false }),
};

async function buildAll(messages) {
  const entries = [];
  for (const [name, build] of Object.entries(BUILDERS)) entries.push([name, JSON.stringify(await build(messages))]);
  return Object.fromEntries(entries);
}

function coldStart() {
  media._clearLoweringMemos();
  clearAttachmentBufferCache();
}

test('every request builder lowers live, saved/reloaded and cold histories identically', async () => {
  const live = await history();
  const snapshot = JSON.stringify(live);
  const liveBodies = await buildAll(live);
  assert.deepEqual(await buildAll(live), liveBodies, 'building twice is stable');
  assert.equal(JSON.stringify(live), snapshot, 'lowering never mutates the history');

  const saved = JSON.parse(JSON.stringify(_messagesForDisk(live)));
  assert.match(JSON.stringify(saved), /attachmentRef/);
  assert.equal(JSON.stringify(saved).includes('Parity body'), false);
  assert.deepEqual(await buildAll(saved), liveBodies, 'reloaded history');

  coldStart();
  assert.deepEqual(await buildAll(saved), liveBodies, 'cold memos and blob cache');
  assert.deepEqual(await buildAll(saved), liveBodies, 'warm again');

  // Office text and non-native PDF text actually reached the right builders.
  for (const name of ['anthropic', 'openaiResponses', 'openaiChat', 'customChat', 'xaiResponses', 'gemini', 'antigravity']) {
    assert.match(liveBodies[name], /Parity body/, name);
  }
  assert.match(liveBodies.customChat, /Parity PDF/);
  assert.match(liveBodies.xaiResponses, /Parity PDF/);
  assert.equal(liveBodies.customChat.includes('"type":"file"'), false);
  assert.match(liveBodies.openaiChat, /"type":"file"/);
  assert.match(liveBodies.antigravity, /"mimeType":"application\/pdf"/);
});

test('estimates and media bytes match for inline parts and their references, with cold memos', async () => {
  const live = await history();
  const saved = JSON.parse(JSON.stringify(_messagesForDisk(live)));
  coldStart();
  for (const index of [1, 3]) {
    const a = live[index].content;
    const b = saved[index].content;
    assert.equal(media.contentToEstimateText(a), media.contentToEstimateText(b));
    assert.deepEqual(media.contentFileDescriptors(a), media.contentFileDescriptors(b));
    assert.equal(media.contentMediaBytes(a), media.contentMediaBytes(b));
    assert.equal(media.contentMediaBytes(a, TEXT_PDF), media.contentMediaBytes(b, TEXT_PDF));
  }
  // Office and text files travel as text, so they are not media; a PDF is
  // media only where it is sent natively.
  const office = live[1].content[2];
  assert.equal(media.contentMediaBytes([office]), 0);
  const pdf = live[3].content[1];
  assert.ok(media.contentMediaBytes([pdf]) > 0);
  assert.equal(media.contentMediaBytes([pdf], TEXT_PDF), 0);
});

test('lowering a PDF part for a text-lowering provider is an internal error, never a raw block', async () => {
  const live = await history();
  assert.throws(() => toOpenAIMessages(live, 'my-custom-gateway', TEXT_PDF), /PDF part reached text lowering/);
  assert.throws(() => toXaiResponsesInput(live, null, { providerName: 'xai', nativePdf: false }), /PDF part reached text lowering/);
  const prepared = await media.preparePdfTextForProvider(live, TEXT_PDF);
  assert.doesNotThrow(() => toOpenAIMessages(prepared, 'my-custom-gateway', TEXT_PDF));
  assert.equal(JSON.stringify(live).includes('Parity PDF'), false, 'the live history is not rewritten');
});

test('a permanently missing blob lowers to a placeholder, a transient read error still throws', async (t) => {
  const saved = JSON.parse(JSON.stringify(_messagesForDisk(await history())));
  const docRef = saved[1].content[2];
  clearAttachmentBufferCache();

  const realStat = fs.statSync;
  const failWith = (code) => {
    t.mock.method(fs, 'statSync', (path, ...rest) => {
      if (String(path).endsWith(docRef.attachmentRef)) throw Object.assign(new Error(`${code} secret/path`), { code });
      return realStat(path, ...rest);
    });
    syncBuiltinESMExports();
  };

  for (const code of ['EBUSY', 'EPERM', 'EACCES', 'EMFILE']) {
    failWith(code);
    for (const [name, build] of Object.entries(BUILDERS)) {
      await assert.rejects(build(saved), { code }, `${name} must not rewrite history on ${code}`);
    }
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  failWith('ENOENT');
  for (const [name, build] of Object.entries(BUILDERS)) {
    const body = JSON.stringify(await build(saved));
    assert.match(body, /\[attachment unavailable: plan\.docx\]/, name);
    assert.equal(body.includes('secret'), false, name);
    assert.equal(body.includes(dataDir), false, name);
  }
  t.mock.restoreAll();
  syncBuiltinESMExports();
});

test('a failed store is retried on the next save and never changes the live part', (t) => {
  t.mock.method(console, 'error', () => {});
  const big = Buffer.alloc(64 * 1024 * 1024 + 1, 1).toString('base64');
  const part = { type: 'file', data: big, mimeType: 'application/zip', filename: 'big.zip' };
  const first = media.sanitizeContentForStoredHistory([part]);
  assert.match(first[0].text, /omitted from stored history/);
  assert.equal(part.data, big);
  assert.equal(media.contentCarriesLiveMedia([part]), true);
  assert.equal(media.contentCarriesLiveMedia(first), false);
  assert.match(media.normalizeContentForAnthropic([part])[0].text, /file not sent inline: big\.zip/);
});
