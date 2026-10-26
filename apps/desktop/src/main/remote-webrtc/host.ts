/**
 * Window-process WebRTC host: one viewer state machine per paired client ×
 * source, the sources' newest pictures fed to the sender renderer (one in
 * flight per source, superseded ones dropped), and the sender's events routed
 * back to their viewer. Phone signals arrive validated by the service; they
 * are validated again here, as every input crossing a process is.
 */
import { randomBytes } from 'node:crypto';

import {
  REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
  parseRemoteWebrtcClientSignal,
  remoteWebrtcCandidatePath,
  remoteWebrtcSourceKey,
  type RemoteWebrtcChannelPush,
  type RemoteWebrtcDesktopSignal,
  type RemoteWebrtcGeometry,
  type RemoteWebrtcIceServer,
  type RemoteWebrtcReceiverStats,
  type RemoteWebrtcSenderStats,
} from '../../shared/remote-webrtc';
import type { RemoteWebrtcSenderCommand, RemoteWebrtcSenderEvent } from '../../shared/remote-webrtc-sender';
import type { RemoteWebrtcPicture, RemoteWebrtcSourceResolver, RemoteWebrtcVideoSource } from './source';
import { createRemoteWebrtcViewer, type RemoteWebrtcViewer } from './viewer';

export interface RemoteWebrtcSenderBridge {
  send(command: RemoteWebrtcSenderCommand): void;
  /** Sender events; `null` when the sender renderer is gone (crash, close). */
  onEvent(listener: (event: RemoteWebrtcSenderEvent | null) => void): void;
}

export interface RemoteWebrtcHostDeps {
  sender: RemoteWebrtcSenderBridge;
  /** To one phone, through the service's E2EE relay. */
  sendSignal(clientId: string, signal: RemoteWebrtcDesktopSignal): Promise<unknown>;
  sources: RemoteWebrtcSourceResolver;
  report(event: string, data: Record<string, unknown>): void;
}

interface SourceFeed {
  source: RemoteWebrtcVideoSource;
  latest: RemoteWebrtcPicture | null;
  /** The newest picture the sender took, resent when a connection comes up. */
  delivered: RemoteWebrtcPicture | null;
  inFlight: { frameId: number; picture: RemoteWebrtcPicture } | null;
  serial: number;
  /** `documentId|generation` the counts below belong to. */
  currentKey: string;
  framesSinceCurrent: number;
  framesCaptured: number;
  framesSuperseded: number;
  /** The track the running sender renderer was asked to give this source
   *  (`source-capture` / `source-draw`); `none` until its first connection,
   *  and again after the renderer is gone (its tracks went with it). */
  track: 'none' | 'capture' | 'drawn';
  /** The path main selected for a captured source: drawn (pushed pictures,
   *  `drawnTrack`) rather than its capture. Survives a sender crash. */
  drawn: boolean;
}

/** The pixels in an array of their own: the IPC to the sender would copy a
 *  view's whole buffer otherwise (a helper frame's rows view its frame). Done
 *  for the picture actually sent only. */
const ownBytes = (pixels: Uint8Array): Uint8Array =>
  pixels.byteOffset === 0 && pixels.byteLength === pixels.buffer.byteLength ? pixels : pixels.slice();

interface ViewerEntry {
  clientId: string;
  sourceKey: string;
  viewer: RemoteWebrtcViewer;
}

const CLIENT_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const pageKey = (documentId: string | null, geometry: RemoteWebrtcGeometry | null) =>
  `${documentId ?? ''}|${geometry?.generation ?? 0}`;

/** Live connection states: the sender holds a peer connection for them. */
const LIVE = new Set(['negotiating', 'connected', 'promoting', 'webrtc']);

export function createRemoteWebrtcHost(deps: RemoteWebrtcHostDeps) {
  const viewers = new Map<string, ViewerEntry>();
  const feeds = new Map<string, SourceFeed>();
  /** Sender connection id → its viewer. */
  const connections = new Map<string, ViewerEntry>();
  /** Signals pushed while handling one phone signal: its reply waits for them,
   *  so a `demote` caused by the phone's `close` reaches it before the answer. */
  let outbox: Promise<void>[] = [];
  let statsRequest = 0;
  const statsWaiters = new Map<number, (stats: Extract<RemoteWebrtcSenderEvent, { type: 'stats' }>['stats']) => void>();

  const viewerKey = (clientId: string, sourceKey: string) => `${clientId}\u0000${sourceKey}`;

  function feedFor(source: RemoteWebrtcVideoSource): SourceFeed {
    const key = remoteWebrtcSourceKey(source.source);
    let feed = feeds.get(key);
    if (!feed) {
      feed = {
        source,
        latest: null,
        delivered: null,
        inFlight: null,
        serial: 0,
        currentKey: '',
        framesSinceCurrent: 0,
        framesCaptured: 0,
        framesSuperseded: 0,
        track: 'none',
        drawn: false,
      };
      feeds.set(key, feed);
    }
    return feed;
  }

  /** Whether any viewer of the source holds a peer connection now. */
  const wanted = (sourceKey: string): boolean =>
    [...viewers.values()].some((entry) => entry.sourceKey === sourceKey && LIVE.has(entry.viewer.state));

  /** Hand the newest picture to the sender, one in flight per source. */
  function pump(sourceKey: string): void {
    const feed = feeds.get(sourceKey);
    if (!feed || feed.inFlight || !feed.latest || !wanted(sourceKey)) return;
    const picture = feed.latest;
    feed.latest = null;
    feed.serial += 1;
    feed.inFlight = { frameId: feed.serial, picture };
    const frame = {
      type: 'frame' as const,
      sourceKey,
      frameId: feed.serial,
      pixelWidth: picture.geometry.pixelWidth,
      pixelHeight: picture.geometry.pixelHeight,
    };
    deps.sender.send(
      picture.mimeType === 'image/x-bgrx'
        ? {
            ...frame,
            mimeType: picture.mimeType,
            pixels: ownBytes(picture.pixels),
            width: picture.width,
            height: picture.height,
            stride: picture.stride,
            source: picture.source,
            target: picture.target,
          }
        : { ...frame, mimeType: picture.mimeType, data: picture.data }
    );
  }

  /** Gives a captured source the track its selected path needs, in the
   *  running sender: its capture from the current plan, or a drawn track. */
  function requestTrack(sourceKey: string, feed: SourceFeed): void {
    if (feed.drawn) {
      feed.track = 'drawn';
      deps.sender.send({ type: 'source-draw', sourceKey });
      return;
    }
    const plan = feed.source.capturePlan?.();
    if (!plan) return;
    feed.track = 'capture';
    deps.sender.send({ type: 'source-capture', sourceKey, plan });
  }

  function senderStats(connectionId: string): Promise<Extract<RemoteWebrtcSenderEvent, { type: 'stats' }>['stats']> {
    statsRequest += 1;
    const requestId = statsRequest;
    return new Promise((resolve) => {
      statsWaiters.set(requestId, resolve);
      deps.sender.send({ type: 'stats', connectionId, requestId });
    });
  }

  /** One measurement line: the sender's view, the capture counters, the
   *  phone's own report when it sent one, and the path the connection is on
   *  (`direct` or `relay`, from the selected candidate pair; ICE may move it
   *  to a better pair later, which the next sample shows). */
  async function measure(entry: ViewerEntry, event: string, receiver?: RemoteWebrtcReceiverStats): Promise<void> {
    const connectionId = entry.viewer.connectionId;
    if (!connectionId) return;
    const outbound = await senderStats(connectionId);
    const feed = feeds.get(entry.sourceKey);
    const stats: RemoteWebrtcSenderStats | null = outbound
      ? {
          ...outbound,
          generation: entry.viewer.generation,
          framesCaptured: feed?.framesCaptured ?? 0,
          framesSuperseded: feed?.framesSuperseded ?? 0,
        }
      : null;
    const pair = stats?.candidatePair ?? receiver?.candidatePair;
    deps.report(event, {
      source: entry.sourceKey,
      ...(pair ? { path: remoteWebrtcCandidatePath(pair) } : {}),
      sender: stats,
      ...(receiver ? { receiver } : {}),
    });
  }

  function createViewer(clientId: string, source: RemoteWebrtcVideoSource): ViewerEntry {
    const sourceKey = remoteWebrtcSourceKey(source.source);
    const entry: ViewerEntry = { clientId, sourceKey, viewer: undefined as unknown as RemoteWebrtcViewer };
    entry.viewer = createRemoteWebrtcViewer(source.source, {
      signal: (signal) => {
        const sent = deps.sendSignal(clientId, signal).then(
          () => undefined,
          (error: unknown) => {
            deps.report('signal-failed', { source: sourceKey, type: signal.type, error: String(error) });
          }
        );
        outbox.push(sent);
      },
      release: async (releases) => {
        if (source.release) {
          await source.release();
          return;
        }
        for (const control of releases) await source.dispatch(control).catch(() => undefined);
      },
      open: ({ connectionId, iceServers, receiveCodecs }) => {
        connections.set(connectionId, entry);
        source.start();
        // A captured source's track (its capture, or the drawn one while it
        // draws) is set up once per sender renderer, before its first
        // connection there.
        const feed = feeds.get(sourceKey);
        if (feed && feed.track === 'none' && (feed.drawn || source.capturePlan)) requestTrack(sourceKey, feed);
        deps.sender.send({
          type: 'open',
          connectionId,
          sourceKey,
          iceServers,
          iceTransportPolicy: REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
          receiveCodecs,
        });
        pump(sourceKey);
      },
      answer: (connectionId, sdp) => deps.sender.send({ type: 'answer', connectionId, sdp }),
      candidate: (connectionId, candidate) => deps.sender.send({ type: 'candidate', connectionId, candidate }),
      channelSend: (connectionId, text) => deps.sender.send({ type: 'channel-send', connectionId, text }),
      close: (connectionId) => {
        if (connections.get(connectionId) !== entry) return;
        connections.delete(connectionId);
        deps.sender.send({ type: 'close', connectionId });
        if (!wanted(sourceKey) && ![...connections.values()].some((other) => other.sourceKey === sourceKey)) {
          source.stop();
        }
      },
      dispatch: (control) => source.dispatch(control),
      page: () => {
        const page = source.page();
        const feed = feeds.get(sourceKey);
        const fresh = feed?.currentKey === pageKey(page.documentId, page.geometry);
        return { ...page, framesSinceCurrent: fresh ? feed!.framesSinceCurrent : 0 };
      },
      newConnectionId: () => randomBytes(18).toString('base64url'),
      // Wall clock: the sender stamps channel receipt with Date.now() too.
      now: () => Date.now(),
      setTimer: (run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return timer;
      },
      clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
      report: (event, data) => {
        deps.report(event, { source: sourceKey, ...data });
        // The selected pair, the encoder actually in use and the frame
        // counters, once the channel owns the view.
        if (event === 'state' && data.to === 'webrtc') void measure(entry, 'promoted');
      },
      receiverStats: (stats) => void measure(entry, 'stats', stats),
      frameSeen: (epoch) => source.frameSeen?.(epoch),
      helperGrant: (grant) => source.helperGrant?.(grant),
      helperInstall: (controllerKey) => source.helperInstall?.(controllerKey),
      promoted: () => {
        for (const message of source.channelState?.() ?? []) entry.viewer.push(JSON.stringify(message));
      },
    });
    return entry;
  }

  function onSenderEvent(event: RemoteWebrtcSenderEvent | null): void {
    if (!event) {
      // The sender renderer is gone, and every track it held with it: each
      // source's track is set up again (its selected path) before its next
      // connection opens; every live connection falls back.
      for (const feed of feeds.values()) {
        feed.inFlight = null;
        feed.track = 'none';
      }
      for (const entry of new Set(connections.values())) entry.viewer.fail('sender-failed');
      for (const [requestId, resolve] of statsWaiters) {
        statsWaiters.delete(requestId);
        resolve(null);
      }
      return;
    }
    switch (event.type) {
      case 'ready':
        return;
      case 'frame-done': {
        const feed = feeds.get(event.sourceKey);
        if (!feed?.inFlight || feed.inFlight.frameId !== event.frameId) return;
        const { picture } = feed.inFlight;
        feed.inFlight = null;
        if (event.ok) {
          feed.delivered = picture;
          const page = feed.source.page();
          const key = pageKey(page.documentId, page.geometry);
          if (key !== feed.currentKey) {
            feed.currentKey = key;
            feed.framesSinceCurrent = 0;
          }
          if (pageKey(picture.documentId, picture.geometry) === key) feed.framesSinceCurrent += 1;
          feed.source.delivered?.(picture.epoch ?? 0);
        }
        pump(event.sourceKey);
        return;
      }
      case 'stats': {
        const resolve = statsWaiters.get(event.requestId);
        statsWaiters.delete(event.requestId);
        resolve?.(event.stats);
        return;
      }
      case 'source-captured': {
        if (event.ok) {
          // A live capture track delivers frames of the current geometry by itself.
          const feed = feeds.get(event.sourceKey);
          if (feed) {
            const page = feed.source.page();
            feed.currentKey = pageKey(page.documentId, page.geometry);
            feed.framesSinceCurrent = 1;
          }
          return;
        }
        // No track to send: every connection of that source falls back.
        deps.report('capture-failed', { source: event.sourceKey, detail: event.detail ?? '' });
        const feed = feeds.get(event.sourceKey);
        if (feed) feed.track = 'none';
        for (const entry of new Set(connections.values())) {
          if (entry.sourceKey === event.sourceKey) entry.viewer.fail('sender-failed');
        }
        return;
      }
    }
    const entry = connections.get(event.connectionId);
    if (!entry) return;
    switch (event.type) {
      case 'offer':
        entry.viewer.senderOffer(event.connectionId, event.sdp);
        return;
      case 'candidate':
        entry.viewer.senderCandidate(event.connectionId, event.candidate);
        return;
      case 'connected': {
        entry.viewer.senderConnected(event.connectionId, event.remoteCertificate);
        // A static page sends no new picture: the newest one goes again, so
        // the fresh connection has a frame to decode.
        const feed = feeds.get(entry.sourceKey);
        if (feed && !feed.latest && feed.delivered) feed.latest = feed.delivered;
        pump(entry.sourceKey);
        return;
      }
      case 'failed':
        entry.viewer.senderFailed(event.connectionId, event.reason);
        return;
      case 'channel':
        entry.viewer.channel(event.connectionId, event.text, event.receivedAt);
        return;
    }
  }

  deps.sender.onEvent(onSenderEvent);

  function stopViewer(key: string): void {
    const entry = viewers.get(key);
    if (!entry) return;
    viewers.delete(key);
    entry.viewer.stop();
  }

  return {
    /** A phone's signal, forwarded by the service with the client it came
     *  from; settles once every signal it caused has been handed to the relay. */
    async signal(clientId: string, raw: unknown, iceServers: unknown): Promise<void> {
      outbox = [];
      handleSignal(clientId, raw, iceServers);
      const sent = outbox;
      outbox = [];
      await Promise.all(sent);
    },

    /** The client stopped streaming the source (or left the relay). */
    viewerLeft(clientId: string, sourceKey: string): void {
      stopViewer(viewerKey(clientId, sourceKey));
    },

    /** A source locked a new geometry generation, or ended (null). */
    geometryChanged(sourceKey: string, geometry: RemoteWebrtcGeometry | null): void {
      for (const [key, entry] of [...viewers]) {
        if (entry.sourceKey !== sourceKey) continue;
        if (geometry) entry.viewer.geometryChanged();
        else stopViewer(key);
      }
      if (!geometry) {
        feeds.delete(sourceKey);
        deps.sender.send({ type: 'source-close', sourceKey });
      }
    },

    /** A source's newest picture; an older one not yet taken is superseded. */
    frame(sourceKey: string, picture: RemoteWebrtcPicture): void {
      const feed = feeds.get(sourceKey);
      if (!feed) return;
      feed.framesCaptured += 1;
      if (feed.latest) feed.framesSuperseded += 1;
      feed.latest = picture;
      pump(sourceKey);
    },

    /** A captured source's plan changed: the sender reopens its track. */
    captureChanged(sourceKey: string): void {
      const feed = feeds.get(sourceKey);
      // While it draws, the capture reopens from the plan current when it ends.
      if (feed?.track === 'capture') requestTrack(sourceKey, feed);
    },

    /** A captured source's track switches to a drawn one (pictures from
     *  `frame`) or back to its capture, in place on every connection (in a
     *  sender that has none yet, at its first connection). Every picture of
     *  the other path is dropped: the waiting one, the one resent to a new
     *  connection, and the one in flight, whose late `frame-done` matches
     *  nothing any more. */
    drawnTrack(sourceKey: string, drawn: boolean): void {
      const feed = feeds.get(sourceKey);
      if (!feed || feed.drawn === drawn) return;
      feed.drawn = drawn;
      feed.latest = null;
      feed.delivered = null;
      feed.inFlight = null;
      if (feed.track !== 'none') requestTrack(sourceKey, feed);
    },

    /** A source's desktop → phone channel message, to each of its viewers
     *  whose channel is up. */
    channelPush(sourceKey: string, message: RemoteWebrtcChannelPush): void {
      const text = JSON.stringify(message);
      for (const entry of viewers.values()) if (entry.sourceKey === sourceKey) entry.viewer.push(text);
    },

    dispose(): void {
      for (const key of [...viewers.keys()]) stopViewer(key);
    },
  };

  function handleSignal(clientId: string, raw: unknown, iceServers: unknown): void {
    {
      if (!CLIENT_ID.test(clientId)) throw new TypeError('remote webrtc client id is invalid.');
      const signal = parseRemoteWebrtcClientSignal(raw);
      const source = deps.sources(signal.source, { clientId, signal: signal.type });
      if (!source) throw new TypeError('remote webrtc source is not streamed.');
      const sourceKey = remoteWebrtcSourceKey(signal.source);
      const key = viewerKey(clientId, sourceKey);
      let entry = viewers.get(key);
      if (!entry) {
        entry = createViewer(clientId, source);
        viewers.set(key, entry);
        feedFor(source);
        // The locked geometry goes to every new viewer first.
        entry.viewer.geometryChanged();
      }
      switch (signal.type) {
        case 'ready':
          // A larger video limit than the stream's frame bound widens the
          // capture before the offer, which then carries the new geometry.
          if (signal.videoLimit) source.videoLimit?.(signal.videoLimit);
          entry.viewer.ready(signal.receiveCodecs, Array.isArray(iceServers) ? (iceServers as RemoteWebrtcIceServer[]) : []);
          return;
        case 'geometry-ack':
          entry.viewer.geometryAck(signal.geometryGeneration);
          return;
        case 'resize-request':
          void source.resize?.(signal.resize).catch((error: unknown) => {
            deps.report('resize-failed', { source: sourceKey, error: String(error) });
          });
          return;
        case 'close':
          // The phone's viewer left: closed, not demoted (the channel's held
          // buttons are still released), and forgotten — its next `ready` is
          // a new viewer.
          if (signal.reason === 'viewer-left') {
            if (signal.connectionId === entry.viewer.connectionId) stopViewer(key);
            return;
          }
          entry.viewer.signal(signal);
          return;
        default:
          entry.viewer.signal(signal);
      }
    }
  }
}

export type RemoteWebrtcHost = ReturnType<typeof createRemoteWebrtcHost>;
