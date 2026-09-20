import { parseAgentJob, agentJobResultText, agentArgsWithResultMetadata } from '../agent-envelope.mjs';
import { toolErrorDisplay } from '../tool-result-text.mjs';

export function createAgentJobCard({ getState, itemIndexById, patchItem }) {
  // Pure builder for the agent-job card patch. Split out so callers that are
  // already patching the same card in the same tick (see tool-card-results
  // non-aggregate path) can MERGE these fields into their single patchItem
  // instead of issuing a second set() — collapsing the L1/L2 double-update
  // jitter into one visible item update.
  function buildAgentJobCardPatch(itemId, text, isError = false) {
    const parsed = parseAgentJob(text);
    const index = itemIndexById?.get(itemId);
    const current = Number.isInteger(index) && getState().items[index]?.id === itemId ? getState().items[index] : null;
    const rawDisplayText = agentJobResultText(text, parsed) || String(text ?? '').trim();
    const displayText = isError ? toolErrorDisplay(rawDisplayText, 'agent') : rawDisplayText;
    return {
      result: displayText,
      text: displayText,
      isError,
      errorCount: isError ? 1 : 0,
      ...(parsed ? { args: agentArgsWithResultMetadata(current?.args, parsed) } : {}),
    };
  }

  function updateAgentJobCard(itemId, text, isError = false) {
    patchItem(itemId, buildAgentJobCardPatch(itemId, text, isError));
  }

  return { buildAgentJobCardPatch, updateAgentJobCard };
}
