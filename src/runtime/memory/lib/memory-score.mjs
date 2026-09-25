// Generated recall records share one aging policy. A classifier's category
// must not grant an inferred rule permanent priority over user preferences.
// Standing user-approved memory is managed separately from this score.
export const CATEGORY_GRADE = {
  rule: 1.6,
  constraint: 1.6,
  decision: 1.6,
  fact: 1.6,
  goal: 1.6,
  preference: 1.6,
  task: 1.6,
  issue: 1.6,
};

const DECAY_RATE = 0.25;

/**
 * Persisted entry score = grade * decay-curve(ageDays, uniform rate).
 *
 * Returns null on unknown category or non-finite timestamps.
 *
 * @param {string} category
 * @param {number|string} lastSeenAt — ms timestamp
 * @param {number} nowMs
 * @returns {number|null}
 */
export function computeEntryScore(category, lastSeenAt, nowMs) {
  const grade = CATEGORY_GRADE[String(category ?? '').toLowerCase()];
  if (grade == null) return null;
  if (!Number.isFinite(Number(nowMs))) return null;
  const anchor = Number.isFinite(Number(lastSeenAt)) ? Number(lastSeenAt) : Number(nowMs);
  const ageDays = Math.max(0, (Number(nowMs) - anchor) / 86_400_000);
  const adjustedAge = ageDays * DECAY_RATE;
  const decay = 1 / (1 + adjustedAge / 30) ** 0.3;
  return Math.min(grade, grade * decay);
}
