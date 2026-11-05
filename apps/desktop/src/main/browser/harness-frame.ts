import { browserPageResample } from '../../shared/browser-page-frame';
import type { DesktopBrowserPageFrame } from '../../shared/contract';
import { createBrowserDisplayHealth } from '../../renderer/browser-display-health';
import { browserCaptureTransient, browserPageTransition } from '../../renderer/browser-page-recovery';
import type { BrowserHost } from './host';

const DEADLINE_MS = 20_000;

/** Wait for displayed pixels the way the pane does (IsolatedBrowserView's
 * presentation loop): every failed read, a timeout of the 2.5 s bounded capture
 * included, is retried after the pane's own delay (250 ms for a transient Viz
 * error, one frame for a page change, 1 s otherwise) and is tracked by the same
 * display-health object. A resample answer is a page change and re-reads at
 * once. The wait fails the moment the pane's health would show the user an
 * error (retries that stay invisible are allowed), else at the harness's
 * deadline with the last error. */
export async function readyBrowserFrame(host: BrowserHost, sessionId: string): Promise<DesktopBrowserPageFrame> {
  const health = createBrowserDisplayHealth();
  const deadline = Date.now() + DEADLINE_MS;
  let lastError: unknown;
  for (;;) {
    let delay: number;
    try {
      const next = await host.browserPageFrame(sessionId);
      if (!browserPageResample(next)) return next;
      lastError = new Error('Browser page changed during capture.');
      delay = 1000 / 60;
    } catch (error) {
      lastError = error;
      // The pane shows this text to the user once its patience runs out; a
      // harness that went on to succeed would hide a visible error flash.
      const visible = health.failed(error, Date.now(), 'harness');
      if (visible) throw new Error(`Browser pane would show an error: ${visible}`);
      if (browserCaptureTransient(error)) delay = 250;
      else delay = browserPageTransition(error, 'capture') ? 1000 / 60 : 1000;
    }
    if (Date.now() + delay > deadline) throw lastError;
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

