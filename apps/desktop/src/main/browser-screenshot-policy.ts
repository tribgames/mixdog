export type BrowserScreenshotFormat = 'jpeg' | 'png';

export interface BrowserScreenshotOptions {
  format: BrowserScreenshotFormat;
  quality: number;
  fullPage: boolean;
}

export interface BrowserScreenshotRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_QUALITY = 75;
const MAX_FULL_PAGE_DIMENSION = 32_768;
const MAX_FULL_PAGE_PIXELS = 24_000_000;
const MAX_SCREENSHOT_BYTES = 100 * 1024 * 1024;

export function browserScreenshotBytesFitBudget(bytes: number): boolean {
  return Number.isFinite(bytes) && bytes > 0 && bytes <= MAX_SCREENSHOT_BYTES;
}

export function normalizeScreenshotOptions(input: {
  format?: unknown;
  quality?: unknown;
  fullPage?: unknown;
}): BrowserScreenshotOptions {
  const format = String(input.format || 'jpeg').trim().toLowerCase();
  if (format !== 'jpeg' && format !== 'png') {
    throw new Error('snapshot format must be jpeg or png');
  }
  if (format === 'png' && input.quality !== undefined) {
    throw new Error('snapshot quality is supported only with format=jpeg');
  }
  const rawQuality = input.quality === undefined ? DEFAULT_QUALITY : Number(input.quality);
  if (!Number.isFinite(rawQuality) || rawQuality < 0 || rawQuality > 100) {
    throw new Error('snapshot quality must be between 0 and 100');
  }
  return {
    format,
    quality: Math.round(rawQuality),
    fullPage: input.fullPage === true,
  };
}

export function boundedFullPageRect(contentSize: {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}): BrowserScreenshotRect {
  const x = Math.max(0, Math.floor(Number(contentSize.x) || 0));
  const y = Math.max(0, Math.floor(Number(contentSize.y) || 0));
  const width = Math.ceil(Number(contentSize.width) || 0);
  const height = Math.ceil(Number(contentSize.height) || 0);
  if (width < 1 || height < 1) throw new Error('full-page screenshot has no measurable content');
  if (width > MAX_FULL_PAGE_DIMENSION
    || height > MAX_FULL_PAGE_DIMENSION
    || width * height > MAX_FULL_PAGE_PIXELS) {
    throw new Error(
      `full-page screenshot is too large (${width}x${height}); limit is `
      + `${MAX_FULL_PAGE_DIMENSION}px per side and ${MAX_FULL_PAGE_PIXELS.toLocaleString()} pixels`,
    );
  }
  return { x, y, width, height };
}

export function scaledScreenshotRect(
  rect: BrowserScreenshotRect,
  scale: number,
): BrowserScreenshotRect {
  return {
    x: Math.floor(rect.x * scale),
    y: Math.floor(rect.y * scale),
    width: Math.ceil(rect.width * scale),
    height: Math.ceil(rect.height * scale),
  };
}

export function assertFullPageOutputBounds(
  rect: BrowserScreenshotRect,
  scale: number,
): void {
  boundedFullPageRect(scaledScreenshotRect(rect, scale));
}
