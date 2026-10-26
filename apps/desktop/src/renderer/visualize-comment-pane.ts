// Where things are in a pane the Comment layer lies over: its page frame,
// picture and video, the picture as it is drawn now, the layer's own box,
// and the region pins on screen.
import { intersectRect, rectOfBox, rectToFractions, type VisualizeFeedbackRect } from '../shared/visualize-feedback';
import type { VisualizePin, VisualizeRegionTarget } from './visualize-feedback-store';

export type PaneMedia = HTMLImageElement | HTMLVideoElement;

const mediaSize = (element: PaneMedia) =>
  element instanceof HTMLVideoElement
    ? { width: element.videoWidth, height: element.videoHeight }
    : { width: element.naturalWidth, height: element.naturalHeight };

/** Where the picture of an image or video (drawn `object-fit: contain`,
 *  letterboxed) is now, in window CSS px, and its CSS px per picture pixel;
 *  null before its size is known. */
function mediaPicture(element: PaneMedia): { picture: VisualizeFeedbackRect; scale: number } | null {
  const { width, height } = mediaSize(element);
  const shown = rectOfBox(element.getBoundingClientRect());
  if (!width || !height || !shown.width || !shown.height) return null;
  const scale = Math.min(shown.width / width, shown.height / height);
  return {
    picture: {
      x: shown.x + (shown.width - width * scale) / 2,
      y: shown.y + (shown.height - height * scale) / 2,
      width: width * scale,
      height: height * scale,
    },
    scale,
  };
}

/** An area of the picture (its own pixels) where it is drawn now, in
 *  fractions of `frame` (window CSS px); null before its size is known. */
function mediaRegionRect(
  element: PaneMedia,
  area: VisualizeFeedbackRect,
  frame: VisualizeFeedbackRect
): VisualizeFeedbackRect | null {
  const shown = mediaPicture(element);
  if (!shown) return null;
  const { picture, scale } = shown;
  return rectToFractions(
    {
      x: picture.x + area.x * scale,
      y: picture.y + area.y * scale,
      width: area.width * scale,
      height: area.height * scale,
    },
    frame
  );
}

/** The part of `area` (window CSS px) over the picture of an image or video
 *  (drawn `object-fit: contain`), in the picture's own pixels. */
export function mediaArea(element: PaneMedia, area: VisualizeFeedbackRect): VisualizeFeedbackRect | null {
  const shown = mediaPicture(element);
  if (!shown) return null;
  const { picture, scale } = shown;
  const inside = intersectRect(area, picture);
  if (!inside) return null;
  return {
    x: Math.round((inside.x - picture.x) / scale),
    y: Math.round((inside.y - picture.y) / scale),
    width: Math.max(1, Math.round(inside.width / scale)),
    height: Math.max(1, Math.round(inside.height / scale)),
  };
}

export const paneFrame = (layer: HTMLElement | null): HTMLIFrameElement | null =>
  layer?.parentElement?.querySelector('iframe') ?? null;
/** The pane a layer lies over: its cell, else the layer's own container. */
export const paneCell = (layer: HTMLElement | null): HTMLElement | null =>
  layer?.closest<HTMLElement>('[data-visualize-pane]') ?? layer?.parentElement ?? null;
export const paneMedia = (layer: HTMLElement | null): PaneMedia | null =>
  layer?.parentElement?.querySelector<PaneMedia>('img, video') ?? null;
export const paneVideo = (layer: HTMLElement | null): HTMLVideoElement | null => {
  const media = paneMedia(layer);
  return media instanceof HTMLVideoElement ? media : null;
};

/** The layer's box (window CSS px); null while it is not laid out. */
export const layerBox = (layer: HTMLElement | null): VisualizeFeedbackRect | null => {
  const box = layer?.getBoundingClientRect();
  return box?.width && box.height ? rectOfBox(box) : null;
};

/** Where a region pin on an image or video is now (fractions of the layer):
 *  its picture-pixel area on the picture as laid out now; null for the
 *  others (and a pin made before the picture's size was known). */
export function liveRegion(
  layer: HTMLElement | null,
  cropsMedia: boolean,
  target: VisualizeRegionTarget
): VisualizeFeedbackRect | null {
  const element = cropsMedia && target.image ? paneMedia(layer) : null;
  const box = layerBox(layer);
  return element && box && target.image ? mediaRegionRect(element, target.image, box) : null;
}

export const fractionStyle = (rect: VisualizeFeedbackRect) => ({
  left: `${rect.x * 100}%`,
  top: `${rect.y * 100}%`,
  width: `${rect.width * 100}%`,
  height: `${rect.height * 100}%`,
});

export interface ShownRegion {
  n: number;
  pin: VisualizePin;
  target: VisualizeRegionTarget;
  rect: VisualizeFeedbackRect;
}

/** The topmost region pin under a point (window CSS px) of a laid-out layer. */
export function regionUnder(
  regions: readonly ShownRegion[],
  box: VisualizeFeedbackRect,
  clientX: number,
  clientY: number
): ShownRegion | undefined {
  const x = (clientX - box.x) / box.width;
  const y = (clientY - box.y) / box.height;
  return regions
    .filter(({ rect }) => x >= rect.x && x <= rect.x + rect.width && y >= rect.y && y <= rect.y + rect.height)
    .at(-1);
}
