/**
 * src/tui/session/tool-card-results.mjs — the tool-card result state machine
 * (patchToolCardResult + flushToolResults) for the session runtime
 * (session-local.mjs), as a dependency-injection factory.
 *
 * These handlers own the per-turn accounting that reflects tool results into
 * store items: aggregate cards, non-aggregate/legacy agent-job cards, grouped
 * fallbacks, and the finalize/cancelled sweeps. They mutate live session state,
 * so state/set/patchItem/markToolCallDone/updateAgentJobCard are threaded via
 * the factory argument (getters/callbacks) — never stale snapshots.
 *
 *   tool-card-results/item-patch.mjs       — store access, measured-rows carry-over
 *   tool-card-results/aggregate-result.mjs — aggregate card results + finalize
 *   tool-card-results/grouped-result.mjs   — non-aggregate card results + finalize
 */
import { toolResultText } from './tool-result-text.mjs';
import { toolResultCallId } from './tool-call-fields.mjs';
import { toolResultDisplay } from './tool-result-status.mjs';
import { createItemPatcher } from './tool-card-results/item-patch.mjs';
import { applyAggregateResult, finalizeAggregateCard, isAggregateCard } from './tool-card-results/aggregate-result.mjs';
import { applyGroupedResult, finalizeGroupedCard } from './tool-card-results/grouped-result.mjs';

const surfaceCard = (card) => (card.aggregate?.ensureVisible || card.ensureVisible)?.();

export function createToolCardResults({
  getState,
  set,
  patchItem,
  markToolCallDone,
  buildAgentJobCardPatch,
  agentStatusState,
  itemIndexById,
}) {
  const ctx = {
    ...createItemPatcher({ getState, patchItem, itemIndexById }),
    set,
    agentStatusState,
    buildAgentJobCardPatch,
  };

  function patchToolCardResult(card, message, toolGroups, done) {
    if (!card || card.done) return false;
    const callId = toolResultCallId(message) || card.callId;
    if (callId && done.has(callId)) return false;
    // Any resolving call clears its active-summary entry (keyed by the same
    // callKey used at markToolCallActive; card.callId holds it for both branches).
    markToolCallDone(card.callId);
    // A result for this card arrived (possibly before its deferred push delay
    // elapsed) — surface the card now so the patch below has a live item and the
    // fast tool paints a completed card directly, no pending placeholder stage.
    // ensureVisible flushes this card AND every earlier-created still-deferred
    // card in order, so transcript order always matches call order.
    surfaceCard(card);
    const rawText = toolResultText(message?.content);
    // Only a provider-marked invocation failure contributes to failure count,
    // red state, or Failed aggregate copy. Tool-reported HTTP/domain/status
    // outcomes remain successful calls with their raw/semantic result detail.
    const outcome = toolResultDisplay(message, rawText, card?.name);
    if (isAggregateCard(card)) return applyAggregateResult(ctx, card, callId, outcome, message, rawText, done);
    return applyGroupedResult(ctx, card, callId, outcome, message, rawText, toolGroups, done);
  }

  /** Results with an id go to their card; the rest fall back to the oldest open cards. */
  function routeResults(messages, toolCards, cardByCallId, toolGroups, done) {
    const results = [];
    for (const m of messages || []) {
      if (m?.role !== 'tool') continue;
      const callId = toolResultCallId(m);
      results.push({ message: m, callId, used: false });
      if (!callId || done.has(callId)) continue;
      const card = cardByCallId.get(callId);
      if (patchToolCardResult(card, m, toolGroups, done)) results[results.length - 1].used = true;
    }
    const openCards = (toolCards || []).filter((card) => !card.done);
    if (openCards.length === 0) return;
    const fallbackResults = results.filter((result) => !result.used).slice(-openCards.length);
    for (let i = 0; i < fallbackResults.length; i++) {
      const card = openCards[i];
      const result = fallbackResults[i];
      if (!card || !result || card.done) continue;
      if (patchToolCardResult(card, result.message, toolGroups, done)) {
        if (result.callId) done.add(result.callId);
        result.used = true;
      }
    }
  }

  function finalizeOpenCards(toolCards, toolGroups, done, { cancelled }) {
    for (const card of toolCards || []) {
      if (card.done) continue;
      // Finalize must surface any still-deferred card before patching its result
      // so the completed/cancelled card is never silently dropped.
      surfaceCard(card);
      if (isAggregateCard(card)) finalizeAggregateCard(ctx, card, toolCards, done, { cancelled });
      else finalizeGroupedCard(ctx, card, toolGroups, done, { cancelled });
    }
  }

  const flushToolResults = (
    messages,
    toolCards,
    cardByCallId,
    toolGroups,
    done,
    { finalize = false, cancelled = false } = {}
  ) => {
    routeResults(messages, toolCards, cardByCallId, toolGroups, done);
    if (finalize) finalizeOpenCards(toolCards, toolGroups, done, { cancelled });
  };

  return { patchToolCardResult, flushToolResults };
}
