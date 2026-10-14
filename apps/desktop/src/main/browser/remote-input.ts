import type { WebContents } from 'electron';

import { browserDocumentId, type BrowserGuestStateStore } from './guest-state';
import type { BrowserRemoteControlHost } from './remote-stream';

type PageInputType = 'pointer' | 'wheel' | 'text' | 'key' | 'composition' | 'composition-end';

/** A control that is a person's input to the page, sent document-bound. */
export function isPageInputControl<T extends { type: string }>(
  control: T
): control is Extract<T, { type: PageInputType }> {
  return (
    control.type === 'pointer' ||
    control.type === 'wheel' ||
    control.type === 'text' ||
    control.type === 'key' ||
    control.type === 'composition' ||
    control.type === 'composition-end'
  );
}

/** Throws unless `guest` is still the session's page showing `documentId`. */
export function pageInputGuard(
  state: BrowserGuestStateStore,
  host: Pick<BrowserRemoteControlHost, 'currentGuest'>,
  sessionId: string,
  guest: WebContents,
  documentId: string
): () => void {
  return () => {
    if (
      guest.isDestroyed() ||
      state.for(guest).crashed ||
      host.currentGuest(sessionId) !== guest ||
      documentId !== browserDocumentId(state, guest)
    ) {
      throw new Error('Remote Browser Use page changed; input was not sent.');
    }
  };
}
