/**
 * The sender's per-source tracks that come from a desktop capture (a screen
 * source). Acquiring a capture is asynchronous while other commands keep
 * running, so every capture and every source close takes the source over with
 * a new owner id; a completion that no longer owns its source stops every
 * track it got instead of installing it.
 */
import { remoteScreenCaptureConstraints, type RemoteScreenCapturePlan } from '../../shared/remote-webrtc';
import type { RemoteWebrtcSenderEvent } from '../../shared/remote-webrtc-sender';

/** A source's video track: drawn on a canvas, or captured. */
export interface RemoteWebrtcSenderSource {
  /** Drawn sources only; a captured (screen) source has none. */
  canvas: HTMLCanvasElement | null;
  context: CanvasRenderingContext2D | null;
  stream: MediaStream;
  track: MediaStreamTrack & { requestFrame?: () => void };
}

export interface RemoteWebrtcSourceCaptureDeps {
  /** Opens a desktop capture (getUserMedia). */
  acquire(constraints: MediaStreamConstraints): Promise<MediaStream>;
  /** Every source's current track, drawn ones included (shared with the sender). */
  sources: Map<string, RemoteWebrtcSenderSource>;
  /** The video senders of every connection of a source. */
  senders(sourceKey: string): RTCRtpSender[];
  emit(event: RemoteWebrtcSenderEvent): void;
}

const stopAll = (stream: MediaStream): void => {
  for (const track of stream.getTracks()) track.stop();
};

export function createRemoteWebrtcSourceCaptures(deps: RemoteWebrtcSourceCaptureDeps) {
  let serial = 0;
  /** The capture that owns each source; a close removes the owner. */
  const owners = new Map<string, number>();

  return {
    /** Opens the plan's capture as the source's track; a new plan (display
     *  changed) replaces the track on every connection of the source. */
    async capture(sourceKey: string, plan: RemoteScreenCapturePlan): Promise<void> {
      serial += 1;
      const owner = serial;
      owners.set(sourceKey, owner);
      const owns = (): boolean => owners.get(sourceKey) === owner;
      let stream: MediaStream | null = null;
      let installed = false;
      try {
        stream = await deps.acquire(remoteScreenCaptureConstraints(plan));
        if (!owns()) return;
        const track = stream.getVideoTracks()[0];
        if (!track) throw new Error('The desktop capture has no video track.');
        track.contentHint = 'detail';
        const previous = deps.sources.get(sourceKey);
        deps.sources.set(sourceKey, { canvas: null, context: null, stream, track });
        installed = true;
        try {
          for (const sender of deps.senders(sourceKey)) {
            // Taken over meanwhile: the newer capture swaps every sender, or
            // the close stopped this track.
            if (!owns()) break;
            await sender.replaceTrack(track);
          }
        } finally {
          if (previous) stopAll(previous.stream);
        }
        if (owns()) deps.emit({ type: 'source-captured', sourceKey, ok: true });
      } catch (error) {
        if (owns()) {
          deps.emit({
            type: 'source-captured',
            sourceKey,
            ok: false,
            detail: (error instanceof Error ? error.message : String(error)).slice(0, 200),
          });
        }
      } finally {
        if (stream && !installed) stopAll(stream);
      }
    },

    /** The source is gone: a capture still opening is abandoned, its track stopped. */
    close(sourceKey: string): void {
      owners.delete(sourceKey);
      const entry = deps.sources.get(sourceKey);
      deps.sources.delete(sourceKey);
      if (entry) stopAll(entry.stream);
    },
  };
}
