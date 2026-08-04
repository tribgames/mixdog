// Session-lifetime preview cache for submitted image attachments. Transcript
// items carry byte-free metadata only (snapshot hygiene); the composer
// registers the data URL at submit time so the current window can render real
// thumbnails. After a restart the chip falls back to an icon + filename.
const MAX_IMAGE_PREVIEW_CACHE = 24;
export const imagePreviewCache = new Map<string, string>();
export function imagePreviewKey(id: number | null | undefined, bytes: number | undefined): string {
  return `${id ?? 'x'}:${bytes ?? 0}`;
}
export function registerImagePreview(id: number, bytes: number, dataUrl: string) {
  const key = imagePreviewKey(id, bytes);
  imagePreviewCache.delete(key);
  imagePreviewCache.set(key, dataUrl);
  while (imagePreviewCache.size > MAX_IMAGE_PREVIEW_CACHE) {
    const oldest = imagePreviewCache.keys().next().value;
    if (oldest === undefined) break;
    imagePreviewCache.delete(oldest);
  }
}
