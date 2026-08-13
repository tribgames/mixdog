/** Only the trusted desktop renderer may request camera/microphone access. */
export function desktopPermissionAllowed(
  permission: string,
  sender: unknown,
  trustedSender: unknown,
): boolean {
  return permission === 'media' && trustedSender != null && sender === trustedSender;
}
