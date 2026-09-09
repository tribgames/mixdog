/** A deterministic same-page batch. Dispatch is never replayed, and a
 * partial result always hands the caller a fresh observation for recovery. */
import { SEQUENCE_STEP_ACTIONS } from '../command';
import { measureBrowserStep } from '../timing';
import { defineBrowserActions } from './types';

export const sequenceActions = defineBrowserActions({
  async sequence({ guest, command, signal, targetIsBackground, actionSnapshot, services }) {
    const { state, reply, runCommand } = services;
    const steps = Array.isArray(command.steps) ? command.steps : [];
    if (steps.length < 2 || steps.length > 6) {
      throw new Error('sequence requires 2 to 6 steps');
    }
    const pinnedRefs = state.peek(guest)?.refSet;
    const pinnedAccessibilityRefs = state.peek(guest)?.accessibilityRefs;
    const generation = state.for(guest).documentGeneration;
    const url = guest.getURL();
    const performed: string[] = [];
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index] || {};
      const stepAction = String(step.action || '').trim().toLowerCase();
      try {
        if (signal?.aborted) throw signal.reason || new Error('browser command cancelled');
        // A SPA URL transition can keep the same document generation.
        // Loading also fences the interval before a navigation commits.
        if (state.for(guest).documentGeneration !== generation || guest.getURL() !== url || guest.isLoading()) {
          throw new Error('the page changed or is navigating; remaining steps were not dispatched');
        }
        if (!SEQUENCE_STEP_ACTIONS.has(stepAction)) {
          throw new Error(`action "${stepAction || '(empty)'}" is not chainable`);
        }
        if (pinnedRefs) state.for(guest).refSet = pinnedRefs;
        if (pinnedAccessibilityRefs) state.for(guest).accessibilityRefs = pinnedAccessibilityRefs;
        const result = await measureBrowserStep(index + 1, () => runCommand({
          ...step,
          action: stepAction,
          tab: command.tab,
          background: command.background,
          internalStep: true,
          session_id: command.session_id,
          turn_id: command.turn_id,
        }, signal));
        if (result.outcome === 'blocked' || result.outcome === 'inconclusive') {
          throw new Error(result.text);
        }
      } catch (error) {
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
