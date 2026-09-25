function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function compareRecallNewestFirst(a, b) {
  const tsA = finite(a?.ts) ?? 0;
  const tsB = finite(b?.ts) ?? 0;
  if (tsA !== tsB) return tsB - tsA;

  const sessionA = String(a?.session_id ?? a?.sessionId ?? '');
  const sessionB = String(b?.session_id ?? b?.sessionId ?? '');
  if (sessionA && sessionA === sessionB) {
    const turnA = finite(a?.source_turn ?? a?.sourceTurn);
    const turnB = finite(b?.source_turn ?? b?.sourceTurn);
    if (turnA !== null && turnB !== null && turnA !== turnB) return turnB - turnA;
  }

  return (finite(b?.id) ?? 0) - (finite(a?.id) ?? 0);
}

// Relevance order for ranked recall rows: retrieval score, stored score, then
// newest ts; id ascending breaks the remaining ties.
export function compareRecallByScore(a, b) {
  const score = (value) => finite(value) ?? 0;
  return (
    score(b.retrievalScore ?? b.rrf ?? 0) - score(a.retrievalScore ?? a.rrf ?? 0) ||
    score(b.score ?? 0) - score(a.score ?? 0) ||
    score(b.ts ?? 0) - score(a.ts ?? 0) ||
    Number(a.id ?? 0) - Number(b.id ?? 0)
  );
}

// Chronological (oldest-first) order for a single-session handoff, where the
// reader must follow cause → effect instead of scanning for the latest hit.
export function compareRecallOldestFirst(a, b) {
  return compareRecallNewestFirst(b, a);
}
