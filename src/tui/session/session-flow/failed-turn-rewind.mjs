// The transcript side of a failed-turn retry: a failed turn that never
// produced output is dropped from the settled items so the resubmitted prompt
// renders once; a turn with assistant/tool activity stays and the retry
// continues below it. Gated on the resubmitted text repeating the failed
// prompt, so a continuation prompt or a merged batch never removes rows.
const TURN_CHROME_KINDS = new Set(['user', 'turndone', 'notice']);

/** The items with the trailing failed, output-less turn removed, or null
 *  when nothing qualifies. */
export function rewoundFailedTurnItems(items, text) {
  const list = Array.isArray(items) ? items : [];
  const resubmitted = String(text || '').trim();
  if (!resubmitted) return null;
  let start = -1;
  for (let index = list.length - 1; index >= 0; index -= 1) {
    if (list[index]?.kind === 'user') {
      start = index;
      break;
    }
  }
  if (start < 0 || String(list[start].text || '').trim() !== resubmitted) return null;
  const tail = list.slice(start + 1);
  const failed = tail.some(
    (item) => item?.kind === 'turndone' && String(item.status || '').toLowerCase() === 'failed'
  );
  if (!failed) return null;
  if (tail.some((item) => !TURN_CHROME_KINDS.has(String(item?.kind || '')))) return null;
  return list.slice(0, start);
}
