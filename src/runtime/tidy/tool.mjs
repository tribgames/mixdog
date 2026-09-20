// The model-facing `tidy` tool: a multi-language cleanup multiplexer.
//
// scan     detect languages → resolve engines → report policy
// check    run every resolved engine in check mode + structural rules, no writes
// fix      same, but reports the change plan; apply:true writes through apply.mjs
// install  download missing managed engines (sha256-verified, policy-gated)
// rules    list the structural rule packs and the languages they cover
// results  page diagnostics/matches from the last check/fix (no engine re-run)
//
// The heavy pieces (engine runners, structural adapter, installer, orchestrator
// write pipeline) load on demand so importing this module stays cheap at boot.
import { isAbsolute, relative } from 'node:path';
import { clean } from '../shared/clean.mjs';
import { TIDY_ACTIONS } from './tool-defs.mjs';
import { detectLanguages, parseGraphLangs } from './languages.mjs';
import { readEnginesManifest } from './install.mjs';
import { resolveEngines, runnableEngines } from './resolve.mjs';
import { DIAGNOSTIC_CAP, RESULTS_PAGE_MAX, buildTidyReport, tidyToolResult } from './report.mjs';
import { runProcess } from './process.mjs';

const GRAPH_LANGS_TIMEOUT_MS = 8000;
// Argv-safe --files batches. Larger scopes stay scoped: omitting --files makes
// mixdog-graph walk cwd, which is never an acceptable fallback.
export const MAX_STRUCTURAL_FILE_ARGS = 200;
const RESULT_CACHE_MAX = 32;
const RESULT_CACHE = new Map();
const PAGING_NOTE =
  'use byRule/byDir to triage; action results filters cached rows with rules/paths before offset/limit paging, omits the header, and does not re-run engines; structural.errors means ok:true/status:partial unless another failure occurred';

class TidyToolError extends Error {}

/** Split a file list into --files batches. Empty input means "do not scan". */
export function chunkStructuralFiles(files = [], maxArgs = MAX_STRUCTURAL_FILE_ARGS) {
  const width = Math.max(1, Number(maxArgs) || MAX_STRUCTURAL_FILE_ARGS);
  if (!Array.isArray(files) || files.length === 0) return [];
  const chunks = [];
  for (let index = 0; index < files.length; index += width) {
    chunks.push(files.slice(index, index + width));
  }
  return chunks;
}

function resultCacheKey(cwd, sessionId) {
  return `${sessionId || ''}::${cwd}`;
}

export function resetTidyResultCache() {
  RESULT_CACHE.clear();
}

export function rememberTidyRun(cwd, sessionId, payload) {
  const key = resultCacheKey(cwd, sessionId);
  RESULT_CACHE.delete(key);
  RESULT_CACHE.set(key, payload);
  while (RESULT_CACHE.size > RESULT_CACHE_MAX) {
    const oldest = RESULT_CACHE.keys().next().value;
    RESULT_CACHE.delete(oldest);
  }
}

function recallTidyRun(cwd, sessionId) {
  return RESULT_CACHE.get(resultCacheKey(cwd, sessionId)) || null;
}

function parseOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(1_000_000_000, Math.trunc(n));
}

function parseLimit(value) {
  if (value == null || value === '') return DIAGNOSTIC_CAP;
  const n = Number(value);
  if (!Number.isFinite(n)) return DIAGNOSTIC_CAP;
  return Math.min(RESULTS_PAGE_MAX, Math.max(1, Math.trunc(n)));
}

function matchFileKey(file, cwd) {
  const raw = String(file || '').replaceAll('\\', '/');
  if (!raw) return '';
  const root = String(cwd || '')
    .replaceAll('\\', '/')
    .replace(/\/+$/, '');
  if (root && (raw === root || raw.startsWith(`${root}/`))) return raw.slice(root.length + 1);
  return raw.replace(/^\.\//, '');
}

function reportHasMore(report) {
  const engineMore = (report.results || []).some((row) => Number(row?.more) > 0);
  return engineMore || Number(report.structural?.more) > 0;
}

function list(value) {
  if (value == null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => clean(item)).filter(Boolean);
}

/** Scope paths are project-relative; an absolute path must live inside cwd. */
function normalizeScope(paths, cwd) {
  return paths.map((value) => {
    if (!isAbsolute(value)) {
      const normalized = value.replaceAll('\\', '/').replace(/^\.\//, '');
      if (normalized.split('/').includes('..')) {
        throw new TidyToolError(`paths must stay inside the project: ${value}`);
      }
      return normalized;
    }
    const rel = relative(cwd, value).replaceAll('\\', '/');
    if (rel.startsWith('..')) {
      throw new TidyToolError(`paths must stay inside the project: ${value}`);
    }
    return rel || '.';
  });
}

async function pluginDataDir() {
  try {
    const { getPluginData } = await import('../agent/orchestrator/config.mjs');
    return getPluginData() || '';
  } catch {
    return '';
  }
}

async function graphBinary() {
  try {
    const { graphBinaryPath } = await import('../agent/orchestrator/tools/code-graph/graph-binary.mjs');
    return graphBinaryPath();
  } catch {
    return null;
  }
}

/** Note when a present mixdog-graph binary does not own the scan protocol. */
async function outdatedGraphNote({ graphBinPath, graphLangs }) {
  if (!graphBinPath || graphLangs) return [];
  const { structuralUnavailableMessage } = await import('./structural.mjs');
  return [structuralUnavailableMessage(graphBinPath)];
}

/** `mixdog-graph <cwd> --langs` when that mode exists; null otherwise. */
async function graphLanguages(binPath, cwd, signal) {
  if (!binPath) return null;
  const result = await runProcess(binPath, [cwd, '--langs'], { cwd, timeoutMs: GRAPH_LANGS_TIMEOUT_MS, signal });
  if (result.code !== 0 || result.error) return null;
  return parseGraphLangs(result.stdout);
}

async function detect({ cwd, scope, languageFilter, signal }) {
  const graphBinPath = await graphBinary();
  // One `--langs` call answers both questions: which extension map to detect
  // with, and whether this binary owns the structural scan protocol.
  const graphLangs = await graphLanguages(graphBinPath, cwd, signal);
  const detected = await detectLanguages({ cwd, paths: scope, languages: languageFilter, graphLangs, signal });
  return { ...detected, graphBinPath, graphLangs };
}

async function resolveForRun({ cwd, detected, engineFilter, signal }) {
  const pluginData = await pluginDataDir();
  const manifest = readEnginesManifest();
  const resolution = await resolveEngines({
    cwd,
    languages: detected.languages.map((language) => language.id),
    engineIds: engineFilter,
    pluginData,
    manifest,
    signal,
  });
  return { ...resolution, pluginData, manifest };
}

/**
 * Missing-but-downloadable engines: install them when policy or the caller
 * approves, otherwise hand the approval request back to the caller.
 */
async function satisfyMissingEngines({ resolution, cwd, engineFilter, approveDownloads, signal }) {
  const installable = resolution.engines
    .filter((engine) => engine.missing && engine.installable)
    .map((engine) => engine.id);
  if (installable.length === 0) return { resolution, needsApproval: null, installed: null };
  const policy = resolution.policy.downloads;
  if (policy === 'never') return { resolution, needsApproval: null, installed: null };
  const { installEngines, planInstall } = await import('./install.mjs');
  if (policy !== 'auto' && !approveDownloads) {
    const plan = planInstall({
      ids: installable,
      manifest: resolution.manifest,
      pluginData: resolution.pluginData,
      policy,
      approveDownloads: false,
    });
    return { resolution, needsApproval: plan.needsApproval, installed: null };
  }
  const outcome = await installEngines({
    ids: installable,
    manifest: resolution.manifest,
    pluginData: resolution.pluginData,
    policy,
    approveDownloads: true,
    signal,
  });
  const refreshed = await resolveEngines({
    cwd,
    languages: resolution.engines.flatMap((engine) => engine.languages),
    engineIds: engineFilter.length ? engineFilter : resolution.engines.map((engine) => engine.id),
    pluginData: resolution.pluginData,
    manifest: resolution.manifest,
    signal,
  });
  return {
    resolution: { ...resolution, engines: refreshed.engines },
    needsApproval: null,
    installed: { engines: outcome.installed, ...(outcome.errors.length ? { errors: outcome.errors } : {}) },
  };
}

async function runStructural({
  cwd,
  files,
  languages = [],
  apply,
  sessionId,
  signal,
  graphBinPath,
  graphLangs,
  extensions = null,
}) {
  const { filesForStructuralGroup, groupsForLanguages, loadRulePacks, resolveStructuralAdapter } = await import(
    './structural.mjs'
  );
  const { groups } = loadRulePacks();
  if (groups.length === 0) {
    return { adapter: 'none', matches: [], applied: [], packs: [], note: 'no structural rule packs are installed' };
  }
  // No fallback engine: an old or missing mixdog-graph throws out of here and
  // the call fails with the rebuild remedy, rather than reporting zero matches.
  const adapter = await resolveStructuralAdapter({ cwd, graphBinPath, graphLangs, signal });
  // `--fix` asks the producer for fix payloads only — the graph binary emits
  // them and writes nothing — so the plan is always complete and apply.mjs
  // stays the only writer. An empty file list must not omit `--files` (that
  // walks cwd). Oversize lists are batched so every spawn stays scoped.
  if (!files.length) {
    return { adapter: adapter.id, packs: [], matches: [], applied: [], note: 'no files in scope' };
  }
  const runnable = groupsForLanguages(groups, languages);
  const { matches, ruleErrors } = await scanStructuralGroups({
    adapter,
    runnable,
    files,
    extensions,
    cwd,
    signal,
    filesForStructuralGroup,
  });
  const structural = {
    adapter: adapter.id,
    packs: runnable.flatMap((group) => group.packs),
    matches,
    applied: [],
    ...(ruleErrors.length ? { error: ruleErrors[0], ruleErrors } : {}),
  };
  if (!apply || structural.error || structural.matches.length === 0) return structural;
  return applyStructuralPlan(structural, { cwd, sessionId, signal });
}

// Every group's matches inside the scoped files, scanned chunk by chunk. One
// unusable pack takes down its own language only; the rest still run.
async function scanStructuralGroups({ adapter, runnable, files, extensions, cwd, signal, filesForStructuralGroup }) {
  const allowed = new Set(files.map((rel) => matchFileKey(rel, cwd)));
  const matches = [];
  const ruleErrors = [];
  for (const group of runnable) {
    const groupFiles = filesForStructuralGroup(files, group, extensions);
    for (const chunk of chunkStructuralFiles(groupFiles)) {
      const scan = await adapter.scan({ cwd, rulesText: group.rulesText, files: chunk, fix: true, signal });
      for (const match of scan.matches || []) {
        if (allowed.has(matchFileKey(match.file, cwd))) matches.push(match);
      }
      if (scan.error) ruleErrors.push({ language: group.language, ...scan.error });
    }
  }
  return { matches, ruleErrors };
}

async function applyStructuralPlan(structural, { cwd, sessionId, signal }) {
  const { applyStructuralFixes } = await import('./apply.mjs');
  const byFile = {};
  for (const match of structural.matches) {
    if (!match.fix) continue;
    byFile[match.file] ||= [];
    byFile[match.file].push(match);
  }
  const outcome = await applyStructuralFixes({ cwd, matchesByFile: byFile, sessionId, signal });
  structural.applied = outcome.applied;
  if (outcome.rejected.length) structural.rejected = outcome.rejected;
  return structural;
}

async function scanAction({ cwd, scope, languageFilter, engineFilter, signal, startedAt }) {
  const detected = await detect({ cwd, scope, languageFilter, signal });
  const resolution = await resolveForRun({ cwd, detected, engineFilter, signal });
  return buildTidyReport({
    action: 'scan',
    languages: detected.languages,
    languageSource: detected.source,
    engines: resolution.engines,
    policy: resolution.policy,
    ...(scope.length ? { scope } : {}),
    notes: [
      ...(detected.note ? [detected.note] : []),
      ...(resolution.config.error ? [resolution.config.error] : []),
      ...(resolution.unknownEngines ? [`unknown engines ignored: ${resolution.unknownEngines.join(', ')}`] : []),
      ...(detected.languages.length === 0 ? ['no non-ignored file of a known language in scope'] : []),
      // Scan does not run structural rules, but an outdated binary that would
      // fail check/fix is named here so it cannot look like a clean project.
      ...(await outdatedGraphNote(detected)),
    ],
    elapsedMs: Date.now() - startedAt,
  });
}

async function runAction({ action, args, cwd, scope, languageFilter, engineFilter, sessionId, signal, startedAt }) {
  const apply = action === 'fix' && args.apply === true;
  const detected = await detect({ cwd, scope, languageFilter, signal });
  const resolved = await resolveForRun({ cwd, detected, engineFilter, signal });
  const { resolution, needsApproval, installed } = await satisfyMissingEngines({
    resolution: resolved,
    cwd,
    engineFilter,
    approveDownloads: args.approveDownloads === true,
    signal,
  });

  const { runEngineSuite } = await import('./run-engines.mjs');
  const results = await runEngineSuite({
    engines: runnableEngines(resolution.engines),
    files: detected.files,
    cwd,
    mode: action === 'fix' ? 'fix' : 'check',
    apply,
    signal,
    sessionId,
    extensions: detected.extensions,
  });

  const enginesFailed = results.some((result) => result.error || result.truncated);
  const structural =
    args.structural === false
      ? null
      : await runStructuralForDetected(detected, { cwd, apply: apply && !enginesFailed, sessionId, signal });

  rememberTidyRun(cwd, sessionId, {
    languages: detected.languages,
    languageSource: detected.source,
    engines: resolution.engines,
    policy: resolution.policy,
    results,
    structural,
    scope,
  });

  const report = buildTidyReport({
    action,
    languages: detected.languages,
    languageSource: detected.source,
    engines: resolution.engines,
    policy: resolution.policy,
    results,
    structural,
    needsApproval,
    installed: installed ? installed.engines : null,
    ...(scope.length ? { scope } : {}),
    notes: actionNotes({ detected, resolution, action, apply, installed }),
    offset: parseOffset(args.offset),
    limit: parseLimit(args.limit),
    elapsedMs: Date.now() - startedAt,
  });
  if (reportHasMore(report)) report.notes = [...(report.notes || []), PAGING_NOTE];
  return report;
}

function runStructuralForDetected(detected, { cwd, apply, sessionId, signal }) {
  return runStructural({
    cwd,
    files: detected.files,
    languages: detected.languages.map((language) => language.id),
    apply,
    sessionId,
    signal,
    graphBinPath: detected.graphBinPath,
    graphLangs: detected.graphLangs,
    extensions: detected.extensions,
  });
}

function actionNotes({ detected, resolution, action, apply, installed }) {
  return [
    ...(detected.note ? [detected.note] : []),
    ...(resolution.config.error ? [resolution.config.error] : []),
    ...(action === 'fix' && !apply ? ['dry run: pass apply:true to write these changes'] : []),
    ...(installed?.errors ? installed.errors.map((entry) => `${entry.id}: ${entry.error}`) : []),
  ];
}

async function resultsAction({ args, cwd, sessionId, engineFilter, pathFilter, startedAt }) {
  const cached = recallTidyRun(cwd, sessionId);
  if (!cached) {
    throw new TidyToolError('no stored tidy results for this session; run check or fix first');
  }
  let results = null;
  if (Array.isArray(cached.results)) {
    results = engineFilter.length ? cached.results.filter((row) => engineFilter.includes(row.id)) : cached.results;
  }
  const rules = list(args.rules);
  const prefixes = pathFilter.map((path) => path.replace(/\/+$/, ''));
  const matchesPath = (file) => {
    const path = matchFileKey(file, cwd);
    return !prefixes.length || prefixes.some(
      (prefix) => !prefix || prefix === '.' || path === prefix || path.startsWith(`${prefix}/`)
    );
  };
  const matchesRow = (row) =>
    (!rules.length || rules.includes(row.ruleId ?? row.code)) && matchesPath(row.file);
  let structural = args.structural === false ? null : cached.structural;
  if (rules.length || prefixes.length) {
    results = results?.map((result) => ({
      ...result,
      diagnostics: (result.diagnostics || []).filter(matchesRow),
      filesChanged: (result.filesChanged || []).filter(matchesPath),
    }));
    if (structural) structural = { ...structural, matches: (structural.matches || []).filter(matchesRow) };
  }
  return buildTidyReport({
    action: 'results',
    engines: cached.engines || [],
    results,
    structural,
    ...(cached.scope?.length ? { scope: cached.scope } : {}),
    notes: [
      'paged from the last check/fix; engines were not re-run',
      ...(rules.length || prefixes.length
        ? ['diagnosticsCount/matchesCount and byRule/byDir describe filtered rows; counts/filesChecked retain run totals']
        : []),
    ],
    offset: parseOffset(args.offset),
    limit: parseLimit(args.limit),
    elapsedMs: Date.now() - startedAt,
  });
}

async function installAction({ args, cwd, engineFilter, signal, startedAt }) {
  if (engineFilter.length === 0) throw new TidyToolError('install requires engines:[...]');
  const pluginData = await pluginDataDir();
  const manifest = readEnginesManifest();
  const resolution = await resolveEngines({
    cwd,
    engineIds: engineFilter,
    pluginData,
    manifest,
    probeVersions: false,
    signal,
  });
  const { installEngines } = await import('./install.mjs');
  const outcome = await installEngines({
    ids: engineFilter,
    manifest,
    pluginData,
    policy: resolution.policy.downloads,
    approveDownloads: args.approveDownloads === true,
    signal,
  });
  return buildTidyReport({
    action: 'install',
    ok: outcome.errors.length === 0,
    engines: resolution.engines,
    policy: resolution.policy,
    installed: outcome.installed,
    needsApproval: outcome.needsApproval,
    errors: outcome.errors,
    elapsedMs: Date.now() - startedAt,
  });
}

async function rulesAction({ cwd, signal, startedAt }) {
  const { loadRulePacks, resolveStructuralAdapter, StructuralEngineUnavailableError } = await import(
    './structural.mjs'
  );
  const { packs } = loadRulePacks();
  // Listing the packs still works without the engine; the report says so
  // explicitly (ok:false + the remedy) instead of showing a usable adapter.
  let adapter = null;
  let unavailable = '';
  try {
    adapter = await resolveStructuralAdapter({ cwd, graphBinPath: await graphBinary(), signal });
  } catch (error) {
    if (!(error instanceof StructuralEngineUnavailableError)) throw error;
    unavailable = error.message;
  }
  return buildTidyReport({
    action: 'rules',
    ok: !unavailable,
    rules: {
      adapter: adapter?.id || 'none',
      packs: packs.map((pack) => ({ id: pack.id, languages: pack.languages, rules: pack.rules })),
    },
    errors: unavailable ? [unavailable] : [],
    elapsedMs: Date.now() - startedAt,
  });
}

export async function executeTidyTool(args = {}, { cwd = process.cwd(), signal = null, sessionId = null } = {}) {
  const startedAt = Date.now();
  const action = clean(args.action).toLowerCase();
  try {
    if (!TIDY_ACTIONS.includes(action)) {
      throw new TidyToolError(`Unsupported tidy action "${action}"; use ${TIDY_ACTIONS.join(', ')}`);
    }
    const scope = normalizeScope(list(args.paths), cwd);
    if (['scan', 'check', 'fix'].includes(action) && scope.length === 0) {
      throw new TidyToolError(
        'paths requires a user-selected scope; ask for files or directories, or use "." for an explicitly requested whole project'
      );
    }
    const languageFilter = list(args.languages);
    const engineFilter = list(args.engines);
    if (action === 'scan') {
      return tidyToolResult(await scanAction({ cwd, scope, languageFilter, engineFilter, signal, startedAt }));
    }
    if (action === 'install') {
      return tidyToolResult(await installAction({ args, cwd, engineFilter, signal, startedAt }));
    }
    if (action === 'rules') {
      return tidyToolResult(await rulesAction({ cwd, signal, startedAt }));
    }
    if (action === 'results') {
      return tidyToolResult(await resultsAction({ args, cwd, sessionId, engineFilter, pathFilter: scope, startedAt }));
    }
    return tidyToolResult(
      await runAction({
        action,
        args,
        cwd,
        scope,
        languageFilter,
        engineFilter,
        sessionId,
        signal,
        startedAt,
      })
    );
  } catch (error) {
    return tidyToolResult(
      {
        ok: false,
        status: 'failed',
        action,
        error: error?.message || String(error),
        elapsedMs: Date.now() - startedAt,
      },
      true
    );
  }
}
