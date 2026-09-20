/**
 * Waiting for the page to settle and for a postcondition to become true. The
 * waits run together: a postcondition that turns true may cut the settle
 * short — unless it was already true before the gesture, in which case it
 * proves nothing about this one and may never shorten the wait.
 */
import type { WebContents } from 'electron';

import { type BrowserCommand, type BrowserSnapshotResultOptions, POSTCONDITION_POLL_MS } from './command';
import { type BrowserPostcondition, normalizeBrowserPostcondition, normalizeBrowserSettleMs } from './postcondition';
import type { BrowserReplyHost } from './reply';
import { pause } from './settle';
import { measureBrowserPhase } from './timing';

export type ReplyWaitHost = Pick<BrowserReplyHost, 'settleAfterAction' | 'postconditionMatchesGuest'>;

export interface ReplyWait {
  settleMs: number;
  expected: ReturnType<typeof normalizeBrowserPostcondition> | BrowserSnapshotResultOptions['expected'];
  postconditionElapsed: number;
  postconditionMatched: boolean;
}

/** Poll until the postcondition holds or its budget ends; `announce` fires
 *  the moment it holds so the settle can stop waiting for it. */
async function pollPostcondition(
  host: ReplyWaitHost,
  guest: WebContents,
  expected: BrowserPostcondition,
  announce: () => void,
  wait: ReplyWait,
  signal?: AbortSignal
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
    wait.postconditionElapsed = Date.now() - startedAt;
    if (await host.postconditionMatchesGuest(guest, expected, signal)) {
      announce();
      break;
    }
    if (wait.postconditionElapsed >= expected.timeoutMs) {
      wait.postconditionMatched = false;
      break;
    }
    // The poll interval is the floor on how fast a verified action can
    // return; each probe is one small page evaluation.
    await pause(POSTCONDITION_POLL_MS, signal);
  }
}

export async function awaitReplyReady(
  host: ReplyWaitHost,
  guest: WebContents,
  command: BrowserCommand,
  options: BrowserSnapshotResultOptions,
  signal?: AbortSignal
): Promise<ReplyWait> {
  const settleMs = normalizeBrowserSettleMs(command.settleMs);
  const expected = options.expected === undefined ? normalizeBrowserPostcondition(command.expect) : options.expected;
  const wait: ReplyWait = { settleMs, expected, postconditionElapsed: 0, postconditionMatched: true };
  let announcePostcondition: () => void = () => undefined;
  const postconditionSatisfied = new Promise<void>((resolve) => {
    announcePostcondition = resolve;
  });
  // A condition that was already true before the gesture proves nothing
  // about this one, so it may never cut the settle short.
  const settleUntil = expected && !options.preexistingPostcondition ? postconditionSatisfied : undefined;
  await measureBrowserPhase('wait', () =>
    Promise.all([
      options.settleAction
        ? host.settleAfterAction(guest, signal, settleUntil, {
            background: options.targetIsBackground,
            requireQuiet: Boolean(expected && options.preexistingPostcondition),
            // Where the page was before the gesture: a URL that changed
            // without a load means the view is still being replaced.
            previousUrl: options.baseline?.url,
          })
        : Promise.resolve(),
      settleMs ? pause(settleMs, signal) : Promise.resolve(),
      expected ? pollPostcondition(host, guest, expected, announcePostcondition, wait, signal) : Promise.resolve(),
    ])
  );
  return wait;
}
