// A relay that meets an oversize frame REFUSES that frame instead of tearing
// the connection down, and signals the leg that SENT it (apps/relay/server.mjs
// `socket.oversizeSignal`, armed per leg in runDesktopLeg/runClientLeg):
//   phone sent it (a request):  { resync: 1, error: 'frame-too-large', … }
//   desktop sent it (a reply):  { type: 'frame-too-large', clientId, … }
// Each direction is therefore refused where the frame originated, and only
// there — the peer is told nothing by the relay:
//   desktop leg: { type: 'frame-too-large', clientId, bytes, limit }
//   phone leg:   { resync: 1, error: 'frame-too-large', bytes, limit }
// The phone shape deliberately rides `resync` — the only cleartext key an
// E2EE browser handles BEFORE decryption — so it can never reach decryptJson.
// The desktop forwards the refusal to the affected browser as an encrypted
// `relayPayloadRejected` event.
//
// Attribution is STRUCTURAL, never inferential. A sender measures each frame
// it has already serialized and refuses an oversize one ITSELF, before the
// send: the frame in hand is the frame that failed, so the call it belongs to
// is known exactly and fails at once. Nothing is correlated after the fact —
// byte sizes are not unique keys, and a relay notice cannot say whose frame it
// was.
//
// A relay notice therefore only ever does two things: it teaches the sender
// the real ceiling, and it produces a user-visible payload error that blames
// NO call. Victim selection rides exclusively on an id the receiving side can
// trust — one the desktop put in an authenticated `relayPayloadRejected`
// event. Cleartext relay shapes carry no victim at all.
//
// Nothing here trusts the relay: an unknown or malformed envelope yields null
// and costs the connection nothing.

/** Relay-side error tag, on both the desktop and the phone leg. */
export const RELAY_FRAME_TOO_LARGE = 'frame-too-large';
/** Desktop → browser event carrying a refusal the desktop was told about. */
export const RELAY_PAYLOAD_REJECTED_EVENT = 'relayPayloadRejected';
/** Desktop → browser event carrying ceilings the relay republished DURING a
 *  connection. A phone learns its ceilings once, in the handshake; the relay
 *  republishes `relay-capabilities` whenever a leg's numbers change, and a
 *  phone that never hears about it keeps sending at the old ones. The first
 *  frame past the new ceiling is then refused at the relay, where nothing can
 *  say which call it belonged to: that call waits out its 20-second deadline
 *  and takes the socket with it, and a fire-and-forget publish is lost with no
 *  error at all. Re-issuing the ceilings is what keeps the refusal on this
 *  side, where the frame in hand names its own call. */
export const RELAY_ROUTING_CAPS_EVENT = 'relayRoutingCaps';
/** Error.code on the rejected calls, for callers that branch on cause. */
export const RELAY_PAYLOAD_TOO_LARGE_CODE = 'RELAY_PAYLOAD_TOO_LARGE';

/** What a refusal is known to be about:
 *  `call`  — a named RPC frame (the sender declined to send that answer),
 *  `push`  — a frame with no caller behind it; no pending call is affected,
 *  `unknown` — nobody could attribute it, so some in-flight call may be
 *  waiting for an answer that will never arrive. */
export type RelayRejectionScope = 'call' | 'push' | 'unknown';

export interface RelayPayloadRejection {
  /** Wire size of the refused frame, when the relay reported a usable one. */
  bytes: number | null;
  /** The relay's per-frame ceiling, when reported. */
  limit: number | null;
  /** The call this refusal belongs to. Present ONLY on the authenticated
   *  desktop → browser event, where the desktop names the very frame it
   *  declined to send. Every relay-controlled shape (the cleartext phone
   *  signal included) reads as null even when it carries an `id`: an
   *  attacker-influenced field must never be able to fail a call. */
  callId: number | null;
  /** Whether an in-flight call can still be waiting because of this refusal. */
  scope: RelayRejectionScope;
}

const positiveSize = (value: unknown): number | null => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : null;
};

const callIdOf = (value: unknown): number | null => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
);

const NON_ASCII = /[^\u0000-\u007F]/;

/** The unit the relay measures a frame in: UTF-8 bytes for text, byte length
 *  for a binary box (apps/relay/server.mjs `frameBytes`). A recorded size that
 *  uses UTF-16 code units instead would under-count every non-ASCII payload
 *  and miss the very frame that was refused. The ASCII fast path keeps the
 *  common case (base64url ciphertext) allocation-free. */
export const relayFrameByteLength = (
  frame: string | ArrayBufferView,
): number => {
  if (typeof frame !== 'string') return frame.byteLength;
  return NON_ASCII.test(frame) ? new TextEncoder().encode(frame).length : frame.length;
};

/** Recognises a refusal in any of its three envelopes; returns null for
 *  everything else, malformed input included. */
export const readRelayPayloadRejection = (
  source: unknown,
  /** TRUE only when the caller knows this message arrived over an
   *  authenticated channel (a decrypted E2EE frame). Trust is a property of
   *  the channel, never of the shape: cleartext relay data reaches the same
   *  handler on a non-E2EE connection, and a forged `relayPayloadRejected`
   *  there must not be able to fail a call. Defaults to untrusted. */
  authenticated = false,
): RelayPayloadRejection | null => {
  if (!source || typeof source !== 'object') return null;
  const frame = source as Record<string, unknown>;
  const desktopEvent = frame.event === RELAY_PAYLOAD_REJECTED_EVENT;
  const refused = desktopEvent
    || frame.type === RELAY_FRAME_TOO_LARGE
    || frame.error === RELAY_FRAME_TOO_LARGE;
  if (!refused) return null;
  const detail = frame.payload && typeof frame.payload === 'object'
    ? frame.payload as Record<string, unknown>
    : frame;
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
export const relayPayloadTooLargeMessage = (
  rejection: RelayPayloadRejection,
): string => {
  // Defensive typeof rather than `!== null`: these numbers come off the wire.
  const bytes = typeof rejection.bytes === 'number' ? rejection.bytes : null;
  const limit = typeof rejection.limit === 'number' ? rejection.limit : null;
  if (bytes !== null && limit !== null) {
    return `payload too large for the relay (${megabytes(bytes)} of ${megabytes(limit)} MB)`;
  }
  if (bytes !== null) return `payload too large for the relay (${megabytes(bytes)} MB)`;
  return 'payload too large for the relay';
};

/** Ceiling assumed before anything better is known: the relay's own policy
 *  ceiling (apps/relay/server.mjs `MAX_FRAME_BYTES`). A sender that has learned
 *  nothing yet must not be more permissive than this. */
export const RELAY_DEFAULT_MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** The ceiling to enforce, given everything a leg has been told: the relay's
 *  declared capability, and any limit a refusal notice reported. The SMALLEST
 *  usable candidate wins, so the local check can never be more permissive than
 *  the relay's; with nothing usable, the shared default applies. */
export const resolveRelayFrameLimit = (
  ...candidates: ReadonlyArray<number | null | undefined>
): number => {
  let limit: number | null = null;
  for (const candidate of candidates) {
    if (typeof candidate !== 'number' || !Number.isFinite(candidate) || candidate <= 0) continue;
    limit = limit === null ? Math.floor(candidate) : Math.min(limit, Math.floor(candidate));
  }
  return limit ?? RELAY_DEFAULT_MAX_FRAME_BYTES;
};

/** The refusal for a frame this leg has ALREADY serialized, or null when it
 *  fits. `callId` is the call the frame belongs to — read off that very frame,
 *  never inferred — so identical sizes, colliding pushes and log rotation
 *  cannot exist as failure modes. */
export const relayFrameRefusal = (
  bytes: number,
  limit: number,
  callId: number | null,
): RelayPayloadRejection | null => {
  if (bytes <= limit) return null;
  const id = callIdOf(callId);
  // The sender knows exactly what it declined to send: a call's frame, or a
  // push that leaves no one waiting.
  return { bytes, limit, callId: id, scope: id === null ? 'push' : 'call' };
};

/** One frame a call has ALREADY put on the wire, kept on that call: its wire
 *  size and which envelope carries it. Not a log and not a lookup key — it is
 *  the call's own property, so nothing is ever matched by size after the
 *  fact. */
export interface RelayInflightFrame {
  bytes: number;
  binary: boolean;
}

/** The calls a newly proved ceiling has already stranded.
 *
 *  A relay refusal that names nobody (it cannot see inside the E2EE envelope)
 *  still proves ONE thing: the ceiling now in force is the one it reported. A
 *  call still waiting whose own frame is larger than that ceiling can never be
 *  answered — the relay will not carry that frame — so it is settled here,
 *  with its size and the limit, instead of waiting out a 20-second deadline
 *  that also takes the socket down with it.
 *
 *  Attribution stays structural: each call is judged by the frame IT sent
 *  against the ceiling that applies to that frame's wire form. The refusal's
 *  own `bytes` is never matched to anything, so identical sizes and colliding
 *  frames remain non-problems, and a call within the ceiling is untouched. */
export const relayStrandedCallRefusals = (
  inflight: Iterable<readonly [number, RelayInflightFrame]>,
  ceilings: { binary: number; text: number },
): RelayPayloadRejection[] => {
  const stranded: RelayPayloadRejection[] = [];
  for (const [callId, frame] of inflight) {
    const refusal = relayFrameRefusal(
      frame.bytes,
      frame.binary ? ceilings.binary : ceilings.text,
      callId,
    );
    if (refusal) stranded.push(refusal);
  }
  return stranded;
};

// A phone frame is charged TWICE: once as it is sent, and again after the
// relay wraps it for the desktop leg. Who may compute that second charge is
// settled: the RELAY does, and publishes the result. It is the only party that
// knows the effective capacity of the leg it is routing to (it clamps what the
// leg declared, and lowers it again for a receiver it has observed refuse) and
// the exact route id it wraps a frame in. Everything below either forwards
// those published numbers or, for a peer that publishes none, derives a
// deliberately smaller stand-in.

/** `encodeRelayBinaryFrame` header (apps/relay/lib/relay-binary-frame.mjs). */
export const RELAY_BINARY_HEADER_BYTES = 6;
/** `{"type":"frame","clientId":"` + id + `","data":""}` — 38 bytes of
 *  scaffolding plus the two quotes of an empty payload, exactly the `jsonBase`
 *  the relay computes for its published ceiling. */
export const RELAY_JSON_ENVELOPE_BYTES = 38 + 2;
/** Bytes one payload byte may become inside the JSON envelope. The relay does
 *  NOT price the frame in hand — a ceiling derived from current content is not
 *  a ceiling, because clients learn it and keep it — so it assumes this and
 *  refuses everything above the resulting limit
 *  (apps/relay/server.mjs `JSON_ESCAPE_WORST_CASE`). */
export const RELAY_JSON_ESCAPE_WORST_CASE = 6;
/** Route id the FALLBACK below prices its envelope with. Every relay routes a
 *  phone by a 36-byte `randomUUID()` (apps/relay/server.mjs `runClientLeg`),
 *  and a relay that publishes its ceilings has already charged that exact id;
 *  64 is the binary decoder's upper bound, charged here ON PURPOSE. The
 *  direction is the whole point: over-charging the envelope can only push a
 *  derived ceiling BELOW the one the relay applies, so a fallback is stricter
 *  than the path it guards and never more permissive than it. */
export const RELAY_FALLBACK_CLIENT_ID_BYTES = 64;

/** One connection's admission decision, in the relay's own terms: the capacity
 *  of the leg that RECEIVES a routed frame, and the largest frame each wire
 *  form may carry to it. The relay computes these per connection and publishes
 *  them (apps/relay/server.mjs `relayCapabilities`); the desktop forwards the
 *  same three numbers to the browser, so every leg reaches the same verdict
 *  instead of re-deriving one from different inputs. */
export interface RelayUplinkCeilings {
  capacity: number;
  binary: number;
  text: number;
}

/** A published size. Zero is a legitimate ceiling (a capacity smaller than the
 *  envelope itself), so it is a value, not a missing field. */
const publishedSize = (value: unknown): number | null => (
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null
);

/** The ceilings a peer PUBLISHED for this connection, or null when it
 *  published none. The same three fields travel on both hops — relay → desktop
 *  in `relay-capabilities`, desktop → browser in `e2ee-ready` — so what the
 *  browser enforces is the relay's own figure, forwarded, never a
 *  recomputation of it. Partial publication counts as none: two authoritative
 *  numbers plus one guess is still a guess. */
export const readRelayUplinkCeilings = (frame: unknown): RelayUplinkCeilings | null => {
  if (!frame || typeof frame !== 'object') return null;
  const published = frame as Record<string, unknown>;
  const capacity = publishedSize(published.uplinkCapacityBytes);
  const binary = publishedSize(published.uplinkBinaryCeilingBytes);
  const text = publishedSize(published.uplinkTextCeilingBytes);
  if (capacity === null || binary === null || text === null) return null;
  return { capacity, binary, text };
};

/** The published fields again, ready to be handed to the next leg verbatim. */
export const relayUplinkCeilingFields = (
  ceilings: RelayUplinkCeilings,
): Record<string, number> => ({
  uplinkCapacityBytes: ceilings.capacity,
  uplinkBinaryCeilingBytes: ceilings.binary,
  uplinkTextCeilingBytes: ceilings.text,
});

/** Capacity assumed for a leg whose capacity was never published: the SMALLEST
 *  capacity the relay can hold at all (apps/relay/server.mjs
 *  `MIN_UPLINK_CAPACITY_BYTES` — every capacity there, declared or configured,
 *  is normalised up to it). Not a typical capacity and not meant to be one: it
 *  is the only number that cannot be above the real one, whatever a silent
 *  relay was configured with. The alternatives all fail somewhere — the policy
 *  ceiling is 64 MiB on the shipped relay and describes frames, not receivers;
 *  the relay's undeclared-leg floor of 64 KiB is above a leg configured at 4
 *  KiB, whose real ceilings are 4054/670. Deriving from this minimum yields
 *  954 binary / 153 text, which is at or below every capacity the relay
 *  accepts. It is deliberately tiny: an unpublished capacity is not a small
 *  path, it is an unknown one, and the way out is publication rather than a
 *  larger guess. */
export const RELAY_UNPUBLISHED_CAPACITY_BYTES = 1024;

/** FALLBACK ONLY — the relay's rule (apps/relay/server.mjs `uplinkCeilings`)
 *  mirrored for a peer that publishes nothing. A mirror is trustworthy in ONE
 *  direction only, so every assumption in it is pessimistic on purpose:
 *   • the route id is charged at RELAY_FALLBACK_CLIENT_ID_BYTES (64) although
 *     the relay routes by a 36-byte UUID — an id this side never sees, priced
 *     high so the error can only be in the safe direction;
 *   • the JSON envelope is charged at its worst-case escaping, never at what
 *     this frame happens to escape to;
 *   • an unpublished capacity is charged at RELAY_UNPUBLISHED_CAPACITY_BYTES,
 *     the smallest capacity the relay can hold — never at the policy ceiling,
 *     which says nothing about what the receiving leg can take, and never at a
 *     comfortable floor some real configuration sits below.
 *  All three push the result DOWN. This leg therefore refuses everything such
 *  a relay refuses, plus a good deal it would have accepted; it is never the
 *  more permissive of the two. */
export const relayFallbackUplinkCeilings = (
  { capacity, policy, textFrames = false }:
    { capacity: number; policy: number; textFrames?: boolean },
): RelayUplinkCeilings => {
  const binary = Math.max(0, Math.min(
    policy,
    capacity - RELAY_BINARY_HEADER_BYTES - RELAY_FALLBACK_CLIENT_ID_BYTES,
  ));
  return {
    capacity,
    binary,
    text: textFrames
      ? binary
      : Math.max(0, Math.min(policy, Math.floor(
        (capacity - RELAY_JSON_ENVELOPE_BYTES - RELAY_FALLBACK_CLIENT_ID_BYTES)
          / RELAY_JSON_ESCAPE_WORST_CASE,
      ))),
  };
};

/** The ceilings this leg enforces, and republishes to the next one: what the
 *  peer published, never above the policy ceiling known here — a refusal
 *  notice can prove a smaller one after the handshake. With nothing published,
 *  the fallback stands in, priced from a capacity the peer stated; a capacity
 *  nobody stated is priced at the protocol floor, NEVER at the policy ceiling
 *  (a policy ceiling is a statement about frames, not about the receiver). */
export const relayUplinkContract = (
  published: RelayUplinkCeilings | null,
  { policy, capacity = null, textFrames = false }:
    { policy: number; capacity?: number | null; textFrames?: boolean },
): RelayUplinkCeilings => {
  const base = published ?? relayFallbackUplinkCeilings({
    capacity: capacity !== null && capacity > 0
      ? capacity
      : RELAY_UNPUBLISHED_CAPACITY_BYTES,
    policy,
    textFrames,
  });
  return {
    capacity: base.capacity,
    binary: Math.min(base.binary, policy),
    text: Math.min(base.text, policy),
  };
};

/** The pre-send verdict for one frame on its path: its own size against the
 *  ceiling that applies to its wire form. The ceilings come from the relay
 *  itself, so nothing the relay refuses can leave this side — and nothing it
 *  accepts is refused here. */
export const relayFrameCapRefusal = (
  frame: string | ArrayBufferView,
  ceilings: { binary: number; text: number },
  callId: number | null,
): RelayPayloadRejection | null => relayFrameRefusal(
  relayFrameByteLength(frame),
  typeof frame === 'string' ? ceilings.text : ceilings.binary,
  callId,
);

/** The call a frame carries (a request) or answers (a response); pushes have
 *  none, and a push refusal therefore blames nobody. */
export const relayFrameCallId = (payload: unknown): number | null => (
  payload && typeof payload === 'object'
    ? callIdOf((payload as { id?: unknown }).id)
    : null
);

/** The authenticated desktop → browser event for a refusal. The id travels
 *  only when the desktop itself named the call. */
export const relayPayloadRejectedFrame = (
  rejection: RelayPayloadRejection,
): Record<string, unknown> => ({
  event: RELAY_PAYLOAD_REJECTED_EVENT,
  payload: {
    bytes: rejection.bytes,
    limit: rejection.limit,
    ...(rejection.callId !== null ? { id: rejection.callId } : {}),
    // A push refusal leaves nobody waiting; anything unattributed does, and
    // the browser has to stop that wait instead of running it to the deadline.
    ...(rejection.callId === null && rejection.scope === 'push'
      ? { scope: 'push' as const }
      : {}),
  },
});
