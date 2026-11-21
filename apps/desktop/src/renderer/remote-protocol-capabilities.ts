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
