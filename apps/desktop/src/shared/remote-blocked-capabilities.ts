import { DESKTOP_IMPORT_CAPABILITIES } from './contract-import';
import { remoteDesktopOnlyError } from './remote-error-codes';

/** Capabilities the host refuses over remote access: host-internal items that
 *  make no sense remotely, and conversation import, which reads this PC's
 *  Codex/Claude folders and is local desktop only. Shared so the host
 *  (`REMOTE_BLOCKED_CAPABILITIES` in `main/remote-methods.ts`) and the
 *  renderer read one list. */
export const REMOTE_BLOCKED_CAPABILITY_NAMES: ReadonlySet<string> = new Set([
  'resolveMediaFile',
  ...DESKTOP_IMPORT_CAPABILITIES,
]);

/** Whether `capability` is refused for every remote client. */
export function remoteCapabilityBlocked(capability: string): boolean {
  return REMOTE_BLOCKED_CAPABILITY_NAMES.has(capability);
}

/** Whether a capability call turns ON "Allow all actions". */
export function isAllowAllActionsEnable(capability: string, args: readonly unknown[] = []): boolean {
  return capability === 'setDeveloperOption' && args[0] === 'allowAllActions' && args[1] === true;
}

/** The argument-sensitive refusals Node's host made of a remote client's capability call before it ran it
 *  (`assertRemoteCapabilityCall`, remote-methods.ts at v1.4.5): a standing allow is never created from a phone, and "Allow all actions"
 *  is only turned on at this PC (any other permission mode, and turning the option off, stay allowed). The core refuses the same
 *  calls to a relay connection (mixdog-core-agents agents/service.rs, mixdog-core-config config/service.rs); this is the page's
 *  answer without a round trip. */
export function assertRemoteCapabilityCall(capability: string, args: readonly unknown[] = []): void {
  if (remoteCapabilityBlocked(capability))
    throw new TypeError(`capability ${capability} is not available over remote access.`);
  if (capability === 'setAgentPermission' && args[2] === 'allow') {
    throw new TypeError(`${capability} cannot create a standing allow over remote access; use the desktop.`);
  }
  if (isAllowAllActionsEnable(capability, args)) {
    throw remoteDesktopOnlyError(`${capability} cannot turn on Allow all actions over remote access; use the desktop.`);
  }
}
