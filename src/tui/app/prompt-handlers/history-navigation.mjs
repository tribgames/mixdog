// prompt-handlers/history-navigation.mjs
// One Up/Down step through recent prompts, as a pure decision over the
// current navigation state.
import { promptHistoryKey } from '../../prompt-history-store.mjs';

const IDLE_NAV = { active: false, index: -1, seed: '', lastValue: '' };

/**
 * Returns { value, nav, reset, draftChanged }: `value` is what the prompt
 * shows next (undefined = leave it), `nav` the navigation state to keep (null
 * = unchanged), `reset` whether the walk ended (back at the seed or nothing to
 * walk), `draftChanged` whether the prompt text was replaced. Entries equal to
 * the current text are skipped so Up/Down always moves to something different.
 */
export function navigatePromptHistory({ direction, currentText = '', meta = {}, nav: current, history }) {
  const currentValue = String(currentText || '');
  const currentKey = promptHistoryKey(currentValue);
  const nav = current || IDLE_NAV;
  if ((meta.emptyDraft && direction === 'down') || history.length === 0) return { reset: true };
  if (direction === 'down' && !nav.active) return {};
  const active = nav.active && (currentValue === nav.lastValue || currentValue === nav.seed);
  const seed = active ? nav.seed : currentValue;
  const step = direction === 'down' ? -1 : 1;
  let nextIndex = (active ? nav.index : -1) + step;
  while (nextIndex >= 0 && nextIndex < history.length && promptHistoryKey(history[nextIndex]) === currentKey) {
    nextIndex += step;
  }
  if (nextIndex < 0) return { reset: true, draftChanged: true, value: seed };
  if (nextIndex >= history.length) return {};
  const value = history[nextIndex];
  return { value, nav: { active: true, index: nextIndex, seed, lastValue: value }, draftChanged: true };
}
