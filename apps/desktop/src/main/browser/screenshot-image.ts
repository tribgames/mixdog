import type { BrowserScreenshotOptions } from './screenshot-policy';
import { browserScreenshotBytesFitBudget } from './screenshot-policy';

/** Decode for validation, but retain Chromium's already encoded bytes. */
export function validatedScreenshot(
  data: string,
  options: BrowserScreenshotOptions,
  decode: (bytes: Buffer) => { getSize(): { width: number; height: number } },
) {
  if (!data || !browserScreenshotBytesFitBudget(Math.floor(data.length * 3 / 4))) return null;
  const bytes = Buffer.from(data, 'base64');
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216
    && bytes[bytes.length - 2] === 255 && bytes[bytes.length - 1] === 217;
  if (options.format === 'png' ? !isPng : !isJpeg) return null;
  const { width, height } = decode(bytes).getSize();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  return {
    data, width, height,
    mimeType: options.format === 'png' ? 'image/png' as const : 'image/jpeg' as const,
    fullPage: options.fullPage,
  };
}
