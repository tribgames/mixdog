// A relay that meets an oversize frame refuses that frame instead of tearing
// the connection down, and signals only the leg that sent it
// (apps/relay/server.mjs `socket.oversizeSignal`):
//   desktop leg: { type: 'frame-too-large', clientId, bytes, limit }
//   phone leg:   { resync: 1, error: 'frame-too-large', bytes, limit }
// The phone shape rides `resync`, the only cleartext key an E2EE browser
// handles before decryption. The desktop forwards a refusal to the affected
// browser as an encrypted `relayPayloadRejected` event.

/** Relay-side error tag, on both the desktop and the phone leg. */
export const RELAY_FRAME_TOO_LARGE = 'frame-too-large';
/** Desktop → browser event carrying a refusal the desktop was told about. */
export const RELAY_PAYLOAD_REJECTED_EVENT = 'relayPayloadRejected';
/** Desktop → browser event carrying ceilings the relay republished during a
 *  connection (`relay-capabilities`). */
export const RELAY_ROUTING_CAPS_EVENT = 'relayRoutingCaps';
/** Error.code on the rejected calls, for callers that branch on cause. */
export const RELAY_PAYLOAD_TOO_LARGE_CODE = 'RELAY_PAYLOAD_TOO_LARGE';

/** `call`: a named RPC frame; `push`: a frame with no caller; `unknown`:
 *  unattributed, so an in-flight call may be left waiting. */
type RelayRejectionScope = 'call' | 'push' | 'unknown';

export interface RelayPayloadRejection {
  /** Wire size of the refused frame, when the relay reported a usable one. */
  bytes: number | null;
  /** The relay's per-frame ceiling, when reported. */
  limit: number | null;
  /** Set only from the authenticated desktop → browser event; relay-controlled
   *  shapes read as null even when they carry an `id`. */
  callId: number | null;
  /** Whether an in-flight call can still be waiting because of this refusal. */
  scope: RelayRejectionScope;
}

const positiveSize = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

const callIdOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

const NON_ASCII = /[\u0080-\uFFFF]/;
const encoder = new TextEncoder();

/** The relay's unit (apps/relay/server.mjs `frameBytes`): UTF-8 bytes for text,
 *  byte length for a binary box. */
export const relayFrameByteLength = (frame: string | ArrayBufferView): number => {
  if (typeof frame !== 'string') return frame.byteLength;
  return NON_ASCII.test(frame) ? encoder.encode(frame).length : frame.length;
};

/** Recognises a refusal in any of its three envelopes; null for anything else.
 *  `authenticated` is true only for a decrypted E2EE frame. */
export const readRelayPayloadRejection = (source: unknown, authenticated = false): RelayPayloadRejection | null => {
  if (!source || typeof source !== 'object') return null;
  const frame = source as Record<string, unknown>;
  const desktopEvent = frame.event === RELAY_PAYLOAD_REJECTED_EVENT;
  const refused = desktopEvent || frame.type === RELAY_FRAME_TOO_LARGE || frame.error === RELAY_FRAME_TOO_LARGE;
  if (!refused) return null;
  const detail =
    frame.payload && typeof frame.payload === 'object' ? (frame.payload as Record<string, unknown>) : frame;
  const trusted = desktopEvent && authenticated;
  const callId = trusted ? callIdOf(detail.id) : null;
  let scope: RelayRejectionScope = 'unknown';
  if (callId !== null) scope = 'call';
  else if (trusted && detail.scope === 'push') scope = 'push';
  return {
    bytes: positiveSize(detail.bytes),
    limit: positiveSize(detail.limit),
    callId,
    scope,
  };
};

const MEGABYTE = 1024 * 1024;
const megabytes = (value: number): string => (value / MEGABYTE).toFixed(1);

/** The user-visible failure text for a call the relay would not forward. */
export const relayPayloadTooLargeMessage = (rejection: RelayPayloadRejection): string => {
  const { bytes, limit } = rejection;
  if (bytes !== null && limit !== null) {
    return `payload too large for the relay (${megabytes(bytes)} of ${megabytes(limit)} MB)`;
  }
  if (bytes !== null) return `payload too large for the relay (${megabytes(bytes)} MB)`;
  return 'payload too large for the relay';
};

/** The relay's policy ceiling (apps/relay/server.mjs `MAX_FRAME_BYTES`). */
export const RELAY_DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** The smallest usable candidate, or the default ceiling when none is usable. */
export const resolveRelayFrameLimit = (...candidates: ReadonlyArray<number | null | undefined>): number => {
  let limit: number | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) continue;
    limit = limit === null ? Math.floor(candidate) : Math.min(limit, Math.floor(candidate));
  }
  return limit ?? RELAY_DEFAULT_MAX_FRAME_BYTES;
};

/** The refusal for an already serialized frame, or null when it fits. */
export const relayFrameRefusal = (
  bytes: number,
  limit: number,
  callId: number | null
): RelayPayloadRejection | null => {
  if (bytes <= limit) return null;
  const id = callIdOf(callId);
  return { bytes, limit, callId: id, scope: id === null ? 'push' : 'call' };
};

/** The wire size and envelope of a frame a call has already sent. */
export interface RelayInflightFrame {
  bytes: number;
  binary: boolean;
}

/** Refusals for in-flight calls whose own frame exceeds the ceiling for its
 *  wire form. */
export const relayStrandedCallRefusals = (
  inflight: Iterable<readonly [number, RelayInflightFrame]>,
  ceilings: { binary: number; text: number }
): RelayPayloadRejection[] => {
  const stranded: RelayPayloadRejection[] = [];
  for (const [callId, frame] of inflight) {
    const refusal = relayFrameRefusal(frame.bytes, frame.binary ? ceilings.binary : ceilings.text, callId);
    if (refusal) stranded.push(refusal);
  }
  return stranded;
};

/** `encodeRelayBinaryFrame` header (apps/relay/lib/relay-binary-frame.mjs). */
export const RELAY_BINARY_HEADER_BYTES = 6;
/** `{"type":"frame","clientId":"` + id + `","data":""}`: 38 bytes of
 *  scaffolding plus two quotes, the relay's `jsonBase`. */
export const RELAY_JSON_ENVELOPE_BYTES = 38 + 2;
/** Bytes one payload byte may become inside the JSON envelope
 *  (apps/relay/server.mjs `JSON_ESCAPE_WORST_CASE`). */
export const RELAY_JSON_ESCAPE_WORST_CASE = 6;
/** The binary decoder's upper bound for a route id; the relay itself routes by
 *  a 36-byte `randomUUID()` (apps/relay/server.mjs `runClientLeg`). */
export const RELAY_FALLBACK_CLIENT_ID_BYTES = 64;

/** The receiving leg's capacity and the largest frame per wire form, as the
 *  relay publishes them (apps/relay/server.mjs `relayCapabilities`). */
export interface RelayUplinkCeilings {
  capacity: number;
  binary: number;
  text: number;
}

const publishedSize = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;

/** The ceilings published in `relay-capabilities` (relay → desktop) or
 *  `e2ee-ready` (desktop → browser); null unless all three are present. */
export const readRelayUplinkCeilings = (frame: unknown): RelayUplinkCeilings | null => {
  if (!frame || typeof frame !== 'object') return null;
  const published = frame as Record<string, unknown>;
  const capacity = publishedSize(published.uplinkCapacityBytes);
  const binary = publishedSize(published.uplinkBinaryCeilingBytes);
  const text = publishedSize(published.uplinkTextCeilingBytes);
  if (capacity === null || binary === null || text === null) return null;
  return { capacity, binary, text };
};

export const relayUplinkCeilingFields = (ceilings: RelayUplinkCeilings): Record<string, number> => ({
  uplinkCapacityBytes: ceilings.capacity,
  uplinkBinaryCeilingBytes: ceilings.binary,
  uplinkTextCeilingBytes: ceilings.text,
});

/** The smallest capacity the relay can hold (apps/relay/server.mjs
 *  `MIN_UPLINK_CAPACITY_BYTES`). */
export const RELAY_UNPUBLISHED_CAPACITY_BYTES = 1024;

/** Mirror of the relay's rule (apps/relay/server.mjs `uplinkCeilings`) for a
 *  peer that publishes nothing. */
export const relayFallbackUplinkCeilings = ({
  capacity,
  policy,
  textFrames = false,
}: {
  capacity: number;
  policy: number;
  textFrames?: boolean;
}): RelayUplinkCeilings => {
  const binary = Math.max(0, Math.min(policy, capacity - RELAY_BINARY_HEADER_BYTES - RELAY_FALLBACK_CLIENT_ID_BYTES));
  if (textFrames) return { capacity, binary, text: binary };
  const escapedPayloadBytes = Math.floor(
    (capacity - RELAY_JSON_ENVELOPE_BYTES - RELAY_FALLBACK_CLIENT_ID_BYTES) / RELAY_JSON_ESCAPE_WORST_CASE
  );
  return { capacity, binary, text: Math.max(0, Math.min(policy, escapedPayloadBytes)) };
};

/** The ceilings this leg enforces: the published ones, else the fallback,
 *  never above `policy`. */
export const relayUplinkContract = (
  published: RelayUplinkCeilings | null,
  { policy, capacity = null, textFrames = false }: { policy: number; capacity?: number | null; textFrames?: boolean }
): RelayUplinkCeilings => {
  const base =
    published ??
    relayFallbackUplinkCeilings({
      capacity: capacity !== null && capacity > 0 ? capacity : RELAY_UNPUBLISHED_CAPACITY_BYTES,
      policy,
      textFrames,
    });
  return {
    capacity: base.capacity,
    binary: Math.min(base.binary, policy),
    text: Math.min(base.text, policy),
  };
};

/** The pre-send verdict: a frame's size against the ceiling for its wire form. */
export const relayFrameCapRefusal = (
  frame: string | ArrayBufferView,
  ceilings: { binary: number; text: number },
  callId: number | null
): RelayPayloadRejection | null =>
  relayFrameRefusal(relayFrameByteLength(frame), typeof frame === 'string' ? ceilings.text : ceilings.binary, callId);

/** The call a frame carries or answers; pushes have none. */
export const relayFrameCallId = (payload: unknown): number | null =>
  payload && typeof payload === 'object' ? callIdOf((payload as { id?: unknown }).id) : null;

/** The authenticated desktop → browser event for a refusal. */
export const relayPayloadRejectedFrame = (rejection: RelayPayloadRejection): Record<string, unknown> => ({
  event: RELAY_PAYLOAD_REJECTED_EVENT,
  payload: {
    bytes: rejection.bytes,
    limit: rejection.limit,
    ...(rejection.callId !== null ? { id: rejection.callId } : {}),
    ...(rejection.callId === null && rejection.scope === 'push' ? { scope: 'push' as const } : {}),
  },
});
