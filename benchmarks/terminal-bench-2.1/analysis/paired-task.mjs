// Offline, content-free report for one paired task. See paired-task.md.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { traceToolResultBytesEstimate } from './reduction-metrics.mjs';

class InputError extends Error {}
const id = (value) => typeof value === 'string' && value.length > 0 && value.trim() === value;
const digest = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const sum = (values) => {
  const total = values.reduce((a, b) => a + b, 0);
  if (!count(total)) throw new InputError('Counter exceeds safe integer range');
  return total;
};
const usageFields = {
  reportedPromptTokens: 'prompt_tokens',
  reportedUncachedInputTokens: 'uncached_input_tokens',
  reportedCacheReadTokens: 'cached_tokens',
  reportedCacheWriteTokens: 'cache_write_tokens',
  reportedOutputTokens: 'output_tokens',
  reportedThinkingTokens: 'thinking_tokens',
};
const externalFields = {
  providerRequestWireBytes: 'observed_transport_wire',
  providerResponseWireBytes: 'observed_transport_wire',
  providerRequestSerializedBytes: 'observed_serialized_message',
  providerResponseSerializedBytes: 'observed_serialized_message',
  toolArgumentPayloadBytes: 'observed_tool_boundary_payload',
  toolResultPayloadBytes: 'observed_tool_boundary_payload',
  providerAttempts: 'observed_transport_attempts',
  providerRetryAttempts: 'observed_transport_retries',
  toolRetryAttempts: 'observed_tool_execution_retries',
};

function readArtifact(path) {
  try {
    const bytes = readFileSync(path);
    return {
      text: bytes.toString('utf8').replace(/^\uFEFF/, ''),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      problem: null,
    };
  } catch (error) {
    return { text: '', problem: error.code === 'ENOENT' ? 'missing' : 'unreadable' };
  }
}

function readJson(path) {
  const { text, sha256, problem } = readArtifact(path);
  if (problem) return { problem };
  try { return { value: JSON.parse(text), sha256 }; } catch { return { problem: 'malformed_json' }; }
}

function readRows(path) {
  const { text, sha256, problem } = readArtifact(path);
  const rows = [];
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) malformed++;
      else rows.push(row);
    } catch {
      malformed++;
    }
  }
  return { rows, sha256, problem: problem ?? (malformed ? 'malformed_rows' : null) };
}

function verifier({ value: result, problem }) {
  if (problem) return { outcome: 'unverified', reward: null, evidence: problem };
  const rewards = result?.verifier_result?.rewards;
  const reported = rewards?.reward ?? rewards?.accuracy;
  const reward = Number.isFinite(reported) ? reported : null;
  const finished = typeof result?.finished_at === 'string' && Number.isFinite(Date.parse(result.finished_at));
  if (!finished) return { outcome: 'unverified', reward, evidence: 'no_finished_verdict' };
  if ((rewards?.reward != null && rewards?.accuracy != null && rewards.reward !== rewards.accuracy)
    || (reward === 1 && result.exception_info != null)) {
    return { outcome: 'unverified', reward, evidence: 'conflicting_trial_outcome' };
  }
  if (result.exception_info != null) {
    const type = result.exception_info.exception_type;
    return typeof type === 'string' && type.trim()
      ? { outcome: 'trial_error', reward, evidence: 'harbor_result' }
      : { outcome: 'unverified', reward, evidence: 'malformed_exception_info' };
  }
  if (reward === null) return { outcome: 'unverified', reward, evidence: 'no_finished_verdict' };
  return { outcome: reward === 1 ? 'verified' : 'verifier_failed', reward, evidence: 'harbor_result' };
}

function measurement(basis, observedSubtotal, ...problems) {
  const unavailable = problems.filter(Boolean);
  return { basis, value: unavailable.length ? null : observedSubtotal, observedSubtotal, unavailable };
}

function measureRows(basis, values, ...problems) {
  const known = values.filter(count);
  return measurement(basis, known.length || (!values.length && !problems.some(Boolean)) ? sum(known) : null,
    ...problems, known.length !== values.length && 'missing_or_invalid_values');
}

const jsonBytes = (value) => value == null ? null : Buffer.byteLength(JSON.stringify(value), 'utf8');
const outputBytes = (value) => typeof value === 'string' ? Buffer.byteLength(value, 'utf8') : jsonBytes(value);
const metricFromCounter = (basis, counter) => {
  if (counter == null) return measurement(basis, null, 'counter_not_supplied');
  if (!count(counter.value) || typeof counter.complete !== 'boolean') {
    return measurement(basis, count(counter.value) ? counter.value : null, 'counter_invalid');
  }
  return measurement(basis, counter.value, !counter.complete && 'counter_partial');
};

// A join must cover both inputs exactly once. Equal row counts are not coverage.
function joined(left, right, leftKey, rightKey, compatible) {
  if (left.length !== right.length) return false;
  const unmatched = new Map();
  for (const row of left) {
    const key = leftKey(row);
    if (!id(key) || unmatched.has(key)) return false;
    unmatched.set(key, row);
  }
  for (const row of right) {
    const key = rightKey(row);
    if (!unmatched.has(key) || !compatible(unmatched.get(key), row)) return false;
    unmatched.delete(key);
  }
  return true;
}

function loadTrial(dir) {
  const result = readJson(join(dir, 'result.json'));
  return {
    result,
    trialId: result.value?.id,
    proof: readJson(join(dir, 'paired-trial-evidence.json')).value,
    exec: readRows(join(dir, 'agent', 'mixdog.txt')),
    trace: readRows(join(dir, 'agent', 'agent-trace.jsonl')),
  };
}

function trialBinding({ trialId, result, proof }, side, ledger, runtime) {
  if (!id(trialId)) return 'result_trial_id_missing';
  if (proof?.schemaVersion !== 1) return 'trial_provenance_missing';
  if (proof.trialId !== trialId || proof.runId !== ledger?.runId || !id(proof.runId)
    || !digest(result.sha256) || proof.artifacts?.result !== result.sha256) return 'result_provenance_mismatch';
  if (proof.taskDigest !== side.taskDigest || proof.controlsDigest !== side.controlsDigest
    || proof.runtimeDigest !== side.runtimeDigest || proof.runtime !== runtime) return 'executed_task_controls_or_runtime_mismatch';
  return null;
}

function measureTrial({ result, proof, exec, trace }, bindingProblem) {
  const verdict = verifier(result);
  const events = exec.rows.filter((row) => row.schema_version === 1 && typeof row.type === 'string');
  const order = new Map(events.map((row, index) => [row, index]));
  const before = (a, b) => order.get(a) < order.get(b);
  const threads = events.filter((row) => row.type === 'thread.started');
  const turns = events.filter((row) => row.type === 'turn.started');
  const turnEnds = events.filter((row) => ['turn.completed', 'turn.failed'].includes(row.type));
  const terminals = events.filter((row) => row.type === 'result');
  const [thread] = threads;
  const [turn] = turns;
  const [end] = turnEnds;
  const [terminal] = terminals;
  const sameSession = (row) => id(thread?.thread_id) && id(turn?.turn_id)
    && row?.thread_id === thread.thread_id && row.turn_id === turn.turn_id;
  const inTurn = (row) => before(turn, row) && before(row, end);
  const terminalMatches = end?.type === 'turn.completed'
    ? terminal?.subtype === 'success' && terminal.is_error === (terminal.termination_reason === 'refusal')
    : terminal?.subtype === 'error_during_execution' && terminal.is_error === true;
  const execProblem = (exec.problem && `exec_${exec.problem}`)
    || (proof?.artifacts?.exec !== exec.sha256 || !digest(exec.sha256) ? 'exec_artifact_unbound' : null)
    || (exec.rows.length !== events.length ? 'exec_unrecognized_events' : null)
    || (threads.length !== 1 || turns.length !== 1 || turnEnds.length !== 1 || terminals.length !== 1
      || events[0] !== thread || events[1] !== turn || events.at(-2) !== end || events.at(-1) !== terminal
      || events.slice(1).some((row) => !sameSession(row)) || terminal.session_id !== thread.thread_id
      || !terminalMatches ? 'exec_session_or_terminal_mismatch' : null);
  const traceProblem = (trace.problem && `trace_${trace.problem}`)
    || (proof?.artifacts?.trace !== trace.sha256 || !digest(trace.sha256) ? 'trace_artifact_unbound' : null);
  const starts = events.filter((row) => row.type === 'model.request.started');
  const completions = events.filter((row) => row.type === 'model.request.completed');
  const failures = events.filter((row) => row.type === 'model.request.failed');
  const roundId = (row) => row.request_id;
  const roundProblem = execProblem || ((terminal.provider_requests !== starts.length
    || (end.provider_requests != null && end.provider_requests !== starts.length)) && 'round_count_mismatch')
    || (starts.some((row, index) => row.request_index !== index + 1)
      || !joined(starts, [...completions, ...failures], roundId, roundId,
        (start, close) => inTurn(start) && inTurn(close) && before(start, close)
          && start.request_index === close.request_index
          && (start.request_index === starts.length || before(close, starts[start.request_index])))
      ? 'round_lifecycle_linkage_unconfirmed' : null);
  const toolRows = (type) => events.filter((row) => row.type === type && row.item?.type === 'tool_call');
  const tools = toolRows('item.started');
  const toolEnds = toolRows('item.completed');
  const toolId = (row) => row.item.id;
  const hasResult = (row) => row.item.timing != null && ['completed', 'failed', 'skipped'].includes(row.item.status);
  const toolResults = toolEnds.filter(hasResult);
  const toolProblem = execProblem || ((terminal.tool_calls !== tools.length
    || (end.tool_calls != null && end.tool_calls !== tools.length)) && 'tool_count_mismatch')
    || (!joined(tools, toolEnds, toolId, toolId,
      (start, close) => inTurn(start) && inTurn(close) && before(start, close) && start.item.status === 'in_progress'
        && (hasResult(close) || (close.item.timing == null
          && close.item.status === (end.type === 'turn.failed' ? 'failed' : 'incomplete'))))
      ? 'tool_lifecycle_linkage_unconfirmed' : null);
  const resultProblem = toolProblem || (toolResults.length !== tools.length && 'missing_tool_results');
  const usage = trace.rows.filter((row) => row.kind === 'usage_raw');
  const loop = trace.rows.filter((row) => row.kind === 'loop');
  const traceTools = trace.rows.filter((row) => row.kind === 'tool');
  const sameTraceSession = (row) => id(proof?.traceSessionId) && row.session_id === proof.traceSessionId
    && sameSession(row.exec_link);
  const toolTraceProblem = traceProblem || resultProblem
    || (!joined(toolResults, traceTools, toolId, (row) => row.exec_link?.tool_call_id,
      (_, row) => sameTraceSession(row)) && 'tool_trace_linkage_unconfirmed');
  // Only the capture can connect the trace's session/round to the CLI round.
  // Usage from failed sends, side requests, or rows without that join stays partial.
  const usageProblem = traceProblem || roundProblem
    || (completions.length !== starts.length || !joined(completions, usage, roundId, (row) => row.exec_link?.request_id,
      (close, row) => sameTraceSession(row) && count(close.usage?.output_tokens)
        && close.usage.output_tokens === row.output_tokens)
      ? 'logical_round_usage_linkage_unconfirmed' : null);
  const seen = (n, problem) => n || !problem ? n : null;
  const metrics = {
    logicalModelRounds: measurement('exec_model_request_started', seen(starts.length, roundProblem), roundProblem),
    failedLogicalRoundEvents: measurement('exec_model_request_failed', seen(failures.length, roundProblem), roundProblem),
    toolCalls: measurement('exec_item_started_tool_call', seen(tools.length, toolProblem), toolProblem),
    failedToolResults: measurement('exec_failed_tool_result',
      seen(toolResults.filter((row) => row.item.status === 'failed').length, resultProblem), resultProblem),
    toolArgumentJsonEstimateBytes: measureRows('exec_parsed_arguments_utf8_json_estimate',
      tools.map((row) => jsonBytes(row.item.arguments)), toolProblem),
    toolResultTextEstimateBytes: measureRows('exec_output_utf8_text_or_json_estimate',
      toolResults.map((row) => outputBytes(row.item.output)), resultProblem),
    tracedToolResultEstimateBytes: measureRows('trace_result_bytes_est_text_only',
      traceTools.map((row) => ['cache-hit', 'scoped-cache-hit'].includes(row.result_kind)
        || traceToolResultBytesEstimate(row) === 0 ? null : traceToolResultBytesEstimate(row)),
      toolTraceProblem),
    providerRequestLoopEstimateBytes: measureRows('trace_body_bytes_est_pre_adapter',
      loop.map((row) => row.body_bytes_est), traceProblem, 'loop_rows_do_not_cover_transport_attempts'),
    usageRows: measurement('trace_usage_raw_rows', seen(usage.length, usageProblem), usageProblem),
  };
  for (const [key, field] of Object.entries(usageFields)) {
    metrics[key] = measureRows(`trace_usage_raw_${field}`, usage.map((row) => row[field]), usageProblem, !usage.length && 'no_usage_observations');
  }
  for (const [key, basis] of Object.entries(externalFields)) {
    metrics[key] = metricFromCounter(basis, proof?.counters?.[key]);
  }
  return { verdict: { ...verdict, bindingProblem }, metrics };
}

function runSide(side, { ledger, loaded }, uses, runtime) {
  const trials = loaded.map((trial) => measureTrial(trial,
    trialBinding(trial, side, ledger, runtime) || (uses.get(trial.trialId) > 1 && 'trial_id_reused')));
  const ledgerIds = ledger?.trialIds;
  const historyProblem = ledger?.schemaVersion !== 1 || ledger.state !== 'closed' || !id(ledger.runId)
    || !Array.isArray(ledgerIds) || !ledgerIds.every(id) || new Set(ledgerIds).size !== ledgerIds.length
    ? 'closed_trial_ledger_missing_or_invalid'
    : ledgerIds.length !== loaded.length || loaded.some(({ trialId }, index) => trialId !== ledgerIds[index])
      ? 'trial_history_mismatch' : null;
  const bindingProblems = [...new Set(trials.map(({ verdict }) => verdict.bindingProblem).filter(Boolean))];
  const earlier = trials.slice(0, -1);
  const final = trials.at(-1).verdict.outcome;
  const outcomeProblems = [historyProblem, ...bindingProblems,
    earlier.some(({ verdict }) => verdict.outcome === 'verified') && 'attempt_after_verified_completion',
    earlier.some(({ verdict }) => verdict.outcome === 'unverified') && 'earlier_verdict_unknown',
    final === 'unverified' && 'final_verdict_unknown'].filter(Boolean);
  const metrics = {};
  for (const key of Object.keys(trials[0].metrics)) {
    const samples = trials.map((trial) => trial.metrics[key]);
    const observed = samples.map((sample) => sample.observedSubtotal).filter(count);
    metrics[key] = measurement(samples[0].basis, observed.length ? sum(observed) : null,
      ...new Set([...samples.flatMap((sample) => sample.unavailable), ...outcomeProblems]));
  }
  for (const [key, original] of [['additionalLogicalModelRounds', 'logicalModelRounds'], ['additionalProviderAttempts', 'providerAttempts']]) {
    const metric = metrics[original];
    const observed = metric.observedSubtotal;
    metrics[key] = measurement(`${metric.basis}_past_first`, observed === null ? null : Math.max(0, observed - 1), ...metric.unavailable);
  }
  metrics.harborTrialRetries = measurement('reconciled_trial_attempts_past_first', trials.length - 1,
    ...outcomeProblems);
  return {
    outcome: outcomeProblems.length ? 'unverified' : final,
    outcomeUnavailable: outcomeProblems,
    attempts: trials.map((trial) => trial.verdict),
    metrics,
  };
}

export function comparePairedTask(manifest, root) {
  const { baseline, current } = manifest ?? {};
  if (manifest?.schemaVersion !== 2 || [baseline, current].some((side) =>
    !side || !digest(side.taskDigest) || !digest(side.controlsDigest) || !digest(side.runtimeDigest)
    || (side.ledger != null && !id(side.ledger)) || !Array.isArray(side.attempts) || !side.attempts.length
    || side.attempts.some((attempt) => !id(attempt?.dir)))) {
    throw new InputError('Invalid paired-task manifest');
  }
  const [prior, next] = [baseline, current].map((side) => ({
    ledger: side.ledger ? readJson(resolve(root, side.ledger)).value : null,
    loaded: side.attempts.map(({ dir }) => loadTrial(resolve(root, dir))),
  }));
  const uses = new Map();
  for (const { trialId } of [...prior.loaded, ...next.loaded]) {
    if (id(trialId)) uses.set(trialId, (uses.get(trialId) ?? 0) + 1);
  }
  const before = runSide(baseline, prior, uses, 'v1.4.5');
  const after = runSide(current, next, uses, 'working-tree');
  const pairUnavailable = [
    baseline.taskDigest !== current.taskDigest && 'task_differs',
    baseline.controlsDigest !== current.controlsDigest && 'controls_differ',
    baseline.runtimeDigest === current.runtimeDigest && 'runtime_digests_match',
    id(prior.ledger?.runId) && prior.ledger.runId === next.ledger?.runId && 'run_id_reused',
    before.outcome !== 'verified' && 'baseline_first_verified_completion_unconfirmed',
    after.outcome !== 'verified' && 'current_first_verified_completion_unconfirmed',
  ].filter(Boolean);
  const verifiedPair = pairUnavailable.length === 0;
  const deltas = {};
  for (const [key, { value: prior }] of Object.entries(before.metrics)) {
    const { value: next } = after.metrics[key];
    deltas[key] = verifiedPair && prior !== null && next !== null ? next - prior : null;
  }
  return {
    schemaVersion: 2, verifiedPair, pairUnavailable,
    baseline: { runtime: 'v1.4.5', ...before },
    current: { runtime: 'working-tree', ...after },
    currentMinusBaseline: deltas,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new InputError('Usage: node analysis/paired-task.mjs <pair-manifest.json>');
    const path = resolve(process.argv[2]);
    const { value, problem } = readJson(path);
    if (problem) throw new InputError('Pair manifest unavailable or malformed');
    console.log(JSON.stringify(comparePairedTask(value, dirname(path)), null, 2));
  } catch (error) {
    // Do not let input content, host paths, or stack frames into the report.
    console.error(error instanceof InputError ? error.message : 'Invalid paired-task input');
    process.exitCode = 1;
  }
}
