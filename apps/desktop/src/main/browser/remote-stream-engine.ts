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
import { jpegSize } from './remote-jpeg-size';
import { driveGuest } from './remote-guest-drive';
import { captureFirstFrame, runMatches, startScreencastRun, stopRun } from './remote-screencast';
import {
  type BrowserRemoteControlHost,
  type PictureView,
  type RemoteStream,
  type ScreencastRun,
  sizeKey,
} from './remote-stream';

type StreamEngineHost = Pick<
  BrowserRemoteControlHost,
  'state' | 'cdp' | 'ensureGuest' | 'currentGuest' | 'tabs' | 'dialog' | 'publishFrame' | 'drive'
>;

const NO_PICTURE: PictureView = { size: { width: 0, height: 0 }, viewport: { width: 0, height: 0 } };

export function createRemoteStreamEngine(host: StreamEngineHost, streams: ReadonlyMap<string, RemoteStream>) {
  const { state, cdp, ensureGuest } = host;

  /** Queue a frame of a page's document: its facts, and the picture `view`
   *  describes (0×0 for none) with `image` when one goes out with it. */
  function composeFrame(
    sessionId: string,
    stream: RemoteStream,
    guest: WebContents,
    documentId: string,
    view: PictureView,
    image: DesktopRemoteBrowserStreamFrame['image']
  ): void {
    stream.signature = frameSignature(host, sessionId, guest, documentId, view);
    stream.seq += 1;
    stream.pending = buildFrame(host, sessionId, stream.seq, guest, documentId, view, image);
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
    composeFrame(sessionId, stream, guest, run.documentId, run.view, { mimeType: 'image/jpeg', data });
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
    composeFrame(sessionId, stream, guest, documentId, view, waiting);
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
    // Every page, document and size change passes here, so a driven viewport
    // is re-applied before the new screencast captures anything.
    await driveGuest(host.drive, sessionId, stream, guest, documentId);
    if (streams.get(sessionId) !== stream) return;
    await startScreencastRun(cdp, stream, target, {
      onPageEvent: () => void check(sessionId, stream),
      onImage: (run, data, viewport) => queueImage(sessionId, stream, run, data, viewport),
      // A failed capture leaves the screencast to deliver the first frame.
      onFirstFrameDue: (run) =>
        void captureFirstFrame(cdp, stream, run, (data, viewport) =>
          queueImage(sessionId, stream, run, data, viewport)
        ).catch(() => undefined),
    });
  }

  function reconcile(sessionId: string, stream: RemoteStream): Promise<void> {
    // A failed sync must not wedge the queue behind it; the next check retries.
    stream.work = stream.work.then(() => sync(sessionId, stream)).catch(() => undefined);
    return stream.work;
  }

  return { publishFacts, check, reconcile, stopRun: (stream: RemoteStream) => stopRun(cdp, stream) };
}
