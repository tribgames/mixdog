/**
 * src/tui/engine/tool-card-results.mjs — the tool-card result state machine
 * (patchToolCardResult + flushToolResults) extracted from createEngineSession
 * (engine.mjs) as a dependency-injection factory.
 *
 * These handlers own the per-turn accounting that reflects tool results into
 * store items: aggregate cards, non-aggregate/legacy agent-job cards, grouped
 * fallbacks, and the finalize/cancelled sweeps. They mutate live session state,
 * so state/set/patchItem/markToolCallDone/updateAgentJobCard are threaded via
 * the factory argument (getters/callbacks) — never stale snapshots. Every body
 * is the original engine.mjs logic verbatim.
 */
import { summarizeToolResult, aggregateDoneCategories, classifyToolCategory } from '../../runtime/shared/tool-surface.mjs';
import { toolResultText, toolErrorDisplay, toolGroupedDisplayFallback } from './tool-result-text.mjs';
import { toolResultCallId } from './tool-call-fields.mjs';
import { memoryCoreResultErrorText } from '../app/input-parsers.mjs';
import { parseAgentJob, toolResultStatus, isErrorToolStatus } from './agent-envelope.mjs';
import {
  withCancelledResultMarker,
  groupedToolResultText,
  aggregateRawResult,
  aggregateSummaries,
  assignAggregateSummaryOrder,
} from './tool-result-status.mjs';
import { formatAggregateDetail } from '../../runtime/shared/tool-surface.mjs';
import { carryTranscriptMeasuredRowsCache } from '../app/transcript-window.mjs';

export function createToolCardResults({
  getState,
  set,
  patchItem,
  markToolCallDone,
  updateAgentJobCard,
  buildAgentJobCardPatch,
  agentStatusState,
}) {
  function patchToolItem(id, patch) {
    const prev = getState().items.find((it) => it.id === id);
    const ok = patchItem(id, patch);
    if (!ok || !prev) return ok;
    const next = getState().items.find((it) => it.id === id);
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
    // Backend "core" memory-op failures are flattened to plain text (isError
    // dropped upstream — see memoryCoreResultErrorText); recover that signal so
    // failed memory writes are excluded from the done count. Gated to Memory
    // calls: the text-matcher's ^(error|failed) catch-all would otherwise
    // misflag legitimate non-memory success output.
    const isMemoryCall = classifyToolCategory(callRec?.name || card?.name || '', callRec?.args || {}) === 'Memory';
    // Split the failure signal into two:
    //   isCallError  — a REAL tool-call failure (backend isError / error
    //                  toolKind). ONLY this paints the ● dot red.
    //   isResultError — a command/result failure (shell exit code, [error…]
    //                  text, failed status text, flattened core memory-op
    //                  failure). These still mark the card Failed in the L2
    //                  detail but must NOT turn the dot red.
    const isCallError = message?.isError === true || message?.toolKind === 'error';
    const isResultError = /^\s*\[?error/i.test(rawText) || isErrorToolStatus(toolResultStatus(rawText)) || (isMemoryCall && memoryCoreResultErrorText(rawText) != null);
    const isError = isCallError || isResultError;
    const text = isError ? toolErrorDisplay(rawText, card?.name || 'tool') : rawText;

    if (aggregate && card.itemId === aggregate.itemId) {
      if (!callRec) return false;
      if (callRec.resolved) {
        card.done = true;
        if (callId) done.add(callId);
        return false;
      }
      callRec.summary = !isError ? summarizeToolResult(callRec.name, callRec.args, rawText, isError) : null;
      assignAggregateSummaryOrder(aggregate, callRec);
      callRec.isError = isError;
      callRec.isCallError = isCallError;
      callRec.resultText = text;
      callRec.resolved = true;
      const allCalls = [...aggregate.calls.values()];
      const completed = allCalls.filter((r) => r.resolved).length;
      const errors = allCalls.filter((r) => r.isError).length;
      const callErrors = allCalls.filter((r) => r.isCallError).length;
      // Collapsed detail carries the merged per-call count summary
      // ("512 lines, 6 matches, 3 files") so the finished card answers "how
      // much" without ctrl+o. Failures keep a bare 'N Ok · N Failed' status so
      // an error stays visible while collapsed.
      const succeeded = completed - errors;
      const detailText = errors > 0
        ? (succeeded > 0 ? `${succeeded} Ok · ${errors} Failed` : `${errors} Failed`)
        : formatAggregateDetail(aggregateSummaries(aggregate));
      const currentItem = getState().items.find((it) => it.id === card.itemId);
      const earlyCompleted = allCalls.filter((r) => r.resolved || r.completedEarly).length;
      const visualCompleted = Math.max(completed, earlyCompleted, Math.min(allCalls.length, Number(currentItem?.completedCount || 0)));
      const rawResult = aggregateRawResult(allCalls);
      // The numbered+labelled raw (rawResult) is preserved for ctrl+o expansion.
      const displayDetail = detailText;
      patchToolItem(card.itemId, {
        result: displayDetail,
        text: displayDetail,
        rawResult: rawResult || null,
        isError: errors > 0,
        errorCount: errors,
        callErrorCount: callErrors,
        count: allCalls.length,
        completedCount: visualCompleted,
        doneCategories: aggregateDoneCategories(allCalls),
        completedAt: Number(currentItem?.completedAt) || Date.now(),
      });
      card.done = true;
      if (callId) done.add(callId);
      return true;
    }

    // Non-aggregate (legacy agent-job cards, etc.)
    const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, callErrors: 0, results: [] };
    group.completed = Math.min(group.count, group.completed + 1);
    group.errors += isError ? 1 : 0;
    group.callErrors = (group.callErrors || 0) + (isCallError ? 1 : 0);
    group.results.push({ text, isError });
    toolGroups.set(card.itemId, group);
    const resultText = groupedToolResultText(group);
    const displayResult = toolGroupedDisplayFallback(resultText, text, rawText);
    const patch = {
      result: displayResult,
      text: displayResult,
      isError: group.errors > 0,
      errorCount: group.errors,
      callErrorCount: group.callErrors || 0,
      count: group.count,
      completedCount: group.completed,
      completedAt: Date.now(),
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
          if (!rec.completedEarly) {
            rec.isError = false;
            rec.resultText = rec.resultText || '';
          }
        }
        const completed = allCalls.filter((r) => r.resolved).length;
        const totalCompleted = completed;
        const errors = allCalls.filter((r) => r.isError).length;
        const callErrors = allCalls.filter((r) => r.isCallError).length;
        const succeeded = completed - errors;
        const rawResult = aggregateRawResult(allCalls);
        // Collapsed detail carries the merged per-call count summary; failures
        // keep a bare 'N Ok · N Failed' status. Raw is kept for ctrl+o.
        let displayDetail = errors > 0
          ? (succeeded > 0 ? `${succeeded} Ok · ${errors} Failed` : `${errors} Failed`)
          : formatAggregateDetail(aggregateSummaries(aggregate));
        if (cancelled) {
          // Cancelled aggregates MUST keep the [status: cancelled] marker on the
          // result so terminalStatus parsing resolves to 'cancelled'. Only normal
          // completions drop the summary; cancelled ones prepend the marker.
          const currentItem = getState().items.find((it) => it.id === card.itemId);
          displayDetail = withCancelledResultMarker(displayDetail, currentItem);
        }
        patchToolItem(card.itemId, {
          result: displayDetail,
          text: displayDetail,
          rawResult: rawResult || null,
          isError: errors > 0,
          errorCount: errors,
          callErrorCount: callErrors,
          count: allCalls.length,
          completedCount: totalCompleted,
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
      const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, results: [] };
      group.completed = Math.min(group.count, group.completed + 1);
      toolGroups.set(card.itemId, group);
      let resultText = groupedToolResultText(group);
      if (cancelled) {
        const currentItem = getState().items.find((it) => it.id === card.itemId);
        resultText = withCancelledResultMarker(resultText, currentItem);
      }
      patchToolItem(card.itemId, { result: resultText, text: resultText, isError: group.errors > 0, errorCount: group.errors, callErrorCount: group.callErrors || 0, count: group.count, completedCount: group.completed, completedAt: Date.now() });
      card.done = true;
      if (card.callId) done.add(card.callId);
    }
  };

  return { patchToolCardResult, flushToolResults };
}
