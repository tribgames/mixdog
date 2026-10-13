// Session-lifetime preview cache for submitted image attachments. Transcript
// items carry byte-free metadata only (snapshot hygiene); the composer
// registers the data URL at submit time so the current window can render real
// thumbnails. After a restart the chip falls back to an icon + filename.
import { RendererLruCache } from './renderer-lru-cache';

// Data URLs are the single heaviest thing the renderer holds, so this cache is
// the shared budget's usual first target. It is deliberately NOT an idle-reclaim
// task: these bytes cannot be rebuilt from what is on screen (dropping one
// falls the chip back to an icon), so only real memory pressure may evict them.
export const imagePreviewCache = new RendererLruCache<string, string>({
  name: 'image-preview',
  maxEntries: 24,
  maxChars: 32 * 1024 * 1024,
  measure: (dataUrl) => dataUrl.length,
});

export function imagePreviewKey(
  submissionId: string,
  id: number | null | undefined,
  bytes: number | undefined
): string {
  return `${submissionId}|${id ?? 'x'}:${bytes ?? 0}`;
}
export function registerImagePreview(submissionId: string, id: number, bytes: number, dataUrl: string) {
  imagePreviewCache.set(imagePreviewKey(submissionId, id, bytes), dataUrl);
}
