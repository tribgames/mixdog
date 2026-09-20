// Media byte lane for the relay leg: the relay proxies a phone's HTTP request
// here and this leg answers with a plan (status + headers) followed by raw
// chunks. Media never becomes an RPC payload again, so a clip cannot stall the
// UI socket and the phone keeps browser caching and Range seeking.
import { createReadStream, statSync, type ReadStream } from 'node:fs';

import { mediaResponsePlan } from '../../../relay/lib/media-http.mjs';
import type { DesktopService } from './desktop-service-contract';
import { resolveMediaFileTarget } from './media-source';

// Media chunk size and the socket backlog that pauses the read. Bigger frames
// waste memory on the relay, smaller ones waste round trips; 256 KB keeps a
// clip flowing while a phone that stalls stops the pump within a few frames.
const MEDIA_CHUNK_BYTES = 256 * 1024;
const MEDIA_SOCKET_BACKLOG_BYTES = 4 * 1024 * 1024;

function buildRelayMediaResponsePlan(input: {
  size: number;
  mime: string;
  assetId: string;
  variant: string;
  rangeHeader: string;
  ifNoneMatch: string;
}) {
  return mediaResponsePlan({
    ...input,
    // The browser may retain bytes, but every reuse must revalidate through
    // the relay token gate so Unpair revokes access immediately. ETags keep
    // unchanged content at 304 without re-downloading it.
    cacheControl: 'private, no-cache',
  });
}

// Two independent stalls can pause a pump — this socket's backlog, and the
// relay's flow control for a phone that stopped draining (the local backlog
// never sees that one, because the relay reads eagerly) — so the read only
// resumes once BOTH are clear.
interface MediaPump {
  stream: ReadStream;
  relayPaused: boolean;
  socketFull: boolean;
}

export interface RelayMediaRequest {
  id: string;
  assetId: string;
  variant: string;
  method: string;
  range: string;
  ifNoneMatch: string;
}

export interface RelayMediaLaneDeps {
  host: DesktopService;
  sendEnvelope(payload: unknown): void;
  /** Bytes queued on the relay socket; 0 when no socket is attached. */
  socketBacklog(): number;
}

export interface RelayMediaLane {
  serve(media: RelayMediaRequest): Promise<void>;
  /** The relay dropped every waiting response with this leg: stop pumping. */
  destroyAll(): void;
}

export function createRelayMediaLane(deps: RelayMediaLaneDeps): RelayMediaLane {
  // Streams currently pumping to the relay, keyed by request id: an aborted
  // phone request (scrolled away, closed tab) must stop the read.
  const pumps = new Map<string, MediaPump>();
  const resume = (id: string): void => {
    const pump = pumps.get(id);
    if (!pump || pump.relayPaused || pump.socketFull) return;
    pump.stream.resume();
  };
  const serve = async (media: RelayMediaRequest): Promise<void> => {
    const { id } = media;
    const fail = (status: number): void => {
      deps.sendEnvelope({ type: 'media-head', id, status, headers: {} });
      deps.sendEnvelope({ type: 'media-end', id });
    };
    let target: { path: string; mime: string } | null;
    try {
      target = await resolveMediaFileTarget(deps.host, media.assetId, media.variant);
    } catch {
      fail(500);
      return;
    }
    if (!target) {
      fail(404);
      return;
    }
    let size: number;
    try {
      size = statSync(target.path).size;
    } catch {
      fail(404);
      return;
    }
    const plan = buildRelayMediaResponsePlan({
      size,
      mime: target.mime,
      assetId: media.assetId,
      variant: media.variant,
      rangeHeader: media.range,
      ifNoneMatch: media.ifNoneMatch,
    });
    deps.sendEnvelope({ type: 'media-head', id, status: plan.status, headers: plan.headers });
    if (plan.status >= 300 || media.method === 'HEAD') {
      deps.sendEnvelope({ type: 'media-end', id });
      return;
    }
    const stream = createReadStream(target.path, {
      start: plan.start,
      end: plan.end,
      highWaterMark: MEDIA_CHUNK_BYTES,
    });
    const pump: MediaPump = { stream, relayPaused: false, socketFull: false };
    pumps.set(id, pump);
    stream.on('data', (chunk) => {
      deps.sendEnvelope({ type: 'media-chunk', id, data: (chunk as Buffer).toString('base64') });
      // Backpressure: without it a phone on a slow link buffers the whole clip
      // in this process and again in the relay.
      if (deps.socketBacklog() <= MEDIA_SOCKET_BACKLOG_BYTES) return;
      pump.socketFull = true;
      stream.pause();
      const poll = setInterval(() => {
        if (!pumps.has(id)) {
          clearInterval(poll);
          return;
        }
        if (deps.socketBacklog() > MEDIA_SOCKET_BACKLOG_BYTES) return;
        clearInterval(poll);
        pump.socketFull = false;
        resume(id);
      }, 50);
      poll.unref?.();
    });
    stream.on('error', () => {
      pumps.delete(id);
      deps.sendEnvelope({ type: 'media-error', id });
    });
    stream.on('end', () => {
      pumps.delete(id);
      deps.sendEnvelope({ type: 'media-end', id });
    });
  };
  const destroyAll = (): void => {
    for (const pump of pumps.values()) {
      try {
        pump.stream.destroy();
      } catch {
        /* already gone */
      }
    }
    pumps.clear();
  };
  return { serve, destroyAll };
}
