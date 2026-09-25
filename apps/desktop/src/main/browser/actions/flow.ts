/**
 * Condition-based waiting. Sequence dispatch lives separately so waiting
 * never needs to know how the next gesture will address the page.
 */
import { boundedInteger } from '../command';
import { browserPostconditionMatches, describeBrowserPostcondition } from '../postcondition';
import { throwIfBrowserCancelled } from '../settle';
import { measureBrowserPhase } from '../timing';
import { sequenceActions } from './sequence';
import { defineBrowserActions } from './types';

export const flowActions = defineBrowserActions({
  ...sequenceActions,
  async wait({ guest, command, signal, targetIsBackground, services }) {
    signal?.throwIfAborted();
    const { documents, reply } = services;
    const wantText = typeof command.text === 'string' ? command.text.trim() : '';
    const wantTextGone = typeof command.textGone === 'string' ? command.textGone.trim() : '';
    const wantUrl = typeof command.url === 'string' ? command.url.trim() : '';
    if (!wantText && !wantTextGone && !wantUrl) {
      throw new Error('wait requires text, textGone, and/or url (substrings to wait for)');
    }
    const timeoutMs = boundedInteger(command.timeoutMs, 10_000, 500, 30_000);
    const expected = { text: wantText, textGone: wantTextGone, url: wantUrl };
    const startedAt = Date.now();
    let observationFailure = '';
    const matched = await measureBrowserPhase('wait', async () => {
      const changes = await documents.observeChanges(guest, signal);
      try {
        for (;;) {
          throwIfBrowserCancelled(signal);
          const revision = changes.latch.version;
          const url = guest.getURL();
          let text: string | null = null;
          if (browserPostconditionMatches({ url: wantUrl }, { url, text }) && (wantText || wantTextGone)) {
            try {
              text = await documents.pageText(guest, signal);
              signal?.throwIfAborted();
              // The collector may recover onto a new document. Its text
              // must not be combined with the URL from before that read.
              if (guest.getURL() !== url) {
                text = null;
                observationFailure = 'Page URL changed during condition observation';
              } else {
                observationFailure = '';
              }
            } catch (error) {
              if (signal?.aborted) throw signal.reason || error;
              observationFailure = `Page observation failed: ${error instanceof Error ? error.message : String(error)}`;
            }
          }
          if (browserPostconditionMatches(expected, { url, text })) return true;
          if (Date.now() - startedAt >= timeoutMs) return false;
          await changes.latch.wait(revision, Math.min(300, timeoutMs - (Date.now() - startedAt)), signal);
        }
      } finally {
        await changes.close();
      }
    });
    signal?.throwIfAborted();
    if (!matched) {
      const waited = describeBrowserPostcondition(expected);
      let outcome = { text: '' };
      if (!command.internalStep) {
        outcome = await reply.snapshotResult(guest, command, signal, { targetIsBackground }).catch((error) => {
          if (signal?.aborted) throw signal.reason || error;
          return { text: `Final snapshot failed: ${error instanceof Error ? error.message : String(error)}` };
        });
      }
      signal?.throwIfAborted();
      throw new Error(
        [`Wait timed out after ${timeoutMs}ms without matching ${waited}.`, observationFailure, outcome.text]
          .filter(Boolean)
          .join('\n\n')
      );
    }
    const elapsed = Date.now() - startedAt;
    const outcome = command.internalStep
      ? { text: '' }
      : await reply.snapshotResult(guest, command, signal, { targetIsBackground });
    signal?.throwIfAborted();
    return {
      ...outcome,
      text: `Condition met after ${elapsed}ms.\n\n${outcome.text}`,
    };
  },
});
