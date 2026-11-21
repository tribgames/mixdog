import type { WebContents } from 'electron';

import type { BrowserCommandResult } from './host-types';
import type { BrowserNetworkLedger } from './network';
import { browserPostconditionMatches, type BrowserPostcondition } from './postcondition';
import { timedBrowserOperation } from './timing';
import { createBrowserDomQuiet } from './dom-quiet';

interface BrowserSettleDiagnostics {
  network: BrowserNetworkLedger;
  pendingDialog: { type: string; message: string } | null;
}

interface BrowserSettleHost {
  diagnostics(guest: WebContents): BrowserSettleDiagnostics;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  /** Resolves false when a frame never confirmed the checkpoint. */
  renderCheckpoint(guest: WebContents, background: boolean, signal?: AbortSignal): Promise<boolean | void>;
  pageText(guest: WebContents, signal?: AbortSignal): Promise<string>;
  /** How long the page must stay quiet before a gesture counts as settled. */
  quietMs: number;
  domTimeoutMs: number;
  loadTimeoutMs: number;
}

/** Why a cancelled command stops: the caller's own reason, or a plain
 *  cancellation when the signal was aborted without one. */
export function browserCancellation(signal: AbortSignal): unknown {
  return signal.reason || new Error('browser command cancelled');
}

/** Stop a command whose caller has already cancelled it. */
export function throwIfBrowserCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw browserCancellation(signal);
}

/** Sleep that a cancelled command wakes from immediately. */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfBrowserCancelled(signal);
  await new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (!signal) return;
    onAbort = () => {
      clearTimeout(timer);
      reject(browserCancellation(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

async function waitForLoadSettle(
  host: BrowserSettleHost,
  guest: WebContents,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted || !guest.isLoading() || host.diagnostics(guest).pendingDialog) return;
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const finish = () => {
      if (timer) clearTimeout(timer);
      guest.removeListener('did-stop-loading', finish);
      signal?.removeEventListener('abort', finish);
      resolve();
    };
    timer = setTimeout(finish, timeoutMs);
    guest.on('did-stop-loading', finish);
    signal?.addEventListener('abort', finish, { once: true });
    // Loading or cancellation can finish between the preflight checks and
    // listener registration. Rechecking closes that otherwise full-timeout
    // race without shortening the real settle window.
    if (signal?.aborted || !guest.isLoading()) finish();
  });
}

async function waitForNetworkQuiet(host: BrowserSettleHost, guest: WebContents, signal?: AbortSignal): Promise<void> {
  const diagnostics = host.diagnostics(guest);
  const startedAt = Date.now();
  let quietSince = diagnostics.network.pendingCount === 0 ? Date.now() : 0;
  while (Date.now() - startedAt < host.domTimeoutMs) {
    throwIfBrowserCancelled(signal);
    if (diagnostics.pendingDialog) return;
    const recentInflight = diagnostics.network.recentInflight();
    if (recentInflight.length === 0) {
      if (!quietSince) quietSince = Date.now();
      if (Date.now() - quietSince >= host.quietMs) return;
    } else {
      quietSince = 0;
    }
    await pause(75, signal);
  }
}

/** How CDP reports that the document a checkpoint was awaiting in went away:
 *  the gesture itself navigated (Enter in a search box, a submit button). */
export const DOCUMENT_REPLACED = /Inspected target navigated or closed|Execution context was destroyed/;

async function stepSettleResult(
  host: BrowserSettleHost,
  guest: WebContents,
  signal?: AbortSignal,
  background = false,
  onUnconfirmed?: () => void
): Promise<BrowserCommandResult> {
  throwIfBrowserCancelled(signal);
  if (!host.diagnostics(guest).pendingDialog) {
    try {
      // A frame that never confirmed (scripts blocked, no timers) is not a
      // failure and the input is never replayed, but its pending work is
      // unknown, so the caller must not treat an idle network as settled.
      if ((await host.renderCheckpoint(guest, background, signal)) === false) onUnconfirmed?.();
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      // The old document has nothing left to render; the navigation the input
      // started is what the caller's load settle and reply observe next.
      if (!host.diagnostics(guest).pendingDialog) {
        const replaced =
          !guest.isDestroyed() && DOCUMENT_REPLACED.test(error instanceof Error ? error.message : String(error));
        if (replaced) return { outcome: 'completed', text: '' };
        return {
          outcome: 'inconclusive',
          // The page itself is loaded and the gesture landed; only this reading
          // of it failed. Say so, or the caller abandons a page that is fine.
          text:
            'The browser input executed, but its rendering checkpoint failed; input was not replayed.' +
            ' The page is still there — observe it again instead of repeating the action.' +
            ` ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
  }
  throwIfBrowserCancelled(signal);
  const dialog = host.diagnostics(guest).pendingDialog;
  return dialog
    ? { outcome: 'blocked', text: `A ${dialog.type} dialog is blocking the sequence.` }
    : { outcome: 'completed', text: '' };
}

async function postconditionMatchesGuest(
  host: BrowserSettleHost,
  guest: WebContents,
  expected: BrowserPostcondition,
  signal?: AbortSignal
): Promise<boolean> {
  signal?.throwIfAborted();
  const url = guest.getURL();
  if (!browserPostconditionMatches({ url: expected.url }, { url, text: null })) return false;
  if (!expected.text && !expected.textGone) return true;
  try {
    const text = await host.pageText(guest, signal);
    signal?.throwIfAborted();
    return guest.getURL() === url && browserPostconditionMatches(expected, { url, text });
  } catch (error) {
    if (signal?.aborted) throw signal.reason || error;
    return false;
  }
}

export function createBrowserSettle(host: BrowserSettleHost) {
  const waitForDomQuiet = createBrowserDomQuiet({
    evaluate: host.evaluate,
    quietMs: host.quietMs,
    timeoutMs: host.domTimeoutMs,
  });

  /** Load, DOM, and network observation together, each bounded by its timeout. */
  async function observeQuiet(
    guest: WebContents,
    signal?: AbortSignal,
    settleSignal = signal,
    earlyExit?: Promise<unknown>
  ): Promise<void> {
    const observed = Promise.allSettled([
      waitForLoadSettle(host, guest, host.loadTimeoutMs, settleSignal),
      waitForDomQuiet(guest, signal, earlyExit),
      waitForNetworkQuiet(host, guest, settleSignal),
    ]);
    // Racing the group, not just aborting it: allSettled still waits for any
    // observer that does not watch the cutoff signal, which made the early
    // exit worth only ~200ms instead of the full quiet window.
    await (earlyExit ? Promise.race([observed, earlyExit]) : observed);
    throwIfBrowserCancelled(signal);
  }

  async function settleAfterAction(
    guest: WebContents,
    signal?: AbortSignal,
    until?: Promise<unknown>,
    options: { background?: boolean; requireQuiet?: boolean; previousUrl?: string } = {}
  ): Promise<void> {
    const stopOnAbort = () => {
      if (!guest.isDestroyed() && guest.isLoading()) {
        try {
          guest.stop();
        } catch {
          /* teardown can race cancellation */
        }
      }
    };
    signal?.addEventListener('abort', stopOnAbort, { once: true });
    const routeChanged =
      options.previousUrl !== undefined && !guest.isLoading() && guest.getURL() !== options.previousUrl;
    const earlyExit = routeChanged ? undefined : until;
    const cutoff = new AbortController();
    const settleSignal = signal ? AbortSignal.any([signal, cutoff.signal]) : cutoff.signal;
    void earlyExit?.then(
      () => cutoff.abort(new Error('postcondition satisfied')),
      () => undefined
    );
    try {
      if (host.diagnostics(guest).pendingDialog) return;
      // reload() returns before navigation completes. Observing its old
      // contexts first races the whole frame tree being replaced.
      await waitForLoadSettle(host, guest, host.loadTimeoutMs, settleSignal);
      signal?.throwIfAborted();
      if (host.diagnostics(guest).pendingDialog) return;
      let unconfirmed = false;
      const checkpoint = await stepSettleResult(host, guest, signal, options.background, () => {
        unconfirmed = true;
      });
      if (checkpoint.outcome === 'blocked') return;
      if (checkpoint.outcome !== 'completed') throw new Error(checkpoint.text);
      // An unconfirmed frame may still be rendering: run the bounded quiet
      // observation instead of returning on an idle network alone.
      if (
        !options.requireQuiet &&
        !unconfirmed &&
        !routeChanged &&
        !guest.isLoading() &&
        host.diagnostics(guest).network.recentInflight().length === 0
      )
        return;
      await observeQuiet(guest, signal, settleSignal, earlyExit);
    } finally {
      cutoff.abort();
      signal?.removeEventListener('abort', stopOnAbort);
    }
  }

  return {
    waitForLoadSettle: timedBrowserOperation('wait', (guest: WebContents, timeoutMs: number, signal?: AbortSignal) =>
      waitForLoadSettle(host, guest, timeoutMs, signal)
    ),
    settleAfterAction,
    // A sequence step whose frame never confirmed the checkpoint gets the same
    // bounded load/DOM/network quiet observation as a final settle; the input
    // is neither replayed nor failed.
    stepSettleResult: timedBrowserOperation(
      'wait',
      async (guest: WebContents, signal?: AbortSignal, background?: boolean) => {
        let unconfirmed = false;
        const step = await stepSettleResult(host, guest, signal, background, () => {
          unconfirmed = true;
        });
        if (unconfirmed && step.outcome === 'completed') await observeQuiet(guest, signal);
        return step;
      }
    ),
    postconditionMatchesGuest: (guest: WebContents, expected: BrowserPostcondition, signal?: AbortSignal) =>
      postconditionMatchesGuest(host, guest, expected, signal),
  };
}
