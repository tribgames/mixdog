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
import type { BrowserPostcondition } from './postcondition';
import { timedBrowserOperation } from './timing';
import { createBrowserDomQuiet } from './dom-quiet';
import { browserRenderCheckpoint } from './render-checkpoint';

export interface BrowserSettleDiagnostics {
  network: BrowserNetworkLedger;
  pendingDialog: { type: string; message: string } | null;
}

export interface BrowserSettleHost {
  diagnostics(guest: WebContents): BrowserSettleDiagnostics;
  evaluate<T>(guest: WebContents, expression: string, signal?: AbortSignal): Promise<T>;
  renderCheckpoint?(guest: WebContents, background: boolean, signal?: AbortSignal): Promise<void>;
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

export function createBrowserSettle(host: BrowserSettleHost) {
  const {
    diagnostics: diagnosticsFor,
    evaluate,
    quietMs: ACTION_SETTLE_QUIET_MS,
    domTimeoutMs: ACTION_SETTLE_DOM_TIMEOUT_MS,
    loadTimeoutMs: ACTION_SETTLE_LOAD_TIMEOUT_MS,
  } = host;

  async function waitForLoadSettle(
    guest: WebContents,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (signal?.aborted || !guest.isLoading() || diagnosticsFor(guest).pendingDialog) return;
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

  const waitForDomQuiet = createBrowserDomQuiet({
    evaluate,
    quietMs: ACTION_SETTLE_QUIET_MS,
    timeoutMs: ACTION_SETTLE_DOM_TIMEOUT_MS,
  });

  async function waitForNetworkQuiet(guest: WebContents, signal?: AbortSignal): Promise<void> {
    const diagnostics = diagnosticsFor(guest);
    const startedAt = Date.now();
    let quietSince = diagnostics.network.pendingCount === 0 ? Date.now() : 0;
    while (Date.now() - startedAt < ACTION_SETTLE_DOM_TIMEOUT_MS) {
      if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
      if (diagnostics.pendingDialog) return;
      const recentInflight = diagnostics.network.recentInflight();
      if (recentInflight.length === 0) {
        if (!quietSince) quietSince = Date.now();
        if (Date.now() - quietSince >= ACTION_SETTLE_QUIET_MS) return;
      } else {
        quietSince = 0;
      }
      await pause(75, signal);
    }
  }

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
    options: { background?: boolean; requireQuiet?: boolean } = {},
  ): Promise<void> {
    const stopOnAbort = () => {
      if (!guest.isDestroyed() && guest.isLoading()) {
        try { guest.stop(); } catch { /* teardown can race cancellation */ }
      }
    };
    signal?.addEventListener('abort', stopOnAbort, { once: true });
    // Real cancellation stops the page; a cutoff only stops WAITING for it, so
    // the two signals must never share the stop-page listener above.
    const cutoff = new AbortController();
    const settleSignal = signal ? AbortSignal.any([signal, cutoff.signal]) : cutoff.signal;
    void until?.then(
      () => cutoff.abort(new Error('postcondition satisfied')),
      () => undefined,
    );
    try {
      if (diagnosticsFor(guest).pendingDialog) return;
      // Uniform for individual gestures and batches: flush queued rendering,
      // then wait only when actual load/network work remains. A future timer
      // has no knowable completion time; explicit expect/settleMs own that
      // dependency and are still awaited independently by reply.
      const checkpoint = await stepSettleResult(guest, signal, options.background);
      if (checkpoint.outcome === 'blocked') return;
      if (checkpoint.outcome !== 'completed') throw new Error(checkpoint.text);
      if (!options.requireQuiet && !guest.isLoading()
        && diagnosticsFor(guest).network.recentInflight().length === 0) return;
      const observed = Promise.allSettled([
        waitForLoadSettle(guest, ACTION_SETTLE_LOAD_TIMEOUT_MS, settleSignal),
        waitForDomQuiet(guest, signal, until),
        waitForNetworkQuiet(guest, settleSignal),
      ]);
      // Racing the group, not just aborting it: allSettled still waits for any
      // observer that does not watch the cutoff signal, which made the early
      // exit worth only ~200ms instead of the full quiet window.
      await (until ? Promise.race([observed, until]) : observed);
      if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
    } finally {
      cutoff.abort();
      signal?.removeEventListener('abort', stopOnAbort);
    }
  }

  /** Let input handlers and their rendering work run without waiting for
   * unrelated DOM mutations. The next gesture still owns its target's
   * actionability checks; the final reply waits for pending load/network work.
   * Hidden pages may throttle animation frames, so the checkpoint is bounded. */
  async function stepSettleResult(
    guest: WebContents,
    signal?: AbortSignal,
    background = false,
  ): Promise<BrowserCommandResult> {
    if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
    if (!diagnosticsFor(guest).pendingDialog) {
      try {
        if (host.renderCheckpoint) await host.renderCheckpoint(guest, background, signal);
        else await evaluate<void>(guest, browserRenderCheckpoint(background), signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason || error;
        return {
          outcome: 'inconclusive',
          text: 'The browser input executed, but its rendering checkpoint failed; input was not replayed.'
            + ` ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
    const dialog = diagnosticsFor(guest).pendingDialog;
    return dialog
      ? { outcome: 'blocked', text: `A ${dialog.type} dialog is blocking the sequence.` }
      : { outcome: 'completed', text: '' };
  }

  async function postconditionMatchesGuest(
    guest: WebContents,
    expected: BrowserPostcondition,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const url = guest.getURL().toLowerCase();
    if (expected.url && !url.includes(expected.url.toLowerCase())) return false;
    if (!expected.text && !expected.textGone) return true;
    try {
      const text = (await host.pageText(guest, signal)).toLowerCase();
      return (!expected.text || text.includes(expected.text.toLowerCase()))
        && (!expected.textGone || !text.includes(expected.textGone.toLowerCase()));
    } catch (error) {
      if (signal?.aborted) throw signal.reason || error;
      return false;
    }
  }

  return {
    pause,
    waitForLoadSettle: timedBrowserOperation('wait', waitForLoadSettle),
    waitForDomQuiet,
    waitForNetworkQuiet,
    settleAfterAction,
    stepSettleResult: timedBrowserOperation('wait', stepSettleResult),
    postconditionMatchesGuest,
  };
}
