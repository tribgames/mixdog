// One JSON result per call, in the same shape media/tool.mjs returns, and
// bounded the way every model-facing tool bounds output: per-engine diagnostic
// caps with a `more` count first, then progressive trimming until the encoded
// report fits the tool output budget.
import { TOOL_OUTPUT_MAX_BYTES } from '../shared/tool-output-limit.mjs';
import { shadowNote } from './shadow.mjs';
import { worktreeNotes } from './worktree.mjs';

export const DIAGNOSTIC_CAP = 20;
const FILE_LIST_CAP = 25;
export const RESULTS_PAGE_MAX = 100;
const TRIM_STEPS = [8, 3, 0];

export function tidyToolResult(value, isError = value?.ok === false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
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

/** check/fix header entry: which engine ran, or how to install a missing one.
 *  Resolution details (path, version, source, kind, languages) belong to scan. */
function briefEngine(engine) {
  return {
    id: engine.id,
    ...(engine.configFile ? { configFile: engine.configFile } : {}),
    ...(engine.suppressedBy ? { suppressedBy: engine.suppressedBy } : {}),
    ...(engine.skipped ? { skipped: engine.skipped } : {}),
    ...(engine.installable ? { installable: true } : {}),
    ...(engine.installHint ? { installHint: engine.installHint } : {}),
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

function shapeDiagnostic(row) {
  return {
    loc: `${String(row.file || '').replaceAll('\\', '/')}:${row.range?.start?.line ?? row.line ?? 0}:${row.range?.start?.column ?? row.col ?? 0}`,
    rule: row.ruleId ?? row.code ?? '',
    severity: row.severity || 'warning',
    message: row.message || '',
    fix: Boolean(row.fixable ?? row.fix),
  };
}

// A page row states only what its rule's byRule entry does not: severity and
// message when they differ from the rule's, and fix only when true.
function compactDiagnostic(row, byRule) {
  const finding = shapeDiagnostic(row);
  const rule = byRule && Object.hasOwn(byRule, finding.rule) ? byRule[finding.rule] : null;
  return {
    loc: finding.loc,
    rule: finding.rule,
    ...(rule?.severity === finding.severity ? {} : { severity: finding.severity }),
    ...(!finding.message || rule?.message === finding.message ? {} : { message: finding.message }),
    ...(finding.fix ? { fix: true } : {}),
  };
}

// Summarize the full selection, never the page or trimmed sample. fixable is a
// count; severity is the highest severity when a rule has mixed severities.
function summarizeDiagnostics(rows = [], includeRules = true) {
  const byRule = new Map();
  const byDir = new Map();
  const severityRank = { error: 3, warning: 2, info: 1 };
  for (const row of rows) {
    const finding = shapeDiagnostic(row);
    const dir =
      String(row.file || '')
        .replaceAll('\\', '/')
        .replace(/^\.\//, '')
        .split('/')
        .slice(0, -1)
        .slice(0, 2)
        .join('/') || '.';
    byDir.set(dir, (byDir.get(dir) || 0) + 1);
    if (!includeRules || !finding.rule) continue;
    // message is the rule's first-seen text; rows repeating it omit theirs.
    const tally = byRule.get(finding.rule) || {
      count: 0,
      severity: finding.severity,
      fixable: 0,
      ...(finding.message ? { message: finding.message } : {}),
    };
    tally.count += 1;
    tally.fixable += Number(finding.fix);
    if (severityRank[finding.severity] > severityRank[tally.severity]) tally.severity = finding.severity;
    byRule.set(finding.rule, tally);
  }
  return { byRule: Object.fromEntries(byRule), byDir: Object.fromEntries(byDir) };
}

// Counts survive trimming the way every other summary does; only the file
// samples shrink, so the two populations stay comparable at any cap.
function shapeWorktreeGroup(group, cap) {
  const page = pageList(group?.files, 0, cap);
  return {
    files: page.items,
    ...(page.more ? { more: page.more } : {}),
    fileCount: (group?.files || []).length,
    findings: Number(group?.findings) || 0,
  };
}

function shapeWorkingTree(workingTree, cap) {
  // Three distinguishable states: a split, a git that failed (`error`, with a
  // note), and no git to ask (`skipped`, silent).
  if (workingTree.skipped) return { skipped: workingTree.skipped };
  if (workingTree.error) return { error: workingTree.error };
  // A population with no file is omitted; the other one still says the split ran.
  const groups = { modified: workingTree.modified, clean: workingTree.clean };
  return Object.fromEntries(
    Object.entries(groups)
      .filter(([, group]) => (group?.files || []).length)
      .map(([name, group]) => [name, shapeWorktreeGroup(group, cap)])
  );
}

function structuralErrors(structural) {
  const errors = [
    ...(structural?.errors || []),
    ...(structural?.ruleErrors || []),
    ...(structural?.error ? [structural.error] : []),
  ].map(({ language = '', kind, message }) => ({ language, kind, message }));
  return [...new Map(errors.map((error) => [JSON.stringify(error), error])).values()];
}

/** Counts without zero leaves or empty groups; undefined when nothing is left. */
function nonZeroCounts(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value === 0 ? undefined : value;
  const kept = Object.entries(value)
    .map(([key, entry]) => [key, nonZeroCounts(entry)])
    .filter(([, entry]) => entry !== undefined);
  return kept.length ? Object.fromEntries(kept) : undefined;
}

/** Summary groups (byRule/byDir) that carry at least one entry. */
function presentGroups(summary) {
  return Object.fromEntries(Object.entries(summary).filter(([, group]) => Object.keys(group).length));
}

// A clean engine is its id, filesChecked and diagnosticsCount 0; list, page and
// summary fields appear only when the engine reported something.
function shapeEngineResult(result, summary, diagnosticCap, offset = 0, filePaging = { cap: FILE_LIST_CAP, offset: 0 }) {
  const diagnosticsCount = (result.diagnostics || []).length;
  const changedCount = (result.filesChanged || []).length;
  const diagnostics = pageList(result.diagnostics, offset, diagnosticCap);
  const changed = pageList(result.filesChanged, filePaging.offset, filePaging.cap);
  const counts = nonZeroCounts(result.counts);
  return {
    id: result.id,
    filesChecked: result.filesChecked || 0,
    ...(changedCount
      ? {
          filesChanged: changed.items,
          ...(changed.more ? { filesChangedMore: changed.more } : {}),
          filesChangedCount: changedCount,
        }
      : {}),
    diagnosticsCount,
    ...(diagnosticsCount
      ? {
          diagnostics: diagnostics.items.map((row) => compactDiagnostic(row, summary.byRule)),
          more: diagnostics.more,
          ...presentGroups(summary),
          offset: diagnostics.offset,
          ...(diagnostics.more ? { nextOffset: diagnostics.offset + diagnostics.items.length } : {}),
        }
      : {}),
    ...(result.dryRun ? { dryRun: true } : {}),
    ...(result.applied ? { applied: true } : {}),
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}),
    ...(result.truncated ? { truncated: true } : {}),
    ...(counts ? { counts } : {}),
  };
}

function shapeStructural(structural, summary, errors, diagnosticCap, offset = 0) {
  if (!structural) return null;
  const matches = pageList(structural.matches, offset, diagnosticCap);
  const matchesCount = (structural.matches || []).length;
  const fixable = (structural.matches || []).filter((match) => match?.fix).length;
  const manual = (structural.matches || []).filter((match) => match?.manual).length;
  return {
    adapter: structural.adapter || 'none',
    ...(structural.packs ? { packsCount: structural.packs.length } : {}),
    matchesCount,
    ...(matchesCount
      ? {
          ...presentGroups(summary),
          matches: matches.items.map((row) => compactDiagnostic(row, summary.byRule)),
          more: matches.more,
          offset: matches.offset,
          ...(matches.more ? { nextOffset: matches.offset + matches.items.length } : {}),
        }
      : {}),
    ...(fixable ? { fixable } : {}),
    ...(manual ? { manual } : {}),
    applied: structural.applied || [],
    ...(structural.rejected?.length ? { rejected: structural.rejected } : {}),
    ...(errors.length ? { errors } : {}),
    ...(structural.note ? { note: structural.note } : {}),
  };
}

/**
 * Assemble the report and trim it until it fits the tool output budget.
 * Counts and rule/directory summaries always survive trimming; only sample
 * rows are dropped. Cached rows and write payloads are never changed.
 */
export function buildTidyReport({
  action,
  ok = true,
  languages = [],
  languageSource = '',
  engines = [],
  results = null,
  structural = null,
  functionLength = null,
  needsApproval = null,
  installed = null,
  errors = [],
  notes = [],
  policy = null,
  rules = null,
  scope = null,
  shadows = null,
  workingTree = null,
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
  const passErrors = structuralErrors(structural);
  const succeeded =
    Boolean(ok) &&
    !structural?.rejected?.length &&
    !engineTruncated &&
    !errors.length &&
    !(results || []).some((result) => result?.error);
  const changed =
    Boolean(structural?.applied?.length) ||
    (results || []).some((result) => !result.dryRun && result.filesChanged?.length && action === 'fix');
  let status = 'failed';
  if (succeeded) status = passErrors.length ? 'partial' : 'complete';
  else if (changed) status = 'partial';
  const parts = {
    ok: succeeded,
    status,
    action,
    scope,
    languages,
    languageSource,
    resolved: engines.filter((engine) => !engine.missing).map(shapeEngine),
    missing: engines.filter((engine) => engine.missing).map(shapeEngine),
    policy,
    results,
    resultSummaries: (results || []).map((result) => {
      const kind = engines.find((engine) => engine.id === result.id)?.kind;
      return summarizeDiagnostics(result.diagnostics, !kind || kind.includes('lint'));
    }),
    rolled: rollupEngineCounts(results),
    structural,
    structuralSummary: summarizeDiagnostics(structural?.matches),
    functionLength: isRunAction(action) ? functionLength : null,
    shadows: !isRunAction(action) && Array.isArray(shadows) ? shadows : [],
    workingTree,
    passErrors,
    rules,
    installed,
    needsApproval,
    errors,
    notes: [
      ...notes,
      ...truncationNotes,
      // A shadow and a clean-file population are reports, never failures: they
      // change what the caller must read, not ok/status.
      ...(!isRunAction(action) && Array.isArray(shadows) ? shadows.map(shadowNote) : []),
      ...worktreeNotes(workingTree, action),
      ...[...new Set(passErrors.map((error) => error.language || 'unknown language'))].map(
        (language) => `${language} structural pass did not complete; see structural.errors`
      ),
      ...(passErrors.length ? ['structural apply blocked for the entire run; no structural fixes were written'] : []),
    ],
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

/** check/fix: the calls whose report is only their results. */
function isRunAction(action) {
  return action === 'check' || action === 'fix';
}

// The environment header describes the run itself, so a `results` page — which
// only re-pages cached rows — leaves it out. scan/install/rules keep languages,
// policy and every missing engine; check/fix name the engines that ran and
// install hints only for an in-scope language no running engine covers.
function environmentHeader(parts, action) {
  if (!isRunAction(action)) {
    const shape = action === 'scan' ? (engine) => engine : briefEngine;
    return {
      languages: parts.languages,
      ...(parts.languageSource ? { languageSource: parts.languageSource } : {}),
      engines: parts.resolved.map(shape),
      ...(parts.missing.length ? { missing: parts.missing.map(shape) } : {}),
      ...(parts.policy ? { policy: parts.policy } : {}),
    };
  }
  const ran = parts.resolved.filter((engine) => !engine.skipped);
  const covered = new Set(ran.flatMap((engine) => engine.languages || []));
  const inScope = new Set((parts.languages || []).map((language) => language.id));
  const uncovered = parts.missing.filter((engine) =>
    (engine.languages || []).some((language) => (!inScope.size || inScope.has(language)) && !covered.has(language))
  );
  return {
    engines: ran.map(briefEngine),
    ...(uncovered.length ? { missing: uncovered.map(briefEngine) } : {}),
  };
}

// One report shape at a given diagnostic cap; optional sections appear only
// when they carry something.
function composeTidyReport(parts, diagnosticCap) {
  const { action, results, structural, pageOffset } = parts;
  const resultFilePage =
    action === 'results' ? { cap: diagnosticCap, offset: pageOffset } : { cap: FILE_LIST_CAP, offset: 0 };
  const workingTree = parts.workingTree
    ? shapeWorkingTree(parts.workingTree, Math.min(FILE_LIST_CAP, diagnosticCap))
    : null;
  // Totals repeat the lone engine's own counts, so they appear for 2+ engines.
  const totals = (results || []).length > 1 ? nonZeroCounts(parts.rolled) : undefined;
  const paged =
    pageOffset > 0 ||
    (results || []).some(
      (result) =>
        (result.diagnostics || []).length > diagnosticCap || (result.filesChanged || []).length > resultFilePage.cap
    ) ||
    (structural?.matches || []).length > diagnosticCap;
  return {
    ok: parts.ok,
    status: parts.status,
    action,
    // Check/fix scope is the caller's own paths; the other actions name it.
    ...(parts.scope && !isRunAction(action) ? { scope: parts.scope } : {}),
    ...(action === 'results' ? {} : environmentHeader(parts, action)),
    ...(parts.shadows.length ? { shadows: parts.shadows } : {}),
    ...(results
      ? {
          results: results.map((result, index) =>
            shapeEngineResult(result, parts.resultSummaries[index], diagnosticCap, pageOffset, resultFilePage)
          ),
        }
      : {}),
    ...(totals ? { counts: totals } : {}),
    ...(structural
      ? {
          structural: shapeStructural(structural, parts.structuralSummary, parts.passErrors, diagnosticCap, pageOffset),
        }
      : {}),
    ...(workingTree && Object.keys(workingTree).length ? { workingTree } : {}),
    ...(parts.functionLength ? { functionLength: parts.functionLength } : {}),
    ...(paged ? { paging: { offset: pageOffset, limit: diagnosticCap } } : {}),
    ...(parts.rules ? { rules: parts.rules } : {}),
    ...(parts.installed ? { installed: parts.installed } : {}),
    ...(parts.needsApproval ? { needsApproval: parts.needsApproval } : {}),
    ...(parts.errors.length ? { errors: parts.errors } : {}),
    ...(parts.notes.length ? { notes: parts.notes } : {}),
    elapsedMs: parts.elapsedMs,
  };
}
