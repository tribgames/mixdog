/** A person acted on a page from outside the pane's own display client (a
 *  paired client, or native input on a presented page): it is kept like any
 *  page they touched, and no longer a stand-in the host may tidy away. */
import type { WebContents } from 'electron';

export function createUserTakesPage(host: {
  sessionIdForGuest(guest: WebContents): string | undefined;
  claimPage(sessionId: string, guest: WebContents): void;
  retain(guest: WebContents): void;
}): (guest: WebContents) => void {
  return (guest) => {
    host.retain(guest);
    const sessionId = host.sessionIdForGuest(guest);
    if (sessionId) host.claimPage(sessionId, guest);
  };
}
