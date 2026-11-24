import { type CSSProperties, type RefObject, useLayoutEffect, useRef, useState } from 'react';
import { registerIdleReclaim } from './idle-reclaim';
import { onSessionPreviewsDeleted, previewKey } from './image-preview-store';
import { subscribeMediaSession } from './remote-file-preview';

const PICTURE_BOX_LIMIT = 512;
const pictureBoxes = new Map<string, { session: string; width: number; height: number }>();

onSessionPreviewsDeleted((session) => {
  for (const [key, box] of pictureBoxes) if (box.session === session) pictureBoxes.delete(key);
});
registerIdleReclaim(() => pictureBoxes.clear());
subscribeMediaSession(() => pictureBoxes.clear());

function rememberPictureBox(key: string, session: string, picture: HTMLImageElement): void {
  const { offsetWidth: width, offsetHeight: height } = picture;
  // A hidden pane lays nothing out.
  if (width <= 0 || height <= 0) return;
  pictureBoxes.delete(key);
  pictureBoxes.set(key, { session, width, height });
  while (pictureBoxes.size > PICTURE_BOX_LIMIT) pictureBoxes.delete(pictureBoxes.keys().next().value as string);
}

export interface PictureHold {
  /** The held box, for whatever stands where the picture goes; undefined while nothing is held. */
  style: CSSProperties | undefined;
  /** The `<img>` showing `shown`. */
  ref: RefObject<HTMLImageElement | null>;
  /** That `<img>`'s load handler. */
  onLoad(): void;
}

/** A local image's box across its mounts, by conversation (`session`, '' for none) and `line` (the view and file).
 *  Mounted again (its row scrolled back into view, its conversation or document shown again), the image holds the box
 *  of what it last showed until that has loaded again, so the row keeps its height instead of shrinking to the
 *  loading box and growing back. The box is what the last settled lookup showed: a picture's own box once it loaded
 *  (a kept copy's included), nothing when the image shows no picture. A box, never a URL: a preview URL dies with its
 *  owner's token or blob.
 *  `settled`: the lookup has answered. `shown`: the picture shown, '' for none. */
export function usePictureHold(session: string, line: string, settled: boolean, shown: string): PictureHold {
  const key = previewKey(session, line);
  const [loaded, setLoaded] = useState('');
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    if (!settled) return;
    if (!shown) pictureBoxes.delete(key);
    else if (loaded === shown && ref.current) rememberPictureBox(key, session, ref.current);
  }, [key, session, settled, shown, loaded]);
  const box = pictureBoxes.get(key);
  return {
    style: box && (!settled || loaded !== shown) ? { width: box.width, height: box.height } : undefined,
    ref,
    onLoad: () => setLoaded(shown),
  };
}
