/** What a Browser Use page request is, by its scheme: web traffic the URL
 *  policy must admit, a request the session can let through as is, or one it
 *  refuses outright. */
import { isDialogBridgeFallback } from './dialog-bridge';

export type BrowserRequestDisposition = 'web' | 'allow' | 'deny';

const DOCUMENT_PROTOCOLS = new Set(['http:', 'https:']);
const WEB_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
/** Content that never leaves the document embedding it. */
const EMBEDDED_ONLY_PROTOCOLS = new Set(['about:', 'data:', 'blob:']);
/** What Chromium's PDF viewer loads: its bundled extension and the shared
 *  WebUI resources it imports (this session installs no extensions).
 *  Chromium still applies its own access rules before serving either. */
const BROWSER_INTERNAL_PROTOCOLS = new Set(['chrome:', 'chrome-extension:']);

/** Whether a URL or origin belongs to one of Chromium's own bundled
 *  components rather than to the page. */
export function isBrowserComponentAddress(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  try {
    return BROWSER_INTERNAL_PROTOCOLS.has(new URL(address).protocol);
  } catch {
    return false;
  }
}

/** A page's own document is only ever an http(s) document; everything it
 *  embeds is web traffic, document-local content, or the browser's own
 *  components. */
export function browserRequestDisposition(url: string, resourceType: string): BrowserRequestDisposition {
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return 'deny';
  }
  if (resourceType === 'mainFrame') return DOCUMENT_PROTOCOLS.has(protocol) ? 'web' : 'deny';
  // Address validation runs before the debugger pauses the request, and a
  // reserved .invalid host never passes it; refusing it here would dismiss
  // every dialog an about:blank page opens.
  if (resourceType === 'xhr' && isDialogBridgeFallback(url)) return 'allow';
  if (WEB_PROTOCOLS.has(protocol)) return 'web';
  return EMBEDDED_ONLY_PROTOCOLS.has(protocol) || BROWSER_INTERNAL_PROTOCOLS.has(protocol) ? 'allow' : 'deny';
}
