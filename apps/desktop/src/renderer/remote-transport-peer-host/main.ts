/**
 * The direct-transport peer host (hidden trusted window, see
 * main/remote-transport/peer-window.ts; docs/remote-transport.md §3, §5, §9 1B).
 * It owns every transport RTCPeerConnection of this PC. The PC always offers:
 * per connection it creates both channels before the offer, applies the
 * phone's answer and candidates, and moves carrier messages as binary in both
 * directions. Window main stays the authority: it validates every signal,
 * checks the DTLS certificate against the signaled fingerprints and keeps the
 * backpressure accounting; this page only runs the peer connections and
 * reports.
 *
 * Ordering promise to main: for one connection, `connected` (the remote
 * certificate) is emitted before `open`, and `open` before any `message`, so
 * main has checked the certificate before it sees a byte from the peer.
 */
import {
  REMOTE_TRANSPORT_BUFFER_HIGH_BYTES,
  REMOTE_TRANSPORT_BUFFER_LOW_BYTES,
  REMOTE_TRANSPORT_CHANNEL_LABEL,
  REMOTE_TRANSPORT_CONTROL_CHANNEL_LABEL,
} from '../../shared/remote-transport';
import {
  REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
  remoteWebrtcCandidatePath,
  type RemoteWebrtcCandidate,
  type RemoteWebrtcCandidateType,
  type RemoteWebrtcIceServer,
} from '../../shared/remote-webrtc';

// ---------------------------------------------------------------------------
// Window main ↔ peer host protocol (channel names: REMOTE_TRANSPORT_PEER_IPC in
// main/remote-transport/peer-window.ts). Carrier bytes travel as Uint8Array
// through structured clone: binary, never base64.
// ---------------------------------------------------------------------------

/** `app` is `mixdog-transport` (reliable, ordered; kinds 1 and 2), `control`
 *  is `mixdog-transport-control` (reliable, ordered, its own SCTP stream; kind
 *  3). Messages reach main one per event in arrival order, never batched or
 *  reordered: each control lane opens its boxes in seal order. */
export type RemoteTransportPeerChannel = 'app' | 'control';

export interface RemoteTransportPeerSendItem {
  connectionId: string;
  channel: RemoteTransportPeerChannel;
  data: Uint8Array;
}

export type RemoteTransportPeerCommand =
  | { type: 'create'; connectionId: string; iceServers: RemoteWebrtcIceServer[] }
  /** The first offer, or an ICE restart (`iceRestart`) on the same connection. */
  | { type: 'offer'; connectionId: string; iceRestart: boolean }
  | { type: 'answer'; connectionId: string; sdp: string }
  | { type: 'candidate'; connectionId: string; candidate: RemoteWebrtcCandidate | null }
  /** Carrier messages, in order; every item is answered by a `sent` report. */
  | { type: 'send'; items: RemoteTransportPeerSendItem[] }
  /** Report both channels' `bufferedAmount` now. */
  | { type: 'sample'; connectionId: string }
  | { type: 'close'; connectionId: string };

export type RemoteTransportPeerFailure =
  | 'ice-failed'
  | 'dtls-failed'
  | 'channel-failed'
  | 'protocol-error'
  | 'peer-host-unavailable';

export type RemoteTransportPeerEvent =
  | { type: 'ready' }
  | { type: 'offer'; connectionId: string; sdp: string }
  /** A local candidate; `relayProtocol`/`url` only on a TURN relay candidate. */
  | {
      type: 'candidate';
      connectionId: string;
      candidate: RemoteWebrtcCandidate | null;
      relayProtocol?: string;
      url?: string;
    }
  /** DTLS is up: the certificate the transport negotiated. */
  | {
      type: 'connected';
      connectionId: string;
      remoteCertificate: { fingerprint?: string; fingerprintAlgorithm?: string } | null;
    }
  /** Both channels are open: `pc.sctp.maxMessageSize` (+∞ when unlimited) and
   *  the selected pair's path. */
  | { type: 'open'; connectionId: string; maxMessageSize: number | null; path: 'direct' | 'turn' | null }
  | { type: 'message'; connectionId: string; channel: RemoteTransportPeerChannel; data: Uint8Array }
  /** A `send` was handed to the channel (or dropped, channel not open):
   *  `bytes` leave the IPC hop, `bufferedAmount` is read right after. */
  | { type: 'sent'; connectionId: string; channel: RemoteTransportPeerChannel; bytes: number; bufferedAmount: number }
  /** `bufferedAmount` on a drain to the low threshold, or on `sample`. */
  | { type: 'buffered'; connectionId: string; channel: RemoteTransportPeerChannel; bufferedAmount: number }
  | { type: 'failed'; connectionId: string; reason: RemoteTransportPeerFailure; detail?: string };

export interface RemoteTransportPeerHostBridge {
  onCommand(listener: (command: RemoteTransportPeerCommand) => void): void;
  emit(event: RemoteTransportPeerEvent): void;
}

declare global {
  interface Window {
    mixdogTransportPeer?: RemoteTransportPeerHostBridge;
  }
}

export interface RemoteTransportPeerHostEnv {
  bridge: RemoteTransportPeerHostBridge;
  RTCPeerConnection: typeof RTCPeerConnection;
}

// ---------------------------------------------------------------------------
// Host
// ---------------------------------------------------------------------------

interface Connection {
  id: string;
  pc: RTCPeerConnection;
  channels: Record<RemoteTransportPeerChannel, RTCDataChannel>;
  /** One-shot `bufferedamountlow` listeners currently registered. */
  armed: Record<RemoteTransportPeerChannel, boolean>;
  /** `connected` was emitted (main is checking the certificate). */
  certified: boolean;
  certifying: boolean;
  opening: boolean;
  /** `open` was emitted: messages flow to main from here on. */
  opened: boolean;
  /** Messages that arrived before `open`, in order, bounded by `heldBytes`. */
  held: Array<{ channel: RemoteTransportPeerChannel; data: Uint8Array }>;
  heldBytes: number;
  done: boolean;
}

const CANDIDATE_TYPES: ReadonlySet<string> = new Set(['host', 'srflx', 'prflx', 'relay']);
const DETAIL_CHARS = 200;

/** A string member some Chromium versions add beyond the DOM typings
 *  (`RTCIceCandidate.relayProtocol`/`url`, `RTCPeerConnectionIceEvent.url`). */
function textField(source: object | null, name: string): string | undefined {
  if (!source || !(name in source)) return undefined;
  const value: unknown = (source as Record<string, unknown>)[name];
  return typeof value === 'string' ? value.slice(0, DETAIL_CHARS) : undefined;
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error)).slice(0, DETAIL_CHARS);

/** The DTLS transport's remote certificate, as RTCCertificateStats names it. */
async function remoteCertificate(pc: RTCPeerConnection) {
  const report = await pc.getStats();
  for (const stats of report.values()) {
    if (stats.type !== 'transport' || !stats.remoteCertificateId) continue;
    const certificate = report.get(stats.remoteCertificateId);
    if (certificate) {
      return { fingerprint: certificate.fingerprint, fingerprintAlgorithm: certificate.fingerprintAlgorithm };
    }
  }
  return null;
}

/** The selected pair's path (§5 fallback order: direct, then TURN). */
async function selectedPath(pc: RTCPeerConnection): Promise<'direct' | 'turn' | null> {
  const report = await pc.getStats();
  for (const stats of report.values()) {
    if (stats.type !== 'transport' || !stats.selectedCandidatePairId) continue;
    const pair = report.get(stats.selectedCandidatePairId);
    const localType = pair && report.get(pair.localCandidateId)?.candidateType;
    const remoteType = pair && report.get(pair.remoteCandidateId)?.candidateType;
    if (!CANDIDATE_TYPES.has(String(localType)) || !CANDIDATE_TYPES.has(String(remoteType))) return null;
    const path = remoteWebrtcCandidatePath({
      localType: localType as RemoteWebrtcCandidateType,
      remoteType: remoteType as RemoteWebrtcCandidateType,
      protocol: 'udp',
    });
    return path === 'relay' ? 'turn' : 'direct';
  }
  return null;
}

export function startRemoteTransportPeerHost(env: RemoteTransportPeerHostEnv): void {
  const { bridge } = env;
  const emit = (event: RemoteTransportPeerEvent): void => bridge.emit(event);
  const connections = new Map<string, Connection>();

  function fail(connection: Connection, reason: RemoteTransportPeerFailure, detail?: string): void {
    if (connection.done) return;
    connection.done = true;
    emit({ type: 'failed', connectionId: connection.id, reason, ...(detail ? { detail: detail.slice(0, DETAIL_CHARS) } : {}) });
  }

  function reportBuffered(connection: Connection, channel: RemoteTransportPeerChannel): void {
    emit({
      type: 'buffered',
      connectionId: connection.id,
      channel,
      bufferedAmount: connection.channels[channel].bufferedAmount,
    });
  }

  /** Waits for this channel's drain to the low threshold. The threshold was set
   *  when the channel was created, before its first send; the amount is read
   *  again right after the listener is registered, so a drain that happened
   *  before the registration is reported instead of missed. */
  function armLow(connection: Connection, channel: RemoteTransportPeerChannel): void {
    if (connection.armed[channel]) return;
    const target = connection.channels[channel];
    connection.armed[channel] = true;
    const onLow = (): void => {
      target.removeEventListener('bufferedamountlow', onLow);
      connection.armed[channel] = false;
      if (connections.get(connection.id) === connection) reportBuffered(connection, channel);
    };
    target.addEventListener('bufferedamountlow', onLow);
    if (target.bufferedAmount <= target.bufferedAmountLowThreshold) onLow();
  }

  async function certify(connection: Connection): Promise<void> {
    if (connection.certified || connection.certifying) return;
    connection.certifying = true;
    let certificate: Awaited<ReturnType<typeof remoteCertificate>> = null;
    try {
      certificate = await remoteCertificate(connection.pc);
    } catch {
      certificate = null;
    }
    if (connection.done) return;
    emit({ type: 'connected', connectionId: connection.id, remoteCertificate: certificate });
    connection.certified = true;
    await maybeOpen(connection);
  }

  async function maybeOpen(connection: Connection): Promise<void> {
    const { app, control } = connection.channels;
    if (connection.opening || connection.done || !connection.certified) return;
    if (app.readyState !== 'open' || control.readyState !== 'open') return;
    connection.opening = true;
    let path: 'direct' | 'turn' | null = null;
    try {
      path = await selectedPath(connection.pc);
    } catch {
      path = null;
    }
    if (connection.done) return;
    const size = connection.pc.sctp?.maxMessageSize;
    emit({
      type: 'open',
      connectionId: connection.id,
      maxMessageSize: typeof size === 'number' ? size : null,
      path,
    });
    connection.opened = true;
    const held = connection.held;
    connection.held = [];
    connection.heldBytes = 0;
    for (const message of held) emit({ type: 'message', connectionId: connection.id, ...message });
  }

  function wireChannel(connection: Connection, channel: RemoteTransportPeerChannel): void {
    const target = connection.channels[channel];
    target.binaryType = 'arraybuffer';
    // Before the first send: the drain signal main resumes on (§10 BUFFER_LOW).
    target.bufferedAmountLowThreshold = REMOTE_TRANSPORT_BUFFER_LOW_BYTES;
    target.onopen = () => void maybeOpen(connection);
    target.onmessage = (event: MessageEvent) => {
      // The carriers move binary transport messages only.
      if (connection.done || !(event.data instanceof ArrayBuffer)) return;
      const data = new Uint8Array(event.data);
      if (connection.opened) {
        emit({ type: 'message', connectionId: connection.id, channel, data });
        return;
      }
      // Before main checked the certificate: held, at most the high-water mark
      // (beyond it the records are lost and the receiver repairs them).
      if (connection.heldBytes + data.byteLength > REMOTE_TRANSPORT_BUFFER_HIGH_BYTES) return;
      connection.heldBytes += data.byteLength;
      connection.held.push({ channel, data });
    };
    target.onclose = () => fail(connection, 'channel-failed', `${channel} channel closed`);
    target.onerror = () => fail(connection, 'channel-failed', `${channel} channel error`);
  }

  function create(command: Extract<RemoteTransportPeerCommand, { type: 'create' }>): void {
    const { connectionId } = command;
    if (connections.has(connectionId)) return;
    const pc = new env.RTCPeerConnection({
      iceServers: command.iceServers,
      iceTransportPolicy: REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
      bundlePolicy: 'max-bundle',
    });
    // Both channels exist before the offer, so it negotiates SCTP for them.
    const app = pc.createDataChannel(REMOTE_TRANSPORT_CHANNEL_LABEL, { ordered: true });
    // Ordered too: the `direct:<connectionId>` control lane opens its boxes in
    // seal order (§3). Its own SCTP stream keeps it from waiting behind bulk.
    const control = pc.createDataChannel(REMOTE_TRANSPORT_CONTROL_CHANNEL_LABEL, { ordered: true });
    const connection: Connection = {
      id: connectionId,
      pc,
      channels: { app, control },
      armed: { app: false, control: false },
      certified: false,
      certifying: false,
      opening: false,
      opened: false,
      held: [],
      heldBytes: 0,
      done: false,
    };
    connections.set(connectionId, connection);
    wireChannel(connection, 'app');
    wireChannel(connection, 'control');
    pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      const candidate = event.candidate;
      const relay = candidate?.type === 'relay';
      const relayProtocol = relay ? textField(candidate, 'relayProtocol') : undefined;
      const url = relay ? (textField(candidate, 'url') ?? textField(event, 'url')) : undefined;
      emit({
        type: 'candidate',
        connectionId,
        candidate: candidate
          ? {
              candidate: candidate.candidate,
              sdpMid: candidate.sdpMid,
              sdpMLineIndex: candidate.sdpMLineIndex,
              usernameFragment: candidate.usernameFragment,
            }
          : null,
        ...(relayProtocol ? { relayProtocol } : {}),
        ...(url ? { url } : {}),
      });
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') {
        void certify(connection);
      } else if (pc.connectionState === 'failed') {
        fail(connection, pc.sctp?.transport.state === 'failed' ? 'dtls-failed' : 'ice-failed');
      }
    };
  }

  async function offer(connection: Connection, iceRestart: boolean): Promise<void> {
    const description = await connection.pc.createOffer(iceRestart ? { iceRestart: true } : undefined);
    await connection.pc.setLocalDescription(description);
    if (connection.done) return;
    emit({ type: 'offer', connectionId: connection.id, sdp: connection.pc.localDescription?.sdp ?? description.sdp ?? '' });
  }

  function send(items: RemoteTransportPeerSendItem[]): void {
    // One `sent` per connection and channel, in first-seen order.
    const sent = new Map<string, { connectionId: string; channel: RemoteTransportPeerChannel; bytes: number }>();
    for (const item of items) {
      const key = `${item.channel}\0${item.connectionId}`;
      const entry = sent.get(key) ?? { connectionId: item.connectionId, channel: item.channel, bytes: 0 };
      sent.set(key, entry);
      entry.bytes += item.data.byteLength;
      const connection = connections.get(item.connectionId);
      const target = connection?.channels[item.channel];
      if (!connection || connection.done || target?.readyState !== 'open') continue;
      try {
        // Structured clone gives every item its own ArrayBuffer.
        target.send(item.data as Uint8Array<ArrayBuffer>);
      } catch (error) {
        fail(connection, 'channel-failed', describe(error));
      }
    }
    for (const { connectionId, channel, bytes } of sent.values()) {
      const connection = connections.get(connectionId);
      const target = connection?.channels[channel];
      const bufferedAmount = target && target.readyState === 'open' ? target.bufferedAmount : 0;
      emit({ type: 'sent', connectionId, channel, bytes, bufferedAmount });
      if (connection && target && bufferedAmount > target.bufferedAmountLowThreshold) armLow(connection, channel);
    }
  }

  function close(connectionId: string): void {
    const connection = connections.get(connectionId);
    if (!connection) return;
    connection.done = true;
    connections.delete(connectionId);
    connection.channels.app.close();
    connection.channels.control.close();
    connection.pc.close();
  }

  async function run(command: RemoteTransportPeerCommand): Promise<void> {
    switch (command.type) {
      case 'create':
        create(command);
        return;
      case 'send':
        send(command.items);
        return;
      case 'close':
        close(command.connectionId);
        return;
    }
    const connection = connections.get(command.connectionId);
    if (!connection || connection.done) return;
    switch (command.type) {
      case 'offer':
        try {
          await offer(connection, command.iceRestart);
        } catch (error) {
          fail(connection, 'protocol-error', describe(error));
        }
        return;
      case 'answer':
        try {
          await connection.pc.setRemoteDescription({ type: 'answer', sdp: command.sdp });
        } catch (error) {
          fail(connection, 'protocol-error', describe(error));
        }
        return;
      case 'candidate':
        // A candidate the peer connection refuses (one of an earlier ICE
        // generation) changes nothing; the connection stands.
        await connection.pc.addIceCandidate(command.candidate ?? undefined).catch(() => undefined);
        return;
      case 'sample':
        reportBuffered(connection, 'app');
        reportBuffered(connection, 'control');
        return;
    }
  }

  bridge.onCommand((command) => {
    void run(command).catch((error: unknown) => {
      if (!('connectionId' in command)) return;
      const connection = connections.get(command.connectionId);
      // A `create` that threw before its connection existed is reported too.
      if (connection) fail(connection, 'peer-host-unavailable', describe(error));
      else emit({ type: 'failed', connectionId: command.connectionId, reason: 'peer-host-unavailable', detail: describe(error) });
    });
  });
  emit({ type: 'ready' });
}

if (typeof window !== 'undefined' && window.mixdogTransportPeer) {
  startRemoteTransportPeerHost({ bridge: window.mixdogTransportPeer, RTCPeerConnection });
}
