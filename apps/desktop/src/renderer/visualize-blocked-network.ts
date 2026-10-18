// The outside-network block of a REMOTE Visualize page. The desktop cuts a
// page's outside network in its main process (lease-guard.ts); a paired
// device has no such session, so the page document carries the same policy as
// a CSP (visualize-network-policy.ts) and a small in-page script relays each
// refusal to this side, which files it with the host as the same
// `blocked-network` page problem the desktop records.
import { withHeadMarkup } from '../shared/sandbox-storage-shim';
import { BLOCKED_NETWORK_CSP, blockedResourceType, isOutsideNetworkUrl } from '../shared/visualize-network-policy';
import { MAX_VISUALIZE_PROBLEMS } from '../shared/visualize';

export const PAGE_BLOCKED_REQUEST = 'mixdog-page-blocked';

/** The in-page half (plain ES5, no `</script`). */
const BLOCKED_NETWORK_SCRIPT = `(function () {
  var parentWindow = window.parent;
  if (!parentWindow || parentWindow === window) return;
  document.addEventListener('securitypolicyviolation', function (event) {
    parentWindow.postMessage({ type: ${JSON.stringify(PAGE_BLOCKED_REQUEST)}, url: String(event.blockedURI || ''), directive: String(event.effectiveDirective || '') }, '*');
  });
})();`;

/** `html` with only the refusal reporter in its head, adding no policy: a tab
 *  that allows outside network is still bound by the frame's own CSP (the
 *  relay's preview frame refuses e.g. `wss:`), and those refusals are reported too. */
export function withBlockedNetworkReporter(html: string): string {
  return withHeadMarkup(html, `<script>${BLOCKED_NETWORK_SCRIPT}</script>`);
}

/** `html` under the no-outside-network policy: the CSP first in its head, then the reporter. */
export function withBlockedNetwork(html: string): string {
  return withHeadMarkup(
    html,
    `<meta http-equiv="Content-Security-Policy" content="${BLOCKED_NETWORK_CSP}"><script>${BLOCKED_NETWORK_SCRIPT}</script>`
  );
}

/** Hands `report` each distinct outside request `frame` was refused (its
 *  address and Electron resource type), from that frame's window only, at most
 *  as many as a tab keeps problems. Returns the cleanup. */
export function serveBlockedNetwork(
  frame: HTMLIFrameElement,
  report: (url: string, resource: string) => void
): () => void {
  const seen = new Set<string>();
  const onMessage = (event: MessageEvent): void => {
    const target = frame.contentWindow;
    if (!target || event.source !== target) return;
    const data = event.data as Record<string, unknown> | null;
    if (!data || typeof data !== 'object' || data.type !== PAGE_BLOCKED_REQUEST) return;
    if (typeof data.url !== 'string' || typeof data.directive !== 'string') return;
    let url: URL;
    try {
      url = new URL(data.url);
    } catch {
      return;
    }
    if (!isOutsideNetworkUrl(url)) return;
    const resource = blockedResourceType(data.directive, url);
    const key = `${url.host} ${resource}`;
    if (seen.has(key) || seen.size >= MAX_VISUALIZE_PROBLEMS) return;
    seen.add(key);
    report(url.href.slice(0, 2048), resource);
  };
  window.addEventListener('message', onMessage);
  return () => window.removeEventListener('message', onMessage);
}
