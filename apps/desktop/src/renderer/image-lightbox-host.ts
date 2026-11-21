// Kept free of the viewer so the remote shim can call it without bundling the app UI; image-lightbox.tsx registers the opener.
import type { LightboxItem } from './image-lightbox';

type Opener = (item: Omit<LightboxItem, 'id'>) => Promise<void>;

let opener: Opener | null = null;

export function setImageLightboxOpener(next: Opener): void {
  opener = next;
}

/** Shows `item` in the lightbox; resolves once it is on screen. */
export async function openImageLightbox(item: Omit<LightboxItem, 'id'>): Promise<void> {
  if (!opener) throw new Error('The image viewer is unavailable.');
  await opener(item);
}
