// Zoom host for the editor previews: a positioned frame holding the one
// scroller (so the ZoomPill floats over it and never scrolls away) plus the
// pill.
//
// Two modes. "fit" (default) shows content at fitWidthScale of the viewport
// and refits whenever the viewport resizes; "fixed" is a scale the user
// picked (25%–400%) and keeps both that scale and the content point at the
// viewport centre across a resize. Wheel zoom anchors at the cursor, buttons
// and keys at the centre. The pill is hidden until the pointer nears the
// bottom edge, a zoom gesture runs, or the pill is hovered / focused / open.
// A mouse can drag-pan overflow, and (clickToggle) a click toggles fit ↔ 100%.
//
// The choice is remembered per `memoryKey` (a file in one surface) for as
// long as that file stays in use; another file starts at fit.
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
  type SyntheticEvent,
} from 'react';
import { flushSync } from 'react-dom';

import { t } from './i18n';
import { ZoomPill } from './ZoomPill';
import {
  SAME_SCALE,
  contentOrigin,
  useZoomPillVisibility,
  useZoomPointerGesture,
  useZoomViewport,
  useZoomWheelAndKeys,
  type ZoomLive,
} from './zoom-frame-hooks';
import {
  PREVIEW_ZOOM_PRESETS,
  PREVIEW_ZOOM_RANGE,
  anchoredScroll,
  clampZoom,
  fitContainScale,
  fitWidthScale,
  scaledSize,
  stepSnapped,
  type ZoomMode,
  type ZoomRange,
} from './zoom-range';

export interface ZoomViewport {
  width: number;
  height: number;
}

export interface ZoomRenderState {
  /** The resolved scale: the fit scale in fit mode, the picked one otherwise. */
  scale: number;
  mode: ZoomMode;
  viewport: ZoomViewport;
}

interface ZoomChoice {
  mode: ZoomMode;
  scale: number;
}

const MEMORY_LIMIT = 64;

const memory = new Map<string, ZoomChoice>();

function remember(key: string, choice: ZoomChoice) {
  memory.delete(key);
  memory.set(key, choice);
  if (memory.size > MEMORY_LIMIT) memory.delete(memory.keys().next().value as string);
}

/** Forget every remembered choice (a surface that closes its files). */
export function forgetZoomMemory(prefix = '') {
  for (const key of [...memory.keys()]) if (key.startsWith(prefix)) memory.delete(key);
}

interface PendingAnchor {
  /** Pointer offset inside the viewport. */
  px: number;
  py: number;
  /** Scroll position and content origin before the change. */
  left: number;
  top: number;
  origin: { x: number; y: number };
  ratio: number;
}

export function ZoomFrame({
  ready,
  intrinsicWidth,
  intrinsicHeight,
  inset = 0,
  range = PREVIEW_ZOOM_RANGE,
  scrollerClassName,
  scrollerRef,
  dataReady,
  memoryKey,
  clickToggle = false,
  children,
}: {
  /** The pill shows (and zoom works) only once the content has loaded. */
  ready: boolean;
  /** Content width at 100%; unknown keeps scale 1. */
  intrinsicWidth?: number;
  /** With a height too, fit is "contain" (the whole content shows, as an
   *  image does); without, fit is the viewport width (as a document does). */
  intrinsicHeight?: number;
  /** Horizontal room kept around fitted content. */
  inset?: number;
  range?: ZoomRange;
  scrollerClassName: string;
  scrollerRef?: RefObject<HTMLDivElement | null>;
  dataReady?: boolean;
  memoryKey?: string;
  /** Mouse click on an image toggles fit ↔ 100% (200% when 100% is fit). */
  clickToggle?: boolean;
  children(state: ZoomRenderState): ReactNode;
}) {
  const ownScrollerRef = useRef<HTMLDivElement | null>(null);
  const scroller = scrollerRef ?? ownScrollerRef;
  const frameRef = useRef<HTMLDivElement | null>(null);
  const [choice, setChoice] = useState<ZoomChoice>(
    () => (memoryKey && memory.get(memoryKey)) || { mode: 'fit', scale: 1 }
  );
  const { visible, hover, frameHandlers, flash, onPillActive } = useZoomPillVisibility();
  // Read by the input hooks without re-subscribing; refreshed below once this
  // render's scale is known.
  const live = useRef<ZoomLive>({ scale: 1, fit: 1, mode: choice.mode, ready });
  const centre = useRef<{ cx: number; cy: number } | null>(null);
  const viewport = useZoomViewport({ scroller, live, centre });

  const fit = intrinsicHeight
    ? fitContainScale(viewport.width, viewport.height, intrinsicWidth, intrinsicHeight)
    : fitWidthScale(viewport.width, intrinsicWidth, inset);
  const scale = choice.mode === 'fit' ? fit : choice.scale;
  live.current = { scale, fit, mode: choice.mode, ready };
  const pending = useRef<PendingAnchor | null>(null);

  /** Apply a choice, keeping the content point at (px, py) in the viewport
   *  fixed. Synchronous so a burst of wheel events chains correctly. */
  const apply = useCallback(
    (next: ZoomChoice, px?: number, py?: number) => {
      const node = scroller.current;
      const current = live.current;
      const nextScale = next.mode === 'fit' ? current.fit : next.scale;
      if (memoryKey) remember(memoryKey, next);
      if (node && Math.abs(nextScale - current.scale) > 1e-9) {
        const origin = contentOrigin(node);
        const x = px ?? node.clientWidth / 2;
        const y = py ?? node.clientHeight / 2;
        pending.current = {
          px: x,
          py: y,
          left: node.scrollLeft,
          top: node.scrollTop,
          origin,
          ratio: nextScale / current.scale,
        };
      } else {
        pending.current = null;
      }
      live.current = { ...current, scale: nextScale, mode: next.mode };
      flushSync(() => setChoice(next));
    },
    [memoryKey, scroller]
  );
  const setFixed = useCallback(
    (value: number, px?: number, py?: number) => apply({ mode: 'fixed', scale: clampZoom(value, range) }, px, py),
    [apply, range]
  );
  const setFit = useCallback((px?: number, py?: number) => apply({ mode: 'fit', scale: 1 }, px, py), [apply]);

  // Put the anchored content point back under the pointer once it has laid out.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scale is the deliberate trigger - this runs after each committed zoom change and reads the pending anchor from a ref.
  useLayoutEffect(() => {
    const node = scroller.current;
    const anchor = pending.current;
    pending.current = null;
    if (!node) return;
    const origin = contentOrigin(node);
    if (anchor) {
      node.scrollLeft = anchoredScroll(anchor.left, anchor.px, anchor.ratio, anchor.origin.x, origin.x);
      node.scrollTop = anchoredScroll(anchor.top, anchor.py, anchor.ratio, anchor.origin.y, origin.y);
    }
    // The scroll above may not fire a scroll event (clamped to the same spot).
    centre.current = {
      cx: node.scrollLeft + node.clientWidth / 2 - origin.x,
      cy: node.scrollTop + node.clientHeight / 2 - origin.y,
    };
  }, [scale, scroller]);

  useZoomWheelAndKeys({ scroller, frameRef, live, hover, range, setFixed, setFit, flash });
  const pointerGesture = useZoomPointerGesture({ clickToggle, live, setFixed, setFit });

  const fitLike = choice.mode === 'fit' || Math.abs(scale - fit) < SAME_SCALE;
  let dataZoomCursor: 'in' | 'out' | undefined;
  if (clickToggle && ready) dataZoomCursor = fitLike ? 'in' : 'out';
  let dataReadyAttr: 'true' | 'false' | undefined;
  if (dataReady !== undefined) dataReadyAttr = dataReady ? 'true' : 'false';

  return (
    <div className="editor-zoom-frame" ref={frameRef} tabIndex={-1} {...frameHandlers}>
      <div
        className={scrollerClassName}
        ref={scroller}
        data-ready={dataReadyAttr}
        data-zoom-mode={choice.mode}
        data-zoom-cursor={dataZoomCursor}
        {...pointerGesture}
      >
        {children({ scale, mode: choice.mode, viewport })}
      </div>
      {ready && (
        <ZoomPill
          level={scale}
          range={range}
          presets={PREVIEW_ZOOM_PRESETS}
          step={(current, direction) => stepSnapped(current, direction, range)}
          onChange={(next) => {
            setFixed(next);
            flash();
          }}
          lead={{
            label: t('Fit width'),
            checked: choice.mode === 'fit',
            onSelect: () => setFit(),
          }}
          visible={visible}
          onActiveChange={onPillActive}
        />
      )}
    </div>
  );
}

// An SVG without an intrinsic size reports 0×0.
const FALLBACK_NATURAL = { width: 800, height: 600 };
// Pixel-sharp rendering from here up, so enlarged pixels stay crisp.
const PIXELATED_FROM = 3;

/** Natural size of the image at `src`, known once it has loaded. The frame
 *  needs it as its intrinsic width, so it lives with the caller. */
export function useImageSize(src: string) {
  const [size, setSize] = useState<{ src: string; width: number; height: number } | null>(null);
  const natural = size && size.src === src ? size : null;
  const onNatural = useCallback(
    (event: SyntheticEvent<HTMLImageElement>) => {
      const { naturalWidth, naturalHeight } = event.currentTarget;
      const known = naturalWidth > 0 && naturalHeight > 0;
      setSize({
        src,
        width: known ? naturalWidth : FALLBACK_NATURAL.width,
        height: known ? naturalHeight : FALLBACK_NATURAL.height,
      });
    },
    [src]
  );
  return { natural, onNatural };
}

/** Image shown at its natural size times the resolved scale. Until the image
 *  has loaded it keeps the plain CSS fit. */
export function ZoomImage({
  src,
  alt,
  natural,
  scale,
  onNatural,
  onLoad,
  onError,
}: {
  src: string;
  alt: string;
  natural: { width: number; height: number } | null;
  scale: number;
  onNatural(event: SyntheticEvent<HTMLImageElement>): void;
  onLoad?(): void;
  onError?(): void;
}) {
  let style: CSSProperties | undefined;
  if (natural) {
    style = {
      width: scaledSize(natural.width, scale),
      height: scaledSize(natural.height, scale),
      maxWidth: 'none',
      maxHeight: 'none',
      flex: 'none',
      imageRendering: scale >= PIXELATED_FROM ? 'pixelated' : undefined,
    };
  }
  return (
    <img
      src={src}
      alt={alt}
      style={style}
      draggable={false}
      onLoad={(event) => {
        onNatural(event);
        onLoad?.();
      }}
      onError={onError}
    />
  );
}
