// Media byte lane for the relay leg: the relay proxies a phone's HTTP request
// here and this leg answers with a head followed by raw chunks. Media never
// becomes an RPC payload again, so a clip cannot stall the UI socket and the
// phone keeps Range seeking.
//
// The relay is untrusted, so the body is never plaintext: it is a sequence of
// AES-GCM frames sealed with the requesting session's media key (see
// shared/remote-media-crypto.ts). The request names its session by `sid` (the
// session's public handshake challenge); the key itself only ever exists on
// the two endpoints. A window is segment aligned and bounded, and the browser
// asks for the next one, which is how a seek lands anywhere in a file.
import { open, type FileHandle } from 'node:fs/promises';

import { parseRange } from '../../../relay/lib/media-http.mjs';
import {
  MEDIA_SCHEME,
  MEDIA_SEGMENT_BYTES,
  encryptMediaMeta,
  encryptMediaSegment,
  type MediaAssetRef,
} from '../shared/remote-media-crypto';
import type { DesktopService } from './desktop-service-contract';
import { leasedMediaFile } from './media-leases';
import { resolveMediaFileTarget } from './media-source';

// Socket backlog that pauses the read; a phone that stalls stops the pump
// within a few frames.
const MEDIA_SOCKET_BACKLOG_BYTES = 4 * 1024 * 1024;
const MEDIA_POLL_MS = 50;
/** Plaintext served per request; a longer range continues in the next one. */
export const MEDIA_WINDOW_MAX_BYTES = 1024 * 1024;

// Two independent stalls can pause a pump — this socket's backlog, and the
// relay's flow control for a phone that stopped draining (the local backlog
// never sees that one, because the relay reads eagerly) — so the read only
// continues once BOTH are clear.
interface MediaPump {
  aborted: boolean;
  relayPaused: boolean;
}

export interface RelayMediaRequest {
  id: string;
  assetId: string;
  variant: string;
  method: string;
  range: string;
  /** The requesting session's handshake challenge; '' when the relay sent none. */
  sid: string;
  /** Protocol opt-in (`MEDIA_SCHEME`); '' from an older client or relay. */
  enc: string;
}

export interface RelayMediaLaneDeps {
  host: Pick<DesktopService, 'invokeCapability'>;
  sendEnvelope(payload: unknown): void;
  /** Bytes queued on the relay socket; 0 when no socket is attached. */
  socketBacklog(): number;
  /** The media key of the attached session whose challenge is `sid`. */
  mediaKey(sid: string): CryptoKey | null;
}

export interface RelayMediaLane {
  serve(media: RelayMediaRequest): Promise<void>;
  /** The relay gave up on (or paused/resumed) one waiting response. */
  abort(id: string): void;
  setPaused(id: string, paused: boolean): void;
  /** The relay dropped every waiting response with this leg: stop pumping. */
  destroyAll(): void;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function createRelayMediaLane(deps: RelayMediaLaneDeps): RelayMediaLane {
  const pumps = new Map<string, MediaPump>();
  const sendChunk = (id: string, frame: Uint8Array): void =>
    deps.sendEnvelope({ type: 'media-chunk', id, data: Buffer.from(frame).toString('base64') });
  const serve = async (media: RelayMediaRequest): Promise<void> => {
    const { id } = media;
    const fail = (status: number): void => {
      deps.sendEnvelope({ type: 'media-head', id, status, headers: {} });
      deps.sendEnvelope({ type: 'media-end', id });
    };
    // Only a client that explicitly speaks the encrypted scheme gets bytes.
    // Anything else (an older renderer expecting plaintext) is told there is
    // no such media, which is exactly what it falls back from today.
    if (media.enc !== MEDIA_SCHEME) {
      fail(404);
      return;
    }
    const key = media.sid ? deps.mediaKey(media.sid) : null;
    if (!key) {
      fail(403);
      return;
    }
    if (media.method !== 'GET') {
      fail(405);
      return;
    }
    let target: { path: string; mime: string } | null;
    try {
      target = leasedMediaFile(media.assetId) ?? (await resolveMediaFileTarget(deps.host, media.assetId, media.variant));
    } catch {
      fail(500);
      return;
    }
    if (!target) {
      fail(404);
      return;
    }
    let handle: FileHandle;
    try {
      handle = await open(target.path, 'r');
    } catch {
      fail(404);
      return;
    }
    const pump: MediaPump = { aborted: false, relayPaused: false };
    pumps.set(id, pump);
    try {
      const { size } = await handle.stat();
      const range = parseRange(media.range, size) as { start: number; end: number } | { unsatisfiable: true } | null;
      if (range && 'unsatisfiable' in range) {
        deps.sendEnvelope({ type: 'media-head', id, status: 416, headers: {} });
        deps.sendEnvelope({ type: 'media-end', id });
        return;
      }
      const requested = range ?? { start: 0, end: size - 1 };
      const start = Math.floor(requested.start / MEDIA_SEGMENT_BYTES) * MEDIA_SEGMENT_BYTES;
      const capped = Math.min(requested.end, start + MEDIA_WINDOW_MAX_BYTES - 1);
      const end = Math.min(size - 1, (Math.floor(capped / MEDIA_SEGMENT_BYTES) + 1) * MEDIA_SEGMENT_BYTES - 1);
      const asset: MediaAssetRef = { assetId: media.assetId, variant: media.variant };
      deps.sendEnvelope({
        type: 'media-head',
        id,
        status: 200,
        // The relay sees these anyway; the authenticated facts are in the meta frame.
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
      });
      sendChunk(id, await encryptMediaMeta(key, asset, { size, mime: target.mime, start, end }));
      for (let offset = start; offset <= end; offset += MEDIA_SEGMENT_BYTES) {
        while (
          !pump.aborted &&
          (pump.relayPaused || deps.socketBacklog() > MEDIA_SOCKET_BACKLOG_BYTES)
        ) {
          await sleep(MEDIA_POLL_MS);
        }
        if (pump.aborted) return;
        const length = Math.min(MEDIA_SEGMENT_BYTES, end - offset + 1);
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        // The file changed under the stream: a short segment would not match
        // the size the frames are bound to.
        if (bytesRead !== length) throw new Error('Media file changed while streaming.');
        const frame = await encryptMediaSegment(key, asset, offset, size, buffer);
        if (pump.aborted) return;
        sendChunk(id, frame);
      }
      deps.sendEnvelope({ type: 'media-end', id });
    } catch {
      if (!pump.aborted) deps.sendEnvelope({ type: 'media-error', id });
    } finally {
      if (pumps.get(id) === pump) pumps.delete(id);
      await handle.close().catch(() => undefined);
    }
  };
  const abort = (id: string): void => {
    const pump = pumps.get(id);
    if (pump) pump.aborted = true;
  };
  const setPaused = (id: string, paused: boolean): void => {
    const pump = pumps.get(id);
    if (pump) pump.relayPaused = paused;
  };
  const destroyAll = (): void => {
    for (const pump of pumps.values()) pump.aborted = true;
    pumps.clear();
  };
  return { serve, abort, setPaused, destroyAll };
}
