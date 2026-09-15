import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { encodeBrowserDisplayPng } from './display-png.ts';

test('display PNG preserves RGB, premultiplied alpha, row order and native colour metadata', async () => {
  const profile = Buffer.from('89504e470d0a1a0a000000017352474200aece1ce90000000049454e44ae426082', 'hex');
  const bitmap = Buffer.from([
    30, 20, 10, 255, 0, 64, 128, 128,
    255, 0, 0, 255, 0, 0, 0, 0,
  ]);
  const png = await encodeBrowserDisplayPng({
    getScaleFactors: () => [1, 2],
    getSize: scale => { assert.equal(scale, 2); return { width: 2, height: 2 }; },
    toBitmap: options => { assert.equal(options.scaleFactor, 2); return bitmap; },
    crop: () => ({ toPNG: () => profile }),
  });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = new Map();
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)));
    chunks.set(type, data);
    offset += length + 12;
  }
  assert.deepEqual([...chunks.keys()], ['IHDR', 'sRGB', 'IDAT', 'IEND']);
  assert.deepEqual([...chunks.get('IHDR')], [0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  assert.deepEqual([...inflateSync(chunks.get('IDAT'))], [
    0, 10, 20, 30, 255, 255, 128, 0, 128,
    0, 0, 0, 255, 255, 0, 0, 0, 0,
  ]);
});

test('display PNG rejects excessive allocation and inconsistent bitmap geometry before compression', async () => {
  const source = {
    getScaleFactors: () => [1],
    getSize: () => ({ width: 100_000, height: 100_000 }),
    toBitmap: () => assert.fail('oversized image must not be copied'),
  };
  await assert.rejects(encodeBrowserDisplayPng(source), /too large/);
  await assert.rejects(encodeBrowserDisplayPng({
    ...source, getSize: () => ({ width: 1, height: 1 }), toBitmap: () => Buffer.alloc(3),
  }), /dimensions changed/);
});
