// The awaited pre-send step: it returns a request copy with every PDF replaced
// by its text; correctness never depends on a cache; only a property of the
// bytes ever becomes (cached) text; hosted models always keep their images.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isEnvironmentError } from '../../../shared/environment-error.mjs';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-pdf-prepare-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));
// The models.dev cache the vision rule reads (warmed from disk on first use).
writeFileSync(
  join(dataDir, 'modelsdev-catalog.json'),
  JSON.stringify({
    fetchedAt: Date.now(),
    data: {
      acme: {
        models: {
          'text-only': { modalities: { input: ['text'], output: ['text'] } },
          'sees-images': { modalities: { input: ['text', 'image'], output: ['text'] } },
          'no-modalities': {},
        },
      },
    },
  })
);

const media = await import('./media-normalization.mjs');
const { toOpenAIMessages } = await import('./openai-compat-wire.mjs');

const TEXT_PDF = { nativePdf: false };

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

const history = (...texts) =>
  texts.map((text, index) => ({
    role: 'user',
    content: [
      { type: 'file', data: minimalPdf(text).toString('base64'), mimeType: 'application/pdf', filename: `f${index}.pdf` },
    ],
  }));

const lowered = (messages) => JSON.stringify(toOpenAIMessages(messages, 'my-gateway', TEXT_PDF));

test.afterEach(() => {
  media._clearLoweringMemos();
});

test('module-load and system failures are environmental, a parse error is not', () => {
  const env = (error) => isEnvironmentError(error);
  assert.equal(env(Object.assign(new Error('Cannot find module unpdf'), { code: 'ERR_MODULE_NOT_FOUND' })), true);
  assert.equal(env(Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' })), true);
  assert.equal(env(Object.assign(new Error('spawn'), { code: 'ENOMEM' })), true);
  assert.equal(env(new Error('Array buffer allocation failed')), true);
  assert.equal(env(new Error('Invalid PDF structure.')), false);
  assert.equal(env(Object.assign(new Error('bad xref'), { name: 'FormatError' })), false);
});

test('a corrupt PDF is a property of the bytes: fixed text, extracted once', async () => {
  const bad = [
    {
      role: 'user',
      content: [{ type: 'file', data: Buffer.from('%PDF-1.4 garbage').toString('base64'), mimeType: 'application/pdf' }],
    },
  ];
  const before = media._pdfExtractionCount();
  const first = lowered(await media.preparePdfTextForProvider(bad, TEXT_PDF));
  assert.match(first, /\[PDF text unavailable: this PDF could not be read\]/);
  assert.equal(lowered(await media.preparePdfTextForProvider(bad, TEXT_PDF)), first);
  assert.equal(media._pdfExtractionCount(), before + 1);
});

test('the result is correct with a cold cache however many PDFs a request holds', async () => {
  const many = history(...Array.from({ length: 70 }, (_, i) => `Doc${i}`));
  const prepared = await media.preparePdfTextForProvider(many, TEXT_PDF);
  const wire = lowered(prepared);
  assert.match(wire, /Doc0\b/);
  assert.match(wire, /Doc69\b/);
  media._clearLoweringMemos();
  assert.equal(lowered(await media.preparePdfTextForProvider(many, TEXT_PDF)), wire);
});

test('a native provider, or one that does not say, keeps its messages untouched', async () => {
  const messages = history('Native');
  const before = media._pdfExtractionCount();
  assert.equal(await media.preparePdfTextForProvider(messages, { nativePdf: true }), messages);
  assert.equal(await media.preparePdfTextForProvider(messages, {}), messages);
  assert.equal(await media.preparePdfTextForProvider(messages, undefined), messages);
  assert.equal(media._pdfExtractionCount(), before);
});

test('conversion returns a copy: other messages and parts are shared, the input is unchanged', async () => {
  const messages = [{ role: 'user', content: 'plain' }, ...history('Copy')];
  const snapshot = JSON.stringify(messages);
  const prepared = await media.preparePdfTextForProvider(messages, TEXT_PDF);
  assert.equal(JSON.stringify(messages), snapshot);
  assert.equal(prepared[0], messages[0]);
  assert.notEqual(prepared[1], messages[1]);
  assert.equal(prepared[1].content[0].type, 'text');
  assert.match(prepared[1].content[0].text, /^--- f0\.pdf \(application\/pdf, \d+ bytes\) ---\nPage|^--- f0\.pdf .*---\n--- Page 1 ---/);
  const bare = [{ role: 'tool', toolCallId: 'c', content: messages[1].content[0] }];
  const preparedBare = await media.preparePdfTextForProvider(bare, TEXT_PDF);
  assert.equal(Array.isArray(preparedBare[0].content), true);
});

test('images are never degraded for a hosted model: the decision cannot depend on catalog state', async () => {
  // No stable source declares a hosted model image-less (custom model config has
  // no such field, the bundled static catalog only lists vision-capable models),
  // and a runtime catalog (models.dev cache) flips with load/refresh and would
  // change sent bytes between turns. So images always ride through, with the
  // runtime catalog cold and with it loaded saying "text only".
  const image = { type: 'image', data: 'AAECAw==', mimeType: 'image/png' };
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'see' }, image] }];
  const hosted = { name: 'acme', nativePdf: true };
  const { getModelsDevRowSync } = await import('../../../shared/llm/model-catalog.mjs');
  const cold = await media.preparePdfTextForProvider(messages, hosted);
  assert.equal(cold, messages);
  // Load the catalog cache (it lists acme/text-only as having no image input).
  assert.deepEqual(getModelsDevRowSync('text-only', 'acme').modalities.input, ['text']);
  const loaded = await media.preparePdfTextForProvider(messages, hosted);
  assert.equal(loaded, messages);
  assert.equal(JSON.stringify(loaded), JSON.stringify(cold));
  assert.equal(JSON.stringify(toOpenAIMessages(loaded, 'acme')).includes('omitted'), false);
});

test('the local text-only wording is unchanged', () => {
  assert.equal(media.omittedMediaText('image'), '[image omitted: local model is text-only]');
});
