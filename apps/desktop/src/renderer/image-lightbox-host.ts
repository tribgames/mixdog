// The in-app image viewer for callers outside a React tree (the attachment
// "open image" bridge of a paired browser, a chip that has no editor pane to
// open into). This module stays free of the viewer itself so the remote shim
// can call it without bundling the app UI: image-lightbox.tsx registers the
// opener when the app loads it.
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
