import type { WebContents } from 'electron';

import { secretInputs } from '../secret-input';
import type { BrowserCdpPort } from './cdp';
import type { createBrowserCredentialFill } from './credential-autofill';
import type { BrowserGuestStateStore } from './guest-state';
import { protectSecretNodes } from './visual-privacy';

type Sessions = { sessionIdForGuest(guest: WebContents): string | undefined };

/** What the credential fill works with: a password, a one-time code or an
 *  ask_user/agent-typed secret it types is remembered for the page (redacted
 *  in its replies) and for the session that owns the page (redacted in every
 *  later browser output, whichever tab is read; agent-bridge.ts), and the
 *  elements it typed into are protected in captures (visual-privacy.ts).
 *  Usernames are no secret and are never registered here. */
export function browserCredentialFillHost(
  state: Pick<BrowserGuestStateStore, 'rememberSecret' | 'forgetSecret' | 'redactText'>,
  cdp: BrowserCdpPort,
  sessions: Sessions
): Parameters<typeof createBrowserCredentialFill>[0] {
  return {
    cdp,
    rememberSecret: (guest, secret) => {
      rememberForSession(sessions, guest, secret);
      return state.rememberSecret(guest, secret);
    },
    forgetSecret: (guest, secret) => state.forgetSecret(guest, secret),
    redactText: (guest, value) => state.redactText(guest, value),
    protectNodes: (guest, nodes) => protectSecretNodes(guest, nodes),
  };
}

/** A value the host fills into a page is also remembered for the session that
 *  owns the page, so any later browser tool output of that session hides it
 *  (agent-bridge.ts), whichever tab is read. */
export function rememberForSession(sessions: Sessions, guest: WebContents, value: string): void {
  const sessionId = sessions.sessionIdForGuest(guest);
  if (sessionId) secretInputs.remember(sessionId, value);
}
