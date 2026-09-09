// Generated recall records share one aging policy. A classifier's category
// must not grant an inferred rule permanent priority over user preferences.
// Standing user-approved memory is managed separately from this score.
export const CATEGORY_GRADE = {
  rule:       1.6,
  constraint: 1.6,
  decision:   1.6,
  fact:       1.6,
  goal:       1.6,
  preference: 1.6,
  task:       1.6,
  issue:      1.6,
}

const DECAY_RATE = 0.25

export async function syncMemoryScorePolicy(db) {
  await db.query(`
    INSERT INTO category_score_params(category, grade, decay)
    SELECT category, $2::real, $3::real FROM unnest($1::text[]) AS category
    ON CONFLICT (category) DO UPDATE SET grade = EXCLUDED.grade, decay = EXCLUDED.decay
    WHERE category_score_params.grade IS DISTINCT FROM EXCLUDED.grade
       OR category_score_params.decay IS DISTINCT FROM EXCLUDED.decay
  `, [Object.keys(CATEGORY_GRADE), 1.6, DECAY_RATE])
}

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
  const grade = CATEGORY_GRADE[String(category ?? '').toLowerCase()]
  if (grade == null) return null
  if (!Number.isFinite(Number(nowMs))) return null
  const anchor = Number.isFinite(Number(lastSeenAt)) ? Number(lastSeenAt) : Number(nowMs)
  const ageDays = Math.max(0, (Number(nowMs) - anchor) / 86_400_000)
  const adjustedAge = ageDays * DECAY_RATE
  const decay = 1 / Math.pow(1 + adjustedAge / 30, 0.3)
  return Math.min(grade, grade * decay)
}
