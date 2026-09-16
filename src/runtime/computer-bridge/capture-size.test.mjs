import assert from 'node:assert/strict';
import test from 'node:test';
import { computerCaptureSize } from './capture-size.mjs';
import sharp from 'sharp';
import { prepareAnthropicImages } from '../agent/orchestrator/providers/lib/anthropic-image-input.mjs';

test('captures fit both encoder budgets before their coordinate frame is registered', () => {
  for (const [width, height] of [
    [1275, 2274],
    [2560, 1440],
    [3840, 2160],
    [1080, 3840],
    [800, 600],
    [1, 3000],
  ]) {
    const image = computerCaptureSize(width, height);
    assert.ok(image.width <= 1280 && image.height <= 1568);
    assert.ok(Math.ceil(image.width / 28) * Math.ceil(image.height / 28) <= 1568);
    assert.ok(Math.ceil(image.width / 32) * Math.ceil(image.height / 32) <= 1536);
    assert.ok(image.width <= width && image.height <= height);
    assert.ok(Math.abs(image.width / width - image.height / height) <= 1 / Math.min(width, height));
  }
  assert.deepEqual(computerCaptureSize(1280, 720), { width: 1280, height: 720 });
  assert.deepEqual(computerCaptureSize(2560, 1440), { width: 1280, height: 720 });
  assert.deepEqual(computerCaptureSize(800, 600), { width: 800, height: 600 });
  assert.throws(() => computerCaptureSize(0, 100), /capture_geometry_invalid/);
});

test('provider preparation does not rescale an already bound computer frame', async () => {
  const frame = computerCaptureSize(1275, 2274);
  const pixels = await sharp({
    create: { ...frame, channels: 3, background: { r: 40, g: 80, b: 120 } },
  })
    .jpeg({ quality: 55 })
    .toBuffer();
  const messages = await prepareAnthropicImages([
    {
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: pixels.toString('base64') },
        },
      ],
    },
  ]);
  const image = messages[0].content.find((part) => part.type === 'image');
  const sent = await sharp(Buffer.from(image.source.data, 'base64')).metadata();
  assert.deepEqual({ width: sent.width, height: sent.height }, frame);
  assert.equal(
    messages[0].content.some((part) => part.type === 'text' && /Multiply coordinates/.test(part.text)),
    false
  );
});
