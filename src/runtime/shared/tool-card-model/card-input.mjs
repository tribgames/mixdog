/**
 * card-input.mjs — normalize the raw tool item fields into the counts,
 * progress flags, elapsed label and row budgets every card model shares.
 */
import { formatElapsed } from '../time-format.mjs';
import { clipPlain, MIN_RESULT_LINE_CHARS, RESULT_LINE_HARD_MAX } from './inline-text.mjs';
import { clampFailureCount } from './terminal-status.mjs';

const trimTrailing = (value) => (value == null ? null : String(value).replace(/\s+$/, ''));

export function readCardInput(input = {}, options = {}) {
  const {
    name = '',
    args = {},
    result = null,
    rawResult = null,
    isError = false,
    errorCount,
    callErrorCount,
    exitErrorCount,
    count = 1,
    completedCount,
    startedAt = 0,
    completedAt = 0,
    aggregate = false,
    categories = {},
    doneCategories = null,
    headerFinalized = true,
  } = input;
  const nowMs = Number(input.nowMs || Date.now());
  const truncate = typeof options.truncate === 'function' ? options.truncate : clipPlain;
  const maxResultChars = Math.max(
    MIN_RESULT_LINE_CHARS,
    Math.min(RESULT_LINE_HARD_MAX, Number(options.maxResultChars ?? RESULT_LINE_HARD_MAX))
  );

  const groupCount = Math.max(1, Number(count || 1));
  const doneCount = Math.max(0, Math.min(groupCount, Number(completedCount ?? (result == null ? 0 : groupCount))));
  const rt = trimTrailing(result);
  const rawRt = trimTrailing(rawResult);
  const pending = doneCount < groupCount;
  const startedAtMs = Number(startedAt || 0);
  const completedAtMs = Number(completedAt || 0);
  const endMs = pending ? nowMs : completedAtMs || nowMs;
  const elapsedMs = startedAtMs ? Math.max(0, endMs - startedAtMs) : 0;

  return {
    name,
    args,
    isError,
    aggregate,
    categories,
    doneCategories,
    truncate,
    maxResultChars,
    groupCount,
    doneCount,
    rt,
    pending,
    headerPending: pending || headerFinalized === false,
    hasResult: result != null && Boolean(String(rt || '').trim()),
    hasRawResult: rawResult != null && Boolean(String(rawRt || '').trim()),
    elapsed: elapsedMs >= 1000 ? formatElapsed(elapsedMs) : '',
    failedCount: clampFailureCount(errorCount, groupCount, isError),
    callFailedCount: clampFailureCount(callErrorCount, groupCount, false),
    exitFailedCount: clampFailureCount(exitErrorCount, groupCount, false),
  };
}

/** The fields every card model (aggregate or single tool) reports. */
export function commonCardFields(base, terminalStatus) {
  return {
    pending: base.pending,
    headerPending: base.headerPending,
    groupCount: base.groupCount,
    doneCount: base.doneCount,
    elapsed: base.elapsed,
    failedCount: base.failedCount,
    callFailedCount: base.callFailedCount,
    exitFailedCount: base.exitFailedCount,
    terminalStatus,
    hasResult: base.hasResult,
    hasRawResult: base.hasRawResult,
  };
}
