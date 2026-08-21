#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarizeReductionTraceRows } from '../../../src/runtime/agent/orchestrator/session/reduction-metrics.mjs';

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const tryReadJson = (path) => {
  try { return readJson(path); } catch { return null; }
};
const optionalNumber = (value) => value == null || value === '' || !Number.isFinite(Number(value))
  ? null
  : Number(value);
const finite = (value, fallback = 0) => optionalNumber(value) ?? fallback;
const seconds = (start, finish) => {
  const value = new Date(finish).getTime() - new Date(start).getTime();
  return Number.isFinite(value) && value >= 0 ? value / 1000 : null;
};
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const sum = (rows, read) => rows.reduce((total, row) => total + finite(read(row)), 0);
const inline = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

const RATES = [
  [/luna/, { input: 0.2, cached: 0.02, write: 0.25, output: 1.2, family: 'openai' }],
  [/terra/, { input: 2, cached: 0.2, write: 2.5, output: 12, family: 'openai' }],
  [/sol|gpt/, { input: 5, cached: 0.5, write: 6.25, output: 30, family: 'openai' }],
  [/haiku/, { input: 1, cached: 0.1, write: 1.25, output: 5, family: 'anthropic' }],
  [/opus|fable|claude/, { input: 5, cached: 0.5, write: 10, output: 25, family: 'anthropic' }],
];

function rateFor(model) {
  const name = String(model || '').toLowerCase();
  return RATES.find(([pattern]) => pattern.test(name))?.[1] ?? RATES.at(-1)[1];
}

function pricedCost({ model, input, cached, cacheWrite, output }) {
  const rate = rateFor(model);
  const uncached = rate.family === 'openai'
    ? Math.max(finite(input) - finite(cached) - finite(cacheWrite), 0)
    : finite(input);
  return (
    uncached * rate.input
    + finite(cached) * rate.cached
    + finite(cacheWrite) * rate.write
    + finite(output) * rate.output
  ) / 1e6;
}

function usageMetrics(trialDir, transcript) {
  const usage = tryReadJson(join(trialDir, 'agent', 'usage.json'));
  if (Array.isArray(usage?.sessions) && usage.sessions.length) {
    const costUsd = usage.sessions.reduce((total, session) => total + pricedCost({
      model: session?.models?.[0],
      input: session.inputTokens,
      cached: session.cacheTokens,
      cacheWrite: session.cacheWriteTokens,
      output: session.outputTokens,
    }), 0);
    return {
      costUsd,
      cacheWrite: finite(usage?.totals?.cacheWriteTokens),
    };
  }
  if (!transcript) return { costUsd: null, cacheWrite: 0 };
  const cacheWrite = finite(transcript.totalCacheWriteTokens);
  const rate = rateFor(transcript.model);
  const uncached = Math.max(finite(transcript.totalUncachedInputTokens) - cacheWrite, 0);
  return {
    costUsd: (
      uncached * rate.input
      + finite(transcript.totalCachedReadTokens) * rate.cached
      + cacheWrite * rate.write
      + finite(transcript.totalOutputTokens) * rate.output
    ) / 1e6,
    cacheWrite,
  };
}

function findRunDir(jobsDir) {
  const direct = join(jobsDir, 'result.json');
  if (existsSync(direct)) return jobsDir;
  const children = readdirSync(jobsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d{4}-\d{2}-\d{2}__/.test(entry.name))
    .map((entry) => join(jobsDir, entry.name))
    .sort();
  return children.at(-1) ?? jobsDir;
}

function compactTraceArgs(value) {
  let text = '';
  try { text = JSON.stringify(value ?? {}); } catch { return ''; }
  return text.length > 320 ? `${text.slice(0, 319)}…` : text;
}

function traceDiagnostics(trialDir) {
  const path = join(trialDir, 'agent', 'agent-trace.jsonl');
  if (!existsSync(path)) return null;
  const tools = [];
  const failures = [];
  const toolCounts = new Map();
  const tokens = { input: 0, cached: 0, cacheWrite: 0, output: 0 };
  let providerRequests = 0;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row?.kind === 'usage_raw') {
      providerRequests += 1;
      tokens.input += finite(row.input_tokens);
      tokens.cached += finite(row.cached_tokens);
      tokens.cacheWrite += finite(row.cache_write_tokens);
      tokens.output += finite(row.output_tokens);
      continue;
    }
    if (row?.kind !== 'tool') continue;
    const tool = inline(row.tool_name) || 'unknown';
    toolCounts.set(tool, (toolCounts.get(tool) ?? 0) + 1);
    const call = {
      iteration: optionalNumber(row.iteration),
      tool,
      resultKind: row.result_kind ?? null,
      errorCategory: row.result_error_category ?? null,
      error: row.result_error_first_line ?? null,
      argsSummary: compactTraceArgs(row.tool_args_summary ?? row.tool_args),
    };
    tools.push(call);
    // scoped-cache-hit is a successful cached result, not a failure.
    if ((row.result_kind && row.result_kind !== 'normal' && row.result_kind !== 'scoped-cache-hit') || row.result_error_first_line) {
      failures.push(call);
    }
  }
  return {
    providerRequests,
    toolCalls: tools.length,
    tokens,
    toolCounts: Object.fromEntries(
      [...toolCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    ),
    failures,
    lastCalls: tools.slice(-3),
  };
}

function loadCostDetails(config, historyRoot) {
  if (!config?.costDetails) return {};
  const source = tryReadJson(resolve(historyRoot, config.costDetails)) ?? {};
  return Object.fromEntries(Object.entries(source).map(([task, row]) => [
    task,
    pricedCost({
      model: config.model,
      input: row.unc,
      cached: row.cr,
      cacheWrite: row.cw,
      output: row.out,
    }),
  ]));
}

function collectTrials(runDir, costDetails = {}) {
  const rows = [];
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('__')) continue;
    const trialDir = join(runDir, entry.name);
    const result = tryReadJson(join(trialDir, 'result.json'));
    if (!result) continue;
    const reward = result?.verifier_result?.rewards?.reward
      ?? result?.verifier_result?.rewards?.accuracy
      ?? null;
    const task = String(result?.task_id?.name ?? result?.task_name ?? entry.name.split('__')[0])
      .replace(/^terminal-bench\//, '');
    const rawTranscript = tryReadJson(join(trialDir, 'agent', 'session-transcript.json'));
    const transcript = Array.isArray(rawTranscript) ? rawTranscript[0] : rawTranscript;
    const usage = usageMetrics(trialDir, transcript);
    const trace = traceDiagnostics(trialDir);
    const directCost = optionalNumber(result?.agent_result?.cost_usd);
    let resultEvent = null;
    let finalContextTokens = null;
    try {
      for (const line of readFileSync(join(trialDir, 'agent', 'mixdog.txt'), 'utf8').split(/\r?\n/)) {
        if (!line.includes('"type":"result"') && !line.includes('"type":"model.request.completed"')) continue;
        try {
          const row = JSON.parse(line);
          if (row?.type === 'result') resultEvent = row;
          if (row?.type === 'model.request.completed') {
            const input = optionalNumber(row?.usage?.input_tokens);
            if (input != null) {
              finalContextTokens = input
                + finite(row?.usage?.cached_input_tokens)
                + finite(row?.usage?.cache_write_input_tokens);
            }
          }
        } catch { /* retain the last valid result row */ }
      }
    } catch { /* non-mixdog baselines have other logs */ }
    const totalSeconds = seconds(result?.started_at, result?.finished_at);
    const environmentSetupSeconds = seconds(
      result?.environment_setup?.started_at,
      result?.environment_setup?.finished_at,
    );
    const agentSetupSeconds = seconds(
      result?.agent_setup?.started_at,
      result?.agent_setup?.finished_at,
    );
    const agentSeconds = seconds(
      result?.agent_execution?.started_at,
      result?.agent_execution?.finished_at,
    );
    const verifierSeconds = seconds(
      result?.verifier?.started_at,
      result?.verifier?.finished_at,
    );
    const teardownSeconds = Number.isFinite(totalSeconds)
      ? Math.max(0, totalSeconds - sum(
        [environmentSetupSeconds, agentSetupSeconds, agentSeconds, verifierSeconds],
        (value) => value,
      ))
      : null;
    rows.push({
      task,
      settled: reward != null || result?.exception_info != null,
      passed: Number(reward) === 1,
      reward: optionalNumber(reward),
      error: result?.exception_info ?? null,
      startedAt: result?.started_at ?? null,
      finishedAt: result?.finished_at ?? null,
      agentSeconds,
      timing: {
        totalSeconds,
        environmentSetupSeconds,
        agentSetupSeconds,
        verifierSeconds,
        teardownSeconds,
        apiSeconds: optionalNumber(resultEvent?.duration_api_ms) == null
          ? null
          : finite(resultEvent.duration_api_ms) / 1000,
      },
      activity: {
        providerRequests: optionalNumber(resultEvent?.provider_requests)
          ?? finite(trace?.providerRequests),
        toolCalls: optionalNumber(resultEvent?.tool_calls)
          ?? optionalNumber(usage?.toolCallCountApprox)
          ?? finite(trace?.toolCalls),
      },
      tokens: {
        input: optionalNumber(result?.agent_result?.n_input_tokens)
          ?? finite(trace?.tokens?.input),
        cached: optionalNumber(result?.agent_result?.n_cache_tokens)
          ?? finite(trace?.tokens?.cached),
        cacheWrite: optionalNumber(usage.cacheWrite)
          ?? finite(trace?.tokens?.cacheWrite),
        output: optionalNumber(result?.agent_result?.n_output_tokens)
          ?? finite(trace?.tokens?.output),
      },
      costUsd: optionalNumber(costDetails[task]) ?? directCost ?? usage.costUsd,
      finalContextTokens: optionalNumber(transcript?.lastContextTokens) ?? finalContextTokens,
      trace: result?.exception_info || trace?.failures?.length ? trace : null,
    });
  }
  return rows.sort((a, b) => a.task.localeCompare(b.task));
}

function reductionRows(runDir) {
  const rows = [];
  const names = ['agent-trace.jsonl', 'reduction-trace.jsonl', 'trace.jsonl'];
  for (const entry of readdirSync(runDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.includes('__')) continue;
    const agentDir = join(runDir, entry.name, 'agent');
    for (const name of names) {
      const path = join(agentDir, name);
      if (!existsSync(path)) continue;
      for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        try { rows.push(JSON.parse(line)); } catch { /* retain valid trace rows */ }
      }
    }
  }
  return summarizeReductionTraceRows(rows);
}

function historyReports(historyRoot, fingerprint, currentJobsDir) {
  const reports = [];
  for (const entry of readdirSync(historyRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const jobsDir = resolve(historyRoot, entry.name);
    if (jobsDir === currentJobsDir) continue;
    const manifestPath = join(jobsDir, 'preset-run.json');
    const reportPath = join(jobsDir, 'report.json');
    if (!existsSync(manifestPath) || !existsSync(reportPath)) continue;
    try {
      const manifest = readJson(manifestPath);
      const report = readJson(reportPath);
      if (manifest.fingerprint === fingerprint && report?.preset?.fingerprint === fingerprint) {
        reports.push(report);
      }
    } catch {
      // Ignore incomplete historical reports.
    }
  }
  const registry = tryReadJson(join(historyRoot, 'preset-history.json'));
  if (registry?.schemaVersion === 1 && Array.isArray(registry.runs)) {
    for (const entry of registry.runs) {
      if (entry?.fingerprint !== fingerprint) continue;
      const runDir = resolve(historyRoot, String(entry.runDir || ''));
      if (runDir === currentJobsDir || !existsSync(join(runDir, 'result.json'))) continue;
      const aggregate = tryReadJson(join(runDir, 'result.json'));
      const trials = collectTrials(runDir);
      const stats = aggregate?.stats ?? {};
      const total = finite(aggregate?.n_total_trials, trials.length);
      const completed = finite(stats.n_completed_trials, trials.filter((trial) => trial.settled).length);
      const passed = trials.filter((trial) => trial.passed).length;
      const tokens = tokenTotals(trials);
      reports.push({
        preset: { fingerprint },
        paths: { jobsDir: runDir, runDir },
        result: {
          passed,
          total,
          clean: total > 0
            && completed === total
            && finite(stats.n_errored_trials) === 0
            && finite(stats.n_retries) === 0
            && finite(stats.n_cancelled_trials) === 0,
        },
        timing: {
          finishedAt: aggregate?.finished_at ?? null,
          wallSeconds: seconds(aggregate?.started_at, aggregate?.finished_at),
          agentTotalSeconds: sum(trials, (trial) => trial.agentSeconds),
        },
        tokens: {
          input: finite(stats.n_input_tokens, tokens.input),
          cached: finite(stats.n_cache_tokens, tokens.cached),
          output: finite(stats.n_output_tokens, tokens.output),
        },
        tasks: trials,
      });
    }
  }
  return reports;
}

function buildBottlenecks(current, previous) {
  if (!previous) return null;
  const priorTasks = new Map((previous.tasks ?? []).map((task) => [task.task, task]));
  const taskDeltas = current.tasks
    .map((task) => {
      const prior = priorTasks.get(task.task);
      if (!prior) return null;
      return {
        task: task.task,
        agentSeconds: finite(task.agentSeconds) - finite(prior.agentSeconds),
        apiSeconds: finite(task.timing?.apiSeconds) - finite(prior.timing?.apiSeconds),
        providerRequests: finite(task.activity?.providerRequests)
          - finite(prior.activity?.providerRequests),
        toolCalls: finite(task.activity?.toolCalls) - finite(prior.activity?.toolCalls),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.agentSeconds - a.agentSeconds);
  return {
    previousJobsDir: previous.paths.jobsDir,
    deltas: {
      agentSeconds: metricDelta(current, previous, ['timing', 'agentTotalSeconds']),
      wallSeconds: metricDelta(current, previous, ['timing', 'wallSeconds']),
      environmentSetupSeconds: sum(current.tasks, (task) => task.timing?.environmentSetupSeconds)
        - sum(previous.tasks ?? [], (task) => task.timing?.environmentSetupSeconds),
      agentSetupSeconds: sum(current.tasks, (task) => task.timing?.agentSetupSeconds)
        - sum(previous.tasks ?? [], (task) => task.timing?.agentSetupSeconds),
      apiSeconds: sum(current.tasks, (task) => task.timing?.apiSeconds)
        - sum(previous.tasks ?? [], (task) => task.timing?.apiSeconds),
    },
    slowestTask: taskDeltas[0] ?? null,
    taskRegressions: taskDeltas.slice(0, 3),
  };
}

function rankMetric(cohort, path) {
  const valueOf = (row) => path.reduce((value, key) => value?.[key], row);
  const values = cohort.map(valueOf).filter((value) => Number.isFinite(value) && value >= 0);
  const current = valueOf(cohort.at(-1));
  if (!Number.isFinite(current) || current < 0 || !values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return {
    rank: sorted.findIndex((value) => value >= current) + 1,
    count: sorted.length,
    best: sorted[0],
    median: median(sorted),
  };
}

function metricDelta(current, previous, path) {
  const valueOf = (row) => path.reduce((value, key) => value?.[key], row);
  const a = valueOf(current);
  const b = valueOf(previous);
  return Number.isFinite(a) && Number.isFinite(b) ? a - b : null;
}

function tokenTotals(rows) {
  return {
    input: sum(rows, (row) => row.tokens.input),
    cached: sum(rows, (row) => row.tokens.cached),
    cacheWrite: sum(rows, (row) => row.tokens.cacheWrite),
    output: sum(rows, (row) => row.tokens.output),
  };
}

function knownCost(rows) {
  const known = rows.filter((row) => Number.isFinite(row.costUsd));
  return {
    usd: known.length ? sum(known, (row) => row.costUsd) : null,
    trials: known.length,
  };
}

function buildPairComparison({ manifest, historyRoot, current, trials }) {
  const config = manifest?.comparison?.baseline;
  if (!config?.jobsDir) return null;
  const jobsDir = resolve(historyRoot, config.jobsDir);
  if (!existsSync(jobsDir)) return { error: `Pinned baseline not found: ${jobsDir}` };
  const runDir = findRunDir(jobsDir);
  const aggregate = tryReadJson(join(runDir, 'result.json'));
  const baselineTrials = collectTrials(runDir, loadCostDetails(config, historyRoot));
  const byTask = new Map(baselineTrials.map((trial) => [trial.task, trial]));
  const pairs = trials
    .filter((trial) => trial.settled && byTask.has(trial.task))
    .map((ours) => {
      const baseline = byTask.get(ours.task);
      const outcome = ours.passed
        ? (baseline.passed ? 'both-pass' : 'ours-only')
        : (baseline.passed ? 'baseline-only' : 'both-fail');
      return {
        task: ours.task,
        outcome,
        ours: {
          passed: ours.passed,
          agentSeconds: ours.agentSeconds,
          tokens: ours.tokens,
          costUsd: ours.costUsd,
        },
        baseline: {
          passed: baseline.passed,
          agentSeconds: baseline.agentSeconds,
          tokens: baseline.tokens,
          costUsd: baseline.costUsd,
        },
      };
    });
  const oursRows = pairs.map((pair) => ({ ...pair.ours, task: pair.task }));
  const baselineRows = pairs.map((pair) => ({ ...pair.baseline, task: pair.task }));
  const oursCost = knownCost(oursRows);
  const baselineCost = knownCost(baselineRows);
  const oursAgent = sum(oursRows, (row) => row.agentSeconds);
  const baselineAgent = sum(baselineRows, (row) => row.agentSeconds);
  const complete = current.result.total > 0 && current.result.completed === current.result.total;
  const baselineStats = aggregate?.stats ?? {};
  const baselinePassed = baselineTrials.filter((trial) => trial.passed).length;
  const currentContext = median(trials.map((trial) => trial.finalContextTokens));
  const baselineContext = optionalNumber(config.finalContextMedianTokens);
  return {
    name: manifest.comparison.name,
    label: config.label ?? manifest.comparison.name,
    jobsDir,
    runDir,
    provisional: !complete,
    sharedTasks: pairs.length,
    outcomes: {
      oursOnly: pairs.filter((pair) => pair.outcome === 'ours-only').length,
      baselineOnly: pairs.filter((pair) => pair.outcome === 'baseline-only').length,
      bothPass: pairs.filter((pair) => pair.outcome === 'both-pass').length,
      bothFail: pairs.filter((pair) => pair.outcome === 'both-fail').length,
    },
    ours: {
      passed: oursRows.filter((row) => row.passed).length,
      total: pairs.length,
      agentTotalSeconds: oursAgent,
      tokens: tokenTotals(oursRows),
      cost: oursCost,
      finalContextMedianTokens: currentContext,
    },
    baseline: {
      passed: baselineRows.filter((row) => row.passed).length,
      total: pairs.length,
      fullPassed: baselinePassed,
      fullTotal: finite(aggregate?.n_total_trials, baselineTrials.length),
      errors: finite(baselineStats.n_errored_trials),
      retries: finite(baselineStats.n_retries),
      agentTotalSeconds: baselineAgent,
      tokens: tokenTotals(baselineRows),
      cost: baselineCost,
      fullCostUsd: config.costDetails
        ? knownCost(baselineTrials).usd
        : optionalNumber(baselineStats.cost_usd),
      costLowerBound: config.costLowerBound === true,
      finalContextMedianTokens: baselineContext,
    },
    ratios: {
      speedup: oursAgent > 0 ? baselineAgent / oursAgent : null,
      cost: oursCost.usd > 0 && baselineCost.usd != null ? oursCost.usd / baselineCost.usd : null,
      inputTokens: tokenTotals(baselineRows).input > 0
        ? tokenTotals(oursRows).input / tokenTotals(baselineRows).input
        : null,
      finalContextReduction: complete && currentContext != null && baselineContext > 0
        ? 1 - currentContext / baselineContext
        : null,
    },
    tasks: pairs,
  };
}

export function generateRunReport({ jobsDir, historyRoot }) {
  const absoluteJobsDir = resolve(jobsDir);
  const manifest = readJson(join(absoluteJobsDir, 'preset-run.json'));
  if (manifest.schemaVersion !== 1) {
    throw new Error(`Unsupported preset-run schemaVersion: ${manifest.schemaVersion}`);
  }
  const runDir = findRunDir(absoluteJobsDir);
  const aggregate = tryReadJson(join(runDir, 'result.json'));
  const trials = collectTrials(runDir);
  const stats = aggregate?.stats ?? {};
  const configuredTasks = manifest?.definition?.tasks ?? [];
  const total = finite(aggregate?.n_total_trials, configuredTasks.length || trials.length);
  const completed = finite(stats.n_completed_trials, trials.filter((trial) => trial.settled).length);
  const passed = trials.filter((trial) => trial.passed).length;
  const errors = finite(stats.n_errored_trials, trials.filter((trial) => trial.error).length);
  const retries = finite(stats.n_retries);
  const cancelled = finite(stats.n_cancelled_trials);
  const pending = finite(stats.n_pending_trials);
  const running = finite(stats.n_running_trials);
  const clean = total > 0
    && completed === total
    && errors === 0
    && retries === 0
    && cancelled === 0
    && pending === 0
    && running === 0;
  const tokenFallback = tokenTotals(trials);
  const startedAt = aggregate?.started_at
    ?? trials.map((trial) => trial.startedAt).filter(Boolean).sort().at(0)
    ?? manifest.startedAt;
  const finishedAt = aggregate?.finished_at
    ?? (completed === total ? trials.map((trial) => trial.finishedAt).filter(Boolean).sort().at(-1) : null)
    ?? manifest.completedAt
    ?? null;
  const lead = manifest?.definition?.routes?.lead ?? {};
  const current = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    preset: {
      name: manifest.preset,
      fingerprint: manifest.fingerprint,
      // Rules and tool-schema digests: the fingerprint covers routes only, so
      // this is what tells two runs of one preset apart.
      contract: manifest.contract ?? null,
      suite: manifest?.definition?.suite ?? null,
      routeProfile: manifest?.definition?.routeProfile ?? null,
      provider: lead.provider ?? null,
      model: lead.model ?? null,
      effort: lead.effort ?? null,
      concurrent: finite(manifest?.definition?.concurrent),
      attempts: finite(manifest?.definition?.attempts),
    },
    paths: {
      jobsDir: absoluteJobsDir,
      runDir: resolve(runDir),
    },
    result: {
      passed,
      total,
      completed,
      errors,
      retries,
      cancelled,
      pending,
      running,
      clean,
      benchmarkExitCode: optionalNumber(manifest.exitCode),
    },
    timing: {
      startedAt,
      finishedAt,
      wallSeconds: seconds(startedAt, finishedAt ?? new Date().toISOString()),
      agentTotalSeconds: sum(trials, (trial) => trial.agentSeconds),
      environmentSetupTotalSeconds: sum(trials, (trial) => trial.timing?.environmentSetupSeconds),
      agentSetupTotalSeconds: sum(trials, (trial) => trial.timing?.agentSetupSeconds),
      verifierTotalSeconds: sum(trials, (trial) => trial.timing?.verifierSeconds),
      teardownTotalSeconds: sum(trials, (trial) => trial.timing?.teardownSeconds),
      apiTotalSeconds: sum(trials, (trial) => trial.timing?.apiSeconds),
    },
    activity: {
      providerRequests: sum(trials, (trial) => trial.activity?.providerRequests),
      toolCalls: sum(trials, (trial) => trial.activity?.toolCalls),
    },
    tokens: {
      input: clean ? finite(stats.n_input_tokens, tokenFallback.input) : tokenFallback.input,
      cached: clean ? finite(stats.n_cache_tokens, tokenFallback.cached) : tokenFallback.cached,
      cacheWrite: tokenFallback.cacheWrite,
      output: clean ? finite(stats.n_output_tokens, tokenFallback.output) : tokenFallback.output,
    },
    cost: knownCost(trials),
    finalContext: {
      medianTokens: median(trials.map((trial) => trial.finalContextTokens)),
      trials: trials.filter((trial) => Number.isFinite(trial.finalContextTokens)).length,
    },
    reduction: reductionRows(runDir),
    tasks: trials,
    comparison: {
      eligible: false,
      cohortSize: 0,
      ranks: {},
      previous: null,
    },
    bottlenecks: null,
    pair: null,
  };

  const historical = historyReports(resolve(historyRoot), manifest.fingerprint, absoluteJobsDir);
  const priorClean = historical
    .filter((report) => report?.result?.clean && report.result.total === total)
    .sort((a, b) => String(a?.timing?.finishedAt).localeCompare(String(b?.timing?.finishedAt)));
  const comparable = priorClean.filter((report) => report.result.passed === passed);
  if (clean) {
    const cohort = [...comparable, current];
    current.comparison = {
      eligible: true,
      cohortSize: cohort.length,
      ranks: {
        agentTotalSeconds: rankMetric(cohort, ['timing', 'agentTotalSeconds']),
        wallSeconds: rankMetric(cohort, ['timing', 'wallSeconds']),
        inputTokens: rankMetric(cohort, ['tokens', 'input']),
        outputTokens: rankMetric(cohort, ['tokens', 'output']),
      },
      previous: null,
    };
  } else {
    current.comparison.provisional = true;
    current.comparison.cohortSize = priorClean.length;
  }
  const previous = clean ? comparable.at(-1) : priorClean.at(-1);
  if (previous) {
    current.comparison.previous = {
      provisional: !clean,
      jobsDir: previous.paths.jobsDir,
      finishedAt: previous.timing.finishedAt,
      deltas: {
        agentTotalSeconds: metricDelta(current, previous, ['timing', 'agentTotalSeconds']),
        wallSeconds: metricDelta(current, previous, ['timing', 'wallSeconds']),
        inputTokens: metricDelta(current, previous, ['tokens', 'input']),
        outputTokens: metricDelta(current, previous, ['tokens', 'output']),
      },
    };
    current.bottlenecks = buildBottlenecks(current, previous);
  }
  current.pair = buildPairComparison({
    manifest,
    historyRoot: resolve(historyRoot),
    current,
    trials,
  });
  return current;
}

const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
const rankText = (rank) => rank ? `${rank.rank}/${rank.count}` : 'n/a';
const percent = (value) => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : 'n/a';

export function formatRunReport(report) {
  const previous = report.comparison.previous;
  const lines = [
    `# Terminal-Bench preset report: ${report.preset.name}`,
    '',
    `- Score: **${report.result.passed}/${report.result.total}** (${report.result.completed} completed)`,
    `- Clean: **${report.result.clean}** (errors ${report.result.errors}, retries ${report.result.retries})`,
    `- Agent total: **${number(report.timing.agentTotalSeconds)}s** — rank ${rankText(report.comparison.ranks.agentTotalSeconds)}`,
    `- Wall: **${number(report.timing.wallSeconds)}s** — rank ${rankText(report.comparison.ranks.wallSeconds)}`,
    `- Tokens: input ${report.tokens.input}, cached ${report.tokens.cached}, output ${report.tokens.output}`,
    `- Cost: $${number(report.cost.usd, 2)} (${report.cost.trials} trials)`,
    `- Final context median: ${number(report.finalContext.medianTokens, 0)} tokens (${report.finalContext.trials} trials)`,
    `- Reduction: ${report.reduction.totalSavedBytes} bytes saved, ${report.reduction.activity.artifactReads} artifact reads`,
  ];
  const contract = report.preset.contract;
  if (contract) {
    const short = (hash) => String(hash || '').replace(/^sha256:/, '').slice(0, 12) || 'n/a';
    lines.push(`- Contract: rules ${short(contract.rulesHash)} (${contract.rulesFiles} files), tools ${short(contract.toolCatalogHash)} (${contract.toolCount} tools, ${contract.toolSchemaBytes} B)`);
  }
  if (previous) {
    lines.push(`- Previous delta: agent ${number(previous.deltas.agentTotalSeconds)}s, wall ${number(previous.deltas.wallSeconds)}s, input ${previous.deltas.inputTokens}, output ${previous.deltas.outputTokens}`);
  }
  if (report.bottlenecks?.slowestTask) {
    const slow = report.bottlenecks.slowestTask;
    lines.push(`- Largest regression: ${slow.task} agent ${number(slow.agentSeconds)}s, API ${number(slow.apiSeconds)}s, requests ${slow.providerRequests >= 0 ? '+' : ''}${slow.providerRequests}`);
  }
  if (report.pair && !report.pair.error) {
    const pair = report.pair;
    lines.push(
      '',
      `## Pair: ${pair.label}${pair.provisional ? ' (provisional)' : ''}`,
      '',
      `- Shared tasks: **${pair.sharedTasks}**`,
      `- Score: **${pair.ours.passed}/${pair.ours.total} vs ${pair.baseline.passed}/${pair.baseline.total}**`,
      `- Outcomes: ours-only ${pair.outcomes.oursOnly}, baseline-only ${pair.outcomes.baselineOnly}, both-pass ${pair.outcomes.bothPass}, both-fail ${pair.outcomes.bothFail}`,
      `- Agent speedup: **${number(pair.ratios.speedup, 2)}x**`,
      `- Cost ratio (ours/baseline): **${number(pair.ratios.cost, 2)}x**`,
      `- Input-token ratio (ours/baseline): **${number(pair.ratios.inputTokens, 2)}x**`,
      `- Final-context reduction: **${percent(pair.ratios.finalContextReduction)}**`,
    );
  }
  const diagnostics = report.tasks.filter((task) => task.error || task.trace?.failures?.length);
  if (diagnostics.length) {
    lines.push('', '## Diagnostics', '');
    for (const task of diagnostics) {
      const errorType = inline(task.error?.exception_type);
      const errorMessage = inline(task.error?.exception_message);
      lines.push(`- **${task.task}**: ${errorType || `${task.trace.failures.length} tool failure(s)`}${errorMessage ? ` — ${errorMessage}` : ''}`);
      if (!task.trace) continue;
      const counts = Object.entries(task.trace.toolCounts)
        .map(([name, count]) => `${name} ${count}`)
        .join(', ');
      lines.push(`  - Trace: ${task.trace.providerRequests} requests, ${task.trace.toolCalls} tools${counts ? ` (${counts})` : ''}`);
      if (task.trace.failures.length) {
        lines.push(`  - Tool failures: ${task.trace.failures.map((failure) => `${failure.tool}/${failure.errorCategory || failure.resultKind || 'error'}`).join(', ')}`);
      }
      if (task.trace.lastCalls.length) {
        lines.push(`  - Last calls: ${task.trace.lastCalls.map((call) => `${call.tool} ${call.argsSummary}`).join(' → ')}`);
      }
    }
  }
  lines.push('', '| Task | Pass | Agent seconds |', '|---|---:|---:|');
  for (const task of report.tasks) {
    lines.push(`| ${task.task} | ${task.passed ? 'yes' : 'no'} | ${number(task.agentSeconds)} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function writeRunReport(report) {
  const jsonPath = join(report.paths.jobsDir, 'report.json');
  const markdownPath = join(report.paths.jobsDir, 'report.md');
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, formatRunReport(report));
  return { jsonPath, markdownPath };
}

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length;) {
    const key = argv[index];
    if (key === '--status') {
      args.status = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value == null) throw new Error(`Invalid argument: ${key ?? ''}`);
    args[key.slice(2)] = value;
    index += 2;
  }
  if (!args['jobs-dir']) {
    throw new Error('Usage: node analysis/run-report.mjs --jobs-dir <path> [--history-root <path>] [--status]');
  }
  return {
    jobsDir: args['jobs-dir'],
    historyRoot: args['history-root'] ?? resolve(args['jobs-dir'], '..'),
    status: args.status === true,
  };
}

function outputSummary(report, paths = null) {
  const agentRank = rankText(report.comparison.ranks.agentTotalSeconds);
  const wallRank = rankText(report.comparison.ranks.wallSeconds);
  let output = `result ${report.result.passed}/${report.result.total} completed=${report.result.completed} running=${report.result.running} pending=${report.result.pending} errors=${report.result.errors} retries=${report.result.retries}\n`
    + `time agent=${number(report.timing.agentTotalSeconds)}s rank=${agentRank} wall=${number(report.timing.wallSeconds)}s rank=${wallRank}\n`
    + `tokens input=${report.tokens.input} cached=${report.tokens.cached} output=${report.tokens.output}\n`
    + `reduction saved=${report.reduction.totalSavedBytes}B artifact_reads=${report.reduction.activity.artifactReads}\n`;
  for (const task of report.tasks.filter((row) => row.error || row.trace?.failures?.length)) {
    output += `diagnostic task=${task.task} error=${inline(task.error?.exception_type) || 'none'} requests=${task.trace?.providerRequests ?? 0} tools=${task.trace?.toolCalls ?? 0} tool_failures=${task.trace?.failures?.length ?? 0} last=${task.trace?.lastCalls?.at(-1)?.tool ?? 'none'}\n`;
  }
  if (report.bottlenecks?.slowestTask) {
    const slow = report.bottlenecks.slowestTask;
    output += `bottleneck task=${slow.task} agent_delta=${number(slow.agentSeconds)}s api_delta=${number(slow.apiSeconds)}s requests_delta=${slow.providerRequests}\n`;
  }
  if (report.pair?.error) {
    output += `pair error=${report.pair.error}\n`;
  } else if (report.pair) {
    output += `pair ${report.pair.ours.passed}/${report.pair.ours.total} vs ${report.pair.baseline.passed}/${report.pair.baseline.total} shared=${report.pair.sharedTasks} ours_only=${report.pair.outcomes.oursOnly} baseline_only=${report.pair.outcomes.baselineOnly} speedup=${number(report.pair.ratios.speedup, 2)}x provisional=${report.pair.provisional}\n`;
  }
  if (paths) output += `report ${paths.jsonPath}\n`;
  process.stdout.write(output);
}

function main(argv) {
  const options = parseArgs(argv);
  const report = generateRunReport(options);
  const paths = options.status ? null : writeRunReport(report);
  outputSummary(report, paths);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv);
  } catch (error) {
    process.stderr.write(`report failed: ${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}
