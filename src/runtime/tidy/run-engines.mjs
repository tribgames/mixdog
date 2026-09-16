// Engine execution. Each engine sees only the files of ITS languages inside the
// requested scope, runs with a timeout, and runs concurrently with the others —
// except in apply mode, where engines run one at a time so two formatters can
// never write the same file at once.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { filesForLanguages } from './languages.mjs';
import { mapLimit } from './process.mjs';
import { runnerFor } from './runners/index.mjs';
import { DEFAULT_ENGINE_TIMEOUT_MS } from './runners/shared.mjs';
import { fullPathFor, guardTidyWritePath, noteWrittenFiles } from './apply.mjs';

const CHECK_CONCURRENCY = 3;

function fileDigest(fullPath) {
  try { return createHash('sha256').update(readFileSync(fullPath)).digest('hex'); } catch { return ''; }
}

/** Files an engine's check pass says it would rewrite, plus fixable findings. */
export function fixCandidates(checkResult) {
  const candidates = new Set(checkResult?.changedFiles || []);
  for (const finding of checkResult?.diagnostics || []) {
    if (finding?.fixable && finding.file) candidates.add(finding.file);
  }
  return [...candidates];
}

async function runOne({ engine, files, cwd, mode, apply, timeoutMs, signal, sessionId, extensions }) {
  const base = { id: engine.id, source: engine.source, ...(engine.version ? { version: engine.version } : {}) };
  const runner = runnerFor(engine.id);
  if (!runner) return { ...base, filesChecked: 0, filesChanged: [], diagnostics: [], skipped: 'no runner for this engine in this build' };
  const scope = filesForLanguages(files, engine.languages, extensions);
  if (scope.length === 0) return { ...base, filesChecked: 0, filesChanged: [], diagnostics: [] };

  const checkResult = await runner.check({ files: scope, cwd, bin: engine.command, args: engine.args || [], timeoutMs, signal });
  const result = {
    ...base,
    filesChecked: scope.length,
    filesChanged: checkResult.changedFiles || [],
    diagnostics: checkResult.diagnostics || [],
    ...(checkResult.stderrTail ? { stderrTail: checkResult.stderrTail } : {}),
  };
  if (mode !== 'fix' || !apply) {
    if (mode === 'fix') result.dryRun = true;
    return result;
  }

  const candidates = fixCandidates(checkResult).filter((file) => !guardTidyWritePath(fullPathFor(cwd, file)));
  if (candidates.length === 0) {
    result.applied = true;
    result.filesChanged = [];
    return result;
  }
  const before = new Map(candidates.map((file) => [file, fileDigest(fullPathFor(cwd, file))]));
  const fixResult = await runner.fix({ files: candidates, cwd, bin: engine.command, args: engine.args || [], timeoutMs, signal });
  const changed = candidates.filter((file) => fileDigest(fullPathFor(cwd, file)) !== before.get(file));
  // The engine wrote in place; run the same invalidation trio a pipeline write
  // would have run for each file it touched.
  noteWrittenFiles(changed.map((file) => fullPathFor(cwd, file)), { sessionId });
  result.applied = true;
  result.filesChanged = changed;
  if (fixResult?.stderrTail) result.stderrTail = fixResult.stderrTail;
  if (fixResult?.diagnostics?.length) result.diagnostics = fixResult.diagnostics;
  return result;
}

/**
 * Run every runnable engine over `files`.
 * `mode` is 'check' or 'fix'; a fix without `apply` is a dry run (check only).
 */
export async function runEngineSuite({
  engines = [],
  files = [],
  cwd,
  mode = 'check',
  apply = false,
  timeoutMs = DEFAULT_ENGINE_TIMEOUT_MS,
  signal = null,
  sessionId = null,
  // The capability table detection classified the files with, so an engine sees
  // exactly the files the report counted for its languages.
  extensions = null,
} = {}) {
  const concurrency = apply ? 1 : CHECK_CONCURRENCY;
  return mapLimit(engines, concurrency, async (engine) => {
    try {
      return await runOne({ engine, files, cwd, mode, apply, timeoutMs, signal, sessionId, extensions });
    } catch (error) {
      return {
        id: engine.id,
        source: engine.source,
        filesChecked: 0,
        filesChanged: [],
        diagnostics: [],
        error: error?.message || String(error),
      };
    }
  });
}
