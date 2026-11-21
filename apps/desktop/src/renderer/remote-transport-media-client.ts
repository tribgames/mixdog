import {
  REMOTE_TRANSPORT_MAX_MEDIA_STREAMS,
  REMOTE_TRANSPORT_MEDIA_TYPE,
  readRemoteTransportMedia,
  type RemoteTransportMedia,
} from '../shared/remote-transport';
import { bytesFromBase64 } from './remote-file-range';

const MEDIA_TRANSPORT_MESSAGE = 'mixdog:media-transport';
const MEDIA_KEY_REQUEST_MESSAGE = 'mixdog:media-key-request';

/** The service worker side the transport media client talks to. */
export interface MediaWorkerContainer {
  readonly controller: { postMessage(message: unknown, transfer: Transferable[]): void } | null;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface RemoteTransportMediaClient {
  /** Offers this transport to the controlling service worker as the media
   *  lane of session `sid` (the label of its media key), and again whenever
   *  the worker asks for that key (a restarted worker lost the port too). */
  attach(sid: string): void;
  /** One authenticated application payload from the desktop. True when it
   *  was a media message (consumed); false otherwise. */
  receive(payload: unknown): boolean;
  /** The transport session ended: windows not yet answered go back to the
   *  HTTP lane, answered ones fail, and the worker drops the port. */
  close(): void;
}

function bytesFromBase64Url(data: string): Uint8Array {
  return bytesFromBase64(data.replace(/-/g, '+').replace(/_/g, '/'));
}

/**
 * Page half of the direct media lane (docs/remote-transport.md §3 "Media
 * adapter"; public/sw-media.js is the worker half). The worker asks for a
 * window over the port `attach` hands it; this sends it as a
 * `transport-media` request on the session's stream and passes the desktop's
 * head, frames and end back unchanged, so the worker decrypts and checks them
 * exactly as on the HTTP lane. A window this client cannot take (no session,
 * the stream limit, a request the contract refuses) is answered
 * `unavailable`, and the worker takes the HTTP lane instead.
 */
export function createRemoteTransportMediaClient(deps: {
  send(message: RemoteTransportMedia): void | Promise<void>;
  container?: MediaWorkerContainer | null;
}): RemoteTransportMediaClient {
  const pageContainer = (): MediaWorkerContainer | null =>
    typeof navigator === 'undefined'
      ? null
      : ((navigator.serviceWorker as unknown as MediaWorkerContainer | undefined) ?? null);
  const container = deps.container !== undefined ? deps.container : pageContainer();
  const windows = new Map<string, { reply: MessagePort; headed: boolean }>();
  let sid: string | null = null;
  let next = 0;
  let closed = false;
  const type = REMOTE_TRANSPORT_MEDIA_TYPE;
  const finish = (id: string, message: { op: string }): void => {
    const entry = windows.get(id);
    if (!entry) return;
    windows.delete(id);
    entry.reply.postMessage(message);
    entry.reply.close();
  };
  const unavailable = (reply: MessagePort): void => {
    reply.postMessage({ op: 'unavailable' });
    reply.close();
  };
  const open = (data: unknown): void => {
    const asked = data as {
      op?: unknown;
      port?: unknown;
      assetId?: unknown;
      variant?: unknown;
      range?: unknown;
      enc?: unknown;
    } | null;
    if (asked?.op !== 'request' || !(asked.port instanceof MessagePort)) return;
    const reply = asked.port;
    const id = `m${++next}`;
    let parsed: RemoteTransportMedia | null = null;
    try {
      parsed = readRemoteTransportMedia(
        { type, op: 'request', id, assetId: asked.assetId, variant: asked.variant, range: asked.range, enc: asked.enc },
        'client'
      );
    } catch {
      parsed = null;
    }
    if (closed || !parsed || windows.size >= REMOTE_TRANSPORT_MAX_MEDIA_STREAMS) {
      unavailable(reply);
      return;
    }
    const request = parsed;
    windows.set(id, { reply, headed: false });
    reply.onmessage = (event: MessageEvent) => {
      if ((event.data as { op?: unknown } | null)?.op !== 'cancel' || !windows.has(id)) return;
      windows.delete(id);
      reply.close();
      void Promise.resolve()
        .then(() => deps.send({ type, op: 'cancel', id }))
        .catch(() => undefined);
    };
    void Promise.resolve()
      .then(() => deps.send(request))
      .catch(() => {
        if (windows.get(id)?.headed === false) {
          windows.delete(id);
          unavailable(reply);
        }
      });
  };
  let lane: MessagePort | null = null;
  const publish = (): void => {
    const controller = container?.controller;
    if (closed || !sid || !controller) return;
    lane?.close();
    const channel = new MessageChannel();
    lane = channel.port1;
    lane.onmessage = (event: MessageEvent) => open(event.data);
    controller.postMessage({ type: MEDIA_TRANSPORT_MESSAGE, sid, port: channel.port2 }, [channel.port2]);
  };
  const onWorkerMessage = (event: MessageEvent): void => {
    const data = event.data as { type?: unknown; sid?: unknown } | null;
    if (data?.type === MEDIA_KEY_REQUEST_MESSAGE && data.sid === sid) publish();
  };
  return {
    attach(value) {
      if (closed) return;
      if (sid === null) container?.addEventListener('message', onWorkerMessage);
      sid = value;
      publish();
    },
    receive(payload) {
      let message: RemoteTransportMedia | null;
      try {
        message = readRemoteTransportMedia(payload, 'desktop');
      } catch {
        const id = (payload as { id?: unknown }).id;
        if (typeof id === 'string') finish(id, { op: 'error' });
        return true;
      }
      if (!message) return false;
      const entry = windows.get(message.id);
      if (!entry) return true;
      if (message.op === 'head') {
        entry.headed = true;
        entry.reply.postMessage({ op: 'head', status: message.status });
      } else if (message.op === 'chunk') {
        const frame = bytesFromBase64Url(message.frame);
        entry.reply.postMessage({ op: 'chunk', frame }, [frame.buffer as ArrayBuffer]);
      } else {
        finish(message.id, { op: message.op });
      }
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      container?.removeEventListener('message', onWorkerMessage);
      for (const [id, entry] of [...windows]) finish(id, { op: entry.headed ? 'error' : 'unavailable' });
      if (sid) container?.controller?.postMessage({ type: MEDIA_TRANSPORT_MESSAGE, sid, port: null }, []);
    },
  };
}
