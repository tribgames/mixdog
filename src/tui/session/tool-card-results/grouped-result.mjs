/**
 * grouped-result.mjs — reflect tool results into a NON-aggregate card
 * (legacy agent-job cards, grouped fallbacks): per-card result groups, the
 * settled patch, and the finalize sweep for a card still open at turn end.
 */
import { toolGroupedDisplayFallback } from '../tool-result-text.mjs';
import { parseAgentJob } from '../agent-envelope.mjs';
import { groupedToolResultText, uiDiffPatchFromMessage, withCancelledResultMarker } from '../tool-result-status.mjs';
import { closeCard } from './item-patch.mjs';

/**
 * A finalized/failed non-aggregate card must never carry an empty body: an
 * empty-body error card is classified fully-failed-with-no-body upstream
 * (transcript-tool-failures) and null-renders (card disappears). Stamp a
 * minimal non-empty fallback, preferring meaningful text, then exit status,
 * then a bare Failed status.
 */
export function finalizedErrorFallbackBody(body, text, exitCode) {
  if (String(body || '').trim()) return body;
  if (String(text || '').trim()) return text;
  if (exitCode != null) return `Exited ${exitCode}`;
  return 'Failed';
}

const newGroup = () => ({ count: 1, completed: 0, errors: 0, callErrors: 0, exitErrors: 0, results: [] });

function settledPatch(group, resultText) {
  return {
    result: resultText,
    text: resultText,
    isError: group.errors > 0,
    errorCount: group.errors,
    callErrorCount: group.callErrors || 0,
    exitErrorCount: group.exitErrors || 0,
    count: group.count,
    completedCount: group.completed,
    completedAt: Date.now(),
    liveOutput: null,
  };
}

/** Fold the agent-job card refresh into this patch instead of a second write. */
function applyAgentJobFields(ctx, patch, { itemId, group, text, rawText, isError, exitCode }) {
  const body = String(text || rawText || '').trim();
  if (body) patch.rawResult = text || rawText;
  if (parseAgentJob(rawText)) ctx.set(ctx.agentStatusState({ force: true }));
  // The two calls previously wrote the same card back-to-back with different
  // result/text strings, producing the visible L1/L2 flash. The agent fields
  // win (final display) while patch keeps the completion metadata
  // (count/completedCount/completedAt/rawResult) for expand.
  Object.assign(patch, ctx.buildAgentJobCardPatch(itemId, rawText, isError));
  // Re-apply the empty-body guard: buildAgentJobCardPatch may overwrite the
  // stamped fallback with an empty agent-job body, letting the card vanish.
  if (group.errors > 0 && !String(patch.result || '').trim()) {
    patch.result = patch.text = finalizedErrorFallbackBody(patch.result, text, exitCode);
  }
}

export function applyGroupedResult(ctx, card, callId, outcome, message, rawText, toolGroups, done) {
  const { exitCode, isExitError, isCallError, isError, text } = outcome;
  const group = toolGroups.get(card.itemId) || newGroup();
  group.completed = Math.min(group.count, group.completed + 1);
  group.errors += isError ? 1 : 0;
  group.callErrors = (group.callErrors || 0) + (isCallError ? 1 : 0);
  group.exitErrors = (group.exitErrors || 0) + (isExitError ? 1 : 0);
  group.results.push({ text, isError, isExitError, exitCode });
  toolGroups.set(card.itemId, group);
  let displayResult = toolGroupedDisplayFallback(groupedToolResultText(group), text, rawText);
  if (group.errors > 0 && !String(displayResult || '').trim()) {
    displayResult = finalizedErrorFallbackBody(displayResult, text, exitCode);
  }
  const patch = { ...settledPatch(group, displayResult), ...uiDiffPatchFromMessage(message) };
  if (group.count <= 1) {
    applyAgentJobFields(ctx, patch, { itemId: card.itemId, group, text, rawText, isError, exitCode });
  }
  ctx.patchToolItem(card.itemId, patch);
  closeCard(card, callId, done);
  return true;
}

export function finalizeGroupedCard(ctx, card, toolGroups, done, { cancelled }) {
  const group = toolGroups.get(card.itemId) || { count: 1, completed: 0, errors: 0, exitErrors: 0, results: [] };
  group.completed = Math.min(group.count, group.completed + 1);
  toolGroups.set(card.itemId, group);
  let resultText = groupedToolResultText(group);
  if (group.errors > 0 && !String(resultText || '').trim()) {
    const exitRec = (group.results || []).find((r) => r?.isExitError);
    resultText = finalizedErrorFallbackBody(resultText, exitRec?.text, exitRec?.exitCode);
  }
  if (cancelled) resultText = withCancelledResultMarker(resultText, ctx.itemById(card.itemId));
  // liveOutput: null — the settled result supersedes any streamed tail.
  ctx.patchToolItem(card.itemId, settledPatch(group, resultText));
  closeCard(card, card.callId, done);
}
