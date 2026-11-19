import type { BrowserScreenshotOptions, BrowserScreenshotRect } from './screenshot-policy';
import { browserScreenshotBytesFitBudget } from './screenshot-policy';

export interface EncodedBrowserScreenshot {
  bytes: Buffer;
  /** The original wire encoding when Chromium has already supplied one. */
  base64?: string;
  width: number;
  height: number;
  mimeType: 'image/jpeg' | 'image/png';
  fullPage: boolean;
  /** The document box a full-page capture clipped, in CSS pixels. */
  pageRect?: BrowserScreenshotRect;
}

export type ScreenshotCropInput = EncodedBrowserScreenshot & { cropSource?: Electron.NativeImage };

export function screenshotWireImage({ mimeType, bytes, base64 }: EncodedBrowserScreenshot) {
  return { mimeType, data: base64 ?? bytes.toString('base64') };
}

/** Decode for validation, but retain Chromium's already encoded bytes. */
export function validatedScreenshot<T extends { getSize(): { width: number; height: number } }>(
  data: string,
  options: BrowserScreenshotOptions,
  decode: (bytes: Buffer) => T,
  retainCropSource = false
) {
  if (!data || !browserScreenshotBytesFitBudget(Math.floor((data.length * 3) / 4))) return null;
  const bytes = Buffer.from(data, 'base64');
  const isPng = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const isJpeg =
    bytes.length >= 4 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[bytes.length - 2] === 255 &&
    bytes[bytes.length - 1] === 217;
  if (options.format === 'png' ? !isPng : !isJpeg) return null;
  const image = decode(bytes);
  const { width, height } = image.getSize();
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) return null;
  return {
    bytes,
    base64: data,
    width,
    height,
    mimeType: options.format === 'png' ? ('image/png' as const) : ('image/jpeg' as const),
    fullPage: options.fullPage,
    ...(retainCropSource ? { cropSource: image } : {}),
  };
}
