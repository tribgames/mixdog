// One JSON result per call, in the same shape media/tool.mjs returns, and
// bounded the way every model-facing tool bounds output: per-engine diagnostic
// caps with a `more` count first, then progressive trimming until the encoded
// report fits the tool output budget.
import { TOOL_OUTPUT_MAX_BYTES } from '../agent/orchestrator/tools/builtin/tool-output-limit.mjs';

export const DIAGNOSTIC_CAP = 20;
export const FILE_LIST_CAP = 25;
const TRIM_STEPS = [8, 3, 0];

export function tidyToolResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

function capList(values, cap) {
  const list = values || [];
  if (list.length <= cap) return { items: list, more: 0 };
  return { items: list.slice(0, cap), more: list.length - cap };
}

/** Engine entry for the report: resolution facts plus the hint when missing. */
export function shapeEngine(engine) {
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

function shapeEngineResult(result, diagnosticCap) {
  const diagnostics = capList(result.diagnostics, diagnosticCap);
  const changed = capList(result.filesChanged, FILE_LIST_CAP);
  return {
    id: result.id,
    ...(result.version ? { version: result.version } : {}),
    source: result.source,
    filesChecked: result.filesChecked || 0,
    filesChanged: changed.items,
    ...(changed.more ? { filesChangedMore: changed.more } : {}),
    filesChangedCount: (result.filesChanged || []).length,
    diagnostics: diagnostics.items,
    ...(diagnostics.more ? { more: diagnostics.more } : {}),
    diagnosticsCount: (result.diagnostics || []).length,
    ...(result.dryRun ? { dryRun: true } : {}),
    ...(result.applied ? { applied: true } : {}),
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.stderrTail ? { stderrTail: result.stderrTail } : {}),
  };
}

function shapeStructural(structural, diagnosticCap) {
  if (!structural) return null;
  const matches = capList(structural.matches, diagnosticCap);
  return {
    adapter: structural.adapter || 'none',
    ...(structural.packs ? { packs: structural.packs } : {}),
    matchesCount: (structural.matches || []).length,
    matches: matches.items,
    ...(matches.more ? { more: matches.more } : {}),
    fixable: (structural.matches || []).filter((match) => match?.fix).length,
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
  maxBytes = TOOL_OUTPUT_MAX_BYTES,
} = {}) {
  const missing = engines.filter((engine) => engine.missing).map(shapeEngine);
  const resolved = engines.filter((engine) => !engine.missing).map(shapeEngine);
  const compose = (diagnosticCap) => ({
    ok,
    action,
    ...(scope ? { scope } : {}),
    languages,
    ...(languageSource ? { languageSource } : {}),
    engines: resolved,
    ...(missing.length ? { missing } : {}),
    ...(policy ? { policy } : {}),
    ...(results ? { results: results.map((result) => shapeEngineResult(result, diagnosticCap)) } : {}),
    ...(structural ? { structural: shapeStructural(structural, diagnosticCap) } : {}),
    ...(rules ? { rules } : {}),
    ...(installed ? { installed } : {}),
    ...(needsApproval ? { needsApproval } : {}),
    ...(errors.length ? { errors } : {}),
    ...(notes.length ? { notes } : {}),
    elapsedMs,
  });

  let report = compose(DIAGNOSTIC_CAP);
  for (const cap of TRIM_STEPS) {
    if (Buffer.byteLength(JSON.stringify(report), 'utf8') <= maxBytes) return report;
    report = { ...compose(cap), truncated: true };
  }
  return report;
}
