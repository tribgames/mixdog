import {
  requiredCapabilityRequest,
  TURN_REVIEW_CAPABILITY_ARITY,
  validateTurnCapabilityArgs,
} from '../shared/capability-request';
import { requiredSessionId } from '../main/desktop-state';
import { invokePhoneCapability } from './remote-capability-lane';
import type { NodeCall, PhoneProtocolAdapter } from './remote-shim-protocol';

const REVIEW_READS = [
  'getTurnReviewDiff',
  'getTurnReviewFilePatch',
  'getSessionReviewDiff',
  'getSessionReviewFilePatch',
  'getTurnChanges',
] as const;
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
