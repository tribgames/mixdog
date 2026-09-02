/**
 * Waiting for the page and chaining gestures: `wait` polls for text or URL
 * substrings; `sequence` runs several ref gestures against one snapshot and
 * reports exactly how far it got when one fails.
 */
import { boundedInteger, SEQUENCE_STEP_ACTIONS } from '../command';
import { pause } from '../settle';
import { defineBrowserActions } from './types';

export const flowActions = defineBrowserActions({
  async wait({ guest, command, signal, targetIsBackground, services }) {
    const { cdp, reply } = services;
    const wantText = typeof command.text === 'string' && command.text.trim() ? command.text.trim() : '';
    const wantTextGone = typeof command.textGone === 'string' && command.textGone.trim()
      ? command.textGone.trim()
      : '';
    const wantUrl = typeof command.url === 'string' && command.url.trim() ? command.url.trim() : '';
    if (!wantText && !wantTextGone && !wantUrl) {
      throw new Error('wait requires text, textGone, and/or url (substrings to wait for)');
    }
    const timeoutMs = boundedInteger(command.timeoutMs, 10_000, 500, 30_000);
    const startedAt = Date.now();
    for (;;) {
      if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
      const urlOk = !wantUrl || guest.getURL().toLowerCase().includes(wantUrl.toLowerCase());
      let textOk = !wantText;
      let textGoneOk = !wantTextGone;
      if (urlOk && (wantText || wantTextGone)) {
        const pageText = await cdp.evaluate<string>(
          guest,
          `(document.body ? (document.body.innerText || document.body.textContent || '') : '').toLowerCase()`,
          signal,
        ).catch((error) => {
          if (signal?.aborted) throw signal.reason || error;
          return '';
        });
        textOk = !wantText || pageText.includes(wantText.toLowerCase());
        textGoneOk = !wantTextGone || !pageText.includes(wantTextGone.toLowerCase());
      }
      if (urlOk && textOk && textGoneOk) {
        const outcome = await reply.snapshotResult(guest, command, signal, { targetIsBackground });
        return {
          ...outcome,
          text: `Condition met after ${Date.now() - startedAt}ms.\n\n${outcome.text}`,
        };
      }
      if (Date.now() - startedAt >= timeoutMs) {
        const waited = [
          wantText && `text ${JSON.stringify(wantText)}`,
          wantTextGone && `textGone ${JSON.stringify(wantTextGone)}`,
          wantUrl && `url ${JSON.stringify(wantUrl)}`,
        ].filter(Boolean).join(' and ');
        const outcome = await reply.snapshotResult(guest, command, signal, { targetIsBackground })
          .catch((error) => {
            if (signal?.aborted) throw signal.reason || error;
            return { text: '' };
          });
        throw new Error(
          `Wait timed out after ${timeoutMs}ms without matching ${waited}.\n\n${outcome.text}`,
        );
      }
      await pause(300, signal);
    }
  },

  async sequence({ guest, command, signal, targetIsBackground, actionSnapshot, services }) {
    const { state, reply, runCommand } = services;
    const steps = Array.isArray(command.steps) ? command.steps : [];
    if (steps.length < 2 || steps.length > 6) {
      throw new Error('sequence requires 2 to 6 steps');
    }
    // Every step addresses the caller's ONE snapshot. A gesture can swap
    // the live ref set out from under the next step, which would reject
    // refs the caller legitimately holds, so the sequence pins it.
    const pinnedRefs = state.peek(guest)?.refSet;
    const performed: string[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index] || {};
      const stepAction = String(step.action || '').trim().toLowerCase();
      if (pinnedRefs) state.for(guest).refSet = pinnedRefs;
      if (!SEQUENCE_STEP_ACTIONS.has(stepAction)) {
        throw new Error(
          `sequence step ${index + 1} action "${stepAction || '(empty)'}" is not chainable`,
        );
      }
      try {
        await runCommand({
          ...step,
          action: stepAction,
          tab: command.tab,
          background: command.background,
          internalStep: true,
          session_id: command.session_id,
          turn_id: command.turn_id,
        }, signal);
      } catch (error) {
        // A partial sequence is a real page state, so report exactly how
        // far it got and hand back a fresh snapshot of where it stopped.
        const failure = (error as Error).message;
        const stopped = await reply.snapshotResult(guest, command, signal, { targetIsBackground })
          .catch((snapshotError) => {
            if (signal?.aborted) throw signal.reason || snapshotError;
            return { text: '' };
          });
        throw new Error(
          `Sequence stopped at step ${index + 1} (${stepAction}); `
          + `${performed.length ? `completed ${performed.join(', ')}` : 'no step completed'}. `
          + `${failure}\n\n${stopped.text}`,
        );
      }
      performed.push(`${index + 1}:${stepAction}`);
    }
    const outcome = await actionSnapshot();
    return {
      ...outcome,
      text: `Sequence completed ${performed.length} steps (${performed.join(', ')}).\n\n${outcome.text}`,
    };
  },
});
