// Provider-spec alignment of the shared media normalizers: OpenAI Responses
// image detail, Anthropic document citations/context, and providers that take
// no document block at all.
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const dataDir = mkdtempSync(join(tmpdir(), 'mixdog-media-spec-'));
process.env.MIXDOG_DATA_DIR = dataDir;
test.after(() => rmSync(dataDir, { recursive: true, force: true }));

const media = await import('./media-normalization.mjs');
const { toAnthropicMessages } = await import('./anthropic-messages.mjs');

const IMAGE = 'iVBORw0KGgo=';

test('Responses input_image keeps a supplied detail and leaves unsupplied or unknown detail out', () => {
  for (const detail of ['low', 'high', 'auto', 'original']) {
    const out = media.normalizeContentForOpenAIResponses([{ type: 'image', data: IMAGE, mimeType: 'image/png', detail }]);
    assert.deepEqual(out, [{ type: 'input_image', image_url: `data:image/png;base64,${IMAGE}`, detail }]);
  }
  const nested = media.normalizeContentForOpenAIResponses([
    { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'HIGH' } },
    { type: 'input_image', file_id: 'file_1', detail: 'low' },
  ]);
  assert.deepEqual(nested, [
    { type: 'input_image', image_url: 'https://example.com/a.png', detail: 'high' },
    { type: 'input_image', file_id: 'file_1', detail: 'low' },
  ]);
  const plain = media.normalizeContentForOpenAIResponses([
    { type: 'image', data: IMAGE, mimeType: 'image/png' },
    { type: 'image', data: IMAGE, mimeType: 'image/png', detail: 'ultra' },
  ]);
  assert.deepEqual(plain, Array(2).fill({ type: 'input_image', image_url: `data:image/png;base64,${IMAGE}` }));
});

test('Chat image_url keeps a supplied detail', () => {
  const out = media.normalizeContentForOpenAIChat([
    { type: 'image', data: IMAGE, mimeType: 'image/png', detail: 'low' },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
    { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
    { type: 'image', data: IMAGE, mimeType: 'image/png', detail: 'bogus' },
  ]);
  assert.deepEqual(out, [
    { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE}`, detail: 'low' } },
    { type: 'image_url', image_url: { url: 'https://example.com/a.png', detail: 'high' } },
    { type: 'image_url', image_url: { url: 'https://example.com/b.png' } },
    { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE}` } },
  ]);
});

test('Chat cache_control and multipart system content are kept only when the caller grants cacheControl', () => {
  const system = [
    { type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'more' },
  ];
  assert.equal(media.normalizeContentForOpenAIChat(system, { role: 'system' }), 'rules\nmore');
  assert.deepEqual(media.normalizeContentForOpenAIChat(system, { role: 'system', cacheControl: true }), system);
  assert.equal(media.normalizeContentForOpenAIChat([{ type: 'text', text: 'solo' }], { role: 'system', cacheControl: true }), 'solo');
  const user = [{ type: 'text', text: 'ctx', cache_control: { type: 'ephemeral' } }];
  assert.deepEqual(media.normalizeContentForOpenAIChat(user), [{ type: 'text', text: 'ctx' }]);
  assert.deepEqual(media.normalizeContentForOpenAIChat(user, { cacheControl: true }), user);
});

test('Anthropic base64 documents keep citations and context, and unchanged inputs are identical', () => {
  const data = Buffer.from('%PDF-1.7\nbody').toString('base64');
  const [pdf] = media.normalizeContentForAnthropic([
    {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data },
      title: 'Spec',
      citations: { enabled: true },
      context: 'Background only',
    },
  ]);
  assert.deepEqual(pdf, {
    type: 'document',
    source: { type: 'base64', media_type: 'application/pdf', data },
    title: 'Spec',
    citations: { enabled: true },
    context: 'Background only',
  });
  const [bare] = media.normalizeContentForAnthropic([
    { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } },
  ]);
  assert.deepEqual(bare, { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } });
  const csv = Buffer.from('a,b\n1,2\n').toString('base64');
  const [text] = media.normalizeContentForAnthropic([
    { type: 'file', data: csv, mimeType: 'text/csv', filename: 'r.csv', citations: { enabled: true } },
  ]);
  assert.deepEqual(text.citations, { enabled: true });
  assert.equal(text.source.type, 'text');
});

test('a provider without native documents gets every document variant as text, or an explicit rejection', async () => {
  const csv = Buffer.from('name,value\nalpha,1\n').toString('base64');
  const noDocuments = { nativeDocuments: false };
  const history = [
    {
      role: 'user',
      content: [
        { type: 'file', data: csv, mimeType: 'text/csv', filename: 'rows.csv' },
        { type: 'document', title: 'Notes', source: { type: 'text', media_type: 'text/plain', data: 'plain notes' } },
        {
          type: 'document',
          source: { type: 'content', content: [{ type: 'text', text: 'block one' }, { type: 'text', text: 'block two' }] },
        },
        { type: 'text', text: 'question' },
      ],
    },
  ];
  const prepared = await media.preparePdfTextForProvider(history, noDocuments);
  const serialized = JSON.stringify(toAnthropicMessages(prepared));
  assert.equal(serialized.includes('"type":"document"'), false);
  assert.match(serialized, /alpha,1/);
  assert.match(serialized, /--- Notes ---\\nplain notes/);
  assert.match(serialized, /block one\\nblock two/);
  assert.equal(history[0].content[0].type, 'file', 'the input is not mutated');

  await assert.rejects(
    media.preparePdfTextForProvider(
      [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.com/a.pdf' } }] }],
      noDocuments
    ),
    /accepts no document blocks/
  );
  // A provider that only lacks native PDFs keeps its text documents native.
  assert.equal(await media.preparePdfTextForProvider(history, { nativePdf: false }), history);
  assert.equal(await media.preparePdfTextForProvider(history, {}), history);
});
