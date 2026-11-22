function stableItemKey(item, index) {
  if (item?.id !== undefined && item?.id !== null) return String(item.id);
  return `${item?.kind || 'item'}:${item?.text || item?.label || item?.status || ''}:${index}`;
}

/** Where the turn still open at the end of a key list began (the list's length when none is), by the list. */
const openTurns = new WeakMap();
/** How many leading keys a list took over from the list it was carried on from, by the list. */
const takenOver = new WeakMap();

/** The leading keys of `keys` that are the held list's own (`transcriptTurnKeys(items, held)`); 0 for a list made whole. */
export function turnKeysTakenOver(keys) {
  return takenOver.get(keys) ?? 0;
}

/** Completed attempts keep the same identity in live, full and tail projections.
 *
 *  `held` carries the keys on from those of a list that holds the same items before index `kept`: the keys of the turns
 *  closed before it are taken over, and only the items from the turn of the first changed one on are read. */
export function transcriptTurnKeys(items, held) {
  const transcript = Array.isArray(items) ? items : [];
  let keys = [];
  let activeTurn = null;
  let start = 0;
  let from = 0;
  const open = held ? openTurns.get(held.keys) : undefined;
  if (held && open !== undefined) {
    from = Math.min(held.kept, held.keys.length, transcript.length);
    if (from > open) {
      // The first changed item follows the first of the turn open at the end of the held list: that turn's key stands
      // until it ends.
      start = open;
      activeTurn = held.keys[open];
    } else {
      // A turn that had closed changed, or the item that opened the last one: back to where a turn begins in both
      // lists (after a turn's end, or at a prompt both hold), since the end of a turn renames the items before it.
      const kept = from;
      while (
        from > 0 &&
        transcript[from - 1]?.kind !== 'turndone' &&
        !(from < kept && transcript[from]?.kind === 'user')
      ) {
        from -= 1;
      }
      start = from;
    }
    keys = held.keys.slice(0, from);
  }
  let taken = from;
  for (let index = from; index < transcript.length; index += 1) {
    const item = transcript[index];
    if (item?.kind === 'user') {
      activeTurn = `turn:${stableItemKey(item, index)}`;
      start = index;
    }
    if (!activeTurn) {
      activeTurn = `segment:${stableItemKey(item, index)}`;
      start = index;
    }
    keys.push(activeTurn);
    if (item?.kind === 'turndone') {
      const named =
        typeof item.attemptId === 'string' && item.attemptId
          ? `attempt:${item.attemptId}`
          : typeof item.checkpointId === 'string' && item.checkpointId
            ? `checkpoint:${item.checkpointId}`
            : null;
      if (named !== null) {
        for (let row = start; row <= index; row += 1) keys[row] = named;
        // The turn's items held before are renamed with it.
        taken = Math.min(taken, start);
      }
      activeTurn = null;
    }
  }
  openTurns.set(keys, activeTurn === null ? transcript.length : start);
  if (taken > 0) takenOver.set(keys, taken);
  return keys;
}
