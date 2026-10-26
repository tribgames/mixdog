/**
 * Adapts a `RemoteScreenSource` to the WebRTC host's `RemoteWebrtcVideoSource`
 * (main/remote-webrtc/source.ts): the sender opens a desktop-capture track from
 * `capturePlan`, a channel `screen-input` reaches the source's gated, serialized
 * input path, and geometry renewals and the end of the session reach the sink.
 */
import {
  isRemoteWebrtcPageInput,
  remoteWebrtcSourceKey,
  type RemoteWebrtcSource,
  type RemoteWebrtcSourceInput,
} from '../../shared/remote-webrtc';
import type { RemoteWebrtcSourceSink, RemoteWebrtcVideoSource } from '../remote-webrtc/source';
import type { ScreenPermission } from './screen-permission';
import type { RemoteScreenSource } from './screen-source';

export interface ScreenWebrtcSourceOptions {
  screenId: string;
  /** The permission the viewer asked for; the source's gate decides. */
  want: ScreenPermission;
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

  return {
    source,
    start() {
      if (starting) return;
      starting = screen.start(options.want).then(
        (result) => options.sink.geometryChanged(key, result.geometry),
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
    release: () => screen.releaseInput(),
  };
}
