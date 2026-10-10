// The one decision for a chat link to a web page (a web URL, or a local HTML
// file main serves on a loopback address): the session's side browser pane,
// or the system browser. Every link surface asks here.

export type LinkOpenTarget = 'pane' | 'external';

export type LinkOpenContext = {
  /** The session whose pane would show the page; absent in a draft. */
  sessionId?: string;
  /** A shell that can reveal a pane is mounted (`browserPageRequestsAvailable()`). */
  paneAvailable: boolean;
  /** The user asked for the system browser (Ctrl/Meta/middle click, menu). */
  external?: boolean;
};

const DRAFT_SESSION = 'new-task';

export function linkOpenTarget({ sessionId, paneAvailable, external }: LinkOpenContext): LinkOpenTarget {
  if (external) return 'external';
  return sessionId && sessionId !== DRAFT_SESSION && paneAvailable ? 'pane' : 'external';
}
