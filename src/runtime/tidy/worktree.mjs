// Where a run's findings sit in the working tree: files the caller (or someone
// else) has already modified or left untracked, versus files that are clean in
// the repository.
//
// `fix apply:true` writes every fixable finding inside the caller's paths, so a
// directory scope rewrites files nobody touched — two build scripts that were
// already non-conforming in HEAD had to be reverted by hand. Scope still comes
// from `paths` and nothing here derives one from a diff: the split is a report
// the caller reads before writing, so they can pass a precise file list.
import { runProcess, which } from './process.mjs';

const GIT_STATUS_TIMEOUT_MS = 20_000;
export const NO_GIT_REASON = 'git is not installed';

function normalizeRel(value) {
  return String(value || '')
    .replaceAll('\\', '/')
    .replace(/^\.\//, '');
}

// Porcelain paths are repository-root relative; a cwd below the root rebases
// them and drops whatever sits outside, since no scoped file can match it.
function addRelative(files, raw, prefix) {
  const path = normalizeRel(raw);
  if (!path) return;
  if (!prefix) {
    files.add(path);
    return;
  }
  if (path.startsWith(prefix)) files.add(path.slice(prefix.length));
}

/**
 * Files git reports as changed — staged, unstaged, or untracked — relative to
 * `cwd`.
 *
 * Two ways there is no split, kept apart on purpose. No git on PATH is the
 * expected case for someone who does not use git: a filesystem lookup catches
 * it, nothing is spawned, and it comes back `skipped` with no error. Git that
 * cannot answer (not a repository, permissions, timeout) is unexpected and
 * comes back with the `error`, so the caller hears about it. Either way
 * `files` is null and the caller reports that instead of calling everything
 * clean.
 */
export async function listWorkingTreeChanges({
  cwd,
  signal = null,
  timeoutMs = GIT_STATUS_TIMEOUT_MS,
  env = process.env,
} = {}) {
  if (!which('git', { env })) return { files: null, error: '', skipped: NO_GIT_REASON };
  const [status, prefix] = await Promise.all([
    runProcess(
      'git',
      ['-c', 'core.quotepath=false', '--literal-pathspecs', 'status', '--porcelain', '-z', '--untracked-files=all'],
      { cwd, signal, timeoutMs, env }
    ),
    runProcess('git', ['rev-parse', '--show-prefix'], { cwd, signal, timeoutMs, env }),
  ]);
  const failed = [status, prefix].find((result) => result.code !== 0);
  if (failed) {
    return {
      files: null,
      error: failed.stderr.trim().slice(0, 200) || failed.error || `git status exited ${failed.code}`,
    };
  }
  const showPrefix = normalizeRel(prefix.stdout.trim());
  const base = showPrefix && !showPrefix.endsWith('/') ? `${showPrefix}/` : showPrefix;
  const records = status.stdout.split('\0');
  const files = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length < 4) continue;
    // `R`/`C` in the index column: the record after this one is the old path,
    // and that path is a working-tree change too.
    if (record[0] === 'R' || record[0] === 'C') {
      index += 1;
      addRelative(files, records[index], base);
    }
    addRelative(files, record.slice(3), base);
  }
  return { files, error: '' };
}

/**
 * Split the files a run produced findings for.
 * `findings` maps a project-relative path to the number of rows on it;
 * `changed` is the set from listWorkingTreeChanges.
 */
export function splitFindingsByWorktree(findings, changed) {
  const modified = { files: [], findings: 0 };
  const clean = { files: [], findings: 0 };
  for (const [file, count] of [...findings.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const group = changed.has(file) ? modified : clean;
    group.files.push(file);
    group.findings += count;
  }
  return { modified, clean };
}

/** What a caller has to know before `apply:true` writes outside their edits. */
export function worktreeNotes(workingTree, action) {
  if (!workingTree) return [];
  // No git is not a problem to warn about on every run; a git that cannot
  // answer is.
  if (workingTree.skipped) return [];
  if (workingTree.error) return [`working-tree split unavailable: ${workingTree.error}`];
  const clean = workingTree.clean?.files?.length || 0;
  if (clean === 0) return [];
  const writes = action === 'fix' ? 'apply:true writes them too' : 'a fix apply:true would write them too';
  return [
    `workingTree.clean: ${clean} file(s) with findings are unmodified in the repository; ${writes} — pass those files in paths only when you mean to touch them`,
  ];
}
