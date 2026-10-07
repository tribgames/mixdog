import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { compactResultImages } from './finalize.mjs';
import { prepareAnthropicImages } from '../../providers/lib/anthropic-image-input.mjs';
import { IMAGE_MAX_WIDTH, IMAGE_MAX_HEIGHT } from '../../tools/builtin/read-image-resize.mjs';

async function noisyPngBase64(width, height) {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 1;
  for (let i = 0; i < pixels.length; i += 1) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    pixels[i] = seed >>> 24;
  }
  const png = await sharp(pixels, { raw: { width, height, channels: 3 } }).png().toBuffer();
  return png.toString('base64');
}

function anthropicImageRequest(image) {
  return [
    {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call_1',
          content: [{ type: 'image', source: { type: 'base64', media_type: image.mimeType, data: image.data } }],
        },
      ],
    },
  ];
}

test('a large tool-result screenshot is re-encoded once and survives per-send preparation byte-for-byte', async () => {
  const original = await noisyPngBase64(1800, 1200);
  const result = await compactResultImages({
    content: [
      { type: 'text', text: 'screenshot' },
      { type: 'image', data: original, mimeType: 'image/png' },
    ],
  });
  const image = result.content.find((part) => part.type === 'image');
  assert.equal(image.mimeType, 'image/jpeg');
  assert.ok(image.data.length < original.length);
  const meta = await sharp(Buffer.from(image.data, 'base64')).metadata();
  assert.ok(meta.width <= IMAGE_MAX_WIDTH && meta.height <= IMAGE_MAX_HEIGHT);
  assert.ok(result.content.some((part) => part.type === 'text' && /supersede/.test(part.text)));

  const request = anthropicImageRequest(image);
  assert.equal(await prepareAnthropicImages(request), request);
});

test('a small tool-result image and non-image results are left untouched', async () => {
  const small = await sharp({ create: { width: 300, height: 300, channels: 3, background: '#336699' } })
    .png()
    .toBuffer();
  const result = { content: [{ type: 'image', data: small.toString('base64'), mimeType: 'image/png' }] };
  assert.equal(await compactResultImages(result), result);
  const text = { content: [{ type: 'text', text: 'ok' }] };
  assert.equal(await compactResultImages(text), text);
});
