/** Only the trusted desktop renderer may use media, write text to the clipboard,
 *  or put an element (a video in the side panel) into fullscreen. */
export function desktopPermissionAllowed(permission: string, sender: unknown, trustedSender: unknown): boolean {
  return (
    (permission === 'media' || permission === 'clipboard-sanitized-write' || permission === 'fullscreen') &&
    trustedSender != null &&
    sender === trustedSender
  );
}
