function stableItemKey(item, index) {
  if (item?.id !== undefined && item?.id !== null) return String(item.id);
  return `${item?.kind || 'item'}:${item?.text || item?.label || item?.status || ''}:${index}`;
}

/** Completed attempts keep the same identity in live, full and tail projections. */
export function transcriptTurnKeys(items) {
  const transcript = Array.isArray(items) ? items : [];
  const keys = [];
  let activeTurn = null;
  let start = 0;
  for (let index = 0; index < transcript.length; index += 1) {
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
      if (typeof item.attemptId === 'string' && item.attemptId) {
        for (let row = start; row <= index; row += 1) keys[row] = `attempt:${item.attemptId}`;
      } else if (typeof item.checkpointId === 'string' && item.checkpointId) {
        for (let row = start; row <= index; row += 1) keys[row] = `checkpoint:${item.checkpointId}`;
      }
      activeTurn = null;
    }
  }
  return keys;
}
