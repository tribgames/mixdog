/**
 * Tool-result status, display text, and aggregate-record helpers for the
 * session runtime.
 */
import { hasBenignExitOutcome, normalizeToolTerminalStatus, toolResultTerminalStatus } from './tool-status.mjs';
import { isReadOnlyNavigationMiss } from './result-classification.mjs';
import { STEP, formatAggregateDetailSteps, runSync, toolLoadingTargets } from './tool-surface.mjs';
import { normalizeToolName } from './tool-primitives.mjs';
import { gitResultError, gitResultExitCode } from './tool-card-model/git-result.mjs';
import { stripShellExitHeader, toolErrorDisplay } from './tool-result-text.mjs';

// Detect a shell command that RAN but exited non-zero (a process exit code)
// as opposed to a real tool-call failure (`[shell-tool-failed]`) or a
// timeout/abort. New results use bare `[exit code: N]`; legacy transcripts may
// use `Error: [shell-run-failed] [exit code: N]`. Persistent shell results can
// prefix `[session: …]`. Returns the numeric exit code, or null otherwise.
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

// Only provider envelope metadata establishes a failed invocation. Result
// bodies can contain "Error:"/HTTP/domain/task status text without making the
// call itself fail. A recognized plain shell exit wins over provider envelope
// error flags: adapters commonly label non-zero process exits as tool errors
// even though the shell tool itself ran successfully.
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

// Build the collapsed failure/exit detail string. Real tool-call/result
// failures keep the red "Failed" wording; completed non-zero commands render
// as the distinct warning "Exited" state. A mixed group surfaces both.
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
  // Do NOT inspect item.rawResult here: aggregate rawResult is child tool
  // output (`1. grep\n<result>…`) that can incidentally contain a `status:`
  // line, which would false-positive as an already-terminal status and skip
  // the cancelled marker. Only result/text/body are session runtime-controlled
  // collapsed detail (empty / status word / an existing marker), so they are
  // the trustworthy terminal-status sources.
  const sources = [item?.result, item?.text, body];
  if (itemHasKnownTerminalStatus(item, sources)) return body;
  if (!body.trim()) return `${CANCELLED_RESULT_STATUS_LINE}\n`;
  return `${CANCELLED_RESULT_STATUS_LINE}\n${body}`;
}

/** The members' raw outputs as one numbered text (`1. grep\n…\n\n2. read\n…`).
 *
 *  Built by `+`, never `join`: V8 keeps a concatenation as a rope that points
 *  at the member strings the aggregate already holds (toolMembers[].rawResult,
 *  the calls' raw text) and copies it flat only when something reads its
 *  characters. A resumed session restores hundreds of aggregates it never
 *  displays; a joined string gave each of them a second, flat copy of every
 *  tool output (~1 MB per idle session in a 30-session measurement). */
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

/** Preserve the atomic calls behind a visual aggregate. Renderers can keep the
 * aggregate as one quiet summary row while revealing the original tool names,
 * arguments, and outputs in provider order. */
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
  // Merge consecutive tool calls of the SAME category into one aggregate card;
  // a different category opens a fresh card (no cross-category merge). The
  // bucket key is the category itself, so a run of Search calls collapses into
  // one Search card while an adjacent Read/Patch stays separate. Falls back to
  // 'default' when a call has no resolved category. Hook/approval denials keep
  // their dedicated ToolHookDenialCard path in App.jsx.
  const key = String(category || '').trim();
  // Exception: Read and Search share one lookup bucket so a batched turn of
  // read+grep renders as ONE card ("Reading 3 files · Searching 2 patterns")
  // instead of two adjacent cards. The per-category entries in
  // aggregateCard.categories keep their own verbs/counts, so the merged
  // header still spells out both. State-changing categories (Patch/Shell/…)
  // stay separate.
  if (key === 'Read' || key === 'Search') return 'category:Read+Search';
  // Agent actions are grouped only inside the provider callback that emitted
  // them. This keeps a later provider batch from changing an older outbound
  // card above an intervening result/transcript boundary.
  if (key === 'Agent') return agentBatch ? `category:Agent:${agentBatch}` : 'category:Agent';
  return key ? `category:${key}` : 'default';
}

// Fold one call's category entries into an aggregate's header counts
// (`categories` Map + first-seen `categoryOrder`), shared by the live card
// and the restored transcript card.
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
    if (withSummary.length > 0 && Number(r.summarySeq ?? 0) < Number(withSummary[withSummary.length - 1].summarySeq ?? 0)) ordered = false;
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
