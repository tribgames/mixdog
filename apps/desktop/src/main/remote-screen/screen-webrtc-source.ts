/**
 * Adapts a `RemoteScreenSource` to the WebRTC host's `RemoteWebrtcVideoSource`
 * (main/remote-webrtc/source.ts): the sender opens a desktop-capture track from
 * `capturePlan`, a channel `screen-input` reaches the source's gated, serialized
 * input path, and geometry renewals and the end of the session reach the sink.
 * Its status (`screen-status`) and cursor position (`screen-cursor`) are pushed
 * on the viewer's channel on change, and both once when the channel is promoted.
 *
 * Helper video: while the secure-desktop helper serves (`videoPath` `helper`),
 * the sender's track becomes a drawn one (`sink.drawnTrack`), switched in place
 * on every connection, and each helper frame is handed over as raw rows the
 * sender crops and scales onto the locked geometry (so the size and
 * generation stay). Leaving the helper path switches back to the capture.
 *
 * Video runs: every path change, pipeline stall and loss of the viewer's
 * channel starts a new run (`epoch`), announced to the phone as
 * `screen-video`. Control on the helper path needs both:
 * - local delivery: a picture of the current run drew into the track the
 *   connection sends (`delivered(epoch)`); a pipeline watchdog
 *   (`helperVideoStallMs`) ends the run when deliveries stop;
 * - receipt: the phone's `screen-frame-seen` for the current run, sent once
 *   it rendered a frame of it (`frameSeen(epoch)`).
 * Anything of an older run (a late acknowledgement, a late seen) counts for
 * nothing. A phone that never sends `screen-frame-seen` never gets control
 * there.
 *
 * Helper control grants (protocol v4): every run is declared to the helper
 * while this session holds it (`setVideoRun`). Run epochs are minted
 * helper-wide (`nextVideoRun`), so no two sessions share one, and taking the
 * hold starts a fresh run (`onHelperHold`) after the previous holder's grant
 * was revoked (secure-desktop-helper.ts). Each helper challenge goes
 * to the phone as `screen-helper-challenge` with the current run, and the
 * phone's `screen-helper-grant` is relayed only when it names the current
 * run. The phone's `screen-helper-install` reaches the source's install
 * request.
 */
import {
  REMOTE_WEBRTC_VERSION,
  isRemoteWebrtcPageInput,
  remoteWebrtcScreenHelperChallenge,
  remoteWebrtcSourceKey,
  type RemoteWebrtcChannelPush,
  type RemoteWebrtcSource,
  type RemoteWebrtcSourceInput,
} from '../../shared/remote-webrtc';
import type { RemoteWebrtcSourceSink, RemoteWebrtcVideoSource } from '../remote-webrtc/source';
import type { RemoteScreenSource, ScreenCursor, ScreenVideoPath } from './screen-source';

/** The helper's capture cadence: `CAPTURE_INTERVAL` in
 *  native/mixdog-secure-desktop/src/helper.rs (a frame every 66 ms at most,
 *  and only once its previous one was written out). */
export const HELPER_FRAME_INTERVAL_MS = 66;
/** Deliveries the average spans: the last 30 frames, as in webrtc-stats. */
const STALL_WINDOW = 30;

/**
 * The local pipeline watchdog: how long without a delivered helper frame
 * (main → the sender's track) before the run ends. It watches this PC's
 * pipeline only, not the network or the phone's renderer (the phone's
 * `screen-frame-seen` is the receipt evidence). The threshold borrows the
 * shape of the webrtc-stats freeze rule (`freezeCount`:
 * `max(3 × average, average + 150 ms)` over the last 30 frame intervals,
 * https://www.w3.org/TR/webrtc-stats/#dom-rtcinboundrtpstreamstats-freezecount),
 * applied to local delivery intervals: a gap well past the pipeline's own
 * cadence, which adapts to a slower pipeline (a large display) instead of
 * tripping on every frame. Before two deliveries the helper's nominal cadence
 * stands in: max(198, 216) = 216 ms.
 */
export function helperVideoStallMs(intervals: readonly number[]): number {
  const average = intervals.length
    ? intervals.reduce((sum, interval) => sum + interval, 0) / intervals.length
    : HELPER_FRAME_INTERVAL_MS;
  return Math.max(3 * average, average + 150);
}

export interface ScreenWebrtcSourceOptions {
  screenId: string;
  sink: RemoteWebrtcSourceSink;
  /** A start the gate refused, or that failed (logged by the source). */
  onStartError?(error: unknown): void;
}

export function createScreenWebrtcSource(
  screen: RemoteScreenSource,
  options: ScreenWebrtcSourceOptions
): RemoteWebrtcVideoSource {
  const source: RemoteWebrtcSource = { kind: 'screen', screenId: options.screenId };
  const key = remoteWebrtcSourceKey(source);
  let starting: Promise<void> | null = null;

  screen.onGeometry(({ geometry }) => {
    options.sink.geometryChanged(key, geometry);
    options.sink.captureChanged(key);
  });
  screen.onStop(() => options.sink.geometryChanged(key, null));

  const statusMessage = (): RemoteWebrtcChannelPush => ({
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-status',
    status: screen.status(),
  });
  const cursorMessage = (cursor: ScreenCursor): RemoteWebrtcChannelPush => ({
    v: REMOTE_WEBRTC_VERSION,
    kind: 'screen-cursor',
    ...cursor,
  });
  // A stop's own status is pushed before the sink ends the viewer.
  screen.onStatus(() => options.sink.channelPush(key, statusMessage()));
  screen.onCursor((cursor) => options.sink.channelPush(key, cursorMessage(cursor)));

  // Video runs (see the header).
  let path: ScreenVideoPath = 'capture';
  /** Minted helper-wide: no other session's run has this epoch. */
  let epoch = screen.nextVideoRun();
  /** `screen-video` of the run was sent: a capture run at once, a helper run
   *  once its first frame is in the track (so what the phone renders after it
   *  is the helper's picture). */
  let announced = true;
  /** The phone's `screen-frame-seen` for the run arrived. */
  let seen = false;
  let lastDelivery: number | null = null;
  const intervals: number[] = [];
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  /** When the last helper frame was handed over (the frame-rate cap). */
  let handedAt = -Infinity;

  const videoMessage = (): RemoteWebrtcChannelPush => ({ v: REMOTE_WEBRTC_VERSION, kind: 'screen-video', epoch, path });
  /** Control on the helper path: delivered locally and seen by the phone, in
   *  this run. Off the helper path the source ignores the report. */
  const grant = (): void => screen.setHelperVideo(path === 'helper' && announced && seen);

  /** A new run on `next`: everything of the old one stops counting, and
   *  control on the helper path is withdrawn until the new run earns it. */
  const newRun = (next: ScreenVideoPath): void => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    lastDelivery = null;
    intervals.length = 0;
    epoch = screen.nextVideoRun();
    path = next;
    seen = false;
    announced = next === 'capture';
    screen.setVideoRun(epoch);
    grant();
    if (announced) options.sink.channelPush(key, videoMessage());
  };

  screen.onHelperChallenge((challenge) => {
    let message: RemoteWebrtcChannelPush;
    try {
      message = remoteWebrtcScreenHelperChallenge(epoch, challenge);
    } catch {
      // Malformed (the helper's pipe admits any process of the PC user):
      // never forwarded to the phone.
      return;
    }
    options.sink.channelPush(key, message);
  });

  // Taking the helper's hold: a fresh run (and epoch) on the same path, so
  // nothing the phone saw or signed before counts with the helper.
  screen.onHelperHold(() => newRun(path));
  screen.onVideoPath((next) => {
    if (next === path) return;
    newRun(next);
    options.sink.drawnTrack(key, next === 'helper');
  });
  screen.onFrame((frame) => {
    const geometry = screen.geometry();
    const plan = screen.capturePlan();
    if (path !== 'helper' || !geometry || !plan) return;
    // No byte budget can be derived without a measured IPC throughput, so
    // the rate is capped by the stream's own frame rate (the helper's 66 ms
    // cadence is slower still); the host's one-in-flight queue keeps the
    // bytes to one frame per source at a time.
    const now = Date.now();
    if (now - handedAt < 1000 / plan.maxFrameRate) return;
    handedAt = now;
    options.sink.frame(key, { documentId: null, geometry, epoch, mimeType: 'image/x-bgrx', ...frame });
  });
  screen.onStop(() => {
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  });

  return {
    source,
    start() {
      if (starting) return;
      starting = screen.start().then(
        (result) => {
          // The first run, declared once the session runs (a later one was
          // declared when it started).
          screen.setVideoRun(epoch);
          options.sink.geometryChanged(key, result.geometry);
        },
        (error: unknown) => {
          options.sink.geometryChanged(key, null);
          options.onStartError?.(error);
        }
      );
    },
    stop() {
      void screen.stop('viewer-left');
    },
    page: () => ({ documentId: null, geometry: screen.running() ? screen.geometry() : null }),
    async dispatch(control: RemoteWebrtcSourceInput) {
      if (isRemoteWebrtcPageInput(control)) throw new Error('remote screen takes screen input only');
      // The host's dispatch carries no generation yet; the current one stands in
      // (the host has already checked the message against the acknowledged one).
      const generation = screen.geometry()?.generation ?? 0;
      if ((await screen.handleInput(control, generation)) === 'rejected') {
        throw new Error('remote screen input was not applied');
      }
    },
    capturePlan: () => screen.capturePlan(),
    release: () => {
      // The channel whose phone saw the run is gone: a new run, which the
      // next channel must see for itself.
      if (path === 'helper') newRun('helper');
      return screen.releaseInput();
    },
    channelState: () => {
      const cursor = screen.cursor();
      return [statusMessage(), ...(announced ? [videoMessage()] : []), ...(cursor ? [cursorMessage(cursor)] : [])];
    },
    delivered(delivery) {
      // Only this run's helper frames count.
      if (path !== 'helper' || delivery !== epoch || !screen.running()) return;
      const now = Date.now();
      if (lastDelivery !== null) {
        intervals.push(now - lastDelivery);
        if (intervals.length > STALL_WINDOW) intervals.shift();
      }
      lastDelivery = now;
      if (watchdog) clearTimeout(watchdog);
      // The pipeline stalled: the run ends (control withdrawn, held input
      // released), and the next one needs a delivery and a seen again.
      watchdog = setTimeout(() => newRun('helper'), helperVideoStallMs(intervals));
      watchdog.unref?.();
      if (!announced) {
        announced = true;
        options.sink.channelPush(key, videoMessage());
      }
    },
    frameSeen(run) {
      // Only for the current helper run, once announced (the phone answers
      // the announcement; an earlier claim is not evidence).
      if (path !== 'helper' || run !== epoch || !announced || !screen.running()) return;
      seen = true;
      grant();
    },
    helperGrant(signed) {
      // Signed for another run: the helper would refuse it, and the phone
      // must not be able to carry a grant across runs.
      if (signed.epoch !== epoch) return;
      screen.helperGrant(signed);
    },
    helperInstall: (controllerKey) => screen.requestHelperInstall(controllerKey),
  };
}
