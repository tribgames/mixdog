const FIVE_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh'];
const SIX_LEVELS = [...FIVE_LEVELS, 'max'];
export const SPARK_MAX_OUTPUT = 131_072;
const STANDARD_COST = { inputCostPerM: 1.25, outputCostPerM: 4.25, cacheReadCostPerM: 0.15, cacheWriteCostPerM: 0 };
const CONTRIBUTOR_COST = { inputCostPerM: 0.1, outputCostPerM: 0.2, cacheReadCostPerM: 0.002, cacheWriteCostPerM: 0 };

export const SEEDS = Object.freeze({
  'muse-spark-1.1': { name: 'Muse Spark 1.1', levels: FIVE_LEVELS, cost: STANDARD_COST },
  'muse-spark-1.2': { name: 'Muse Spark 1.2', levels: FIVE_LEVELS, cost: STANDARD_COST },
  'muse-spark-1.2-contributor': { name: 'Muse Spark 1.2 (C)', levels: FIVE_LEVELS, cost: CONTRIBUTOR_COST },
  'muse-spark-1.3': { name: 'Muse Spark 1.3', levels: SIX_LEVELS, cost: STANDARD_COST },
  'muse-spark-1.3-contributor': { name: 'Muse Spark 1.3 (C)', levels: SIX_LEVELS, cost: CONTRIBUTOR_COST },
});

export function seedRow(id) {
  const seed = SEEDS[id];
  return {
    id,
    name: seed.name,
    provider: 'muse-code-oauth',
    family: 'muse-spark',
    contextWindow: 1_048_576,
    outputTokens: SPARK_MAX_OUTPUT,
    supportsReasoning: true,
    supportsVision: true,
    supportsFunctionCalling: true,
    reasoningLevels: [...seed.levels],
    reasoningOptions: [{ type: 'effort', values: [...seed.levels] }],
    ...seed.cost,
  };
}
