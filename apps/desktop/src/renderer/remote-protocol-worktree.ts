import { DESKTOP_WORKTREE_CAPABILITIES, type DesktopWorktreeCapability } from '../shared/contract';
import { requiredCapabilityRequest } from '../shared/capability-request';
import { requiredSessionId } from '../main/desktop-state';
import {
  isWorktreeCapability,
  validateWorktreeCapabilityArgs,
  WORKTREE_CAPABILITY_ARITY,
} from '../main/worktree-validation';
import { invokePhoneCapability } from './remote-capability-lane';
import type { NodeCall, PhoneProtocolAdapter } from './remote-shim-protocol';

const invokeWorktree: NodeCall = ([input], host) => {
  const request = requiredCapabilityRequest(input, {
    known: (name): name is DesktopWorktreeCapability => isWorktreeCapability(name as DesktopWorktreeCapability),
    arity: (capability) => WORKTREE_CAPABILITY_ARITY[capability],
    validate: (capability, args) => validateWorktreeCapabilityArgs(capability, args),
    sessionId: requiredSessionId,
  });
  return invokePhoneCapability(host, request, false);
};

export const adapter: PhoneProtocolAdapter = {
  group: 'worktree',
  capabilities: Object.fromEntries(DESKTOP_WORKTREE_CAPABILITIES.map((capability) => [capability, invokeWorktree])),
};
