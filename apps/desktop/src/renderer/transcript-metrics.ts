// Session-lifetime preview cache for submitted image attachments. Transcript
// items carry byte-free metadata only (snapshot hygiene); the composer
// registers the data URL at submit time so the current window can render real
// thumbnails. After a restart the chip falls back to an icon + filename.
import { enforceRendererCacheBudget, registerBudgetedCache } from "./renderer-cache-budget";

const MAX_IMAGE_PREVIEW_CACHE = 24;
export const IMAGE_PREVIEW_CACHE_MAX_CHARS = 32 * 1024 * 1024;
export const imagePreviewCache = new Map<string, string>();

function retainedPreviewChars(): number {
  let total = 0;
  for (const value of imagePreviewCache.values()) total += value.length;
  return total;
}

function trimPreviewsTo(targetChars: number): void {
  while (retainedPreviewChars() > targetChars) {
    const oldest = imagePreviewCache.keys().next().value;
    if (oldest === undefined) break;
    imagePreviewCache.delete(oldest);
  }
}

// Data URLs are the single heaviest thing the renderer holds, so this cache is
// the shared budget's usual first target. It is deliberately NOT an idle-reclaim
// task: these bytes cannot be rebuilt from what is on screen (dropping one
// falls the chip back to an icon), so only real memory pressure may evict them.
registerBudgetedCache({
  name: "image-preview",
  chars: retainedPreviewChars,
  trim: trimPreviewsTo,
});

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
  trimPreviewsTo(IMAGE_PREVIEW_CACHE_MAX_CHARS);
  enforceRendererCacheBudget();
}

export function _resetImagePreviewCacheForTest() {
  imagePreviewCache.clear();
}
