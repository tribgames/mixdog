// Media adapter of the direct transport (docs/remote-transport.md §3 "Media
// adapter"): the relay's HTTP media lane re-expressed as `transport-media`
// application messages on a session's sequenced stream. The window logic is
// the HTTP lane's own (remote-relay-media.ts serveMediaWindow), so range,
// version, lease and device semantics and the media encryption are identical
// on both lanes; only the carrier of the frames differs.
//
// The session is the stream's: a request names no `sid`, and the media key
// and the device a download lease must belong to are this session's.
//
// Flow control is the stream core's bulk admission
// (RemoteTransportSender.canAdmit({ stream, bufferedAmount })), which counts
// sealed boxes (charged per record) and the carrier's queued wire bytes
// (framing included), never plaintext: a record is sealed only while the
// carrier queue is at or below the low-water mark (so never above the
// high-water mark), the bulk share has room and this stream has credit. The
// pump waits for that before it reads the next segment, so a stalled phone
// or a full carrier stops the file reads, and an RPC sent during a download
// finds at most the low-water mark of media ahead of it.
import { parseMediaRequest } from '../../../../relay/lib/media-http.mjs';
import {
  REMOTE_TRANSPORT_MAX_MEDIA_STREAMS,
  REMOTE_TRANSPORT_MEDIA_TYPE,
  readRemoteTransportMedia,
  type RemoteTransportMedia,
  type RemoteTransportMediaStatus,
} from '../../shared/remote-transport';
import { serveMediaWindow, type MediaWindowOutput, type MediaWindowSources } from '../remote-relay-media';

/** What the adapter needs from its session's coordinator (1A). */
export interface RemoteTransportMediaLink {
  /** Whether a media record of `stream` may be sealed now:
   *  `sender.canAdmit({ stream, bufferedAmount })`, with the current
   *  carrier's queued wire bytes (data-channel `bufferedAmount` plus bytes on
   *  the main → peer-renderer IPC hop; on the relay carrier its socket
   *  backlog). */
  canAdmit(stream: string): boolean;
  /** Admits (the same check, at seal time), seals and pushes one media
   *  message as a bulk record, `sender.push(box, { stream })`, in the
   *  coordinator's serialized split → canAdmit → seal → sender path.
   *  Resolves false when refused before sealing (nothing sealed, the next
   *  sequence unchanged); rejects once the session ended. */
  send(message: RemoteTransportMedia, admission: { stream: string }): Promise<boolean>;
  /** Without `stream`: one small refusal (`error` before any head), sealed as
   *  an ordinary record (`canAdmit()` / `push(box)`, as an RPC result), so it
   *  never waits on bulk admission. Same resolution as above. */
  send(message: RemoteTransportMedia): Promise<boolean>;
  /** Called whenever admission may have opened: an ack advance, the
   *  carrier's `bufferedamountlow`, a carrier change. Returns the unsubscribe. */
  onWritable(listener: () => void): () => void;
  /** The phone broke the media bound: end the session as for any other
   *  admission or protocol violation (close reason `protocol-error`). */
  protocolError(detail: string): void;
}

export interface RemoteTransportMediaDeps extends MediaWindowSources {
  link: RemoteTransportMediaLink;
  /** This session's media key (`RelayE2EEChannel.mediaKey`); null when the
   *  session negotiated no media lane. */
  mediaKey: CryptoKey | null;
  /** This session's paired device, named exactly as the relay lane names it
   *  (remote-relay.ts mediaDevice: the relay credential, else
   *  `connection:<clientId>`). */
  device: string | null;
}

export interface RemoteTransportMediaAdapter {
  /** One authenticated application payload from the phone. True when it was
   *  a media message (consumed, a malformed one included); false otherwise. */
  receive(payload: unknown): boolean;
  /** The session ended: every pump stops; nothing more is sent. */
  close(): void;
}

interface MediaStream {
  readonly id: string;
  aborted: boolean;
  wake: (() => void) | null;
}

export function createRemoteTransportMediaAdapter(deps: RemoteTransportMediaDeps): RemoteTransportMediaAdapter {
  const type = REMOTE_TRANSPORT_MEDIA_TYPE;
  // Running pumps only: at most REMOTE_TRANSPORT_MAX_MEDIA_STREAMS.
  const streams = new Map<string, MediaStream>();
  // Ids of refused requests whose `error` is not sealed yet, oldest first.
  // A conforming phone never has more than the stream limit outstanding
  // (its client refuses a 33rd window itself, and a cancel takes a queued
  // refusal back), so this holds at most that many; one more ends the session.
  const refusals: string[] = [];
  const refuser: MediaStream = { id: '', aborted: false, wake: null };
  let refusing = false;
  let closed = false;
  // Counts writable notifications. A waiter compares it with the value it
  // saw before its admission check or send, so a notification that came in
  // between is never slept through.
  let generation = 0;
  const wake = (stream: MediaStream): void => {
    const resolve = stream.wake;
    stream.wake = null;
    resolve?.();
  };
  const unsubscribe = deps.link.onWritable(() => {
    generation += 1;
    for (const stream of streams.values()) wake(stream);
    wake(refuser);
  });
  /** Resolves on the first notification after `seen` (at once if one already
   *  came) or on an abort. Checked and armed in one step, so nothing between
   *  can be lost. */
  const changed = (stream: MediaStream, seen: number): Promise<void> =>
    stream.aborted || generation !== seen
      ? Promise.resolve()
      : new Promise((resolve) => {
          stream.wake = resolve;
        });
  const abort = (stream: MediaStream): void => {
    stream.aborted = true;
    wake(stream);
  };
  // The reader and every record wait here for room, never the coordinator.
  const admissible = async (stream: MediaStream): Promise<void> => {
    for (;;) {
      if (stream.aborted) return;
      const seen = generation;
      if (deps.link.canAdmit(stream.id)) return;
      await changed(stream, seen);
    }
  };
  const deliver = async (stream: MediaStream, message: RemoteTransportMedia): Promise<void> => {
    for (;;) {
      await admissible(stream);
      if (stream.aborted) return;
      const seen = generation;
      let sent: boolean;
      try {
        sent = await deps.link.send(message, { stream: stream.id });
      } catch {
        abort(stream);
        return;
      }
      if (sent || stream.aborted) return;
      // Another record took the room between the check and the seal; room
      // that came back while the send was pending is retried at once.
      await changed(stream, seen);
    }
  };
  // One loop seals every queued refusal, as ordinary records: refusals
  // never wait on bulk admission and never hold a promise per request.
  const refuse = async (): Promise<void> => {
    refusing = true;
    while (refusals.length > 0 && !closed) {
      const id = refusals[0];
      const seen = generation;
      let sent: boolean;
      try {
        sent = await deps.link.send({ type, op: 'error', id });
      } catch {
        break;
      }
      if (sent) {
        const at = refusals.indexOf(id);
        if (at >= 0) refusals.splice(at, 1);
      } else {
        await changed(refuser, seen);
      }
    }
    refusing = false;
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe();
    for (const stream of streams.values()) abort(stream);
    abort(refuser);
    refusals.length = 0;
  };
  const output = (stream: MediaStream): MediaWindowOutput => {
    const { id } = stream;
    return {
      get aborted() {
        return stream.aborted;
      },
      ready: () => admissible(stream),
      head: (status) => deliver(stream, { type, op: 'head', id, status: status as RemoteTransportMediaStatus }),
      chunk: (frame) => deliver(stream, { type, op: 'chunk', id, frame: Buffer.from(frame).toString('base64url') }),
      end: () => deliver(stream, { type, op: 'end', id }),
      error: () => deliver(stream, { type, op: 'error', id }),
    };
  };
  const session = { mediaKey: () => deps.mediaKey, device: () => deps.device };
  return {
    receive(payload) {
      let message: RemoteTransportMedia | null;
      try {
        message = readRemoteTransportMedia(payload, 'client');
      } catch {
        return true;
      }
      if (!message) return false;
      const active = streams.get(message.id);
      const queued = refusals.indexOf(message.id);
      if (message.op === 'cancel') {
        if (active) abort(active);
        // The phone stopped waiting: its refusal need not be sent.
        if (queued >= 0) refusals.splice(queued, 1);
        return true;
      }
      // An id is one stream for its whole life; a repeat is ignored.
      if (message.op !== 'request' || closed || active || queued >= 0) return true;
      if (streams.size >= REMOTE_TRANSPORT_MAX_MEDIA_STREAMS) {
        // As the relay refuses a 33rd stream before any head (503). Nothing
        // is allocated for it but its id in the bounded refusal queue.
        if (refusals.length >= REMOTE_TRANSPORT_MAX_MEDIA_STREAMS) {
          close();
          deps.link.protocolError('media streams');
          return true;
        }
        refusals.push(message.id);
        if (!refusing) void refuse();
        return true;
      }
      const stream: MediaStream = { id: message.id, aborted: false, wake: null };
      streams.set(stream.id, stream);
      const out = output(stream);
      // The relay's own route check (asset id shape, known variants), which
      // answers 404 on the HTTP lane before the desktop is asked.
      const routed = parseMediaRequest(`/media/${message.assetId}`, new URLSearchParams({ variant: message.variant }));
      const serving = routed
        ? serveMediaWindow(deps, { ...message, method: 'GET' }, session, out)
        : (async () => {
            await out.head(404);
            await out.end();
          })();
      void serving.finally(() => {
        if (streams.get(stream.id) === stream) streams.delete(stream.id);
      });
      return true;
    },
    close,
  };
}
