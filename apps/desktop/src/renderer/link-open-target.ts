// The one decision for a chat link to a web page (a web URL, or a local HTML
// file main serves on a loopback address): the session's side browser pane,
// or the system browser. Every link surface asks here.
import { isLoopbackWebUrl } from './remote-external-link';

export type LinkOpenTarget = 'pane' | 'external';

export type LinkOpenContext = {
  /** The session whose pane would show the page; absent in a draft. */
  sessionId?: string;
  /** A shell that can reveal a pane is mounted (`browserPageRequestsAvailable()`). */
  paneAvailable: boolean;
  /** The user asked for the system browser (Ctrl/Meta/middle click, menu);
   *  `false` asks for the pane even for a remote web page (Shift-click, menu). */
  external?: boolean;
  /** The clicked address. A remote http(s) page defaults to the system
   *  browser, which holds the user's sign-ins; the pane has none. Loopback
   *  addresses and every other scheme (file:, Mixdog's media/preview
   *  schemes) stay in the pane. */
  url?: string;
};

const DRAFT_SESSION = 'new-task';

/** An http(s) page that is not on this machine. */
function isRemoteWebUrl(url: string): boolean {
  return /^https?:\/\//i.test(url) && !isLoopbackWebUrl(url);
}

export function linkOpenTarget({ sessionId, paneAvailable, external, url }: LinkOpenContext): LinkOpenTarget {
  if (external) return 'external';
  if (!sessionId || sessionId === DRAFT_SESSION || !paneAvailable) return 'external';
  return external === undefined && url && isRemoteWebUrl(url) ? 'external' : 'pane';
}
