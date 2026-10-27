// The phone's reading of its receiving RTCPeerConnection's getStats() report
// (W3C webrtc-stats): the peer certificate for the fingerprint check, and the
// receiver sample the contract sends on the input channel.
import type {
  RemoteWebrtcCandidatePairStats,
  RemoteWebrtcCandidateType,
  RemoteWebrtcConnectionRef,
  RemoteWebrtcReceiverStats,
} from '../shared/remote-webrtc';

type Stat = Record<string, unknown> & { id?: string; type?: string };
/** The part of RTCStatsReport read here (a Map of stat id → stat). */
export interface RemoteWebrtcStatsReport {
  get(id: string): unknown;
  forEach(callback: (value: unknown) => void): void;
}

const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
const text = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);

function stats(report: RemoteWebrtcStatsReport, type: string): Stat[] {
  const found: Stat[] = [];
  report.forEach((value) => {
    if (value && typeof value === 'object' && (value as Stat).type === type) found.push(value as Stat);
  });
  return found;
}

function byId(report: RemoteWebrtcStatsReport, id: unknown): Stat | null {
  if (typeof id !== 'string') return null;
  const value = report.get(id);
  return value && typeof value === 'object' ? (value as Stat) : null;
}

/** The connected DTLS transport's remote certificate (RTCCertificateStats). */
export function remoteWebrtcPeerCertificate(
  report: RemoteWebrtcStatsReport
): { fingerprint?: unknown; fingerprintAlgorithm?: unknown } | null {
  for (const transport of stats(report, 'transport')) {
    if (transport.dtlsState !== 'connected') continue;
    const certificate = byId(report, transport.remoteCertificateId);
    if (certificate)
      return { fingerprint: certificate.fingerprint, fingerprintAlgorithm: certificate.fingerprintAlgorithm };
  }
  return null;
}

const CANDIDATE_TYPES: ReadonlySet<string> = new Set(['host', 'srflx', 'prflx', 'relay']);

/** The transport's selected candidate pair, with its two candidates' types. */
export function remoteWebrtcSelectedPair(report: RemoteWebrtcStatsReport): RemoteWebrtcCandidatePairStats | undefined {
  for (const transport of stats(report, 'transport')) {
    const pair = byId(report, transport.selectedCandidatePairId);
    const local = pair && byId(report, pair.localCandidateId);
    const remote = pair && byId(report, pair.remoteCandidateId);
    if (!pair || !local || !remote) continue;
    const localType = String(local.candidateType);
    const remoteType = String(remote.candidateType);
    const protocol = local.protocol;
    if (!CANDIDATE_TYPES.has(localType) || !CANDIDATE_TYPES.has(remoteType)) continue;
    if (protocol !== 'udp' && protocol !== 'tcp') continue;
    const relayProtocol = local.relayProtocol;
    const roundTrip = number(pair.currentRoundTripTime);
    const bitrate = number(pair.availableOutgoingBitrate);
    return {
      localType: localType as RemoteWebrtcCandidateType,
      remoteType: remoteType as RemoteWebrtcCandidateType,
      protocol,
      ...(relayProtocol === 'udp' || relayProtocol === 'tcp' || relayProtocol === 'tls' ? { relayProtocol } : {}),
      // RTCIceCandidatePairStats reports seconds.
      ...(roundTrip === undefined ? {} : { currentRoundTripTimeMs: roundTrip * 1_000 }),
      ...(bitrate === undefined ? {} : { availableOutgoingBitrate: bitrate }),
    };
  }
  return undefined;
}

/** The inbound video stream's counters (RTCInboundRtpStreamStats); seconds
 *  become milliseconds, the jitter buffer delay a per-frame mean. The input
 *  timings are the phone's own window means. */
export function readRemoteWebrtcReceiverStats(
  report: RemoteWebrtcStatsReport,
  connection: Pick<RemoteWebrtcConnectionRef, 'connectionId' | 'generation'>,
  at: number,
  input: { inputRoundTripMs?: number; inputToVisibleMs?: number } = {}
): RemoteWebrtcReceiverStats | null {
  const inbound = stats(report, 'inbound-rtp').find((entry) => entry.kind === 'video');
  if (!inbound) return null;
  const codec = text(byId(report, inbound.codecId)?.mimeType);
  const decoder = text(inbound.decoderImplementation);
  const jitterDelay = number(inbound.jitterBufferDelay);
  const jitterCount = number(inbound.jitterBufferEmittedCount);
  const freezes = number(inbound.freezeCount);
  const pair = remoteWebrtcSelectedPair(report);
  const width = number(inbound.frameWidth);
  const height = number(inbound.frameHeight);
  return {
    connectionId: connection.connectionId,
    generation: connection.generation,
    at,
    ...(codec ? { codec } : {}),
    ...(decoder ? { decoderImplementation: decoder } : {}),
    framesReceived: number(inbound.framesReceived) ?? 0,
    framesDecoded: number(inbound.framesDecoded) ?? 0,
    framesDropped: number(inbound.framesDropped) ?? 0,
    totalDecodeTimeMs: (number(inbound.totalDecodeTime) ?? 0) * 1_000,
    ...(jitterDelay !== undefined && jitterCount ? { jitterBufferDelayMs: (jitterDelay * 1_000) / jitterCount } : {}),
    ...(freezes === undefined ? {} : { freezeCount: freezes }),
    ...(input.inputRoundTripMs === undefined ? {} : { inputRoundTripMs: input.inputRoundTripMs }),
    ...(input.inputToVisibleMs === undefined ? {} : { inputToVisibleMs: input.inputToVisibleMs }),
    ...(width === undefined ? {} : { frameWidth: width }),
    ...(height === undefined ? {} : { frameHeight: height }),
    ...(pair ? { candidatePair: pair } : {}),
  };
}
