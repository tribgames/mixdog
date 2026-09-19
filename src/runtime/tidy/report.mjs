// One JSON result per call, in the same shape media/tool.mjs returns, and
// bounded the way every model-facing tool bounds output: per-engine diagnostic
// caps with a `more` count first, then progressive trimming until the encoded
// report fits the tool output budget.
import { TOOL_OUTPUT_MAX_BYTES } from '../agent/orchestrator/tools/builtin/tool-output-limit.mjs';

export const DIAGNOSTIC_CAP = 20;
const FILE_LIST_CAP = 25;
export const RESULTS_PAGE_MAX = 100;
const TRIM_STEPS = [8, 3, 0];

export function tidyToolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function pageList(values, offset, cap) {
  const list = Array.isArray(values) ? values : [];
  const start = Math.max(0, Math.trunc(Number(offset) || 0));
  const width = Math.max(0, Math.trunc(Number(cap) || 0));
  const items = width === 0 ? [] : list.slice(start, start + width);
  return { items, more: Math.max(0, list.length - start - items.length), offset: start };
}

/** Engine entry for the report: resolution facts plus the hint when missing. */
function shapeEngine(engine) {
  return {
    id: engine.id,
    ...(engine.version ? { version: engine.version } : {}),
    source: engine.source,
    ...(engine.path ? { path: engine.path } : {}),
    kind: engine.kind,
    languages: engine.languages,
    ...(engine.configFile ? { configFile: engine.configFile } : {}),
    ...(engine.suppressedBy ? { suppressedBy: engine.suppressedBy } : {}),
    ...(engine.skipped ? { skipped: engine.skipped } : {}),
    ...(engine.toolchain ? { toolchain: true } : {}),
    ...(engine.installable ? { installable: true } : {}),
    ...(engine.missing ? { installHint: engine.installHint } : {}),
  };
}

function rollupEngineCounts(results) {
  if (!Array.isArray(results) || results.length === 0) return null;
  const byFixability = { safe: 0, unsafe: 0, manual: 0, fixable: 0, unfixable: 0 };
  const bySeverity = { error: 0, warning: 0, info: 0 };
  let diagnostics = 0;
  let filesToFormat = 0;
  let any = false;
  for (const result of results) {
    const counts = result?.counts;
    if (!counts) continue;
    any = true;
    diagnostics += Number(counts.diagnostics) || 0;
    filesToFormat += Number(counts.filesToFormat) || 0;
    const fixability = counts.byFixability || {};
    for (const key of Object.keys(byFixability)) {
      byFixability[key] += Number(fixability[key]) || 0;
    }
    const severity = counts.bySeverity || {};
    for (const key of Object.keys(bySeverity)) {
      bySeverity[key] += Number(severity[key]) || 0;
    }
  }
  return any ? { diagnostics, filesToFormat, byFixability, bySeverity } : null;
}

function shapeEngineResult(result, diagnosticCap, offset = 0, filePaging = { cap: FILE_LIST_CAP, offset: 0 }) {
  const diagnostics = pageList(result.diagnostics, offset, diagnosticCap);
  const changed = pageList(result.filesChanged, filePaging.offset, filePaging.cap);
  return {
    id: result.id,
    ...(result.version ? { version: result.version } : {}),
    source: result.source,
    filesChecked: result.filesChecked || 0,
    filesChanged: changed.items,
    ...(changed.more ? { filesChangedMore: changed.more } : {}),
    filesChangedCount: (result.filesChanged || []).length,
    diagnostics: diagnostics.items,
    more: diagnostics.more,
    diagnosticsCount: (result.diagnostics || []).length,
    offset: diagnostics.offset,
    ...(diagnostics.more ? { nextOffset: diagnostics.offset + diagnostics.items.length } : {}),
    ...(result.dryRun ? { dryRun: true } : {}),
    ...(result.applied ? { applied: true } : {}),
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    ...(result.counts ? { counts: result.counts } : {}),
  };
}

function shapeStructural(structural, diagnosticCap, offset = 0) {
  if (!structural) return null;
  const matches = pageList(structural.matches, offset, diagnosticCap);
  return {
    adapter: structural.adapter || 'none',
    ...(structural.packs ? { packs: structural.packs } : {}),
    matchesCount: (structural.matches || []).length,
    matches: matches.items,
    more: matches.more,
    offset: matches.offset,
    ...(matches.more ? { nextOffset: matches.offset + matches.items.length } : {}),
    fixable: (structural.matches || []).filter((match) => match?.fix).length,
    manual: (structural.matches || []).filter((match) => match?.manual).length,
    applied: structural.applied || [],
    ...(structural.rejected?.length ? { rejected: structural.rejected } : {}),
    ...(structural.error ? { error: structural.error } : {}),
    ...(structural.ruleErrors?.length > 1 ? { ruleErrors: structural.ruleErrors } : {}),
    ...(structural.note ? { note: structural.note } : {}),
  };
}

/**
 * Assemble the report and trim it until it fits the tool output budget.
 * Counts always survive trimming; only sample rows are dropped.
 */
export function buildTidyReport({
  action,
  ok = true,
  languages = [],
  languageSource = '',
  engines = [],
  results = null,
  structural = null,
  needsApproval = null,
  installed = null,
  errors = [],
  notes = [],
  policy = null,
  rules = null,
  scope = null,
  elapsedMs = 0,
  offset = 0,
  limit = DIAGNOSTIC_CAP,
  maxBytes = TOOL_OUTPUT_MAX_BYTES,
} = {}) {
  const truncationNotes = (results || [])
    .filter((result) => result?.truncated)
    .map((result) => result.note || `${result.id} output was truncated; split the scope and re-run`);
  const engineTruncated = (results || []).some((result) => result?.truncated);
  const startCap = Math.min(RESULTS_PAGE_MAX, Math.max(0, Math.trunc(Number(limit) || 0)));
  const structuralFailed =
    Boolean(structural?.error) || (Array.isArray(structural?.ruleErrors) && structural.ruleErrors.length > 0);
  const parts = {
    ok: Boolean(ok) && !structuralFailed,
    action,
    scope,
    languages,
    languageSource,
    resolved: engines.filter((engine) => !engine.missing).map(shapeEngine),
    missing: engines.filter((engine) => engine.missing).map(shapeEngine),
    policy,
    results,
    rolled: rollupEngineCounts(results),
    structural,
    rules,
    installed,
    needsApproval,
    errors,
    notes: [...notes, ...truncationNotes],
    elapsedMs,
    pageOffset: Math.max(0, Math.trunc(Number(offset) || 0)),
  };
  const caps = [startCap, ...TRIM_STEPS.filter((step) => step < startCap)];
  let report = composeTidyReport(parts, caps[0]);
  if (engineTruncated) report = { ...report, truncated: true };
  for (const cap of caps.slice(1)) {
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= maxBytes) return report;
    report = { ...composeTidyReport(parts, cap), truncated: true };
  }
  return report;
}

// One report shape at a given diagnostic cap; optional sections appear only
// when they carry something.
function composeTidyReport(parts, diagnosticCap) {
  const { action, results, structural, pageOffset } = parts;
  const resultFilePage =
    action === 'results' ? { cap: diagnosticCap, offset: pageOffset } : { cap: FILE_LIST_CAP, offset: 0 };
  return {
    ok: parts.ok,
    action,
    ...(parts.scope ? { scope: parts.scope } : {}),
    languages: parts.languages,
    ...(parts.languageSource ? { languageSource: parts.languageSource } : {}),
    engines: parts.resolved,
    ...(parts.missing.length ? { missing: parts.missing } : {}),
    ...(parts.policy ? { policy: parts.policy } : {}),
    ...(results
      ? { results: results.map((result) => shapeEngineResult(result, diagnosticCap, pageOffset, resultFilePage)) }
      : {}),
    ...(parts.rolled ? { counts: parts.rolled } : {}),
    ...(structural ? { structural: shapeStructural(structural, diagnosticCap, pageOffset) } : {}),
    ...(results || structural ? { paging: { offset: pageOffset, limit: diagnosticCap } } : {}),
    ...(parts.rules ? { rules: parts.rules } : {}),
    ...(parts.installed ? { installed: parts.installed } : {}),
    ...(parts.needsApproval ? { needsApproval: parts.needsApproval } : {}),
    ...(parts.errors.length ? { errors: parts.errors } : {}),
    ...(parts.notes.length ? { notes: parts.notes } : {}),
    elapsedMs: parts.elapsedMs,
  };
}
