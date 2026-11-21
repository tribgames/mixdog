import { RendererLruCache } from './renderer-lru-cache';

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
