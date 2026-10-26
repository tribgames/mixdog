import type { WebContents } from 'electron';

import type { BrowserGuestCdp } from './cdp';
import type { RemoteStream, ScreencastRun } from './remote-stream';

/** Guest events that change what a frame reports; each triggers an immediate check. */
const PAGE_EVENTS = [
  'did-navigate',
  'did-navigate-in-page',
  'page-title-updated',
  'did-start-loading',
  'did-stop-loading',
  'zoom-changed',
] as const;
export const STREAM_JPEG_QUALITY = 50;
/** A static page may never repaint; the first frame is then captured directly. */
const STREAM_FIRST_FRAME_MS = 300;

interface ScreencastTarget {
  guest: WebContents;
  port: Electron.Debugger;
  documentId: string;
  size: string;
}

interface ScreencastHandlers {
  /** A page event that may change what a frame reports. */
  onPageEvent(): void;
  /** The screencast delivered an image of the run's page. */
  onImage(run: ScreencastRun, data: string, viewport: { width: number; height: number }): void;
  /** No frame arrived in time; capture one directly. */
  onFirstFrameDue(run: ScreencastRun): void;
}

/** Detach the stream's run and stop its screencast. */
export async function stopRun(cdp: Pick<BrowserGuestCdp, 'call'>, stream: Pick<RemoteStream, 'run'>): Promise<void> {
  const run = stream.run;
  if (!run) return;
  stream.run = null;
  if (run.firstFrameTimer) clearTimeout(run.firstFrameTimer);
  run.port.removeListener('message', run.listener);
  run.detachGuest();
  // The guest may already be gone; stopping its screencast is then moot.
  if (!run.guest.isDestroyed()) await cdp.call(run.guest, 'Page.stopScreencast').catch(() => undefined);
}

/** The page's visible viewport at its own device pixels (no clip, so no
 *  emulation override and nothing the PC pane could see flicker). */
export async function captureViewportScreenshot(cdp: Pick<BrowserGuestCdp, 'call'>, guest: WebContents) {
  const shot = await cdp.call<{ data?: string }>(guest, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: STREAM_JPEG_QUALITY,
  });
  return shot.data ?? '';
}

/** Capture the run's first image directly, for a page that never repaints.
 *  `queue` receives the image and the CSS viewport it depicts. */
export async function captureFirstFrame(
  cdp: Pick<BrowserGuestCdp, 'call'>,
  stream: Pick<RemoteStream, 'run' | 'options'>,
  run: ScreencastRun,
  queue: (data: string, viewport: { width: number; height: number }) => void
): Promise<void> {
  if (stream.run !== run || run.view) return;
  const metrics = await cdp.call<{ cssVisualViewport?: { clientWidth: number; clientHeight: number } }>(
    run.guest,
    'Page.getLayoutMetrics'
  );
  const viewport = metrics.cssVisualViewport;
  if (!viewport?.clientWidth || !viewport.clientHeight) return;
  const scale = Math.min(
    1,
    stream.options.maxWidth / viewport.clientWidth,
    stream.options.maxHeight / viewport.clientHeight
  );
  const shot = await cdp.call<{ data: string }>(run.guest, 'Page.captureScreenshot', {
    format: 'jpeg',
    quality: STREAM_JPEG_QUALITY,
    clip: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight, scale },
  });
  if (run.view) return;
  queue(shot.data, { width: viewport.clientWidth, height: viewport.clientHeight });
}

/** Whether `run` already is the screencast of this page, document and size. */
export function runMatches(run: ScreencastRun | null, target: ScreencastTarget): boolean {
  return (
    !!run &&
    run.guest === target.guest &&
    run.port === target.port &&
    run.documentId === target.documentId &&
    run.size === target.size
  );
}

/** Begin the screencast of `target` as the stream's run. */
export async function startScreencastRun(
  cdp: Pick<BrowserGuestCdp, 'call'>,
  stream: Pick<RemoteStream, 'run' | 'options'>,
  target: ScreencastTarget,
  handlers: ScreencastHandlers
): Promise<void> {
  const { guest, port, documentId, size } = target;
  const run: ScreencastRun = {
    guest,
    port,
    documentId,
    size,
    view: null,
    shooting: false,
    dirty: false,
    detachGuest: () => {
      for (const name of PAGE_EVENTS) (guest as NodeJS.EventEmitter).removeListener(name, handlers.onPageEvent);
    },
    firstFrameTimer: null,
    listener: (_event, method, params, cdpSession) => {
      if (cdpSession || method !== 'Page.screencastFrame' || stream.run !== run) return;
      // Acked at once: Chromium sends no further frame until this one is.
      // A failed ack only means the guest is going away.
      void cdp.call(guest, 'Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => undefined);
      const metadata = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
      const data = String(params.data ?? '');
      if (!data) return;
      handlers.onImage(run, data, {
        width: metadata.deviceWidth || 0,
        height: metadata.deviceHeight || 0,
      });
    },
  };
  stream.run = run;
  port.on('message', run.listener);
  for (const name of PAGE_EVENTS) (guest as NodeJS.EventEmitter).on(name, handlers.onPageEvent);
  try {
    await cdp.call(guest, 'Page.startScreencast', {
      format: 'jpeg',
      quality: STREAM_JPEG_QUALITY,
      // The bound the stream started with: renewals never restart the capture.
      maxWidth: stream.options.maxWidth,
      maxHeight: stream.options.maxHeight,
    });
  } catch (error) {
    if (stream.run === run) {
      stream.run = null;
      port.removeListener('message', run.listener);
      run.detachGuest();
    }
    throw error;
  }
  run.firstFrameTimer = setTimeout(() => {
    run.firstFrameTimer = null;
    handlers.onFirstFrameDue(run);
  }, STREAM_FIRST_FRAME_MS);
  run.firstFrameTimer.unref?.();
}
