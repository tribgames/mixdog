// Leaf constant: the anchor sentence every compact summary message opens with.
// Kept import-free so store-layer code can classify messages without pulling
// the context-utils graph (which cycles back into the session store).
export const SUMMARY_PREFIX_ANCHOR =
  'A previous model worked on this task and produced the compacted handoff summary below.';
