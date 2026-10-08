// Auto effort: turns the effort judge's difficulty distribution into this
// turn's effort by moving along the model's effort ladder from a base effort.
// Every turn starts again from the base, so a run of hard turns never
// ratchets the effort upward.
//
// The base is `medium` on every model: raised only when the request needs it,
// lowered when it is easy. The ladder is the model's supported efforts from
// `low` up to the tier below the top: `none`/`minimal` switch thinking off and
// `max`/`ultra` are reserved for an explicit user choice, so auto never picks
// them. A chosen `max`/`ultra` is left untouched.

const EFFORT_ORDER = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const FLOOR_INDEX = EFFORT_ORDER.indexOf('low');
const RESERVED_TOP = new Set(['max', 'ultra']);

export const AUTO_EFFORT_BASE = 'medium';

/** The effort auto moves from: `medium`, unless the user chose `max`/`ultra`. */
export function autoEffortBase(chosen) {
  const effort = String(chosen ?? '')
    .trim()
    .toLowerCase();
  return RESERVED_TOP.has(effort) ? effort : AUTO_EFFORT_BASE;
}

export const AUTO_EFFORT_MODES = Object.freeze(['off', 'observe', 'on']);

// The judge rates four levels, each one ladder step from the base: easy -1
// (low), normal 0 (medium), hard +1 (high), very hard +2 (xhigh).
export const AUTO_EFFORT_LEVELS = Object.freeze(['easy', 'normal', 'hard', 'very hard']);
const STEP_OF_LEVEL = [-1, 0, 1, 2];

// The chosen level minimises the expected cost under the judge distribution.
// A miss costs one per level, plus this much for an opposite call (easy
// against hard or very hard, either way) and this much for a needless "very
// hard" (xhigh). Fitted on the held-out validation split: fewer opposite calls
// at nearly unchanged exact accuracy.
export const AUTO_EFFORT_OPPOSITE_COST = 1;
export const AUTO_EFFORT_FALSE_VERY_HARD_COST = 1;
// Ties keep the default first, then the cheaper side.
const TIE_ORDER = [1, 0, 2, 3];

function expectedCost(values, level) {
  let cost = 0;
  values.forEach((p, actual) => {
    const opposite = (level === 0 && actual >= 2) || (actual === 0 && level >= 2);
    cost +=
      p *
      (Math.abs(level - actual) +
        (opposite ? AUTO_EFFORT_OPPOSITE_COST : 0) +
        (level === 3 && actual < 3 ? AUTO_EFFORT_FALSE_VERY_HARD_COST : 0));
  });
  return cost;
}

export function normalizeAutoEffortMode(value) {
  const mode = String(value ?? '')
    .trim()
    .toLowerCase();
  return AUTO_EFFORT_MODES.includes(mode) ? mode : 'off';
}

/** The efforts auto may choose for a model, in ascending order. */
export function autoEffortLadder(options) {
  const supported = new Set((options || []).map((value) => String(value).trim().toLowerCase()));
  return EFFORT_ORDER.filter(
    (level, index) => supported.has(level) && index >= FLOOR_INDEX && !RESERVED_TOP.has(level)
  );
}

/** Ladder step for a judge distribution over the four levels (index 0 = easy). */
export function judgedStep(probs) {
  const values = Array.isArray(probs) && probs.length === AUTO_EFFORT_LEVELS.length ? probs.map(Number) : null;
  if (!values || values.some((value) => !Number.isFinite(value))) return { step: 0, level: null, confidence: 0 };
  const confidence = Math.max(...values);
  let level = TIE_ORDER[0];
  for (const candidate of TIE_ORDER)
    if (expectedCost(values, candidate) < expectedCost(values, level) - 1e-12) level = candidate;
  return { step: STEP_OF_LEVEL[level], level, confidence };
}

/**
 * This turn's effort, or null when auto does not apply (the default lies
 * outside the ladder). `effort === base` when the judge keeps the default.
 */
export function resolveAutoEffort({ base, options, probs }) {
  const ladder = autoEffortLadder(options);
  const at = ladder.indexOf(String(base ?? '').toLowerCase());
  if (at < 0) return null;
  const { step, level, confidence } = judgedStep(probs);
  const effort = ladder[Math.max(0, Math.min(ladder.length - 1, at + step))];
  return { base: ladder[at], effort, step, level, confidence: Number(confidence.toFixed(3)) };
}
