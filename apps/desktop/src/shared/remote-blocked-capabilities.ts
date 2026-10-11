/** Capabilities the host refuses over remote access: host-internal items that
 *  make no sense remotely. Shared so the host (`REMOTE_BLOCKED_CAPABILITIES` in
 *  `main/remote-methods.ts`) and the renderer read one list. */
export const REMOTE_BLOCKED_CAPABILITY_NAMES: ReadonlySet<string> = new Set(['resolveMediaFile']);

/** Whether `capability` is refused for every remote client. */
export function remoteCapabilityBlocked(capability: string): boolean {
  return REMOTE_BLOCKED_CAPABILITY_NAMES.has(capability);
}
