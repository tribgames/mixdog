import {
  ChevronLeft,
  ChevronRight,
  Download,
  ExternalLink,
  Maximize2,
  Minimize2,
  PanelTop,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { showDesktopToast } from './desktop-toasts';
import { setImageLightboxOpener } from './image-lightbox-host';
import { fileDownloadFailureMessage, saveUrlOnDevice } from './file-download-transfer';
import { t } from './i18n';
import { DownloadSessionContext, startProjectFileDownload } from './project-file-download';
import { isRemoteHostRenderer } from './remote-ui-projection';
import type { ResolvedLocalLink } from './local-link-resolver';
import { MarkdownOpenFileContext, MarkdownSessionContext } from './MarkdownLink';
import { useMobileBack } from './mobile-back';
import { watchTouchZoom } from './touch-zoom';
import type { ZoomPoint } from './zoom-target';

export interface LightboxItem {
  id: string;
  src: string;
  name: string;
  /** Project file behind the image, when there is one ("Open in tab"). */
  target?: ResolvedLocalLink | null;
  /** The item's existing open-in-OS path ("Open in default app"). */
  openDefault?: () => void;
}

interface RegisteredImage {
  element: HTMLElement;
  read: () => LightboxItem | null;
}

// Images of one message navigate together: the registry groups every mounted
// image by its message (or artifact strip) element.
const DOCUMENT_POSITION_FOLLOWING = 4; // Node.DOCUMENT_POSITION_FOLLOWING
const registry = new WeakMap<Element, Set<RegisteredImage>>();

function groupRoot(element: HTMLElement): Element {
  return element.closest('.message, .transcript-artifacts') ?? element.ownerDocument.body;
}

/** Makes an image available to its message's lightbox navigation. */
export function useLightboxRegistration(ref: RefObject<HTMLElement | null>, item: LightboxItem | null): void {
  const latest = useRef(item);
  latest.current = item;
  const enabled = item !== null;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!enabled || !element) return;
    const root = groupRoot(element);
    const entry: RegisteredImage = { element, read: () => latest.current };
    const group = registry.get(root) ?? new Set<RegisteredImage>();
    group.add(entry);
    registry.set(root, group);
    return () => {
      group.delete(entry);
    };
  }, [ref, enabled]);
}

/** The images that share a message with `element`, in document order. */
export function lightboxItemsFor(element: HTMLElement): LightboxItem[] {
  const group = registry.get(groupRoot(element));
  if (!group) return [];
  return [...group]
    .sort((a, b) => (a.element.compareDocumentPosition(b.element) & DOCUMENT_POSITION_FOLLOWING ? -1 : 1))
    .flatMap((entry) => entry.read() ?? []);
}

/** How the viewer saves `item`: `device` on a paired device (the host's file,
 *  or the bytes shown, go to this device and its share sheet), `dialog` on the
 *  desktop where the OS save dialog can take the URL, else not at all. */
function lightboxSaveMode(item: Pick<LightboxItem, 'src' | 'target'>): 'device' | 'dialog' | null {
  if (isRemoteHostRenderer()) return 'device';
  return window.mixdogDesktop?.saveFileAs && /^(?:data|https?):/i.test(item.src) ? 'dialog' : null;
}

/** Runs the save of `lightboxSaveMode`, reporting a failure as a toast. */
function saveLightboxItem(sessionId: string, item: Pick<LightboxItem, 'src' | 'name' | 'target'>): void {
  const run = async () => {
    if (lightboxSaveMode(item) === 'dialog') {
      await window.mixdogDesktop!.saveFileAs!(item.src, item.name);
    } else if (item.target) {
      const { project, path, accessToken } = item.target;
      await startProjectFileDownload(sessionId, path, item.name, accessToken ? project : undefined);
    } else {
      await saveUrlOnDevice(item.src, item.name);
    }
  };
  void run().catch((error: unknown) => showDesktopToast(fileDownloadFailureMessage(error), 'error'));
}

// One viewer mounted on demand for callers outside a React tree.
setImageLightboxOpener(async (item) => {
  const { createRoot } = await import('react-dom/client');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(<ImageLightbox items={[{ ...item, id: 'attachment' }]} startId="attachment" onClose={close} />);
});

const MIN_SCALE = 0.25;
const MAX_SCALE = 16;
const ZOOM_STEP = 1.25;
const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value));
const RESET_VIEW = { scale: 1, x: 0, y: 0 };
type LightboxView = typeof RESET_VIEW;

/** The viewer's stage as touch sees it: its centre (where the fitted image
 *  is centred) in window px, its size, the fitted image's size, and the scale
 *  that shows the image at its original resolution. */
export interface LightboxStage {
  center: ZoomPoint;
  width: number;
  height: number;
  imageWidth: number;
  imageHeight: number;
  actual: number;
}

/** `view` zoomed by `ratio` about window point `at`, then moved by (dx, dy).
 *  Touch keeps the scale between fit (1) and the original resolution, and the
 *  image over the stage: an axis it does not overflow stays centred. */
function touchLightboxView(
  view: LightboxView,
  stage: LightboxStage,
  ratio: number,
  at: ZoomPoint,
  dx = 0,
  dy = 0
): LightboxView {
  const scale = Math.min(Math.max(1, stage.actual), Math.max(1, view.scale * ratio));
  const applied = scale / view.scale;
  // Translation is applied about the image's centre: keep the image point
  // under `at` there.
  const x = (at.x - stage.center.x) * (1 - applied) + applied * view.x + dx;
  const y = (at.y - stage.center.y) * (1 - applied) + applied * view.y + dy;
  const limitX = Math.max(0, (stage.imageWidth * scale - stage.width) / 2);
  const limitY = Math.max(0, (stage.imageHeight * scale - stage.height) / 2);
  return {
    scale,
    x: Math.min(limitX, Math.max(-limitX, x)),
    y: Math.min(limitY, Math.max(-limitY, y)),
  };
}

/** Modal image viewer: zoom, pan, previous/next, and open actions. */
export function ImageLightbox({
  items,
  startId,
  onClose,
}: {
  items: readonly LightboxItem[];
  startId: string;
  onClose: () => void;
}) {
  const openFile = useContext(MarkdownOpenFileContext);
  const transcriptSession = useContext(MarkdownSessionContext);
  const paneSession = useContext(DownloadSessionContext);
  const sessionId = transcriptSession || paneSession;
  const dialog = useRef<HTMLDialogElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const image = useRef<HTMLImageElement>(null);
  const drag = useRef<{ x: number; y: number; originX: number; originY: number } | null>(null);
  const [index, setIndex] = useState(() =>
    Math.max(
      0,
      items.findIndex((item) => item.id === startId)
    )
  );
  const [view, setView] = useState(RESET_VIEW);
  const item = items[Math.min(index, items.length - 1)];
  const zoomed = view.scale !== 1;
  const target = item.target;

  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  const zoomBy = (factor: number) =>
    setView((current) => {
      const scale = clampScale(current.scale * factor);
      return scale <= 1 ? { scale, x: 0, y: 0 } : { ...current, scale };
    });
  const go = (step: number) => {
    setIndex((current) => (current + step + items.length) % items.length);
    setView(RESET_VIEW);
  };
  // Wheel zoom needs a non-passive listener to keep the page from zooming.
  // biome-ignore lint/correctness/useExhaustiveDependencies: zoomBy is recreated every render and only calls the stable setView; one listener serves the dialog's life.
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      zoomBy(event.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP);
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);
  /** The scale that shows the image at its original resolution: touch's
   *  maximum, however large; the toolbar's 1:1 keeps the desktop range. */
  const naturalScale = () => (image.current?.naturalWidth ?? 0) / (image.current?.offsetWidth || 1) || 1;
  const actualScale = () => clampScale(naturalScale());
  // Touch (touch-zoom.ts): two fingers pinch and pan, one finger pans a
  // zoomed image, a double tap goes between fit and the original resolution.
  // biome-ignore lint/correctness/useExhaustiveDependencies: naturalScale reads refs only; one watcher serves the dialog's life.
  useEffect(() => {
    const element = stage.current;
    if (!element) return undefined;
    const measure = (): LightboxStage => {
      const box = element.getBoundingClientRect();
      return {
        center: { x: box.left + box.width / 2, y: box.top + box.height / 2 },
        width: element.clientWidth,
        height: element.clientHeight,
        imageWidth: image.current?.offsetWidth ?? 0,
        imageHeight: image.current?.offsetHeight ?? 0,
        actual: naturalScale(),
      };
    };
    return watchTouchZoom(element, {
      pinch: (ratio, at) => {
        const geometry = measure();
        setView((current) => touchLightboxView(current, geometry, ratio, at));
      },
      pan: (dx, dy) => {
        const geometry = measure();
        setView((current) => touchLightboxView(current, geometry, 1, geometry.center, dx, dy));
      },
      doubleTap: (at) => {
        const geometry = measure();
        setView((current) =>
          current.scale === 1 ? touchLightboxView(RESET_VIEW, geometry, geometry.actual, at) : RESET_VIEW
        );
      },
    });
  }, []);
  const toggleActualSize = () => setView(zoomed ? RESET_VIEW : { scale: actualScale(), x: 0, y: 0 });
  const close = () => dialog.current?.close();
  useMobileBack(true, close);
  const button = (label: string, icon: ReactNode, onClick: () => void, extra: { disabled?: boolean } = {}) => (
    <button type="button" className="icon-button" aria-label={label} data-tooltip={label} onClick={onClick} {...extra}>
      {icon}
    </button>
  );

  return createPortal(
    <dialog
      ref={dialog}
      className="transcript-artifact-preview image-lightbox"
      aria-label={item.name}
      // Its drags pan the image; the phone's drawers stay put behind it.
      data-no-edge-swipe=""
      onClose={onClose}
      onClick={(event) => {
        event.stopPropagation();
        if (event.target === event.currentTarget) close();
      }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' && items.length > 1) go(-1);
        else if (event.key === 'ArrowRight' && items.length > 1) go(1);
        else if (event.key === '+' || event.key === '=') zoomBy(ZOOM_STEP);
        else if (event.key === '-') zoomBy(1 / ZOOM_STEP);
        else if (event.key === '0') setView(RESET_VIEW);
        else return;
        event.preventDefault();
      }}
    >
      <div className="image-lightbox-toolbar">
        <span className="image-lightbox-title" title={item.name}>
          {item.name}
        </span>
        {items.length > 1 && <span className="image-lightbox-count">{`${index + 1} / ${items.length}`}</span>}
        {button(t('Zoom out'), <ZoomOut size={16} aria-hidden="true" />, () => zoomBy(1 / ZOOM_STEP))}
        {button(t('Zoom in'), <ZoomIn size={16} aria-hidden="true" />, () => zoomBy(ZOOM_STEP))}
        {button(
          zoomed ? t('Fit to window') : t('Actual size'),
          zoomed ? <Minimize2 size={16} aria-hidden="true" /> : <Maximize2 size={16} aria-hidden="true" />,
          toggleActualSize
        )}
        {target &&
          openFile &&
          button(t('Open in tab'), <PanelTop size={16} aria-hidden="true" />, () => {
            const { project, path, accessToken } = target;
            if (accessToken) openFile(project, path, undefined, accessToken);
            else openFile(project, path);
            close();
          })}
        {item.openDefault &&
          button(t('Open in default app'), <ExternalLink size={16} aria-hidden="true" />, item.openDefault)}
        {lightboxSaveMode(item) &&
          button(
            lightboxSaveMode(item) === 'device' ? t('Download / Share') : t('Save as'),
            <Download size={16} aria-hidden="true" />,
            () => saveLightboxItem(sessionId, item)
          )}
        {button(t('Close preview'), <X size={16} aria-hidden="true" />, close)}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: pointer pan/zoom surface; keyboard zoom and navigation are handled by the dialog's onKeyDown. */}
      <div
        ref={stage}
        className="image-lightbox-stage"
        data-zoomed={zoomed ? 'true' : undefined}
        onDoubleClick={() => setView(RESET_VIEW)}
        onPointerDown={(event) => {
          // A finger's drag is touch-zoom's.
          if (!zoomed || event.pointerType === 'touch') return;
          drag.current = { x: event.clientX, y: event.clientY, originX: view.x, originY: view.y };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          setView((current) => ({
            ...current,
            x: start.originX + event.clientX - start.x,
            y: start.originY + event.clientY - start.y,
          }));
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        {items.length > 1 && (
          <>
            <span className="image-lightbox-nav previous">
              {button(t('Previous image'), <ChevronLeft size={20} aria-hidden="true" />, () => go(-1))}
            </span>
            <span className="image-lightbox-nav next">
              {button(t('Next image'), <ChevronRight size={20} aria-hidden="true" />, () => go(1))}
            </span>
          </>
        )}
        <img
          key={item.id}
          ref={image}
          src={item.src}
          alt={item.name}
          draggable={false}
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
        />
      </div>
    </dialog>,
    document.body
  );
}
