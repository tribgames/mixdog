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
  remoteWebrtcSourceKey,
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
  /** A captured source's track was asked for (`source-capture`). */
  captured: boolean;
}

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
        captured: false,
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
    deps.sender.send({
      type: 'frame',
      sourceKey,
      frameId: feed.serial,
      pixelWidth: picture.geometry.pixelWidth,
      pixelHeight: picture.geometry.pixelHeight,
      mimeType: picture.mimeType,
      data: picture.data,
    });
  }

  function senderStats(connectionId: string): Promise<Extract<RemoteWebrtcSenderEvent, { type: 'stats' }>['stats']> {
    statsRequest += 1;
    const requestId = statsRequest;
    return new Promise((resolve) => {
      statsWaiters.set(requestId, resolve);
      deps.sender.send({ type: 'stats', connectionId, requestId });
    });
  }

  /** One measurement line: the sender's view, the capture counters, and the
   *  phone's own report when it sent one. */
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
    deps.report(event, { source: entry.sourceKey, sender: stats, ...(receiver ? { receiver } : {}) });
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
        // A captured source's track is opened from its plan, once, before
        // its first connection.
        const feed = feeds.get(sourceKey);
        const plan = source.capturePlan?.();
        if (plan && feed && !feed.captured) {
          feed.captured = true;
          deps.sender.send({ type: 'source-capture', sourceKey, plan });
        }
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
    });
    return entry;
  }

  function onSenderEvent(event: RemoteWebrtcSenderEvent | null): void {
    if (!event) {
      // The sender renderer is gone: every live connection falls back.
      for (const entry of new Set(connections.values())) entry.viewer.fail('sender-failed');
      for (const feed of feeds.values()) feed.inFlight = null;
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
        if (feed) feed.captured = false;
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
      const plan = feed?.captured ? feed.source.capturePlan?.() : null;
      if (plan) deps.sender.send({ type: 'source-capture', sourceKey, plan });
    },

    dispose(): void {
      for (const key of [...viewers.keys()]) stopViewer(key);
    },
  };

  function handleSignal(clientId: string, raw: unknown, iceServers: unknown): void {
    {
      if (!CLIENT_ID.test(clientId)) throw new TypeError('remote webrtc client id is invalid.');
      const signal = parseRemoteWebrtcClientSignal(raw);
      const source = deps.sources(signal.source);
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
