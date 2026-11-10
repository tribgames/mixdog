// The phone's review reads over `mixdogd` (the turn review bar, the transcript's turn changes and the session diff):
// `invokeCapability` for the five review reads, answered as Node's relay did (remote-methods.ts `invokeCapability` at b6f10295a): the
// request's shape and the read's argument rules (ipc-validation.ts validateTurnCapabilityArgs) before anything is sent, then the core
// over the desktop's capability lane (remote-capability-lane.ts), with the value alone (VALUE_ONLY_SESSION_CAPABILITIES: Node never
// sent these reads the session's snapshot).
import { requiredCapabilityRequest, TURN_REVIEW_CAPABILITY_ARITY, validateTurnCapabilityArgs } from '../shared/capability-request';
import { requiredSessionId } from '../main/desktop-state';
import { invokePhoneCapability } from './remote-capability-lane';
import type { NodeCall, PhoneProtocolAdapter } from './remote-shim-protocol';

const REVIEW_READS = ['getTurnReviewDiff', 'getTurnReviewFilePatch', 'getSessionReviewDiff', 'getSessionReviewFilePatch', 'getTurnChanges'] as const;
type ReviewRead = (typeof REVIEW_READS)[number];
const READS: ReadonlySet<string> = new Set(REVIEW_READS);

const invokeReview: NodeCall = ([input], host) => {
  const request = requiredCapabilityRequest(input, {
    known: (name): name is ReviewRead => READS.has(name),
    arity: (capability) => TURN_REVIEW_CAPABILITY_ARITY[capability],
    validate: (capability, args) => validateTurnCapabilityArgs(capability, args),
    sessionId: requiredSessionId,
  });
  return invokePhoneCapability(host, request, true);
};

export const adapter: PhoneProtocolAdapter = {
  group: 'review',
  capabilities: Object.fromEntries(REVIEW_READS.map((capability) => [capability, invokeReview])),
};
