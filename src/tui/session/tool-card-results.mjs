/**
 * src/tui/session/tool-card-results.mjs — the tool-card result state machine
 * (patchToolCardResult + flushToolResults) extracted from the session runtime
 * (session-local.mjs) as a dependency-injection factory.
 *
 * These handlers own the per-turn accounting that reflects tool results into
 * store items: aggregate cards, non-aggregate/legacy agent-job cards, grouped
 * fallbacks, and the finalize/cancelled sweeps. They mutate live session state,
 * so state/set/patchItem/markToolCallDone/updateAgentJobCard are threaded via
 * the factory argument (getters/callbacks) — never stale snapshots.
 */
import { aggregateDoneCategories } from '../../runtime/shared/tool-surface.mjs';
import { toolResultText, toolGroupedDisplayFallback } from './tool-result-text.mjs';
import { toolResultCallId } from './tool-call-fields.mjs';
import { parseAgentJob } from './agent-envelope.mjs';
import {
  withCancelledResultMarker,
  groupedToolResultText,
  aggregateRawResult,
  aggregateResultPatch,
  applyAggregateCallFields,
  toolResultDisplay,
  uiDiffPatchFromMessage,
} from './tool-result-status.mjs';
import { carryTranscriptMeasuredRowsCache } from '../app/transcript-window.mjs';

export function createToolCardResults({
  getState,
  set,
  patchItem,
  markToolCallDone,
  updateAgentJobCard,
  buildAgentJobCardPatch,
  agentStatusState,
  itemIndexById,
}) {
  const itemById = (id) => {
    const index = itemIndexById?.get(id);
    const item = Number.isInteger(index) ? getState().items[index] : null;
    return item?.id === id ? item : null;
  };
  // A finalized/failed non-aggregate card must never carry an empty body:
  // an empty-body error card is classified fully-failed-with-no-body upstream
  // (transcript-tool-failures) and null-renders (card disappears). Stamp a
  // minimal non-empty fallback, preferring meaningful text, then exit status,
  // a bare Failed status.
  function finalizedErrorFallbackBody(body, text, exitCode) {
    if (String(body || '').trim()) return body;
    if (String(text || '').trim()) return text;
    if (exitCode != null) return `Exited ${exitCode}`;
    return 'Failed';
  }
  function patchToolItem(id, patch) {
    const prev = itemById(id);
    const ok = patchItem(id, patch);
    if (!ok || !prev) return ok;
    const next = itemById(id);
    if (next && next !== prev) carryTranscriptMeasuredRowsCache(prev, next);
    return ok;
  }

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
    (card.aggregate?.ensureVisible || card.ensureVisible)?.();
    const rawText = toolResultText(message?.content);
    // Aggregate card handling — collect semantic summaries per call
    const aggregate = card.aggregate;
    const callRec = aggregate && callId ? aggregate.calls.get(callId) : null;
    // Only a provider-marked invocation failure contributes to failure count,
    // red state, or Failed aggregate copy. Tool-reported HTTP/domain/status
    // outcomes remain successful calls with their raw/semantic result detail.
    const { exitCode, isExitError, isCallError, isError, text } = toolResultDisplay(
      message,
      rawText,
      card?.name,
    );

    if (aggregate && card.itemId === aggregate.itemId) {
      if (!callRec) return false;
      if (callRec.resolved) {
        card.done = true;
        if (callId) done.add(callId);
        return false;
      }
      applyAggregateCallFields(callRec, aggregate, {
        isError, isCallError, isExitError, exitCode, text, rawText, message,
      });
      callRec.resolved = true;
      const allCalls = [...aggregate.calls.values()];
      const completed = allCalls.filter((r) => r.resolved).length;
      const currentItem = itemById(card.itemId);
      const earlyCompleted = allCalls.filter((r) => r.resolved || r.completedEarly).length;
      const visualCompleted = Math.max(completed, earlyCompleted, Math.min(allCalls.length, Number(currentItem?.completedCount || 0)));
      patchToolItem(card.itemId, {
        ...aggregateResultPatch(aggregate, allCalls, completed),
        rawResult: aggregateRawResult(allCalls) || null,
        ...uiDiffPatchFromMessage(message),
        completedCount: visualCompleted,
        doneCategories: aggregateDoneCategories(allCalls),
        completedAt: Number(currentItem?.completedAt) || Date.now(),
      });
      card.done = true;
      if (callId) done.add(callId);
      return true;
    }

    // Non-aggregate (legacy agent-job cards, etc.)
    const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, callErrors: 0, exitErrors: 0, results: [] };
    group.completed = Math.min(group.count, group.completed + 1);
    group.errors += isError ? 1 : 0;
    group.callErrors = (group.callErrors || 0) + (isCallError ? 1 : 0);
    group.exitErrors = (group.exitErrors || 0) + (isExitError ? 1 : 0);
    group.results.push({ text, isError, isExitError, exitCode });
    toolGroups.set(card.itemId, group);
    const resultText = groupedToolResultText(group);
    let displayResult = toolGroupedDisplayFallback(resultText, text, rawText);
    if (group.errors > 0 && !String(displayResult || '').trim()) {
      displayResult = finalizedErrorFallbackBody(displayResult, text, exitCode);
    }
    const patch = {
      result: displayResult,
      text: displayResult,
      ...uiDiffPatchFromMessage(message),
      isError: group.errors > 0,
      errorCount: group.errors,
      callErrorCount: group.callErrors || 0,
      exitErrorCount: group.exitErrors || 0,
      count: group.count,
      completedCount: group.completed,
      completedAt: Date.now(),
      liveOutput: null,
    };
    if (group.count <= 1) {
      const body = String(text || rawText || '').trim();
      if (body) patch.rawResult = text || rawText;
      const parsedAgent = parseAgentJob(rawText);
      if (parsedAgent) {
        set(agentStatusState({ force: true }));
      }
      // Coalesce the agent-job card refresh (result/text/isError/errorCount/
      // args) into THIS patch instead of a second updateAgentJobCard() call.
      // The two calls previously wrote the same card back-to-back with
      // different result/text strings, producing the visible L1/L2 flash.
      // The agent fields win (final display) while patch keeps the completion
      // metadata (count/completedCount/completedAt/rawResult) for expand.
      Object.assign(patch, buildAgentJobCardPatch(card.itemId, rawText, isError));
      // Re-apply the empty-body guard: buildAgentJobCardPatch may overwrite the
      // stamped fallback with an empty agent-job body, letting the card vanish.
      if (group.errors > 0 && !String(patch.result || '').trim()) {
        patch.result = patch.text = finalizedErrorFallbackBody(patch.result, text, exitCode);
      }
    }
    patchToolItem(card.itemId, patch);
    card.done = true;
    if (callId) done.add(callId);
    return true;
  }

  const flushToolResults = (messages, toolCards, cardByCallId, toolGroups, done, { finalize = false, cancelled = false } = {}) => {
    const results = [];
    for (const m of messages || []) {
      if (!m || m.role !== 'tool') continue;
      const callId = toolResultCallId(m);
      results.push({ message: m, callId, used: false });
      if (!callId || done.has(callId)) continue;
      const card = cardByCallId.get(callId);
      if (patchToolCardResult(card, m, toolGroups, done)) {
        results[results.length - 1].used = true;
      }
    }

    const openCards = (toolCards || []).filter((card) => !card.done);
    if (openCards.length === 0) return;

    const unusedResults = results.filter((result) => !result.used);
    const fallbackResults = unusedResults.slice(-openCards.length);
    for (let i = 0; i < fallbackResults.length; i++) {
      const card = openCards[i];
      const result = fallbackResults[i];
      if (!card || !result || card.done) continue;
      if (patchToolCardResult(card, result.message, toolGroups, done)) {
        if (result.callId) done.add(result.callId);
        result.used = true;
      }
    }

    if (!finalize) return;
    for (const card of toolCards || []) {
      if (card.done) continue;
      // Finalize must surface any still-deferred card before patching its result
      // so the completed/cancelled card is never silently dropped.
      (card.aggregate?.ensureVisible || card.ensureVisible)?.();
      // Aggregate finalize — mark any remaining calls as done
      const aggregate = card.aggregate;
      if (aggregate && card.itemId === aggregate.itemId) {
        const allCalls = [...aggregate.calls.values()];
        // Never let a call that truly never resolved be presented as a real
        // completion. Stamp it resolved so completedCount reflects an honest
        // (if degenerate) accounting instead of manufacturing success out of
        // a call that never came back. A record already marked completedEarly
        // (via __earlyNotify) already carries a real isError/resultText/summary
        // from its actual result — preserve those; only blank-fill for calls
        // truly never heard from (no completedEarly, no resolved).
        for (const rec of allCalls) {
          if (rec.resolved) continue;
          rec.resolved = true;
          rec.completedAt = rec.completedAt || Date.now();
          if (!rec.completedEarly) {
            rec.isError = false;
            rec.resultText = rec.resultText || '';
            rec.rawResultText = rec.rawResultText ?? rec.resultText;
          }
        }
        const completed = allCalls.filter((r) => r.resolved).length;
        const outcomePatch = aggregateResultPatch(aggregate, allCalls, completed);
        let displayDetail = outcomePatch.result;
        if (cancelled) {
          // Cancelled aggregates MUST keep the [status: cancelled] marker on the
          // result so terminalStatus parsing resolves to 'cancelled'. Only normal
          // completions drop the summary; cancelled ones prepend the marker.
          displayDetail = withCancelledResultMarker(displayDetail, itemById(card.itemId));
        }
        patchToolItem(card.itemId, {
          ...outcomePatch,
          result: displayDetail,
          text: displayDetail,
          rawResult: aggregateRawResult(allCalls) || null,
          completedCount: completed,
          doneCategories: aggregateDoneCategories(allCalls),
          completedAt: Date.now(),
        });
        for (const sibling of toolCards || []) {
          if (sibling.itemId !== card.itemId) continue;
          sibling.done = true;
          if (sibling.callId) done.add(sibling.callId);
        }
        continue;
      }
      // Non-aggregate finalize
      const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, exitErrors: 0, results: [] };
      group.completed = Math.min(group.count, group.completed + 1);
      toolGroups.set(card.itemId, group);
      let resultText = groupedToolResultText(group);
      if (group.errors > 0 && !String(resultText || '').trim()) {
        const exitRec = (group.results || []).find((r) => r && r.isExitError);
        resultText = finalizedErrorFallbackBody(resultText, exitRec?.text, exitRec?.exitCode);
      }
      if (cancelled) {
        const currentItem = itemById(card.itemId);
        resultText = withCancelledResultMarker(resultText, currentItem);
      }
      // liveOutput: null — the settled result supersedes any streamed tail.
      patchToolItem(card.itemId, { result: resultText, text: resultText, isError: group.errors > 0, errorCount: group.errors, callErrorCount: group.callErrors || 0, exitErrorCount: group.exitErrors || 0, count: group.count, completedCount: group.completed, completedAt: Date.now(), liveOutput: null });
      card.done = true;
      if (card.callId) done.add(card.callId);
    }
  };

  return { patchToolCardResult, flushToolResults };
}
