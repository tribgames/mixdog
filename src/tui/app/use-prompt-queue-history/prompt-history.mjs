// use-prompt-queue-history/prompt-history.mjs
// Local fallback for the prompt history: the engine publishes the list
// incrementally, and only an older snapshot (no promptHistoryList) makes the
// surface rescan the transcript itself.
import { PROMPT_HISTORY_LIMIT } from '../transcript-window.mjs';
import { promptHistoryKey } from '../app-format.mjs';

/** Newest-first, de-duplicated user prompts, capped at PROMPT_HISTORY_LIMIT. */
export function scanPromptHistory(items) {
  const seen = new Set();
  const history = [];
  for (let i = items.length - 1; i >= 0 && history.length < PROMPT_HISTORY_LIMIT; i -= 1) {
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
