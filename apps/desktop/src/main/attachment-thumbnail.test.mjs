import assert from 'node:assert/strict';
import test from 'node:test';
import { readAttachmentThumbnail } from './attachment-thumbnail.ts';

const REF = 'a'.repeat(64);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
const GIF = [...Buffer.from('GIF89a'), 1, 2];
const WEBP = [...Buffer.from('RIFF'), 0, 0, 0, 0, ...Buffer.from('WEBP')];
const undecodable = () => ({ isEmpty: () => true });

function fakeImage(width, height, calls = {}) {
  return {
    isEmpty: () => false,
    getSize: () => ({ width, height }),
    resize(options) {
      calls.resize = options;
      return fakeImage(options.width, options.height, calls);
    },
    toJPEG(quality) {
      calls.quality = quality;
      return Buffer.from('jpeg');
    },
  };
}

test('invalid ref returns null without calling the service', async () => {
  let called = 0;
  const read = async () => {
    called++;
    return b64(PNG);
  };
  for (const ref of ['', 'A'.repeat(64), 'a'.repeat(63), '../x', 5, null]) {
    assert.equal(await readAttachmentThumbnail(ref, read, undecodable), null);
  }
  assert.equal(called, 0);
});

test('service null returns null', async () => {
  assert.equal(await readAttachmentThumbnail(REF, async () => null, undecodable), null);
});

test('decodable image is resized to a 320px JPEG data URL', async () => {
  const calls = {};
  const url = await readAttachmentThumbnail(
    REF,
    async () => b64(PNG),
    () => fakeImage(1280, 640, calls)
  );
  assert.equal(url, `data:image/jpeg;base64,${Buffer.from('jpeg').toString('base64')}`);
  assert.deepEqual([calls.resize.width, calls.resize.height], [320, 160]);
  assert.equal(calls.quality, 82);
});

test('small decodable image is not upscaled', async () => {
  const calls = {};
  await readAttachmentThumbnail(
    REF,
    async () => b64(PNG),
    () => fakeImage(100, 50, calls)
  );
  assert.equal(calls.resize, undefined);
});

test('undecodable small PNG/GIF/WebP returns the original data URL', async () => {
  for (const [bytes, mime] of [
    [PNG, 'image/png'],
    [GIF, 'image/gif'],
    [WEBP, 'image/webp'],
  ]) {
    assert.equal(
      await readAttachmentThumbnail(REF, async () => b64(bytes), undecodable),
      `data:${mime};base64,${b64(bytes)}`
    );
  }
});

test('without a decoder the original is returned up to the given bound', async () => {
  const large = [...PNG, ...new Array(600 * 1024).fill(0)];
  assert.equal(await readAttachmentThumbnail(REF, async () => b64(large), null), null);
  assert.equal(
    await readAttachmentThumbnail(REF, async () => b64(large), null, 1024 * 1024),
    `data:image/png;base64,${b64(large)}`
  );
});

test('undecodable oversized or non-image data returns null', async () => {
  const big = [...PNG, ...new Array(512 * 1024).fill(0)];
  assert.equal(await readAttachmentThumbnail(REF, async () => b64(big), undecodable), null);
  assert.equal(await readAttachmentThumbnail(REF, async () => b64([1, 2, 3, 4]), undecodable), null);
});
