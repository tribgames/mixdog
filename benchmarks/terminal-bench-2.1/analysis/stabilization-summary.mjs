// Aggregate completed, same-preset runs by exact runtime bundle.
// Usage: node stabilization-summary.mjs [--append] --out <json> <jobsDir> [...]
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sum = (rows, value) => rows.reduce((total, row) => total + value(row), 0);
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const mean = (values) => values.length ? sum(values, (value) => value) / values.length : null;
// Sample standard deviation; a single observation has no spread to report.
const sd = (values) => {
  if (values.length < 2) return null;
  const center = mean(values);
  return Math.sqrt(sum(values, (value) => (value - center) ** 2) / (values.length - 1));
};

// Two-sample resolution at alpha 0.05 (two-sided) and power 0.8:
// z(0.975) + z(0.8) = 1.960 + 0.842. Run-to-run wall time in this suite
// varies by ~15%, so the question "did this candidate change the time?" has a
// floor below which the measured delta is indistinguishable from noise. The
// summary reports that floor instead of letting a 5-run median imply one.
const Z_RESOLUTION = 1.960 + 0.842;
export function resolution(values) {
  const spread = sd(values);
  const center = mean(values);
  if (spread === null || !center) return { sd: spread, cv: null, detectableFraction: null, runsFor: null };
  const cv = spread / center;
  const runsFor = (fraction) => Math.ceil(2 * (Z_RESOLUTION * cv / fraction) ** 2);
  return {
    sd: spread,
    cv,
    // Smallest relative difference two cohorts of this size could establish.
    detectableFraction: Z_RESOLUTION * cv * Math.sqrt(2 / values.length),
    runsFor: { '0.05': runsFor(0.05), '0.10': runsFor(0.10), '0.20': runsFor(0.20) },
  };
}

// Whether the observed median gap between two cohorts exceeds what their own
// spread can resolve. Neither a hypothesis test nor a causal claim: a gap
// under the floor is "not shown", not "absent".
export function compareCohorts(base, candidate, metric) {
  const a = base.rows.map((row) => row[metric]);
  const b = candidate.rows.map((row) => row[metric]);
  const baseMean = mean(a);
  const sdA = sd(a);
  const sdB = sd(b);
  const medianDelta = median(b) - median(a);
  const medianDeltaFraction = baseMean ? medianDelta / median(a) : null;
  const detectableFraction = sdA !== null && sdB !== null && baseMean
    ? Z_RESOLUTION * Math.sqrt((sdA ** 2) / a.length + (sdB ** 2) / b.length) / baseMean
    : null;
  return {
    metric,
    base: base.bundle,
    candidate: candidate.bundle,
    runs: { base: a.length, candidate: b.length },
    medianDelta,
    medianDeltaFraction,
    detectableFraction,
    resolvable: detectableFraction === null || medianDeltaFraction === null
      ? null
      : Math.abs(medianDeltaFraction) >= detectableFraction,
  };
}

// `input` is the full prompt total. Rows measured from the run's own trace
// carry their normalized uncached figure; older rows only have the total, so
// the subtraction stays as their documented fallback.
const uncachedInputOf = (row) => (Number.isFinite(row.tokens.uncachedInput)
  ? row.tokens.uncachedInput
  : row.tokens.input - row.tokens.cached);

function aggregate(rows) {
  const input = sum(rows, (row) => row.tokens.input);
  const cached = sum(rows, (row) => row.tokens.cached);
  const output = sum(rows, (row) => row.tokens.output);
  const reasoning = sum(rows, (row) => row.totals.thinking);
  const reasoningComplete = rows.every((row) => row.totals.thinkingComplete === true);
  return {
    runs: rows.length,
    passed: sum(rows, (row) => row.result.passed),
    tasks: sum(rows, (row) => row.result.total),
    errors: sum(rows, (row) => row.result.errors),
    retries: sum(rows, (row) => row.result.retries),
    tokens: {
      input, cached, uncachedInput: sum(rows, uncachedInputOf),
      cacheWrite: sum(rows, (row) => row.tokens.cacheWrite),
      output,
      reasoning: reasoningComplete ? reasoning : null,
      reasoningRecorded: reasoning,
      reasoningComplete,
      reasoningMissingRequests: rows.every((row) => Number.isFinite(row.totals.missingThinkingRequests))
        ? sum(rows, (row) => row.totals.missingThinkingRequests) : null,
      nonReasoningOutput: reasoningComplete ? output - reasoning : null,
      inputPlusOutput: input + output,
      inputMedian: median(rows.map((row) => row.tokens.input)),
      outputMedian: median(rows.map((row) => row.tokens.output)),
    },
    wall: {
      total: sum(rows, (row) => row.wall),
      median: median(rows.map((row) => row.wall)),
      min: Math.min(...rows.map((row) => row.wall)),
      max: Math.max(...rows.map((row) => row.wall)),
      ...resolution(rows.map((row) => row.wall)),
    },
    agent: {
      total: sum(rows, (row) => row.agent),
      median: median(rows.map((row) => row.agent)),
      ...resolution(rows.map((row) => row.agent)),
    },
    streamSeconds: sum(rows, (row) => sum(row.tasks, (task) => task.streamSeconds)),
    calls: {
      total: sum(rows, (row) => row.totals.calls),
      median: median(rows.map((row) => row.totals.calls)),
    },
    requests: sum(rows, (row) => row.totals.requests),
    cost: {
      total: sum(rows, (row) => row.cost),
      median: median(rows.map((row) => row.cost)),
      perAgentMinute: sum(rows, (row) => row.cost) / sum(rows, (row) => row.agent) * 60,
    },
  };
}

export function summarizeRuns(runs) {
  if (!runs.length) throw new Error('At least one completed run is required.');
  const fingerprint = runs[0].fingerprint;
  if (runs.some((run) => run.fingerprint !== fingerprint)) {
    throw new Error('Cannot compare different preset fingerprints.');
  }
  if (new Set(runs.map((run) => run.run)).size !== runs.length) {
    throw new Error('Duplicate runs would inflate the totals.');
  }
  const groups = new Map();
  for (const run of runs) {
    if (!run.bundle) throw new Error('A runtime bundle identity is required.');
    const group = groups.get(run.bundle) ?? [];
    if (group.some((row) => row.rules !== run.rules || row.tools !== run.tools)) {
      throw new Error('One bundle cannot have conflicting rule or tool identities.');
    }
    group.push(run);
    groups.set(run.bundle, group);
  }
  const cohorts = [...groups].map(([bundle, rows]) => ({
      bundle, rules: rows[0].rules, tools: rows[0].tools,
      ...aggregate(rows),
      taskTotals: [...new Set(rows.flatMap((row) => row.tasks.map((task) => task.task)))].sort().map((task) => {
        const results = rows.flatMap((row) => row.tasks.filter((entry) => entry.task === task));
        return {
          task,
          passed: sum(results, (row) => Number(row.passed)),
          agent: sum(results, (row) => row.agent),
          agentMedian: median(results.map((row) => row.agent)),
          agentSd: sd(results.map((row) => row.agent)),
          calls: sum(results, (row) => row.calls),
          output: results.every((row) => row.outputComplete === true)
            ? sum(results, (row) => row.output) : null,
          outputRecorded: sum(results, (row) => row.output),
          reasoning: results.every((row) => row.thinkingComplete === true)
            ? sum(results, (row) => row.thinking) : null,
          reasoningRecorded: sum(results, (row) => row.thinking),
          reasoningComplete: results.every((row) => row.thinkingComplete === true),
          streamSeconds: sum(results, (row) => row.streamSeconds),
        };
      }),
      rows,
    }));
  // Every later bundle against the first one, in observation order; the first
  // bundle is the baseline the round started from.
  const comparisons = cohorts.slice(1).flatMap((candidate) => ['wall', 'agent']
    .map((metric) => compareCohorts(cohorts[0], candidate, metric)));
  return {
    fingerprint,
    summary: aggregate(runs),
    cohorts: cohorts.map(({ rows: _rows, ...cohort }) => cohort),
    comparisons,
    runs,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const append = args[0] === '--append';
  if (append) args.shift();
  if (args[0] !== '--out' || !args[1] || args.length < 3) {
    throw new Error('Usage: stabilization-summary.mjs [--append] --out <json> <jobsDir> [...]');
  }
  const previous = append ? JSON.parse(readFileSync(args[1], 'utf8')).runs : [];
  const child = spawnSync(process.execPath, [
    fileURLToPath(new URL('_tmp-contract-metrics.mjs', import.meta.url)),
    ...args.slice(2),
  ], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(child.stderr || `Metrics exited ${child.status}.`);
  const runs = child.stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const result = summarizeRuns([...previous, ...runs]);
  writeFileSync(args[1], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output: resolve(args[1]), summary: result.summary,
    cohorts: result.cohorts.map(({ taskTotals, ...cohort }) => cohort),
    comparisons: result.comparisons }));
}
