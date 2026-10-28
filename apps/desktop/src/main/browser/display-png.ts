import type { NativeImage } from 'electron';
import { promisify } from 'node:util';
import { crc32, deflate } from 'node:zlib';
import { browserScreenshotBytesFitBudget } from './screenshot-policy';

const compress = promisify(deflate);
const signature = Buffer.from('89504e470d0a1a0a', 'hex');

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.allocUnsafe(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}

/** Electron's desktop bitmap is premultiplied BGRA, normalised to sRGB since
 * Electron 43 whatever the source's colour profile; the PNG is tagged sRGB to
 * match. Keep every pixel, alpha and HiDPI representation, but spend
 * compression CPU in libuv's pool rather than blocking the main input/IPC
 * thread. */
export async function encodeBrowserDisplayPng(image: NativeImage): Promise<Buffer> {
  const scaleFactor = Math.max(1, ...image.getScaleFactors());
  const { width, height } = image.getSize(scaleFactor);
  if (!width || !height) throw new Error('Browser display frame is not ready.');
  const stride = width * 4;
  const length = (stride + 1) * height;
  if (!browserScreenshotBytesFitBudget(length)) throw new Error('Browser display frame is too large.');
  const bitmap = image.toBitmap({ scaleFactor });
  if (bitmap.length !== stride * height) throw new Error('Browser display bitmap dimensions changed.');
  const rows = Buffer.allocUnsafe(length);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    rows[row] = 0; // PNG filter None: no expensive adaptive filter search.
    for (let x = 0; x < stride; x += 4) {
      const source = y * stride + x;
      const target = row + 1 + x;
      const alpha = bitmap[source + 3];
      if (alpha === 255) {
        rows[target] = bitmap[source + 2];
        rows[target + 1] = bitmap[source + 1];
        rows[target + 2] = bitmap[source];
      } else {
        const factor = alpha ? 255 / alpha : 0;
        rows[target] = Math.min(255, Math.round(bitmap[source + 2] * factor));
        rows[target + 1] = Math.min(255, Math.round(bitmap[source + 1] * factor));
        rows[target + 2] = Math.min(255, Math.round(bitmap[source] * factor));
      }
      rows[target + 3] = alpha;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6; // 8-bit RGBA, non-interlaced.
  const pixels = await compress(rows, { level: 1 });
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('sRGB', Buffer.from([0])), // Perceptual rendering intent.
    chunk('IDAT', pixels),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
