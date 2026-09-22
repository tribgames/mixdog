/**
 * memory-action-handlers/cycle-actions.mjs — the cycle-driven memory actions:
 * cycle1, cycle2/sleep, flush, rebuild and backfill. Cycle scheduler
 * primitives and the cycle2 LLM adapter are injected; the whole-action
 * backfill mutex lives here since it only guards this module's backfill path.
 */
import { runCycle2 } from '../memory-cycle.mjs';
import { throwIfAborted } from '../memory-cycle2-shared.mjs';
import { createBackfillAction } from './cycle-backfill-action.mjs';
import { createRebuildAction } from './cycle-rebuild-action.mjs';

// `_runCycle1Impl` reads `config?.min_batch ?? config?.cycle1?.min_batch ??
// default` — top-level wins, so overrides are pinned at top-level only.
const CYCLE1_NUMERIC_OVERRIDES = [
  ['min_batch', (args) => args?.min_batch],
  ['session_cap', (args) => args?.session_cap],
  ['batch_size', (args) => args?.batch_size],
  ['window_size', (args) => args?.window_size ?? args?.windowSize],
  [
    'rows_per_session',
    (args) => args?.rows_per_session ?? args?.rowsPerSession ?? args?.max_rows_per_session ?? args?.maxRowsPerSession,
  ],
];

function cycle1ConfigFromArgs(args, baseCycle1) {
  let cycle1Config = baseCycle1;
  for (const [key, pick] of CYCLE1_NUMERIC_OVERRIDES) {
    const value = Number(pick(args));
    if (Number.isFinite(value) && value > 0) cycle1Config = { ...cycle1Config, [key]: value };
  }
  const sessionIdOverride = String(args?.sessionId ?? args?.session_id ?? '').trim();
  if (sessionIdOverride) cycle1Config = { ...cycle1Config, session_id: sessionIdOverride };
  const concurrencyOverride = Number(args?.concurrency);
  if (Number.isFinite(concurrencyOverride) && concurrencyOverride > 0) {
    cycle1Config = { ...cycle1Config, concurrency: Math.min(8, Math.floor(concurrencyOverride)) };
  }
  return cycle1Config;
}

function countOf(list, fallback) {
  return Array.isArray(list) ? list.length : Number(fallback || 0);
}

function cycle1SummaryText(result) {
  const pendingStr = result?.pendingRows != null ? result.pendingRows : 0;
  const inFlightStr = result?.skippedInFlight === true ? 'true' : 'false';
  const timedOutPart = result?.timedOutWaiting === true ? ' timedOut=true' : '';
  const omitted = countOf(result?.omitted_row_ids, result?.quality?.omitted_rows);
  const prefiltered = countOf(result?.prefiltered_row_ids, result?.quality?.prefiltered_rows);
  const failedRows = countOf(result?.failed_row_ids, result?.quality?.failed_rows);
  const invalidChunks = countOf(result?.invalid_chunks, result?.quality?.invalid_chunks);
  return (
    `cycle1: chunks=${result.chunks} processed=${result.processed} skipped_chunks=${result.skipped}` +
    ` omitted=${omitted} prefiltered=${prefiltered} failed_rows=${failedRows} invalid_chunks=${invalidChunks}` +
    ` pending=${pendingStr} inFlight=${inFlightStr}${timedOutPart}`
  );
}

function cycle2SummaryResult(result) {
  const counts = {
    processed: result?.processed || 0,
    merged: result?.merged || 0,
    linked: result?.linked || 0,
    kept: result?.kept || 0,
    held: result?.held || 0,
    deferred: result?.deferred || 0,
  };
  const parts = Object.entries(counts)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${k}=${v}`);
  if (result?.ok === false)
    return { text: `cycle2 failed: ${result.error || 'unknown'} ${parts.join(' ')}`.trim(), isError: true };
  if (parts.length) return { text: `cycle2 ${parts.join(' ')}` };
  // No applied counts — distinguish an in-flight skip from an empty queue.
  let cause = '';
  if (result?.skippedInFlight) cause = ' (skipped: in-flight)';
  return { text: `cycle2 noop${cause}` };
}

export function createCycleActions({
  getDb,
  dataDir,
  awaitCycle1Run,
  startCycle1Run,
  finalizeCycle2Run,
  getSchedulerCycle1InFlight,
  getCycle2CallLlm,
  ingestTranscriptFile,
  cwdFromTranscriptPath,
}) {
  const withCycle2Llm = (options) =>
    typeof options.callLlm === 'function' ? options : { ...options, callLlm: getCycle2CallLlm() };

  async function cycle1(args, config, signal) {
    const cycle1Config = cycle1ConfigFromArgs(args, config?.cycle1 || {});
    const callerDeadlineMs = Number(args?._callerDeadlineMs) || 0;
    throwIfAborted(signal);
    const cycle1Options = callerDeadlineMs > 0 ? { callerDeadlineMs, signal } : { signal };
    if (typeof args?._callLlm === 'function') {
      cycle1Options.callLlm = args._callLlm;
    }
    const result = await awaitCycle1Run(cycle1Config, cycle1Options);
    throwIfAborted(signal);
    return { ...result, text: cycle1SummaryText(result) };
  }

  async function cycle2(args, config, signal) {
    const db = getDb();
    throwIfAborted(signal);
    const cycle2Config = { ...(config?.cycle2 || {}) };
    if (Number.isFinite(Number(args?.batch_size))) {
      cycle2Config.batch_size = Math.max(1, Math.floor(Number(args.batch_size)));
    }
    const result = await runCycle2(db, cycle2Config, withCycle2Llm({ signal }));
    throwIfAborted(signal);
    await finalizeCycle2Run(result);
    return cycle2SummaryResult(result);
  }

  async function flush(_args, config, signal) {
    const db = getDb();
    throwIfAborted(signal);
    const r1 = await awaitCycle1Run(config?.cycle1 || {}, { signal });
    throwIfAborted(signal);
    const r2 = await runCycle2(db, config?.cycle2 || {}, withCycle2Llm({ signal }));
    throwIfAborted(signal);
    await finalizeCycle2Run(r2);
    return {
      text: `flush: cycle1 chunks=${r1.chunks} processed=${r1.processed}, cycle2 ${JSON.stringify(r2)}`,
      isError: r2.ok === false,
    };
  }

  const rebuild = createRebuildAction({
    getDb,
    startCycle1Run,
    finalizeCycle2Run,
    getSchedulerCycle1InFlight,
    withCycle2Llm,
  });

  const backfill = createBackfillAction({
    getDb,
    dataDir,
    awaitCycle1Run,
    finalizeCycle2Run,
    withCycle2Llm,
    ingestTranscriptFile,
    cwdFromTranscriptPath,
  });

  return { cycle1, cycle2, flush, rebuild, backfill };
}
