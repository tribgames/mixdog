/**
 * The live-view sender (hidden trusted window, see main/remote-webrtc/sender-window.ts).
 * Per source: one canvas-generated video track, fed the newest picture main
 * hands over at the locked pixel size. Per connection: one RTCPeerConnection
 * through TURN only, with the reliable ordered input channel. Electron's
 * WebRTC encodes; which encoder actually runs is reported, never assumed.
 */
import {
  REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
  REMOTE_WEBRTC_INPUT_CHANNEL,
  type RemoteWebrtcCandidatePairStats,
  type RemoteWebrtcCandidateType,
} from '../../shared/remote-webrtc';
import type {
  RemoteWebrtcSenderCommand,
  RemoteWebrtcSenderEvent,
  RemoteWebrtcSenderFailure,
} from '../../shared/remote-webrtc-sender';
import { createRemoteWebrtcSourceCaptures, type RemoteWebrtcSenderSource } from './source-capture';

declare global {
  interface Window {
    mixdogWebrtcSender: {
      onCommand(listener: (command: RemoteWebrtcSenderCommand) => void): void;
      emit(event: RemoteWebrtcSenderEvent): void;
    };
  }
}

const bridge = window.mixdogWebrtcSender;
const emit = (event: RemoteWebrtcSenderEvent): void => bridge.emit(event);

interface Connection {
  sourceKey: string;
  pc: RTCPeerConnection;
  channel: RTCDataChannel;
  sender: RTCRtpSender | null;
  closed: boolean;
}

const sources = new Map<string, RemoteWebrtcSenderSource>();
const connections = new Map<string, Connection>();

/** A canvas-generated track, fed only when a picture is drawn. */
function createDrawn(): RemoteWebrtcSenderSource {
  const canvas = document.createElement('canvas');
  canvas.width = 2;
  canvas.height = 2;
  const context = canvas.getContext('2d', { alpha: false });
  if (!context) throw new Error('2D canvas is unavailable.');
  // Frames only when a picture is drawn (requestFrame), never on a timer.
  const stream = canvas.captureStream(0);
  const track = stream.getVideoTracks()[0] as RemoteWebrtcSenderSource['track'];
  // Text and UI: keep detail (and resolution) over motion smoothness.
  track.contentHint = 'detail';
  return { canvas, context, stream, track };
}

const captures = createRemoteWebrtcSourceCaptures({
  acquire: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
  createDrawn,
  sources,
  senders: (sourceKey) =>
    [...connections.values()].flatMap((connection) =>
      connection.sourceKey === sourceKey && connection.sender ? [connection.sender] : []
    ),
  emit,
});

function sourceTrack(sourceKey: string): RemoteWebrtcSenderSource {
  let entry = sources.get(sourceKey);
  if (entry) return entry;
  entry = createDrawn();
  sources.set(sourceKey, entry);
  return entry;
}

/** Draws the picture onto the canvas, already sized to the frame's pixel size. */
async function paint(
  command: Extract<RemoteWebrtcSenderCommand, { type: 'frame' }>,
  context: CanvasRenderingContext2D
): Promise<void> {
  if (command.mimeType === 'image/x-bgrx') {
    // WebCodecs takes the helper's B, G, R, X rows as they are (with their
    // stride), and the canvas crops, scales and converts on draw: no
    // per-pixel work in JS, here or in main.
    const frame = new VideoFrame(command.pixels, {
      format: 'BGRX',
      codedWidth: command.width,
      codedHeight: command.height,
      layout: [{ offset: 0, stride: command.stride }],
      timestamp: 0,
    });
    try {
      const { source, target } = command;
      // Desktop area the helper frame does not cover stays black.
      context.fillStyle = '#000';
      context.fillRect(0, 0, command.pixelWidth, command.pixelHeight);
      context.imageSmoothingQuality = 'high';
      context.drawImage(
        frame,
        source.x,
        source.y,
        source.width,
        source.height,
        target.x,
        target.y,
        target.width,
        target.height
      );
    } finally {
      frame.close();
    }
    return;
  }
  const bytes = Uint8Array.from(atob(command.data), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: command.mimeType }), {
    resizeWidth: command.pixelWidth,
    resizeHeight: command.pixelHeight,
    resizeQuality: 'high',
  });
  try {
    context.drawImage(bitmap, 0, 0);
  } finally {
    bitmap.close();
  }
}

/** Draws a picture into the source's drawn track. `ok` means it is in the
 *  track every connection of the source sends: still the source's track, and
 *  on every sender (`installed`). */
async function drawFrame(command: Extract<RemoteWebrtcSenderCommand, { type: 'frame' }>): Promise<void> {
  let ok = false;
  try {
    const entry = sourceTrack(command.sourceKey);
    const { canvas, context } = entry;
    if (!canvas || !context) throw new Error('A captured source takes no pictures.');
    if (canvas.width !== command.pixelWidth || canvas.height !== command.pixelHeight) {
      canvas.width = command.pixelWidth;
      canvas.height = command.pixelHeight;
    }
    await paint(command, context);
    entry.track.requestFrame?.();
    await entry.installed;
    ok = sources.get(command.sourceKey) === entry;
  } finally {
    emit({ type: 'frame-done', sourceKey: command.sourceKey, frameId: command.frameId, ok });
  }
}

function fail(connectionId: string, reason: RemoteWebrtcSenderFailure, detail?: string): void {
  const connection = connections.get(connectionId);
  if (!connection || connection.closed) return;
  emit({ type: 'failed', connectionId, reason, ...(detail ? { detail: detail.slice(0, 200) } : {}) });
}

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

async function open(command: Extract<RemoteWebrtcSenderCommand, { type: 'open' }>): Promise<void> {
  const { connectionId } = command;
  const pc = new RTCPeerConnection({
    iceServers: command.iceServers,
    iceTransportPolicy: REMOTE_WEBRTC_ICE_TRANSPORT_POLICY,
    bundlePolicy: 'max-bundle',
  });
  const channel = pc.createDataChannel(REMOTE_WEBRTC_INPUT_CHANNEL, { ordered: true });
  const connection: Connection = { sourceKey: command.sourceKey, pc, channel, sender: null, closed: false };
  connections.set(connectionId, connection);
  pc.onicecandidate = (event) => {
    emit({
      type: 'candidate',
      connectionId,
      candidate: event.candidate
        ? {
            candidate: event.candidate.candidate,
            sdpMid: event.candidate.sdpMid,
            sdpMLineIndex: event.candidate.sdpMLineIndex,
            usernameFragment: event.candidate.usernameFragment,
          }
        : null,
    });
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      void remoteCertificate(pc).then((certificate) =>
        emit({ type: 'connected', connectionId, remoteCertificate: certificate })
      );
    } else if (pc.connectionState === 'failed') {
      const dtls = pc.getSenders().some((sender) => sender.transport?.state === 'failed');
      fail(connectionId, dtls ? 'dtls-failed' : 'ice-failed');
    }
  };
  channel.onmessage = (event) => {
    if (typeof event.data === 'string') {
      emit({ type: 'channel', connectionId, text: event.data, receivedAt: Date.now() });
    }
  };
  channel.onclose = () => fail(connectionId, 'channel-failed');
  try {
    const source = sourceTrack(command.sourceKey);
    const transceiver = pc.addTransceiver(source.track, { direction: 'sendonly', streams: [source.stream] });
    connection.sender = transceiver.sender;
    // Only codecs the phone can decode, in the browser's own preference order.
    const receivable = new Set(command.receiveCodecs.map((codec) => codec.toLowerCase()));
    const codecs = (RTCRtpSender.getCapabilities('video')?.codecs ?? []).filter((codec) =>
      receivable.has(codec.mimeType.toLowerCase())
    );
    if (!codecs.some((codec) => !/\/(?:rtx|red|ulpfec|flexfec-03)$/iu.test(codec.mimeType))) {
      fail(connectionId, 'unsupported', 'no common video codec');
      return;
    }
    transceiver.setCodecPreferences(codecs);
    // Fixed resolution: under congestion, frame rate gives way, never size.
    const parameters = transceiver.sender.getParameters() as RTCRtpSendParameters & {
      degradationPreference?: string;
    };
    parameters.degradationPreference = 'maintain-resolution';
    await transceiver.sender.setParameters(parameters);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    emit({ type: 'offer', connectionId, sdp: pc.localDescription?.sdp ?? offer.sdp ?? '' });
  } catch (error) {
    fail(connectionId, 'unsupported', error instanceof Error ? error.message : String(error));
  }
}

const CANDIDATE_TYPES: ReadonlySet<string> = new Set(['host', 'srflx', 'prflx', 'relay']);
const candidateType = (value: unknown): RemoteWebrtcCandidateType =>
  (CANDIDATE_TYPES.has(String(value)) ? value : 'relay') as RemoteWebrtcCandidateType;

async function stats(connectionId: string, requestId: number): Promise<void> {
  const connection = connections.get(connectionId);
  if (!connection) {
    emit({ type: 'stats', connectionId, requestId, stats: null });
    return;
  }
  const report = await connection.pc.getStats();
  let outbound: Record<string, any> | null = null;
  let pair: RemoteWebrtcCandidatePairStats | undefined;
  for (const entry of report.values()) {
    if (entry.type === 'outbound-rtp' && entry.kind === 'video') outbound = entry;
    if (entry.type === 'transport' && entry.selectedCandidatePairId) {
      const selected = report.get(entry.selectedCandidatePairId);
      const local = selected && report.get(selected.localCandidateId);
      const remote = selected && report.get(selected.remoteCandidateId);
      if (selected && local && remote) {
        pair = {
          localType: candidateType(local.candidateType),
          remoteType: candidateType(remote.candidateType),
          protocol: local.protocol === 'tcp' ? 'tcp' : 'udp',
          ...(local.relayProtocol ? { relayProtocol: local.relayProtocol } : {}),
          ...(typeof selected.currentRoundTripTime === 'number'
            ? { currentRoundTripTimeMs: selected.currentRoundTripTime * 1_000 }
            : {}),
          ...(typeof selected.availableOutgoingBitrate === 'number'
            ? { availableOutgoingBitrate: selected.availableOutgoingBitrate }
            : {}),
        };
      }
    }
  }
  const codec = outbound?.codecId ? report.get(outbound.codecId)?.mimeType : undefined;
  emit({
    type: 'stats',
    connectionId,
    requestId,
    stats: {
      connectionId,
      generation: 0,
      at: Date.now(),
      ...(codec ? { codec } : {}),
      ...(outbound?.encoderImplementation ? { encoderImplementation: outbound.encoderImplementation } : {}),
      ...(typeof outbound?.powerEfficientEncoder === 'boolean'
        ? { powerEfficientEncoder: outbound.powerEfficientEncoder }
        : {}),
      framesEncoded: outbound?.framesEncoded ?? 0,
      framesSent: outbound?.framesSent ?? 0,
      totalEncodeTimeMs: (outbound?.totalEncodeTime ?? 0) * 1_000,
      ...(outbound?.qualityLimitationReason ? { qualityLimitationReason: outbound.qualityLimitationReason } : {}),
      ...(outbound?.frameWidth ? { frameWidth: outbound.frameWidth } : {}),
      ...(outbound?.frameHeight ? { frameHeight: outbound.frameHeight } : {}),
      ...(outbound?.framesPerSecond ? { framesPerSecond: outbound.framesPerSecond } : {}),
      ...(outbound?.targetBitrate ? { targetBitrate: outbound.targetBitrate } : {}),
      bytesSent: outbound?.bytesSent ?? 0,
      ...(pair ? { candidatePair: pair } : {}),
    },
  });
}

function close(connectionId: string): void {
  const connection = connections.get(connectionId);
  if (!connection) return;
  connection.closed = true;
  connections.delete(connectionId);
  connection.channel.close();
  connection.pc.close();
}

async function run(command: RemoteWebrtcSenderCommand): Promise<void> {
  switch (command.type) {
    case 'open':
      return open(command);
    case 'answer':
      await connections.get(command.connectionId)?.pc.setRemoteDescription({ type: 'answer', sdp: command.sdp });
      return;
    case 'candidate': {
      const connection = connections.get(command.connectionId);
      // null: the phone's end of candidates.
      await connection?.pc.addIceCandidate(command.candidate ?? undefined);
      return;
    }
    case 'channel-send': {
      const channel = connections.get(command.connectionId)?.channel;
      if (channel?.readyState === 'open') channel.send(command.text);
      return;
    }
    case 'encoding': {
      const sender = connections.get(command.connectionId)?.sender;
      if (!sender) return;
      const parameters = sender.getParameters();
      for (const encoding of parameters.encodings) {
        if (command.maxBitrate !== undefined) encoding.maxBitrate = command.maxBitrate;
        if (command.maxFramerate !== undefined) encoding.maxFramerate = command.maxFramerate;
      }
      await sender.setParameters(parameters);
      return;
    }
    case 'stats':
      return stats(command.connectionId, command.requestId);
    case 'close':
      close(command.connectionId);
      return;
    case 'frame':
      return drawFrame(command);
    case 'source-capture':
      return captures.capture(command.sourceKey, command.plan);
    case 'source-draw':
      captures.draw(command.sourceKey);
      return;
    case 'source-close':
      captures.close(command.sourceKey);
      return;
  }
}

bridge.onCommand((command) => {
  void run(command).catch((error: unknown) => {
    if ('connectionId' in command) {
      fail(command.connectionId, 'unsupported', error instanceof Error ? error.message : String(error));
    }
  });
});
emit({ type: 'ready' });
