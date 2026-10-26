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
//
// The same window logic (`serveMediaWindow`) also serves the direct transport
// (main/remote-transport/media.ts): only where the frames go, how the
// requesting session is known and what pauses the reader differ per lane, so
// range, version, lease, device and encryption semantics are one code path.
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

/** What one request asks for, on either lane. */
export interface MediaWindowRequest {
  assetId: string;
  variant: string;
  method: string;
  range: string;
  /** Protocol opt-in (`MEDIA_SCHEME`); '' from an older client or relay. */
  enc: string;
}

export interface RelayMediaRequest extends MediaWindowRequest {
  id: string;
  /** The requesting session's handshake challenge; '' when the relay sent none. */
  sid: string;
}

/** Where gallery files and download leases come from. */
export interface MediaWindowSources {
  host: Pick<DesktopService, 'invokeCapability'>;
  /** Download leases; without it every `download` request is a 404. */
  downloads?: FileDownloadMediaSource;
}

/** The requesting session, as its lane knows it: named by `sid` on the relay
 *  lane, the stream's own session on the transport. */
export interface MediaWindowSession {
  /** Its media key; null when there is no such authenticated session. */
  mediaKey(): CryptoKey | null;
  /** Its paired device (as file-downloads.ts names requesters). */
  device(): string | null;
}

/** Where one window's answer goes. Every step is awaited in order, so a lane
 *  that must wait for room before it may queue a frame holds the pump there. */
export interface MediaWindowOutput {
  /** The requester went away: the pump stops at its next step, quietly. */
  readonly aborted: boolean;
  /** Resolves once the next segment may be produced. The file read waits
   *  here, so a consumer that stopped draining stops the reads. */
  ready(): Promise<void>;
  head(status: number): void | Promise<void>;
  chunk(frame: Uint8Array): void | Promise<void>;
  end(): void | Promise<void>;
  error(): void | Promise<void>;
}

export interface RelayMediaLaneDeps extends MediaWindowSources {
  sendEnvelope(payload: unknown): void;
  /** Bytes queued on the relay socket; 0 when no socket is attached. */
  socketBacklog(): number;
  /** The media key of the attached session whose challenge is `sid`. */
  mediaKey(sid: string): CryptoKey | null;
  /** The paired device (as file-downloads.ts names requesters) of the
   *  authenticated session whose challenge is `sid`. */
  mediaDevice?(sid: string): string | null;
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
 *  location inside the lease's folder (openAuthorizedFile), and the very file
 *  the lease was minted for. */
async function openLeasedFile(lease: NonNullable<ReturnType<typeof leasedMediaFile>>): Promise<FileHandle> {
  const file = await openAuthorizedFile(lease.path, lease.within);
  if (file.identity.dev !== lease.identity.dev || file.identity.ino !== lease.identity.ino) {
    await file.handle.close();
    throw new Error('The leased file was replaced.');
  }
  return file.handle;
}

async function gallerySource(deps: MediaWindowSources, media: MediaWindowRequest): Promise<MediaByteSource | null> {
  const leased = leasedMediaFile(media.assetId);
  const target = leased ?? (await resolveMediaFileTarget(deps.host, media.assetId, media.variant));
  if (!target) return null;
  let handle: FileHandle;
  try {
    // A gallery file gets the same opened-file check, within its own folder.
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
}

// A lease answers only the device it was minted for; the device comes from
// the authenticated session the request names, never from the request.
function downloadSource(
  deps: MediaWindowSources,
  deviceId: string | null,
  media: MediaWindowRequest
): MediaByteSource | null {
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
}

/** Answers one request on `out`: a status, or a 200 head, the authenticated
 *  meta frame and the window's segment frames, then the end. Shared by both
 *  lanes, so a window is the same bytes whichever lane carries it. */
export async function serveMediaWindow(
  deps: MediaWindowSources,
  media: MediaWindowRequest,
  session: MediaWindowSession,
  out: MediaWindowOutput
): Promise<void> {
  const fail = async (status: number): Promise<void> => {
    await out.head(status);
    await out.end();
  };
  // Only a client that explicitly speaks the encrypted scheme gets bytes.
  // Anything else (an older renderer expecting plaintext) is told there is
  // no such media, which is exactly what it falls back from today.
  if (media.enc !== MEDIA_SCHEME) return fail(404);
  const key = session.mediaKey();
  if (!key) return fail(403);
  if (media.method !== 'GET') return fail(405);
  const download = media.variant === FILE_DOWNLOAD_MEDIA_VARIANT;
  let source: MediaByteSource | null;
  try {
    // A download id never falls through to the gallery's own resolution.
    source = download ? downloadSource(deps, session.device(), media) : await gallerySource(deps, media);
  } catch {
    return fail(500);
  }
  if (!source) return fail(404);
  const opened = source;
  // Exactly `length` bytes, or the file changed under the stream: a short
  // segment would not match the size the frames are bound to.
  const readSegment = async (offset: number, length: number): Promise<Uint8Array> => {
    const bytes = await opened.read(offset, length);
    if (bytes.byteLength !== length) throw new Error('Media file changed while streaming.');
    return bytes;
  };
  try {
    const { size } = opened;
    const range = parseRange(media.range, size) as { start: number; end: number } | { unsatisfiable: true } | null;
    if (range && 'unsatisfiable' in range) {
      await fail(416);
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
        if (!out.aborted) await fail(readFailureStatus(error));
        return;
      }
    }
    if (out.aborted) return;
    await out.head(200);
    const meta = { size, mime: opened.mime, start, end, ...(opened.version ? { version: opened.version } : {}) };
    await out.chunk(await encryptMediaMeta(key, asset, meta));
    for (let offset = start; offset <= end; offset += MEDIA_SEGMENT_BYTES) {
      await out.ready();
      if (out.aborted) return;
      const bytes = first ?? (await readSegment(offset, Math.min(MEDIA_SEGMENT_BYTES, end - offset + 1)));
      first = null;
      if (out.aborted) return;
      const frame = await encryptMediaSegment(key, asset, offset, size, bytes);
      if (out.aborted) return;
      await out.chunk(frame);
    }
    await out.end();
  } catch {
    if (!out.aborted) await out.error();
  } finally {
    await opened.close();
  }
}

export function createRelayMediaLane(deps: RelayMediaLaneDeps): RelayMediaLane {
  const pumps = new Map<string, MediaPump>();
  const serve = async (media: RelayMediaRequest): Promise<void> => {
    const { id } = media;
    const pump: MediaPump = { aborted: false, relayPaused: false };
    pumps.set(id, pump);
    const out: MediaWindowOutput = {
      get aborted() {
        return pump.aborted;
      },
      ready: async () => {
        while (!pump.aborted && (pump.relayPaused || deps.socketBacklog() > MEDIA_SOCKET_BACKLOG_BYTES)) {
          await sleep(MEDIA_POLL_MS);
        }
      },
      head: (status) =>
        deps.sendEnvelope({
          type: 'media-head',
          id,
          status,
          // The relay sees these anyway; the authenticated facts are in the meta frame.
          headers: status === 200 ? { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store' } : {},
        }),
      chunk: (frame) => deps.sendEnvelope({ type: 'media-chunk', id, data: Buffer.from(frame).toString('base64') }),
      end: () => deps.sendEnvelope({ type: 'media-end', id }),
      error: () => deps.sendEnvelope({ type: 'media-error', id }),
    };
    const session: MediaWindowSession = {
      mediaKey: () => (media.sid ? deps.mediaKey(media.sid) : null),
      device: () => deps.mediaDevice?.(media.sid) ?? null,
    };
    try {
      await serveMediaWindow(deps, media, session, out);
    } finally {
      if (pumps.get(id) === pump) pumps.delete(id);
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
