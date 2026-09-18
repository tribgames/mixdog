import { createPolling } from '../host-harness-poll';
import { browserPageResample } from '../../shared/browser-page-frame';
import type { DesktopBrowserPageFrame } from '../../shared/contract';
import type { BrowserHost } from './host';

/** Wait for displayed pixels the way the pane does. A capture that lost its
 * race answers with a resample rather than an error, and the states before the
 * first paint are transient, so both are polled instead of failing a harness
 * that only wants the page once it is on screen. */
export async function readyBrowserFrame(host: BrowserHost, sessionId: string): Promise<DesktopBrowserPageFrame> {
  const { eventually } = createPolling({ timeoutMs: 8000, intervalMs: 50 });
  let lastError: unknown;
  try {
    const frame = await eventually(
      async () => {
        try {
          const next = await host.browserPageFrame(sessionId);
          if (browserPageResample(next)) {
            lastError = new Error('Browser page changed during capture.');
            return null;
          }
          return next;
        } catch (error) {
          if (
            !/UnknownVizError|Browser display frame is not ready|Browser page changed during capture/.test(
              String(error)
            )
          )
            throw error;
          lastError = error;
          return null;
        }
      },
      (value) => value !== null
    );
    return frame!;
  } catch (error) {
    throw lastError ?? error;
  }
}
