// "Open in the system browser" on a paired device. A loopback address
// (`http://localhost:5173`, `127.0.0.1`, `[::1]`) names the PC the agent runs
// on; this device's own browser would reach itself instead. Such an address
// opens in the PC's browser, streamed into the conversation's browser panel.
import { browserPageRequestsAvailable, requestBrowserPage } from './browser-page-request';
import { t } from './i18n';

/** Whether `url` is a web address on the machine that serves it. */
export function isLoopbackWebUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === '::1' ||
    host === '0.0.0.0' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

export interface RemoteExternalLinkDeps {
  /** The conversation on screen, whose browser panel shows the PC's page. */
  sessionId(): string | undefined;
  /** Opens a tab in the PC's main-workspace browser (a host that offers it). */
  openHostTab?(url: string): Promise<unknown>;
  /** This device's own browser, for every other address. */
  openHere(url: string): Promise<void>;
}

export async function openRemoteExternalLink(url: string, deps: RemoteExternalLinkDeps): Promise<void> {
  if (!isLoopbackWebUrl(url)) return deps.openHere(url);
  const sessionId = deps.sessionId();
  if (sessionId && browserPageRequestsAvailable()) {
    requestBrowserPage(sessionId, url, { newTab: true });
    return;
  }
  if (deps.openHostTab) {
    await deps.openHostTab(url);
    return;
  }
  throw new Error(t("This address is on the PC. Open it from a conversation's browser panel."));
}
