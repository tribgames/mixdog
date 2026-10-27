/**
 * What keeps a stream's frames true to its session's page: the page's facts
 * pushed as frames, and the screencast and driven viewport reconciled with the
 * session's current guest, document and size.
 */
import type { WebContents } from 'electron';

import type { DesktopRemoteBrowserStreamFrame } from '../../shared/contract';
import { browserDocumentId } from './guest-state';
import { buildFrame, frameSignature } from './remote-frame';
import { schedulePublish } from './remote-frame-publish';
import { lockRemoteGeometry, readRemotePagePixelRatio } from './remote-geometry';
import { jpegSize } from './remote-jpeg-size';
import { driveGuest } from './remote-guest-drive';
import {
  captureFirstFrame,
  captureViewportScreenshot,
  runMatches,
  startScreencastRun,
  stopRun,
} from './remote-screencast';
import {
  type BrowserRemoteControlHost,
  type PictureView,
  type RemoteStream,
  type ScreencastRun,
  sizeKey,
  viewportKey,
} from './remote-stream';

type StreamEngineHost = Pick<
  BrowserRemoteControlHost,
  | 'state'
  | 'cdp'
  | 'ensureGuest'
  | 'currentGuest'
  | 'tabs'
  | 'dialog'
  | 'publishFrame'
  | 'drive'
  | 'geometryChanged'
  | 'captured'
>;

const NO_PICTURE: PictureView = { size: { width: 0, height: 0 }, viewport: { width: 0, height: 0 } };

export function createRemoteStreamEngine(host: StreamEngineHost, streams: ReadonlyMap<string, RemoteStream>) {
  const { state, cdp, ensureGuest } = host;
  /** Geometry generations per session, monotonic across that session's streams. */
  const generations = new Map<string, number>();
  /** Streams re-reading their pixel ratio after the page re-laid out. */
  const relocking = new WeakSet<RemoteStream>();

  /** Lock the page as the screencast describes it (`css`) at the stream's
   *  pixel ratio, unless it already is: a new generation for the viewers. */
  function lock(sessionId: string, stream: RemoteStream, css: { width: number; height: number }): void {
    const ratio = stream.pixelRatio ?? 1;
    const current = stream.geometry?.geometry;
    if (
      current &&
      current.cssWidth === Math.round(css.width) &&
      current.cssHeight === Math.round(css.height) &&
      current.deviceScaleFactor === ratio
    ) {
      return;
    }
    const generation = (generations.get(sessionId) ?? 0) + 1;
    generations.set(sessionId, generation);
    stream.geometry = lockRemoteGeometry(
      { cssWidth: css.width, cssHeight: css.height, devicePixelRatio: ratio },
      stream.options,
      generation
    );
    host.geometryChanged?.(sessionId, stream.geometry.geometry);
  }

  /** The page's CSS size changed under the lock (a PC-side resize or zoom):
   *  read its pixel ratio again, then lock the new layout. */
  async function relock(
    sessionId: string,
    stream: RemoteStream,
    run: ScreencastRun,
    css: { width: number; height: number }
  ) {
    if (relocking.has(stream)) return;
    relocking.add(stream);
    try {
      stream.pixelRatio = (await readRemotePagePixelRatio(cdp, run.guest).catch(() => null)) ?? stream.pixelRatio;
      if (stream.run === run) lock(sessionId, stream, css);
    } finally {
      relocking.delete(stream);
    }
  }

  /** Screenshot capture of the run's page: one in flight, newest only. */
  async function shoot(
    sessionId: string,
    stream: RemoteStream,
    run: ScreencastRun,
    viewport: { width: number; height: number }
  ) {
    if (run.shooting) {
      run.dirty = true;
      return;
    }
    run.shooting = true;
    try {
      do {
        run.dirty = false;
        const data = await captureViewportScreenshot(cdp, run.guest);
        if (stream.run !== run || stream.geometry?.capture !== 'screenshot') return;
        if (data) queueImage(sessionId, stream, run, data, viewport);
      } while (run.dirty);
    } catch {
      // The page went away or refused the capture; the next repaint retries.
    } finally {
      run.shooting = false;
    }
  }

  /** A screencast frame: the picture itself, or — when the locked geometry
   *  captures at the page's device pixels — the signal that it repainted. */
  function onScreencastImage(
    sessionId: string,
    stream: RemoteStream,
    run: ScreencastRun,
    data: string,
    viewport: { width: number; height: number }
  ): void {
    if (stream.run !== run) return;
    if (viewport.width > 0 && viewport.height > 0) {
      const locked = stream.geometry?.geometry;
      if (!locked) lock(sessionId, stream, viewport);
      else if (locked.cssWidth !== Math.round(viewport.width) || locked.cssHeight !== Math.round(viewport.height)) {
        void relock(sessionId, stream, run, viewport);
      }
    }
    if (stream.geometry?.capture === 'screenshot') {
      void shoot(sessionId, stream, run, viewport);
      return;
    }
    queueImage(sessionId, stream, run, data, viewport);
  }

  /** Queue a frame of a page's document: its facts, and the picture `view`
   *  describes (0×0 for none) with `image` when one goes out with it. */
  function composeFrame(
    sessionId: string,
    stream: RemoteStream,
    guest: WebContents,
    documentId: string,
    view: PictureView,
    image: DesktopRemoteBrowserStreamFrame['image'],
    /** `view` is a picture of the capture run at the stream's current size. */
    current: boolean
  ): void {
    stream.signature = frameSignature(host, sessionId, guest, documentId, view);
    stream.seq += 1;
    const frame = buildFrame(host, sessionId, stream.seq, guest, documentId, view, image);
    if (stream.fitFailed) {
      // Definite: the fit asked for will not come; a take-over stops waiting.
      stream.pending = { ...frame, fitFailed: true };
    } else {
      // Settled: the layout was decided and, if it is a fit, the fit applied
      // to this very page and document (`driven`), pictured by the current run.
      const fitApplied =
        !stream.viewport ||
        (stream.driven?.guest === guest &&
          stream.driven.documentId === documentId &&
          stream.driven.key === viewportKey(stream.viewport));
      const settled = stream.layout !== 'undecided' && fitApplied && current && view.size.width > 0;
      stream.pending = settled ? { ...frame, fitSettled: true } : frame;
    }
    schedulePublish(stream, host.publishFrame);
  }

  /** Queue the run's image of its page. */
  function queueImage(
    sessionId: string,
    stream: RemoteStream,
    run: ScreencastRun,
    data: string,
    viewport: { width: number; height: number }
  ): void {
    const { guest } = run;
    if (stream.run !== run || guest.isDestroyed()) return;
    // A frame from before a navigation must not carry the new document's id.
    if (browserDocumentId(state, guest) !== run.documentId) return;
    run.view = { size: jpegSize(data) ?? viewport, viewport };
    composeFrame(
      sessionId,
      stream,
      guest,
      run.documentId,
      run.view,
      { mimeType: 'image/jpeg', data },
      run.size === sizeKey(stream)
    );
    const geometry = stream.geometry?.geometry;
    if (geometry) host.captured?.(sessionId, { documentId: run.documentId, geometry, mimeType: 'image/jpeg', data });
  }

  /** Push the session page's facts if they changed. This needs no screencast
   *  and no debugger: a dialog may hold back painting, even debugger
   *  initialization, until the client answers the card these facts carry.
   *  The picture described is the image the screencast of this page, this
   *  document and the current size has sent, or none (0×0) until it sends
   *  one, so the client maps no input through the image it still shows. */
  function publishFacts(sessionId: string, stream: RemoteStream): void {
    if (streams.get(sessionId) !== stream) return;
    const guest = host.currentGuest(sessionId);
    if (!guest || guest.isDestroyed()) return;
    const documentId = browserDocumentId(state, guest);
    const run = stream.run;
    const live = run?.guest === guest && run.documentId === documentId && run.size === sizeKey(stream);
    const view = (live && run.view) || NO_PICTURE;
    if (frameSignature(host, sessionId, guest, documentId, view) === stream.signature) return;
    // A metadata-only frame must not discard an image still waiting to go out.
    const waiting = live && stream.pending?.documentId === documentId ? stream.pending.image : undefined;
    composeFrame(sessionId, stream, guest, documentId, view, waiting, live);
  }

  /** Push the page's facts, then reconcile the screencast and push what that changed. */
  async function check(sessionId: string, stream: RemoteStream): Promise<void> {
    publishFacts(sessionId, stream);
    if (stream.checking) return;
    stream.checking = true;
    try {
      await reconcile(sessionId, stream);
      publishFacts(sessionId, stream);
    } finally {
      stream.checking = false;
    }
  }

  /** Make the screencast match the session's current guest, document and size. */
  async function sync(sessionId: string, stream: RemoteStream): Promise<void> {
    if (streams.get(sessionId) !== stream) return;
    const guest = stream.run ? host.currentGuest(sessionId) : await ensureGuest(sessionId, { reveal: false });
    if (!guest || guest.isDestroyed()) {
      await stopRun(cdp, stream);
      return;
    }
    await cdp.waitForInitialDocument(guest);
    const port = await cdp.guestDebugger(guest);
    const documentId = browserDocumentId(state, guest);
    const size = sizeKey(stream);
    const target = { guest, port, documentId, size };
    const current = stream.run;
    if (runMatches(current, target)) return;
    await stopRun(cdp, stream);
    if (streams.get(sessionId) !== stream) return;
    if (current && current.size !== size) {
      // A frame captured at the old size must not reach the client as the new one.
      stream.pending = null;
    }
    // Every page, document and size change passes here, so an explicitly
    // driven viewport is re-applied before the new screencast captures anything.
    await driveGuest(host.drive, sessionId, stream, guest, documentId);
    if (streams.get(sessionId) !== stream) return;
    // The fit changed while this one was applied: the reconcile queued by that
    // change applies it and starts the capture; none starts at a size whose
    // fit this page does not hold.
    const fit = stream.viewport;
    if (
      fit &&
      !(
        stream.driven?.guest === guest &&
        stream.driven.documentId === documentId &&
        stream.driven.key === viewportKey(fit)
      )
    ) {
      return;
    }
    // A fit that failed was given up: the run captures the page as it is.
    target.size = sizeKey(stream);
    // The device pixel ratio the capture size honours; a ratio change of the
    // same CSS layout is a new geometry too.
    const ratio = await readRemotePagePixelRatio(cdp, guest).catch(() => null);
    if (streams.get(sessionId) !== stream) return;
    if (ratio !== null && ratio !== stream.pixelRatio) {
      stream.pixelRatio = ratio;
      const locked = stream.geometry?.geometry;
      if (locked) lock(sessionId, stream, { width: locked.cssWidth, height: locked.cssHeight });
    }
    await startScreencastRun(cdp, stream, target, {
      onPageEvent: () => void check(sessionId, stream),
      onImage: (run, data, viewport) => onScreencastImage(sessionId, stream, run, data, viewport),
      // A failed capture leaves the screencast to deliver the first frame.
      onFirstFrameDue: (run) => {
        if (stream.geometry?.capture === 'screenshot') {
          if (stream.run !== run || run.view) return;
          const locked = stream.geometry.geometry;
          void shoot(sessionId, stream, run, { width: locked.cssWidth, height: locked.cssHeight });
          return;
        }
        void captureFirstFrame(cdp, stream, run, (data, viewport) =>
          onScreencastImage(sessionId, stream, run, data, viewport)
        ).catch(() => undefined);
      },
    });
  }

  function reconcile(sessionId: string, stream: RemoteStream): Promise<void> {
    // A failed sync must not wedge the queue behind it; the next check retries.
    stream.work = stream.work.then(() => sync(sessionId, stream)).catch(() => undefined);
    return stream.work;
  }

  return { publishFacts, check, reconcile, stopRun: (stream: RemoteStream) => stopRun(cdp, stream) };
}
