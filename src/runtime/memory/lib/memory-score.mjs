// Per-category grade (base score ceiling) and decay rate.
//
// grade = baseline ceiling for the category (durability of knowledge type).
// decay = how fast score drops with age. 0 means immune to age-decay
//         (rules never decay), higher means faster drop.
//
// Pairing: rules/constraints have high grade + low/zero decay (long-term),
// issues/tasks have low grade + high decay (transient by nature).
//
// score = grade * 1 / (1 + ageDays*rate/30)^0.3
//
// At ageDays=0: score = grade.
// As ageDays → ∞: score → 0.
// rate=0 disables decay entirely → score stays at grade forever.
export const CATEGORY_GRADE = {
  rule:       2.0,
  constraint: 1.9,
  decision:   1.8,
  fact:       1.6,
  goal:       1.5,
  preference: 1.4,
  task:       1.1,
  issue:      1.0,
}

export const CATEGORY_DECAY = {
  rule:       0.0,
  constraint: 0.06,
  decision:   0.15,
  fact:       0.25,
  goal:       0.30,
  preference: 0.35,
  task:       0.45,
  issue:      0.50,
}

// Smooth exponential freshness factor — used by hybrid retrieval ranking
// (separate from computeEntryScore, which is the persisted column score).
// Returns value in [0.50, 1.60].
//   ageH=0 → 1.60, ageH=6 → ~1.39, ageH=24 → ~1.08, ageH=72 → ~0.85,
//   ageH=168 → ~0.68, ageH=720 → ~0.50.
export function freshnessFactor(ts, nowMs = Date.now()) {
  const ts_ = Number(ts ?? 0)
  if (!Number.isFinite(ts_) || ts_ <= 0) return 0.85
  const ageH = Math.max(0, (nowMs - ts_) / 3_600_000)
  const raw = 0.50 + 1.10 * Math.exp(-ageH / 55)
  return Math.max(0.50, Math.min(1.60, raw))
}

/**
 * Persisted entry score = grade * decay-curve(ageDays, category-specific rate).
 *
 * Returns null on unknown category or non-finite timestamps.
 * rate=0 (rule) yields score = grade with no time component.
 *
 * @param {string} category
 * @param {number|string} lastSeenAt — ms timestamp
 * @param {number} nowMs
 * @returns {number|null}
 */
export function computeEntryScore(category, lastSeenAt, nowMs) {
  const grade = CATEGORY_GRADE[String(category ?? '').toLowerCase()]
  const rate  = CATEGORY_DECAY[String(category ?? '').toLowerCase()]
  if (grade == null || rate == null) return null
  if (!Number.isFinite(Number(nowMs))) return null
  const anchor = Number.isFinite(Number(lastSeenAt)) ? Number(lastSeenAt) : Number(nowMs)
  const ageDays = Math.max(0, (Number(nowMs) - anchor) / 86_400_000)
  const adjustedAge = ageDays * rate
  const decay = 1 / Math.pow(1 + adjustedAge / 30, 0.3)
  return Math.min(grade, grade * decay)
}
