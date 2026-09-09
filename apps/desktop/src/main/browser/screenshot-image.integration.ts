import assert from 'node:assert/strict';
import { nativeImage } from 'electron';
import { validatedScreenshot } from './screenshot-image';
import { normalizeScreenshotOptions } from './screenshot-policy';

export function measureScreenshotReuse(data: string) {
  const options = normalizeScreenshotOptions({ format: 'jpeg', quality: 60, fullPage: true });
  const decode = (bytes: Buffer) => nativeImage.createFromBuffer(bytes);
  const before: number[] = [];
  const after: number[] = [];
  for (let index = 0; index < 5; index++) {
    let start = performance.now();
    const reencoded = decode(Buffer.from(data, 'base64')).toJPEG(60).toString('base64');
    before.push(performance.now() - start);
    assert.ok(reencoded.length);
    start = performance.now();
    const reused = validatedScreenshot(data, options, decode);
    after.push(performance.now() - start);
    assert.equal(reused?.data, data);
    assert.ok(reused.width > 0 && reused.height > 0);
  }
  const median = (samples: number[]) => samples.sort((a, b) => a - b)[2];
  // PNG and JPEG both keep the exact encoding, and a real decoder rejects
  // corrupt bytes even when their signatures look plausible.
  const png = decode(Buffer.from(data, 'base64')).toPNG().toString('base64');
  assert.equal(validatedScreenshot(png, normalizeScreenshotOptions({ format: 'png' }), decode)?.data, png);
  assert.equal(validatedScreenshot(Buffer.from([255, 216, 0, 255, 217]).toString('base64'), options, decode), null);
  return { reencodeMedianMs: median(before), reuseMedianMs: median(after) };
}
