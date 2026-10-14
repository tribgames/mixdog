import type { DesktopRemoteBrowserStreamFrame } from '../../shared/contract';
import type { RemoteStream } from './remote-stream';

const STREAM_MAX_FPS = 12;
const STREAM_FRAME_INTERVAL_MS = Math.ceil(1_000 / STREAM_MAX_FPS);

type PublishState = Pick<RemoteStream, 'pending' | 'publishing' | 'publishTimer' | 'lastPublishedAt'>;
type PublishFrame = (frame: DesktopRemoteBrowserStreamFrame) => Promise<void>;

function publishNow(stream: PublishState, publishFrame: PublishFrame): void {
  stream.publishTimer = null;
  const frame = stream.pending;
  if (!frame || stream.publishing) return;
  stream.pending = null;
  stream.publishing = true;
  stream.lastPublishedAt = Date.now();
  void publishFrame(frame)
    // A frame the service rejects is dropped; the next one supersedes it.
    .catch(() => undefined)
    .finally(() => {
      stream.publishing = false;
      // Whatever arrived while the service was busy goes out next, newest only.
      if (stream.pending) schedulePublish(stream, publishFrame);
    });
}

/** The newest frame replaces any waiting one; sends are capped at ~12/s. */
export function schedulePublish(stream: PublishState, publishFrame: PublishFrame): void {
  if (stream.publishTimer || stream.publishing) return;
  const wait = Math.max(0, stream.lastPublishedAt + STREAM_FRAME_INTERVAL_MS - Date.now());
  if (wait === 0) publishNow(stream, publishFrame);
  else {
    stream.publishTimer = setTimeout(() => publishNow(stream, publishFrame), wait);
    stream.publishTimer.unref?.();
  }
}
