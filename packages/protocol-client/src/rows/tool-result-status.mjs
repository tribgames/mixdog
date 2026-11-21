import { hasBenignExitOutcome, normalizeToolTerminalStatus, toolResultTerminalStatus } from './tool-status.mjs';
import { isReadOnlyNavigationMiss } from './result-classification.mjs';
import { STEP, formatAggregateDetailSteps, runSync, toolLoadingTargets } from './tool-surface.mjs';
import { normalizeToolName } from './tool-primitives.mjs';
import { gitResultError, gitResultExitCode } from './tool-card-model/git-result.mjs';
import { stripShellExitHeader, toolErrorDisplay } from './tool-result-text.mjs';

// Result formats: bare `[exit code: N]`; legacy `Error: [shell-run-failed] [exit code: N]`; persistent shells prefix `[session: …]`.
export function shellCommandExitCode(text) {
  const body = String(text || '');
  const lines = body.split('\n');
  if (/^\[tool output offloaded:\s*shell\b/i.test(String(lines[0] || '').trim())) {
    lines.shift();
    while (lines.length > 0 && !String(lines[0] || '').trim()) lines.shift();
  }
  const header = lines.slice(0, 6).join('\n');
  // Timeout / signal / abort are NOT a plain command exit — keep them "Failed".
  if (/\[timeout:|\[signal:|timed out|aborted|interrupted/i.test(header)) return null;
  const m = header.match(
    /^\s*(?:\[session:[^\n]*\]\s*\n)?(?:Error:\s*)?(?:\[shell-run-failed\]\s*)?\[exit code:\s*(\d+)\]/i
  );
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isFinite(code) ? code : null;
}

// Adapters label non-zero process exits as tool errors, so a recognized shell exit outranks the envelope error flag.
export function toolCallOutcome(message, rawText) {
  if (normalizeToolName(message?.toolName || message?.name) === 'git') {
    const exitCode = gitResultExitCode(rawText);
    if (exitCode !== null) return { isCallError: false, isExitError: !hasBenignExitOutcome(rawText), exitCode };
    if (gitResultError(rawText)) return { isCallError: true, isExitError: false, exitCode: null };
  }
  const exitCode = shellCommandExitCode(rawText);
  if (exitCode != null) {
    // Every completed shell result carries `[exit code: N]` — including 0.
    // A non-zero code is a command failure unless execution marked a known
    // successful no-match/no-change outcome.
    const benignExit = exitCode !== 0 && hasBenignExitOutcome(rawText);
    return { isCallError: false, isExitError: exitCode !== 0 && !benignExit, exitCode };
  }
  if (isReadOnlyNavigationMiss(message?.toolName || message?.name, rawText)) {
    return { isCallError: false, isExitError: false, exitCode };
  }
  const isCallError = message?.isError === true || message?.toolKind === 'error';
  return {
    isCallError,
    isExitError: false,
    exitCode,
  };
}

export function failureDetailText({ succeeded = 0, realErrors = 0, exitErrors = 0, exitCode } = {}) {
  const parts = [];
  if (succeeded > 0) parts.push(`${succeeded} Ok`);
  if (realErrors > 0) parts.push(`${realErrors} Failed`);
  if (exitErrors > 0) {
    const solo = exitErrors === 1 && realErrors === 0 && succeeded === 0;
    parts.push(solo && Number.isFinite(exitCode) ? `Exited ${exitCode}` : `${exitErrors} Exited non-zero`);
  }
  return parts.join(' · ');
}

const CANCELLED_RESULT_STATUS_LINE = '[status: cancelled]';

function itemHasKnownTerminalStatus(item, texts = []) {
  const settled = (token) => token === 'completed' || token === 'failed' || token === 'cancelled';
  if (settled(normalizeToolTerminalStatus(item?.args?.status))) return true;
  for (const text of texts) {
    if (settled(toolResultTerminalStatus(text))) return true;
  }
  return false;
}

export function withCancelledResultMarker(text, item) {
  const body = String(text || '');
  const sources = [item?.result, item?.text, body];
  if (itemHasKnownTerminalStatus(item, sources)) return body;
  if (!body.trim()) return `${CANCELLED_RESULT_STATUS_LINE}\n`;
  return `${CANCELLED_RESULT_STATUS_LINE}\n${body}`;
}

/** Built by `+`, never `join`: a V8 rope points at the member strings already held, while a joined string
 *  gave every aggregate a flat copy (~1 MB per idle session in a 30-session measurement). */
export function aggregateRawResult(calls) {
  return runSync(aggregateRawResultSteps(calls));
}

/** `aggregateRawResult`, yielding every `STEP` calls. */
export function* aggregateRawResultSteps(calls) {
  let joined = '';
  let index = 0;
  let seen = 0;
  for (const rec of calls || []) {
    if (++seen % STEP === 0) yield;
    if (rec?.resolved !== true) continue;
    const text = String(rec?.rawResultText ?? rec?.resultText ?? '').replace(/\s+$/, '');
    if (!text.trim()) continue;
    const label = String(rec?.name || rec?.category || 'tool').trim() || 'tool';
    index += 1;
    joined = joined + (index > 1 ? `\n\n${index}. ${label}\n` : `${index}. ${label}\n`) + text;
  }
  return joined;
}

export function aggregateToolMembers(calls) {
  return runSync(aggregateToolMembersSteps(calls));
}

/** `aggregateToolMembers`, yielding every `STEP` calls. */
export function* aggregateToolMembersSteps(calls) {
  const source = calls?.values?.() || calls || [];
  const members = [];
  let seen = 0;
  for (const rec of source) {
    if (++seen % STEP === 0) yield;
    if (!rec || typeof rec !== 'object') continue;
    const completed = rec.resolved === true || rec.completedEarly === true;
    members.push({
      kind: 'tool',
      ...(rec.callId != null ? { id: rec.callId } : {}),
      name: String(rec.name || 'tool'),
      args: rec.args ?? {},
      result: rec.resultText ?? null,
      rawResult: rec.rawResultText ?? rec.resultText ?? null,
      isError: rec.isError === true,
      errorCount: rec.isError === true ? 1 : 0,
      callErrorCount: rec.isCallError === true ? 1 : 0,
      exitErrorCount: rec.isExitError === true ? 1 : 0,
      count: 1,
      completedCount: completed ? 1 : 0,
      headerFinalized: completed,
      ...stringUiDiffPatch(rec.uiDiff),
      ...(Number(rec.startedAt) > 0 ? { startedAt: Number(rec.startedAt) } : {}),
      ...(Number(rec.completedAt) > 0 ? { completedAt: Number(rec.completedAt) } : {}),
    });
  }
  return members;
}

export function aggregateBucketForCategory(category, { agentBatch = '' } = {}) {
  const key = String(category || '').trim();
  if (key === 'Read' || key === 'Search') return 'category:Read+Search';
  if (key === 'Agent') return agentBatch ? `category:Agent:${agentBatch}` : 'category:Agent';
  return key ? `category:${key}` : 'default';
}

export function mergeAggregateCategoryEntries(aggregate, categoryEntries) {
  for (const entry of categoryEntries) {
    if (!aggregate.categories.has(entry.key)) aggregate.categoryOrder.push(entry.key);
    const prev = aggregate.categories.get(entry.key);
    aggregate.categories.set(entry.key, { ...entry, count: Number(prev?.count || 0) + Number(entry.count || 1) });
  }
}

// The calls' summaries in `summarySeq` order, yielding every `STEP` calls. The sort is stable, so a list already in order (every
// call without a `summarySeq` is) is left as it is and only an out-of-order one is sorted.
function* aggregateSummariesSteps(aggregate) {
  const withSummary = [];
  const summaries = [];
  let ordered = true;
  let seen = 0;
  for (const r of aggregate?.calls?.values?.() || []) {
    if (++seen % STEP === 0) yield;
    if (!r.summary) continue;
    if (
      withSummary.length > 0 &&
      Number(r.summarySeq ?? 0) < Number(withSummary[withSummary.length - 1].summarySeq ?? 0)
    )
      ordered = false;
    withSummary.push(r);
    summaries.push(r.summary);
  }
  if (ordered) return summaries;
  // Out of order (only a live card's calls are): one sort, not divisible.
  withSummary.sort((a, b) => Number(a.summarySeq ?? 0) - Number(b.summarySeq ?? 0));
  return withSummary.map((r) => r.summary);
}

/** Live tool messages: a present uiDiff is always a string (empty if malformed). */
export function uiDiffFromMessage(source) {
  if (!source || typeof source !== 'object' || !Object.hasOwn(source, 'uiDiff')) return undefined;
  return typeof source.uiDiff === 'string' ? source.uiDiff : '';
}

export function uiDiffPatchFromMessage(source) {
  const value = uiDiffFromMessage(source);
  return value === undefined ? {} : { uiDiff: value };
}

export function assignUiDiffFromMessage(target, source) {
  const value = uiDiffFromMessage(source);
  if (value === undefined || !target) return target;
  target.uiDiff = value;
  return target;
}

/** Stored/member records only copy a string uiDiff; other types stay omitted. */
export function stringUiDiffPatch(value) {
  return typeof value === 'string' ? { uiDiff: value } : {};
}

export function aggregateLoadingTargets(calls) {
  return runSync(aggregateLoadingTargetsSteps(calls));
}

/** `aggregateLoadingTargets`, yielding every `STEP` calls: the union of the calls' targets, or none when any call has none. */
export function* aggregateLoadingTargetsSteps(calls) {
  // The union is built call by call (a Set for membership, an array for first-seen order), never spread at the end.
  const known = new Set();
  const targets = [];
  let count = 0;
  for (const call of calls?.values ? calls.values() : calls || []) {
    if (++count % STEP === 0) yield;
    const own = toolLoadingTargets(call.name, call.args);
    if (own.length === 0) return [];
    for (const target of own) {
      if (known.has(target)) continue;
      known.add(target);
      targets.push(target);
    }
  }
  return targets;
}

export function aggregateResultPatch(aggregate, allCalls, completedCount) {
  return runSync(aggregateResultPatchSteps(aggregate, allCalls, completedCount));
}

/** `aggregateResultPatch`, yielding every `STEP` calls in each of its passes. */
export function* aggregateResultPatchSteps(aggregate, allCalls, completedCount) {
  let errors = 0;
  let callErrors = 0;
  let exitErrors = 0;
  let firstExit;
  let seen = 0;
  for (const r of allCalls) {
    if (++seen % STEP === 0) yield;
    if (r.isError) errors++;
    if (r.isCallError) callErrors++;
    if (r.isExitError) {
      exitErrors++;
      firstExit ??= r;
    }
  }
  const succeeded = Math.max(0, completedCount - errors - exitErrors);
  const displayDetail =
    errors > 0 || exitErrors > 0
      ? failureDetailText({
          succeeded,
          realErrors: callErrors,
          exitErrors,
          exitCode: firstExit?.exitCode,
        })
      : yield* formatAggregateDetailSteps(yield* aggregateSummariesSteps(aggregate));
  return {
    result: displayDetail,
    text: displayDetail,
    isError: errors > 0,
    errorCount: errors,
    callErrorCount: callErrors,
    exitErrorCount: exitErrors,
    count: allCalls.length,
    toolMembers: yield* aggregateToolMembersSteps(allCalls),
  };
}

// restore/tool-result-status.mjs: a result's outcome and the text a card shows for it (a failure's presented error, a command's body
// without its exit header).
export function toolResultDisplay(message, rawText, toolName) {
  const outcome = toolCallOutcome({ ...message, toolName }, rawText);
  const isError = outcome.isCallError;
  let text = rawText;
  if (isError) text = toolErrorDisplay(rawText, toolName || 'tool');
  else if (outcome.exitCode != null) text = stripShellExitHeader(rawText);
  return { ...outcome, isError, text };
}
