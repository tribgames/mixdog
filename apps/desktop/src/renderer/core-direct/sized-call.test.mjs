import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { BLOB_REF_FIELDS } from '../../shared/core-lanes/blob-ref-fields.ts';
import { sizedCall } from './sized-call.ts';

const FRAME = 256 * 1024;
const harness = () => {
  const sent = [];
  const blobs = [];
  const client = {
    server: { limits: { maxInboundFrameBytes: FRAME, maxBlobPutChunkBytes: 190000 } },
    call: async (method, params) => (sent.push({ method, params }), { ok: true }),
    putBlob: async (bytes, mediaType) => (
      blobs.push({ bytes, mediaType }), { blob: { digest: `sha256:${blobs.length}`, bytes: bytes.length, mediaType } }
    ),
  };
  return { client, sent, blobs };
};
const frameBytes = (params) => Buffer.byteLength(JSON.stringify(params));

test('small_passthrough', async () => {
  const { client, sent, blobs } = harness();
  const params = { input: { prompt: 'hello' } };
  await sizedCall(client, 'turn/start', params);
  assert.equal(blobs.length, 0);
  assert.equal(sent[0].params, params);
});

test('large_text_ref', async () => {
  const { client, sent, blobs } = harness();
  const content = 'x'.repeat(300 * 1024);
  const params = { root: 'r', rel: 'a.txt', content };
  await sizedCall(client, 'projectFs/writeText', params);
  assert.equal(blobs.length, 1);
  assert.equal(blobs[0].bytes.length, content.length);
  assert.deepEqual(sent[0].params.content, { $blobRef: 'sha256:1', as: 'text' });
  assert.equal(sent[0].params.rel, 'a.txt');
  assert.equal(params.content, content, 'the caller params are not changed');
  assert.ok(frameBytes(sent[0].params) < FRAME);
});

test('large_image_ref', async () => {
  const { client, sent, blobs } = harness();
  const raw = Buffer.alloc(300 * 1024, 7);
  const params = {
    input: {
      prompt: [
        { type: 'text', text: 'see' },
        { type: 'image', data: raw.toString('base64') },
        { type: 'image', data: `data:image/png;base64,${raw.toString('base64')}` },
      ],
    },
  };
  await sizedCall(client, 'turn/start', params);
  assert.equal(blobs.length, 2);
  const prompt = sent[0].params.input.prompt;
  const uploaded = new Map(blobs.map(({ bytes }, i) => [`sha256:${i + 1}`, bytes]));
  assert.equal(prompt[1].data.as, 'base64');
  assert.deepEqual(Buffer.from(uploaded.get(prompt[1].data.$blobRef)), raw);
  // A data URL travels as its text: a "base64" reference would expand without the `data:...;base64,` prefix.
  assert.equal(prompt[2].data.as, 'text');
  assert.equal(new TextDecoder().decode(uploaded.get(prompt[2].data.$blobRef)), params.input.prompt[2].data);
  assert.equal(prompt[0].text, 'see');
});

test('several supported attachment fields that together exceed a frame still submit', async () => {
  const { client, sent, blobs } = harness();
  const data = Buffer.alloc(42 * 1024, 23).toString('base64');
  const prompt = Array.from({ length: 5 }, () => ({ type: 'image', data, mimeType: 'image/png' }));
  await sizedCall(client, 'turn/start', { input: { prompt } });
  assert.equal(sent.length, 1);
  assert.ok(frameBytes(sent[0].params) < FRAME);
  for (const part of sent[0].params.input.prompt) {
    const restored =
      typeof part.data === 'string'
        ? part.data
        : Buffer.from(blobs[Number(part.data.$blobRef.slice(7)) - 1].bytes).toString('base64');
    assert.equal(restored, data);
  }
});

test('new, existing, and room submissions preserve large display and goal text', async () => {
  const displayText = '表'.repeat(100_000);
  const goalCommand = 'goal '.repeat(60_000);
  for (const [method, key] of [
    ['thread/start', 'initialInput'],
    ['turn/start', 'input'],
    ['room/send', 'input'],
  ]) {
    const { client, sent, blobs } = harness();
    await sizedCall(client, method, { [key]: { prompt: 'go', options: { displayText, goalCommand } } });
    assert.ok(frameBytes(sent[0].params) < FRAME);
    const restored = (ref) => {
      assert.equal(ref.as, 'text');
      return new TextDecoder().decode(blobs[Number(ref.$blobRef.slice(7)) - 1].bytes);
    };
    const options = sent[0].params[key].options;
    assert.equal(restored(options.displayText), displayText);
    assert.equal(restored(options.goalCommand), goalCommand);
  }
});

test('still_too_large_refused', async () => {
  const { client, sent } = harness();
  const files = Array.from({ length: 6 }, (_, i) => ({ rel: `f${i}`, content: 'y'.repeat(60 * 1024) }));
  const params = { root: 'r', files, note: 'z'.repeat(300 * 1024) };
  await assert.rejects(
    sizedCall(client, 'projectFs/writeTextBatch', params),
    (e) => e instanceof TypeError && /too large to send/.test(e.message)
  );
  // A method with no listed fields cannot shrink: over the frame bound it is refused here, not sent to be cut off by the core.
  await assert.rejects(
    sizedCall(client, 'thread/rename', { name: 'n'.repeat(300 * 1024) }),
    (e) => e instanceof TypeError && /thread\/rename is too large/.test(e.message)
  );
  assert.equal(sent.length, 0);
});

test('table_matches_rust_json', () => {
  const rust = JSON.parse(
    readFileSync(
      new URL('../../../../../native/core/crates/mixdog-app-protocol/src/boundary/blob_fields.json', import.meta.url),
      'utf8'
    )
  ).methods;
  assert.deepEqual(BLOB_REF_FIELDS, rust);
});

test('feedback_attachment_images_travel_as_blob_refs', async () => {
  const { client, sent, blobs } = harness();
  const png = Buffer.alloc(300 * 1024, 9);
  const input = {
    id: 'id-1',
    kind: 'bug',
    message: 'it broke',
    attachments: [
      { name: 'a.png', mimeType: 'image/png', data: png.toString('base64') },
      { name: 'b.png', mimeType: 'image/png', data: 'not base64!' },
    ],
  };
  await sizedCall(client, 'feedback/upload', { input });
  assert.equal(blobs.length, 1);
  assert.equal(Buffer.from(blobs[0].bytes).equals(png), true);
  const attachments = sent[0].params.input.attachments;
  assert.deepEqual(attachments[0].data, { $blobRef: 'sha256:1', as: 'base64' });
  assert.equal(attachments[1].data, 'not base64!');
  assert.equal(sent[0].params.input.message, 'it broke');
});
