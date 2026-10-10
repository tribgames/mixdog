// Payload-limit handling for the browser leg of the relay: the ceilings this
// connection has learned, the pre-send refusal of an oversize frame, and how a
// refusal (or a newly proved ceiling) settles the calls it strands.
import {
  RELAY_PAYLOAD_TOO_LARGE_CODE,
  readRelayUplinkCeilings,
  relayFrameByteLength,
  relayFrameCallId,
  relayFrameCapRefusal,
  relayPayloadTooLargeMessage,
  relayStrandedCallRefusals,
  relayUplinkContract,
  resolveRelayFrameLimit,
  type RelayInflightFrame,
  type RelayPayloadRejection,
  type RelayUplinkCeilings,
} from '../shared/remote-payload-limit';

export interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  /** The frame this call actually sent. Recorded on the call itself so a
   *  ceiling that drops while it is in flight can be applied to it by its
   *  OWN size — never by matching a refusal's size to a list of recent
   *  frames, which is what made attribution guesswork. */
  frame?: RelayInflightFrame;
}

/** The one failure a call gets when the relay would not carry its frame. */
export const relayPayloadTooLargeError = (rejection: RelayPayloadRejection): Error & { code: string } => {
  const failure = new Error(relayPayloadTooLargeMessage(rejection)) as Error & { code: string };
  failure.code = RELAY_PAYLOAD_TOO_LARGE_CODE;
  return failure;
};

// Reaches the toast surface without importing it: notifications.tsx renders
// whatever arrives on DESKTOP_TOAST_EVENT, and this shim installs before the
// React app exists, so it must not pull a component module in.
export const showRemoteToast = (text: string): void => {
  try {
    window.dispatchEvent(
      new CustomEvent('mixdog:desktop-toast', {
        detail: { id: `relay-payload:${Date.now()}`, text, tone: 'error' },
      })
    );
  } catch {
    /* container without a toast surface */
  }
};

export interface RelayPayloadLimitsOptions {
  pending: Map<number, PendingCall>;
  showToast: (text: string) => void;
}

let activeUplinkLimits: (() => RelayUplinkCeilings | null) | null = null;

/** Largest binary frame the relay admits on this connection, or null when it
 *  has published none (or this is not a remote browser). */
export const learnedRelayUplinkBinaryBytes = (): number | null => activeUplinkLimits?.()?.binary ?? null;

export const createRelayPayloadLimits = ({ pending, showToast }: RelayPayloadLimitsOptions) => {
  // The relay's per-frame ceiling as this browser knows it: handed over with
  // the E2EE handshake, and tightened by any refusal notice that proves a
  // smaller one. Until then the shared conservative default applies, so an
  // oversize request is never sent on the assumption that it might fit.
  let learnedFrameLimit: number | null = null;
  /** Capacity of the leg that receives this frame once the relay has wrapped
   *  it. Only a desktop that publishes no ceilings leaves this doing any work:
   *  it is the input the conservative derivation is priced from. */
  let learnedRoutedLimit: number | null = null;
  /** The relay's own ceilings for this connection, forwarded by the desktop
   *  from `relay-capabilities`. This is the contract: the relay published what
   *  it will admit, so the browser refuses at exactly that byte instead of
   *  deriving a second opinion from a capacity and an assumed envelope. */
  let publishedCeilings: RelayUplinkCeilings | null = null;
  // The desktop leg accepted the text-flagged binary envelope, so a text frame
  // is wrapped at a FIXED cost there instead of being JSON-escaped. Only the
  // fallback prices that itself; a published text ceiling already reflects it.
  let relayTextEnvelope = false;
  const relayFrameLimit = (): number => resolveRelayFrameLimit(learnedFrameLimit);
  /** The ceilings this leg enforces before it sends anything: the relay's
   *  published ones, bounded by any smaller ceiling a refusal notice has since
   *  proved. A desktop that publishes none (an older build) falls back to the
   *  conservative derivation, which is never the more permissive of the two. */
  const relayUplinkLimits = (): RelayUplinkCeilings =>
    relayUplinkContract(publishedCeilings, {
      policy: relayFrameLimit(),
      capacity: learnedRoutedLimit,
      textFrames: relayTextEnvelope,
    });
  // The composer reads the ceilings through this module-level handle so it can
  // refuse an oversize attachment at attach time. Unpublished ceilings are a
  // guess, not a contract, so they never gate an attachment.
  activeUplinkLimits = () => (publishedCeilings ? relayUplinkLimits() : null);
  const learnFrameLimit = (candidate: unknown): void => {
    if (typeof candidate !== 'number') return;
    learnedFrameLimit = resolveRelayFrameLimit(candidate, learnedFrameLimit);
  };
  /** Learned caps describe ONE connection: they only ever tighten, so carrying
   *  them across a redial keeps a restarted relay's smaller ceiling forever and
   *  refuses frames the new path accepts. Every connection starts unlearned. */
  const resetLearnedCaps = (): void => {
    learnedFrameLimit = null;
    learnedRoutedLimit = null;
    publishedCeilings = null;
    relayTextEnvelope = false;
  };
  /** Everything the desktop declared when the secure channel opened: the
   *  relay's policy ceiling, the ceilings it published for this connection,
   *  and how a text frame will be wrapped. */
  const learnRoutingCaps = (message: Record<string, unknown>): void => {
    learnFrameLimit(message.maxFrameBytes);
    if (typeof message.maxRoutedBytes === 'number') {
      learnedRoutedLimit = resolveRelayFrameLimit(message.maxRoutedBytes, learnedRoutedLimit);
    }
    publishedCeilings = readRelayUplinkCeilings(message);
    relayTextEnvelope = message.textFrames === 1;
  };

  /** The ceiling can drop while frames are already on their way: the relay
   *  lowers it, and a frame sent a moment earlier — or concurrently, before
   *  the desktop's update lands here — meets the NEW limit. That refusal can
   *  name no call, so without this the call behind it waits out its 20-second
   *  deadline and closes the socket, and a push vanishes with no error at all.
   *  Every call whose own frame is past the ceiling now in force is settled at
   *  once instead, carrying its size and that limit. Calls within the ceiling
   *  are not touched, and no deadline anywhere is moved. */
  const failStrandedCalls = (): void => {
    const waiting: Array<readonly [number, RelayInflightFrame]> = [];
    for (const [id, entry] of pending) {
      if (entry.frame) waiting.push([id, entry.frame] as const);
    }
    if (waiting.length === 0) return;
    for (const refusal of relayStrandedCallRefusals(waiting, relayUplinkLimits())) {
      if (refusal.callId === null) continue;
      const entry = pending.get(refusal.callId);
      if (!entry) continue;
      pending.delete(refusal.callId);
      entry.reject(relayPayloadTooLargeError(refusal));
    }
  };
  /** A refusal fails EXACTLY the call it names and never guesses one. An id is
   *  only ever present when the desktop itself declined to send that call's
   *  answer, inside the encrypted channel; a relay-controlled signal carries
   *  none and is reported to the user without blaming a call that may be
   *  perfectly healthy. Either way the ceiling it reports is learned, so the
   *  next oversize frame is refused before it is sent. */
  const applyRelayPayloadRejection = (rejection: RelayPayloadRejection): void => {
    learnFrameLimit(rejection.limit);
    // The reported ceiling is now the one in force, so anything already sent
    // past it is dead on arrival — including whatever this refusal was about.
    failStrandedCalls();
    if (rejection.callId === null) {
      // Unattributed or a push: the user is told, and NOTHING else happens.
      // Touching in-flight calls here would fail healthy ones — the refusal
      // names no call, so no call's fate may depend on it. Each keeps its own
      // deadline, which is the only bound that belongs to it.
      showToast(relayPayloadTooLargeMessage(rejection));
      return;
    }
    const entry = pending.get(rejection.callId);
    // Already settled (its own deadline, a reconnect): nothing to say twice.
    if (!entry) return;
    pending.delete(rejection.callId);
    entry.reject(relayPayloadTooLargeError(rejection));
  };

  /** Refuse an oversize frame HERE, while holding the very frame that would
   *  fail and knowing the call it carries. What must fit is the frame AS THE
   *  RELAY WILL ROUTE IT — wrapped for the desktop leg and charged again
   *  there — and the relay itself published that ceiling for this connection,
   *  per wire form. Judging the frame against the relay's own figure is what
   *  makes the refusal exact: no second derivation to disagree with it, and
   *  nothing content-dependent. Nothing is sent, so nothing has to be
   *  correlated afterwards and no call waits out its 20-second deadline for an
   *  answer that was never going to come. */
  const refuseOversize = (frame: string | Uint8Array, payload: Record<string, unknown>): void => {
    const refusal = relayFrameCapRefusal(frame, relayUplinkLimits(), relayFrameCallId(payload));
    if (!refusal) return;
    const failure = relayPayloadTooLargeError(refusal);
    // A fire-and-forget publish has no caller to reject: say it once,
    // visibly, instead of dropping it in silence.
    if (refusal.callId === null) showToast(failure.message);
    throw failure;
  };
  /** What this call put on the wire, kept on the call itself, so a ceiling
   *  that drops after the send can be applied to that very frame. */
  const noteSentFrame = (frame: string | Uint8Array, payload: Record<string, unknown>): void => {
    const callId = relayFrameCallId(payload);
    if (callId === null) return;
    const entry = pending.get(callId);
    if (!entry) return;
    entry.frame = { bytes: relayFrameByteLength(frame), binary: typeof frame !== 'string' };
  };

  return {
    relayUplinkLimits,
    learnRoutingCaps,
    resetLearnedCaps,
    applyRelayPayloadRejection,
    refuseOversize,
    noteSentFrame,
  };
};

export type RelayPayloadLimits = ReturnType<typeof createRelayPayloadLimits>;
