// Offline seed rosters for providers whose discovery endpoint lists bare ids.
// A seed is the cold-start fallback only: the metadata lookup applies it to
// fields nothing fetched (live roster, models.dev) supplied, and provider
// rows never let it override discovered data. Pure data, no provider imports,
// so the shared sync lookup and the provider transports read one copy.

// ── Muse Code (Meta Muse Spark) ─────────────────────────────────────────────
export const MUSE_DEFAULT_EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh']);
const MUSE_SIX_LEVELS = Object.freeze([...MUSE_DEFAULT_EFFORT_LEVELS, 'max']);
const MUSE_SPARK_CONTEXT = 1_048_576;
export const MUSE_SPARK_MAX_OUTPUT = 131_072;
const STANDARD_COST = { inputCostPerM: 1.25, outputCostPerM: 4.25, cacheReadCostPerM: 0.15, cacheWriteCostPerM: 0 };
const CONTRIBUTOR_COST = { inputCostPerM: 0.1, outputCostPerM: 0.2, cacheReadCostPerM: 0.002, cacheWriteCostPerM: 0 };

// Only the 1.3 revisions accept `max`.
const MUSE_SEEDS = Object.freeze({
  'muse-spark-1.1': { name: 'Muse Spark 1.1', levels: MUSE_DEFAULT_EFFORT_LEVELS, cost: STANDARD_COST },
  'muse-spark-1.2': { name: 'Muse Spark 1.2', levels: MUSE_DEFAULT_EFFORT_LEVELS, cost: STANDARD_COST },
  'muse-spark-1.2-contributor': {
    name: 'Muse Spark 1.2 (C)',
    levels: MUSE_DEFAULT_EFFORT_LEVELS,
    cost: CONTRIBUTOR_COST,
  },
  'muse-spark-1.3': { name: 'Muse Spark 1.3', levels: MUSE_SIX_LEVELS, cost: STANDARD_COST },
  'muse-spark-1.3-contributor': { name: 'Muse Spark 1.3 (C)', levels: MUSE_SIX_LEVELS, cost: CONTRIBUTOR_COST },
});
export const MUSE_SEED_IDS = Object.freeze(Object.keys(MUSE_SEEDS));

function museEffortRow(id, name, levels, cost) {
  return {
    id,
    name,
    provider: 'muse-code-oauth',
    family: 'muse-spark',
    contextWindow: MUSE_SPARK_CONTEXT,
    outputTokens: MUSE_SPARK_MAX_OUTPUT,
    supportsReasoning: true,
    supportsVision: true,
    supportsFunctionCalling: true,
    reasoningLevels: [...levels],
    reasoningOptions: [{ type: 'effort', values: [...levels] }],
    ...cost,
  };
}

// Revisioned Spark ids the seed does not list inherit the newest seeded
// revision of their tier (limits, vision, pricing) but take the five-level
// ladder: only reviewed seeds advertise `max`.
const SPARK_ID_RE = /^muse-spark-(\d+)\.(\d+)(?:\.(\d+))?(-contributor)?$/i;

function revisionOf(id) {
  const m = SPARK_ID_RE.exec(id);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}

function compareRevision(a, b) {
  for (let i = 0; i < 3; i += 1) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function museLineageRow(id) {
  const match = SPARK_ID_RE.exec(id);
  if (!match) return null;
  const contributor = Boolean(match[4]);
  let template = null;
  let templateRevision = null;
  for (const seedId of MUSE_SEED_IDS) {
    if (SPARK_ID_RE.exec(seedId)[4] ? !contributor : contributor) continue;
    const candidate = revisionOf(seedId);
    if (!templateRevision || compareRevision(candidate, templateRevision) > 0) {
      template = seedId;
      templateRevision = candidate;
    }
  }
  if (!template) return null;
  const revision =
    match[3] && Number(match[3]) !== 0 ? `${match[1]}.${match[2]}.${match[3]}` : `${match[1]}.${match[2]}`;
  return museEffortRow(
    id,
    `Muse Spark ${revision}${contributor ? ' (C)' : ''}`,
    MUSE_DEFAULT_EFFORT_LEVELS,
    MUSE_SEEDS[template].cost
  );
}

/** Seed row for a seeded id, else the lineage row of a revisioned Spark id, else null. */
export function museSeedRow(id) {
  const key = String(id || '');
  const seed = MUSE_SEEDS[key];
  if (seed) return museEffortRow(key, seed.name, seed.levels, seed.cost);
  return museLineageRow(key);
}

// ── Xiaomi MiMo ─────────────────────────────────────────────────────────────
const MIMO_SEED_CONTEXT = 1_048_576;
const MIMO_SEED_OUTPUT = 131_072;
export const MIMO_SEED_MODELS = Object.freeze(
  [
    ['mimo-v2.6-pro', 'MiMo-V2.6-Pro', MIMO_SEED_CONTEXT],
    ['mimo-v2.6-flash', 'MiMo-V2.6-Flash', MIMO_SEED_CONTEXT],
    ['mimo-v2.6-pro-ultraspeed', 'MiMo-V2.6-Pro-Ultraspeed', MIMO_SEED_CONTEXT],
    ['mimo-v2.5-pro', 'MiMo-V2.5-Pro', MIMO_SEED_CONTEXT],
    ['mimo-v2.5', 'MiMo-V2.5', MIMO_SEED_CONTEXT],
    ['mimo-v2-pro', 'MiMo-V2-Pro', MIMO_SEED_CONTEXT],
    ['mimo-v2-omni', 'MiMo-V2-Omni', 262_144],
  ].map(([id, display_name, context_window]) =>
    Object.freeze({ id, display_name, context_window, max_output_tokens: MIMO_SEED_OUTPUT })
  )
);

/** Exact seed id, else the longest seed whose id is a lineage prefix of the
 *  model (dated or suffixed variants of a seeded model). */
export function mimoSeedRow(model) {
  const id = String(model || '').toLowerCase();
  let seed = MIMO_SEED_MODELS.find((item) => item.id === id) || null;
  if (!seed) {
    for (const item of MIMO_SEED_MODELS) {
      if (id.startsWith(`${item.id}-`) && (!seed || item.id.length > seed.id.length)) seed = item;
    }
  }
  if (!seed) return null;
  return {
    id: String(model),
    contextWindow: seed.context_window,
    outputTokens: seed.max_output_tokens,
    reasoning: true,
    vision: true,
    inputModalities: ['text', 'image'],
  };
}
