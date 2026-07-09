/**
 * src/tui/engine/tool-result-status.mjs — pure tool-result status + aggregate
 * text helpers extracted from createEngineSession (engine.mjs).
 *
 * These functions were function-declared inside the closure but reference only
 * their arguments plus toolErrorDisplay (imported below) — no session state —
 * so they move out verbatim as free functions. engine.mjs imports them and
 * keeps calling them unchanged.
 */
import { toolErrorDisplay } from './tool-result-text.mjs';

export const CANCELLED_RESULT_STATUS_LINE = '[status: cancelled]';

// Detect a shell command that RAN but exited non-zero (a process exit code)
// as opposed to a real tool-call failure (`[shell-tool-failed]`) or a
// timeout/abort. bash-tool.mjs emits `Error: [shell-run-failed] [exit code: N]`
// for a plain non-zero exit; timeout/signal cases carry `[timeout: …]`/
// `[signal: …]` instead of an `[exit code: …]` marker. Returns the numeric
// exit code (>= 0) for a command-exit, or null otherwise.
export function shellCommandExitCode(text) {
  const body = String(text || '');
  // Anchor to the START of the result so a success/non-shell body that merely
  // QUOTES the marker mid-output is never misclassified. bash-tool emits
  // `Error: [shell-run-failed] [exit code: N]` as the leading marker header.
  if (!/^\s*(?:Error:\s*)?\[shell-run-failed\]/i.test(body)) return null;
  // Restrict marker parsing to the header region (first line) so only the
  // engine-emitted status header — not quoted command output below — counts.
  const header = body.split('\n', 1)[0] || '';
  // Timeout / signal / abort are NOT a plain command exit — keep them "Failed".
  if (/\[timeout:|\[signal:|timed out|aborted|interrupted/i.test(header)) return null;
  const m = header.match(/\[exit code:\s*(\d+)\]/i);
  if (!m) return null;
  const code = Number(m[1]);
  return Number.isFinite(code) ? code : null;
}

// Build the collapsed failure/exit detail string. Real tool-call/result
// failures keep the red-adjacent "Failed" wording; shell command-exits render
// as the distinct neutral "Exit" state ("Exit N" for a single exit, "Y Exit"
// grouped). A mixed group surfaces both ("1 Ok · 1 Failed · 1 Exit").
export function failureDetailText({ succeeded = 0, realErrors = 0, exitErrors = 0, exitCode } = {}) {
  const parts = [];
  if (succeeded > 0) parts.push(`${succeeded} Ok`);
  if (realErrors > 0) parts.push(`${realErrors} Failed`);
  if (exitErrors > 0) {
    const solo = exitErrors === 1 && realErrors === 0 && succeeded === 0;
    parts.push(solo && Number.isFinite(exitCode) ? `Exit ${exitCode}` : `${exitErrors} Exit`);
  }
  return parts.join(' · ');
}

export function normalizedResultStatusToken(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  if (/^(running|pending|queued|in_progress|in-progress)$/.test(raw)) return 'running';
  if (/^(completed|complete|done|success|succeeded|ok)$/.test(raw)) return 'completed';
  if (/^(failed|fail|error|errored|timeout|timed_out|killed)$/.test(raw)) return 'failed';
  if (/^(cancelled|canceled|cancel)$/.test(raw)) return 'cancelled';
  return '';
}

export function resultTextTerminalStatus(text) {
  const body = String(text || '');
  const tagged = body.match(/<status[^>]*>([\s\S]*?)<\/status>/i)?.[1]?.trim();
  if (tagged) return normalizedResultStatusToken(tagged);
  const bracketed = body.match(/^\[status:\s*([^\]]*)\]/mi)?.[1]?.trim();
  if (bracketed) return normalizedResultStatusToken(bracketed);
  const inline = body.match(/^(?:status|state):\s*([^\s·,;]+)/mi)?.[1]?.trim();
  return normalizedResultStatusToken(inline);
}

export function itemHasKnownTerminalStatus(item, texts = []) {
  const settled = (token) => token === 'completed' || token === 'failed' || token === 'cancelled';
  if (settled(normalizedResultStatusToken(item?.args?.status))) return true;
  for (const text of texts) {
    if (settled(resultTextTerminalStatus(text))) return true;
  }
  return false;
}

export function withCancelledResultMarker(text, item) {
  const body = String(text || '');
  // Do NOT inspect item.rawResult here: aggregate rawResult is child tool
  // output (`1. grep\n<result>…`) that can incidentally contain a `status:`
  // line, which would false-positive as an already-terminal status and skip
  // the cancelled marker. Only result/text/body are engine-controlled
  // collapsed detail (empty / status word / an existing marker), so they are
  // the trustworthy terminal-status sources.
  const sources = [item?.result, item?.text, body];
  if (itemHasKnownTerminalStatus(item, sources)) return body;
  if (!body.trim()) return `${CANCELLED_RESULT_STATUS_LINE}\n`;
  return `${CANCELLED_RESULT_STATUS_LINE}\n${body}`;
}

export function groupedToolResultText(group) {
  const completed = Math.min(group.count, group.completed);
  if (group.count <= 1) return group.results.at(-1)?.text ?? '';
  if (group.errors > 0) {
    const exitErrors = Number(group.exitErrors || 0);
    const realErrors = Math.max(0, group.errors - exitErrors);
    const succeeded = Math.max(0, completed - group.errors);
    const exitCode = group.results.find((result) => result?.isExitError)?.exitCode;
    // Command-exits carry no failure reason line; only real failures do.
    const reasons = group.results
      .filter((result) => result?.isError && !result?.isExitError)
      .map((result) => firstErrorLine(result?.text))
      .filter(Boolean);
    const uniqueReasons = [...new Set(reasons)].slice(0, 2);
    const base = failureDetailText({ succeeded, realErrors, exitErrors, exitCode });
    return [
      `${base}${uniqueReasons[0] ? ` · ${uniqueReasons[0]}` : ''}`,
      ...uniqueReasons.slice(1),
    ].join('\n');
  }
  for (const result of group.results || []) {
    const line = String(result?.text || '').trim();
    if (line) return result.text;
  }
  return '';
}

export function firstErrorLine(text) {
  const clean = toolErrorDisplay(text, 'tool');
  if (clean) return clean;
  for (const line of String(text || '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(Error|\[?error|FAIL\b)/i.test(trimmed)) return trimmed;
  }
  return String(text || '').split('\n').map((line) => line.trim()).find(Boolean) || '';
}

export function aggregateRawResult(calls) {
  const chunks = [];
  for (const rec of calls || []) {
    if (rec?.resolved !== true) continue;
    let text = String(rec?.resultText || '').replace(/\s+$/, '');
    if (!text.trim()) continue;
    const label = String(rec?.name || rec?.category || 'tool').trim() || 'tool';
    chunks.push(`${chunks.length + 1}. ${label}\n${text}`);
  }
  return chunks.join('\n\n');
}

export function aggregateBucketForCategory(category) {
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
  return key ? `category:${key}` : 'default';
}

export function aggregateSummaries(aggregate) {
  return [...(aggregate?.calls?.values?.() || [])]
    .filter((r) => r.summary)
    .sort((a, b) => Number(a.summarySeq ?? 0) - Number(b.summarySeq ?? 0))
    .map((r) => r.summary);
}

export function assignAggregateSummaryOrder(aggregate, callRec) {
  if (!aggregate || !callRec?.summary || callRec.summarySeq != null) return;
  const next = Math.max(0, Number(aggregate.nextSummarySeq || 0));
  callRec.summarySeq = next;
  aggregate.nextSummarySeq = next + 1;
}
