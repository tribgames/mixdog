/**
 * When a page is done moving. A gesture is followed by three independent
 * quiet signals — load, DOM mutations, and in-flight requests — and a
 * postcondition is sampled the same way whether it was asked for before or
 * after the action. Nothing here decides what to do next; it only reports
 * that the page stopped changing.
 */
import type { WebContents } from 'electron';

import type { BrowserCommandResult } from './command';
import type { BrowserNetworkLedger } from './network';
import { browserPostconditionMatches, type BrowserPostcondition } from './postcondition';
import { timedBrowserOperation } from './timing';
import { createBrowserDomQuiet } from './dom-quiet';

export interface BrowserSettleDiagnostics {
  network: BrowserNetworkLedger;
  pendingDialog: { type: string; message: string } | null;
}

export interface BrowserSettleHost {
  diagnostics(guest: WebContents): BrowserSettleDiagnostics;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  renderCheckpoint(guest: WebContents, background: boolean, signal?: AbortSignal): Promise<void>;
  pageText(guest: WebContents, signal?: AbortSignal): Promise<string>;
  /** How long the page must stay quiet before a gesture counts as settled. */
  quietMs: number;
  domTimeoutMs: number;
  loadTimeoutMs: number;
}

/** Sleep that a cancelled command wakes from immediately. */
export async function pause(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
  await new Promise<void>((resolve, reject) => {
    let onAbort: (() => void) | null = null;
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (!signal) return;
    onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason || new Error('browser command cancelled'));
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
    if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
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

/** Let input handlers and their rendering work run without waiting for
 * unrelated DOM mutations. The next gesture still owns its target's
 * actionability checks; the final reply waits for pending load/network work.
 * Hidden pages may throttle animation frames, so the checkpoint is bounded. */
async function stepSettleResult(
  host: BrowserSettleHost,
  guest: WebContents,
  signal?: AbortSignal,
  background = false
): Promise<BrowserCommandResult> {
  if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
  if (!host.diagnostics(guest).pendingDialog) {
    try {
      await host.renderCheckpoint(guest, background, signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
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
  if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
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

  /** Post-gesture settle starts load, DOM, and network observation together.
   *  Long-polling pages cannot hold the command forever.
   *
   *  `until` is an early exit, not a cancellation: once the caller's own
   *  postcondition holds, the page has reached the state that was asked for,
   *  so the generic quiet windows stop waiting for pages that never go quiet
   *  (analytics, polling widgets). Measured: expect-bearing clicks sat at
   *  1.3-1.5s while the condition itself matched almost immediately. */
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
    // Real cancellation stops the page; a cutoff only stops WAITING for it, so
    // the two signals must never share the stop-page listener above.
    // A client-side route change swaps the view without loading a document:
    // nothing is loading, the network can already be quiet, and a url
    // postcondition is satisfied by history.pushState before the new screen
    // renders. Returning then reports the screen the caller just left, so this
    // one case waits for the page to go quiet and refuses the early exit.
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
      // Uniform for individual gestures and batches: flush queued rendering,
      // then wait only when actual load/network work remains. A future timer
      // has no knowable completion time; explicit expect/settleMs own that
      // dependency and are still awaited independently by reply.
      const checkpoint = await stepSettleResult(host, guest, signal, options.background);
      if (checkpoint.outcome === 'blocked') return;
      if (checkpoint.outcome !== 'completed') throw new Error(checkpoint.text);
      if (
        !options.requireQuiet &&
        !routeChanged &&
        !guest.isLoading() &&
        host.diagnostics(guest).network.recentInflight().length === 0
      )
        return;
      const observed = Promise.allSettled([
        waitForLoadSettle(host, guest, host.loadTimeoutMs, settleSignal),
        waitForDomQuiet(guest, signal, earlyExit),
        waitForNetworkQuiet(host, guest, settleSignal),
      ]);
      // Racing the group, not just aborting it: allSettled still waits for any
      // observer that does not watch the cutoff signal, which made the early
      // exit worth only ~200ms instead of the full quiet window.
      await (earlyExit ? Promise.race([observed, earlyExit]) : observed);
      if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
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
    stepSettleResult: timedBrowserOperation('wait', (guest: WebContents, signal?: AbortSignal, background?: boolean) =>
      stepSettleResult(host, guest, signal, background)
    ),
    postconditionMatchesGuest: (guest: WebContents, expected: BrowserPostcondition, signal?: AbortSignal) =>
      postconditionMatchesGuest(host, guest, expected, signal),
  };
}
