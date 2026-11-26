import { registerIdleReclaim } from './idle-reclaim';
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

/** The preview keys of each message this window sent, in the order its content carries the images: the order of the
 *  stored row's `imageRefs`, which hold no ids. */
const sentImageKeys = new RendererLruCache<string, readonly string[]>({
  name: 'image-preview-order',
  maxEntries: 48,
  maxChars: 48 * 1024,
  measure: (keys) => keys.reduce((sum, key) => sum + key.length, 0),
});

registerIdleReclaim(() => {
  imagePreviewCache.clear();
  sentImageKeys.clear();
});

/** Registers the pictures of a send, `images` in the order of its content. */
export function registerSentImages(
  submissionId: string,
  images: ReadonlyArray<{ id: number; bytes: number; dataUrl: string }>
) {
  if (images.length === 0) return;
  for (const image of images) registerImagePreview(submissionId, image.id, image.bytes, image.dataUrl);
  sentImageKeys.set(
    submissionId,
    images.map((image) => imagePreviewKey(submissionId, image.id, image.bytes))
  );
}

/** Where an image stands in the content of the message this window sent; undefined when it sent none such. */
export function sentImageSlot(
  submissionId: string,
  id: number | null | undefined,
  bytes: number | undefined
): number | undefined {
  const slot = sentImageKeys.peek(submissionId)?.indexOf(imagePreviewKey(submissionId, id, bytes)) ?? -1;
  return slot < 0 ? undefined : slot;
}

/** The picture of the image at `slot` of a sent message whose row shows `count` images. A row showing another count
 *  is not that send alone (a queued batch delivered as one turn): it gets none. */
export function sentImagePreview(submissionId: string, slot: number, count: number): string | undefined {
  const keys = sentImageKeys.peek(submissionId);
  return keys?.length === count ? imagePreviewCache.peek(keys[slot]) : undefined;
}
