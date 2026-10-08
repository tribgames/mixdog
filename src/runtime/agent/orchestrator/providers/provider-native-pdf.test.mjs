// Native-PDF capability is declared by each adapter class (its wire protocol),
// one predicate serves intake, lowering and the media estimates, and a PDF's
// recorded page count prices it identically inline and stored.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-native-pdf-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const media = await import('./media-normalization.mjs');
const { providerNativePdf } = await import('./registry.mjs');
const { providerTakesNativePdf, isPermanentAttachmentError } = await import('../../../attachments/store.mjs');
const { shouldCompactForRequestMedia } = await import('../session/loop/compact-policy.mjs');
const ctx = await import('../session/context-utils.mjs');
const { messageAttachmentBreakdown } = ctx;
const { createCustomProvider } = await import('./custom-provider.mjs');
const { toAnthropicMessages } = await import('./anthropic-messages.mjs');
const { OpenCodeGoProvider } = await import('./opencode-go.mjs');
const { AnthropicProvider } = await import('./anthropic.mjs');

const cfg = { baseURL: 'http://127.0.0.1:1', apiKey: 'k', preconnect: false };

test('each adapter declares nativePdf by its wire protocol', async () => {
  const make = async (file, name, ...args) => new (await import(`./${file}`))[name](...args);
  const declared = {
    anthropic: await make('anthropic.mjs', 'AnthropicProvider', { apiKey: 'k' }),
    anthropicOauth: await make('anthropic-oauth.mjs', 'AnthropicOAuthProvider', {}),
    gemini: await make('gemini.mjs', 'GeminiProvider', { apiKey: 'k' }),
    antigravity: await make('antigravity-oauth.mjs', 'AntigravityOAuthProvider', {}),
    openaiOauth: await make('openai-oauth.mjs', 'OpenAIOAuthProvider', {}),
    openai: await make('openai-ws.mjs', 'OpenAIDirectProvider', { apiKey: 'k' }),
    compat: await make('openai-compat.mjs', 'OpenAICompatProvider', 'deepseek', cfg),
    grok: await make('grok-oauth.mjs', 'GrokOAuthProvider', {}),
    opencodeGo: await make('opencode-go.mjs', 'OpenCodeGoProvider', { apiKey: 'k' }),
    cursorApi: await make('cursor.mjs', 'CursorApiProvider', { apiKey: 'k' }),
    cursorOauth: await make('cursor.mjs', 'CursorOAuthProvider', {}),
    local: await make('mixdog-local.mjs', 'MixdogLocalProvider', {}),
  };
  for (const name of ['anthropic', 'anthropicOauth', 'gemini', 'antigravity', 'openaiOauth', 'openai']) {
    assert.equal(declared[name].nativePdf, true, name);
  }
  for (const name of ['compat', 'grok', 'opencodeGo', 'cursorApi', 'cursorOauth', 'local']) {
    assert.equal(declared[name].nativePdf, false, name);
  }
});

test('a custom provider follows its protocol, not its name', async () => {
  const custom = (id, protocol) => createCustomProvider(id, { name: id, protocol, models: [{ id: 'm' }], ...cfg });
  // An unknown third-party gateway behind the Anthropic wire lowers PDFs to text.
  assert.equal((await custom('custom-a', 'anthropic')).nativePdf, false);
  assert.equal((await custom('custom-b', 'openai-chat')).nativePdf, false);
  assert.equal((await custom('custom-c', 'openai-responses')).nativePdf, false);
});

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

const pdfRequest = () => [
  {
    role: 'user',
    content: [
      { type: 'text', text: 'read it' },
      { type: 'file', data: minimalPdf('Gateway PDF').toString('base64'), mimeType: 'application/pdf', filename: 'g.pdf' },
    ],
  },
];

// What an Anthropic-wire instance hands its transport for a request.
async function anthropicWireBody(provider) {
  let sent = null;
  provider._doSend = async (messages) => {
    sent = messages;
    return { content: 'ok' };
  };
  await provider.send(pdfRequest(), 'some-model', undefined, {});
  return JSON.stringify(toAnthropicMessages(sent));
}

test('OpenCode Go minimax (Anthropic route) and custom Anthropic gateways get PDF text, not a document block', async () => {
  const goProvider = new OpenCodeGoProvider({ apiKey: 'k' });
  assert.equal(goProvider.anthropic.nativePdf, false, 'the inner route follows the outer provider');
  let sent = null;
  goProvider.anthropic._doSend = async (messages) => {
    sent = messages;
    return { content: 'ok', usage: {} };
  };
  await goProvider.send(pdfRequest(), 'minimax-m2', undefined, {});
  const go = JSON.stringify(toAnthropicMessages(sent));
  assert.match(go, /Gateway PDF/);
  assert.equal(go.includes('"type":"document"'), false);

  const custom = await createCustomProvider('custom-z', { name: 'z', protocol: 'anthropic', models: [{ id: 'm' }], ...cfg });
  const body = await anthropicWireBody(custom);
  assert.match(body, /Gateway PDF/);
  assert.equal(body.includes('"type":"document"'), false);

  // The built-in Anthropic API keeps the native block and extracts nothing.
  const before = media._pdfExtractionCount();
  const native = await anthropicWireBody(new AnthropicProvider({ apiKey: 'k' }));
  assert.match(native, /"type":"document"/);
  assert.equal(native.includes('Gateway PDF'), false);
  assert.equal(media._pdfExtractionCount(), before, 'the native instance extracted nothing');
});

test('the one predicate: only an explicit false lowers PDFs to text', () => {
  assert.equal(providerTakesNativePdf({ nativePdf: true }), true);
  assert.equal(providerTakesNativePdf({ nativePdf: false }), false);
  assert.equal(providerTakesNativePdf({}), true);
  assert.equal(providerTakesNativePdf(undefined), true);
  assert.equal(providerNativePdf('not-registered'), true);
});

const imageRef = { type: 'image', attachmentRef: 'a'.repeat(64), mimeType: 'image/png', sizeBytes: 1 };
const pdfRef = (name) => ({ type: 'file', attachmentRef: 'b'.repeat(64), mimeType: 'application/pdf', filename: name, sizeBytes: 1 });
const toolMessage = (content) => ({ role: 'tool', toolCallId: 'c', content });

test('compaction triggers once images plus native documents in tool results exceed 100', () => {
  const images = (n) => Array.from({ length: n }, () => imageRef);
  assert.equal(shouldCompactForRequestMedia([toolMessage(images(100))]), false);
  assert.equal(shouldCompactForRequestMedia([toolMessage(images(101))]), true);
  assert.equal(shouldCompactForRequestMedia([toolMessage(images(60)), toolMessage(images(41))]), true);
  const mixed = [...images(60), ...Array.from({ length: 41 }, (_, i) => pdfRef(`${i}.pdf`))];
  assert.equal(shouldCompactForRequestMedia([toolMessage(mixed)]), true, 'native documents count');
  assert.equal(media.contentMediaCount(mixed), 101);
  assert.equal(media.contentMediaCount(mixed, { nativePdf: false }), 60, 'a PDF sent as text is not a document');
  assert.equal(media.contentMediaBytes(mixed, { nativePdf: false }) < media.contentMediaBytes(mixed), true);
});

test('a PDF that records its page count is priced per page, the same inline and stored', () => {
  const data = Buffer.from('%PDF-1.4\n').toString('base64');
  const inline = { type: 'file', data, mimeType: 'application/pdf', filename: 'a.pdf', pageCount: 10 };
  const stored = { type: 'file', attachmentRef: 'c'.repeat(64), mimeType: 'application/pdf', filename: 'a.pdf', sizeBytes: 9, pageCount: 10 };
  const tokens = (part) => messageAttachmentBreakdown({ role: 'user', content: [part] }).tokens;
  assert.equal(tokens(inline), 25_000);
  assert.equal(tokens(stored), 25_000);
  assert.deepEqual(media.contentFileDescriptors([inline]), media.contentFileDescriptors([stored]));
  const { pageCount: _inline, ...noPages } = inline;
  assert.equal(tokens(noPages), 1_500, 'without a page count the size-based floor stands');
  assert.equal(tokens({ ...stored, pageCount: 1, sizeBytes: 160_000 }), 10_000, 'a dense file keeps its size-based price');
});

test('a text-lowered PDF is priced at most at its extraction budget, inline and stored alike', () => {
  const data = Buffer.from('%PDF-1.4\n').toString('base64');
  const inline = { type: 'file', data, mimeType: 'application/pdf', filename: 'a.pdf', pageCount: 100 };
  const stored = { type: 'file', attachmentRef: 'd'.repeat(64), mimeType: 'application/pdf', filename: 'a.pdf', sizeBytes: 9, pageCount: 100 };
  const { textPdfAllowanceDiscount } = ctx;
  const discount = textPdfAllowanceDiscount([{ role: 'user', content: [inline] }]);
  assert.equal(discount, 250_000 - Math.ceil(media.PDF_TEXT_MAX_BYTES / 4));
  assert.equal(textPdfAllowanceDiscount([{ role: 'user', content: [stored] }]), discount);
  const small = { ...inline, pageCount: 2 };
  assert.equal(textPdfAllowanceDiscount([{ role: 'user', content: [small] }]), 0, 'under the budget nothing is discounted');
});

test('store errors are told apart by code, not by message text', () => {
  assert.equal(isPermanentAttachmentError(Object.assign(new Error('x'), { code: 'ENOENT' })), true);
  assert.equal(isPermanentAttachmentError(Object.assign(new Error('x'), { code: 'ATTACHMENT_INVALID' })), true);
  assert.equal(isPermanentAttachmentError(Object.assign(new Error('x'), { code: 'ATTACHMENT_INTEGRITY' })), true);
  assert.equal(isPermanentAttachmentError(new Error('prompt attachment blob is invalid')), false);
  assert.equal(isPermanentAttachmentError(Object.assign(new Error('busy'), { code: 'EBUSY' })), false);
});
