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
//
// The `download` variant serves file-download leases (main/file-downloads.ts):
// the asset id is the lease's random media id, the lease must belong to the
// paired device of the requesting session, and every byte is read through the
// lease's own opened handle, which refuses a file whose version changed.
import type { FileHandle } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseRange } from '../../../relay/lib/media-http.mjs';
import { FILE_DOWNLOAD_MEDIA_VARIANT, fileDownloadErrorReason } from '../shared/file-downloads';
import {
  MEDIA_SCHEME,
  MEDIA_SEGMENT_BYTES,
  encryptMediaMeta,
  encryptMediaSegment,
  type MediaAssetRef,
} from '../shared/remote-media-crypto';
import type { DesktopService } from './desktop-service-contract';
import type { FileDownloadMediaSource } from './file-downloads';
import { leasedMediaFile } from './media-leases';
import { openAuthorizedFile } from './opened-file-authorization';
import { resolveMediaFileTarget } from './media-source';

// Socket backlog that pauses the read; a phone that stalls stops the pump
// within a few frames.
const MEDIA_SOCKET_BACKLOG_BYTES = 4 * 1024 * 1024;
const MEDIA_POLL_MS = 50;
/** Plaintext served per request; a longer range continues in the next one. */
export const MEDIA_WINDOW_MAX_BYTES = 1024 * 1024;
/** A download is read start to end, so each of its requests carries more;
 *  the pump still holds one segment at a time. */
export const DOWNLOAD_WINDOW_MAX_BYTES = 8 * 1024 * 1024;

/** What one request streams from: the gallery file it opened, or a lease. */
interface MediaByteSource {
  size: number;
  mime: string;
  version?: string;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** The status for a source that failed before the head was sent. */
function readFailureStatus(error: unknown): number {
  const reason = fileDownloadErrorReason(error);
  if (reason === 'changed') return 412;
  if (reason === 'expired' || reason === 'not-found') return 404;
  return 500;
}

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
  /** The paired device (as file-downloads.ts names requesters) of the
   *  authenticated session whose challenge is `sid`. */
  mediaDevice?(sid: string): string | null;
  /** Download leases; without it every `download` request is a 404. */
  downloads?: FileDownloadMediaSource;
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

/** A leased project file, opened again the way it was authorized: its real
 *  location inside the lease's folder and not secret-bearing
 *  (openAuthorizedFile), and the very file the lease was minted for. */
async function openLeasedFile(lease: NonNullable<ReturnType<typeof leasedMediaFile>>): Promise<FileHandle> {
  const file = await openAuthorizedFile(lease.path, lease.within);
  if (file.identity.dev !== lease.identity.dev || file.identity.ino !== lease.identity.ino) {
    await file.handle.close();
    throw new Error('The leased file was replaced.');
  }
  return file.handle;
}

export function createRelayMediaLane(deps: RelayMediaLaneDeps): RelayMediaLane {
  const pumps = new Map<string, MediaPump>();
  const sendChunk = (id: string, frame: Uint8Array): void =>
    deps.sendEnvelope({ type: 'media-chunk', id, data: Buffer.from(frame).toString('base64') });
  const gallerySource = async (media: RelayMediaRequest): Promise<MediaByteSource | null> => {
    const leased = leasedMediaFile(media.assetId);
    const target = leased ?? (await resolveMediaFileTarget(deps.host, media.assetId, media.variant));
    if (!target) return null;
    let handle: FileHandle;
    try {
      // A gallery file gets the same name and opened-file check, within its
      // own folder: the media store never serves a secret through a link.
      handle = leased
        ? await openLeasedFile(leased)
        : (await openAuthorizedFile(target.path, dirname(target.path))).handle;
    } catch {
      return null;
    }
    try {
      const { size } = await handle.stat();
      return {
        size,
        mime: target.mime,
        read: async (offset, length) => {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return bytesRead === length ? buffer : buffer.subarray(0, bytesRead);
        },
        close: () => handle.close().catch(() => undefined),
      };
    } catch (error) {
      await handle.close().catch(() => undefined);
      throw error;
    }
  };
  // A lease answers only the device it was minted for; the device comes from
  // the authenticated session the request names, never from the request.
  const downloadSource = (media: RelayMediaRequest): MediaByteSource | null => {
    const deviceId = deps.mediaDevice?.(media.sid);
    const target = deviceId ? deps.downloads?.resolveMedia(media.assetId, FILE_DOWNLOAD_MEDIA_VARIANT, deviceId) : null;
    if (!target) return null;
    return {
      size: target.size,
      mime: target.mime,
      version: target.version,
      read: (offset, length) => target.read(offset, length),
      // The handle is the lease's; it closes when the lease ends.
      close: async () => undefined,
    };
  };
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
    const download = media.variant === FILE_DOWNLOAD_MEDIA_VARIANT;
    let source: MediaByteSource | null;
    try {
      // A download id never falls through to the gallery's own resolution.
      source = download ? downloadSource(media) : await gallerySource(media);
    } catch {
      fail(500);
      return;
    }
    if (!source) {
      fail(404);
      return;
    }
    const pump: MediaPump = { aborted: false, relayPaused: false };
    pumps.set(id, pump);
    // Exactly `length` bytes, or the file changed under the stream: a short
    // segment would not match the size the frames are bound to.
    const readSegment = async (offset: number, length: number): Promise<Uint8Array> => {
      const bytes = await (source as MediaByteSource).read(offset, length);
      if (bytes.byteLength !== length) throw new Error('Media file changed while streaming.');
      return bytes;
    };
    try {
      const { size } = source;
      const range = parseRange(media.range, size) as { start: number; end: number } | { unsatisfiable: true } | null;
      if (range && 'unsatisfiable' in range) {
        fail(416);
        return;
      }
      const requested = range ?? { start: 0, end: size - 1 };
      const start = Math.floor(requested.start / MEDIA_SEGMENT_BYTES) * MEDIA_SEGMENT_BYTES;
      const windowBytes = download ? DOWNLOAD_WINDOW_MAX_BYTES : MEDIA_WINDOW_MAX_BYTES;
      const capped = Math.min(requested.end, start + windowBytes - 1);
      const end = Math.min(size - 1, (Math.floor(capped / MEDIA_SEGMENT_BYTES) + 1) * MEDIA_SEGMENT_BYTES - 1);
      const asset: MediaAssetRef = { assetId: media.assetId, variant: media.variant };
      // The first segment is read before the head: a lease that ended or a
      // file that changed is then a status the phone can act on (404/412),
      // not a body that breaks off.
      let first: Uint8Array | null = null;
      if (start <= end) {
        try {
          first = await readSegment(start, Math.min(MEDIA_SEGMENT_BYTES, end - start + 1));
        } catch (error) {
          if (!pump.aborted) fail(readFailureStatus(error));
          return;
        }
      }
      if (pump.aborted) return;
      deps.sendEnvelope({
        type: 'media-head',
        id,
        status: 200,
        // The relay sees these anyway; the authenticated facts are in the meta frame.
        headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' },
      });
      const meta = { size, mime: source.mime, start, end, ...(source.version ? { version: source.version } : {}) };
      sendChunk(id, await encryptMediaMeta(key, asset, meta));
      for (let offset = start; offset <= end; offset += MEDIA_SEGMENT_BYTES) {
        while (!pump.aborted && (pump.relayPaused || deps.socketBacklog() > MEDIA_SOCKET_BACKLOG_BYTES)) {
          await sleep(MEDIA_POLL_MS);
        }
        if (pump.aborted) return;
        const bytes = first ?? (await readSegment(offset, Math.min(MEDIA_SEGMENT_BYTES, end - offset + 1)));
        first = null;
        if (pump.aborted) return;
        const frame = await encryptMediaSegment(key, asset, offset, size, bytes);
        if (pump.aborted) return;
        sendChunk(id, frame);
      }
      deps.sendEnvelope({ type: 'media-end', id });
    } catch {
      if (!pump.aborted) deps.sendEnvelope({ type: 'media-error', id });
    } finally {
      if (pumps.get(id) === pump) pumps.delete(id);
      await source.close();
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
