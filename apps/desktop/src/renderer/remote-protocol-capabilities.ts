// The phone's `invokeCapability` for every capability no other group claims (voice status, the workflow and orchestration choices,
// skills, the settings reads the composer and sidebar make, ...). The review and worktree groups keep their own capabilities, found
// first by name (remote-shim-protocol.ts `handlerOf`); this group answers the call itself, so a capability the desktop serves is not a
// call that rejects on the phone for lack of an owner.
//
// A call is checked before anything is sent exactly as the desktop's own host checks one (main/ipc-validation.ts
// `requiredDesktopCapabilityRequest`: the fields, a known name, the capability's argument count, its per-capability rules and the
// addressed session), after the capabilities no remote client may call (shared/remote-blocked-capabilities.ts, Node's
// `assertRemoteCapability`) and the calls Node refused by their arguments (`assertRemoteCapabilityCall`: a standing allow, turning on
// "Allow all actions"; the core refuses both to a relay connection too). The page is not the boundary: the core refuses the same capabilities to a relay connection by its method
// table (`origins` of `media/resolveMediaFile` and `import/*` in mixdog-app-protocol methods.rs).
import { requiredCapabilityRequestUsing } from '../main/ipc-validation';
import { assertRemoteCapabilityCall, remoteCapabilityBlocked } from '../shared/remote-blocked-capabilities';
import { isAbsoluteHostPath } from '../shared/remote-files-arguments';
import { invokePhoneCapability } from './remote-capability-lane';
import type { NodeCall, PhoneProtocolAdapter } from './remote-shim-protocol';

const invokeCapability: NodeCall = ([input], host) => {
  const named = (input as { capability?: unknown } | null | undefined)?.capability;
  if (typeof named === 'string' && remoteCapabilityBlocked(named)) {
    throw new TypeError(`capability ${named} is not available over remote access.`);
  }
  const request = requiredCapabilityRequestUsing(input, isAbsoluteHostPath);
  assertRemoteCapabilityCall(request.capability, request.args);
  return invokePhoneCapability(host, { ...request, args: [...(request.args ?? [])] }, false);
};

export const adapter: PhoneProtocolAdapter = {
  group: 'capabilities',
  calls: { invokeCapability },
};
