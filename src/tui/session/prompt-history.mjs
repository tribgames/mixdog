/**
 * src/tui/session/prompt-history.mjs - pure prompt-history derivation.
 *
 * The newest-first, deduped user-prompt
 * history the session runtime publishes on state.promptHistoryList. Pure (input items
 * → array); callers decide when/whether to publish so the store's
 * immutable-emit contract is preserved.
 */
import { PROMPT_HISTORY_LIMIT, promptHistoryKey } from '../prompt-history-store.mjs';

// The history list without `text` (compared by promptHistoryKey): a prompt
// handed back to the draft must not also sit in the Up-arrow history.
export function promptHistoryWithout(list, text) {
  const key = promptHistoryKey(text);
  return (list || []).filter((entry) => promptHistoryKey(entry) !== key);
}

export function recomputePromptHistory(sourceItems, limit = PROMPT_HISTORY_LIMIT) {
  const items = Array.isArray(sourceItems) ? sourceItems : [];
  const seen = new Set();
  const history = [];
  for (let i = items.length - 1; i >= 0 && history.length < limit; i -= 1) {
    const item = items[i];
    if (item?.kind !== 'user') continue;
    const text = String(item.text || '').trim();
    const key = promptHistoryKey(text);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    history.push(text);
  }
  return history;
}
