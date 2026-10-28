import assert from 'node:assert/strict';
import test from 'node:test';
import { crc32, inflateSync } from 'node:zlib';
import { encodeBrowserDisplayPng } from './display-png.ts';

test('display PNG preserves RGB, premultiplied alpha and row order, tagged sRGB like its pixels', async () => {
  // A wide-gamut source: its own PNG would carry a Display P3 ICC profile,
  // but toBitmap hands over sRGB-normalised pixels (Electron 43+).
  const iccp = Buffer.from('Display P3\0\0', 'latin1');
  const sourcePng = Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    Buffer.from([0, 0, 0, iccp.length]),
    Buffer.from('iCCP', 'ascii'),
    iccp,
    Buffer.alloc(4),
  ]);
  const bitmap = Buffer.from([30, 20, 10, 255, 0, 64, 128, 128, 255, 0, 0, 255, 0, 0, 0, 0]);
  const png = await encodeBrowserDisplayPng({
    getScaleFactors: () => [1, 2],
    getSize: (scale) => {
      assert.equal(scale, 2);
      return { width: 2, height: 2 };
    },
    toBitmap: (options) => {
      assert.equal(options.scaleFactor, 2);
      return bitmap;
    },
    toPNG: () => sourcePng,
    crop: () => ({ toPNG: () => sourcePng }),
  });
  assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const chunks = new Map();
  for (let offset = 8; offset < png.length; ) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    assert.equal(png.readUInt32BE(offset + 8 + length), crc32(png.subarray(offset + 4, offset + 8 + length)));
    chunks.set(type, data);
    offset += length + 12;
  }
  assert.deepEqual([...chunks.keys()], ['IHDR', 'sRGB', 'IDAT', 'IEND']);
  assert.deepEqual([...chunks.get('sRGB')], [0]);
  assert.deepEqual([...chunks.get('IHDR')], [0, 0, 0, 2, 0, 0, 0, 2, 8, 6, 0, 0, 0]);
  assert.deepEqual(
    [...inflateSync(chunks.get('IDAT'))],
    [0, 10, 20, 30, 255, 255, 128, 0, 128, 0, 0, 0, 255, 255, 0, 0, 0, 0]
  );
});

test('display PNG rejects excessive allocation and inconsistent bitmap geometry before compression', async () => {
  const source = {
    getScaleFactors: () => [1],
    getSize: () => ({ width: 100_000, height: 100_000 }),
    toBitmap: () => assert.fail('oversized image must not be copied'),
  };
  await assert.rejects(encodeBrowserDisplayPng(source), /too large/);
  await assert.rejects(
    encodeBrowserDisplayPng({
      ...source,
      getSize: () => ({ width: 1, height: 1 }),
      toBitmap: () => Buffer.alloc(3),
    }),
    /dimensions changed/
  );
});
