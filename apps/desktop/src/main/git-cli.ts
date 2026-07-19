// Dock Git panel backend (claudecodeui git-panel pattern): plain `git` CLI
// calls from the main process, scoped to the active project directory.
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface GitFileEntry {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
  additions: number;
  deletions: number;
}

export interface GitStatusResult {
  repository: boolean;
  branch: string;
  upstream: boolean;
  ahead: number;
  behind: number;
  files: GitFileEntry[];
}

function run(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd,
      windowsHide: true,
      maxBuffer: 16_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      if (error) reject(new Error(String(stderr || error.message).trim()));
      else resolve(String(stdout));
    });
  });
}

export function requiredRepositoryCwd(value: unknown): string {
  const cwd = typeof value === 'string' ? value.trim() : '';
  if (!cwd || !isAbsolute(cwd)) throw new TypeError('A project directory is required.');
  return cwd;
}

export async function gitStatus(cwd: string): Promise<GitStatusResult> {
  let branch = '';
  try {
    branch = (await run(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  } catch {
    return { repository: false, branch: '', upstream: false, ahead: 0, behind: 0, files: [] };
  }
  const raw = await run(cwd, ['status', '--porcelain=v1', '-z', '-b']);
  const files: GitFileEntry[] = [];
  let upstream = false;
  let ahead = 0;
  let behind = 0;
  const parts = raw.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.startsWith('## ')) {
      // `-b` header record: `## main...origin/main [ahead 1, behind 2]`.
      upstream = entry.includes('...');
      ahead = Number(/\[.*ahead (\d+)/.exec(entry)?.[1] || 0);
      behind = Number(/\[.*behind (\d+)/.exec(entry)?.[1] || 0);
      continue;
    }
    if (entry.length < 4) continue;
    const index = entry[0];
    const worktree = entry[1];
    const path = entry.slice(3);
    if (!path) continue;
    files.push({ path, index, worktree, untracked: index === '?' && worktree === '?', additions: 0, deletions: 0 });
    // -z rename/copy records append the OLD path as the next NUL field.
    if (index === 'R' || index === 'C') i += 1;
  }
  // aider-desk grammar: rows carry +/− stats. Numstat covers tracked files
  // (worktree vs HEAD); untracked files stay at 0/0.
  const stats = new Map<string, { additions: number; deletions: number }>();
  try {
    const numstat = await run(cwd, ['diff', 'HEAD', '--numstat', '-z']);
    const fields = numstat.split('\0').filter(Boolean);
    for (let i = 0; i < fields.length; i++) {
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(fields[i]);
      if (!match) continue;
      // A rename record has an empty path in the stat field; the two
      // following NUL fields carry old/new paths.
      let path = match[3];
      if (!path) {
        i += 2;
        path = fields[i] ?? '';
      }
      if (path) stats.set(path, {
        additions: match[1] === '-' ? 0 : Number(match[1]),
        deletions: match[2] === '-' ? 0 : Number(match[2]),
      });
    }
  } catch { /* empty repository (no HEAD yet) */ }
  for (const file of files) {
    const stat = stats.get(file.path);
    if (stat) { file.additions = stat.additions; file.deletions = stat.deletions; }
  }
  return { repository: true, branch, upstream, ahead, behind, files };
}

export function gitDiff(cwd: string, path: string, staged: boolean): Promise<string> {
  // Commit-all model (aider-desk): the working diff is always vs HEAD so
  // staged and unstaged edits read as one change.
  return run(cwd, ['diff', ...(staged ? ['--cached'] : ['HEAD']), '--', path]);
}

export async function gitStage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await run(cwd, ['add', '--', ...paths]);
}

export async function gitUnstage(cwd: string, paths: string[]): Promise<void> {
  if (paths.length) await run(cwd, ['reset', 'HEAD', '--', ...paths]);
}

export async function gitCommit(cwd: string, message: string): Promise<string> {
  const trimmed = message.trim();
  if (!trimmed) throw new TypeError('A commit message is required.');
  // Commit-all model (aider-desk/agent workflow): no staging surface in the
  // panel; a commit takes the whole working tree.
  await run(cwd, ['add', '-A']);
  return run(cwd, ['commit', '-m', trimmed]);
}

export async function gitRevertFile(cwd: string, path: string, untracked: boolean): Promise<void> {
  if (untracked) {
    // Untracked file: delete it (git clean keeps us inside repo semantics).
    await run(cwd, ['clean', '-f', '--', path]);
    return;
  }
  // Tracked file: restore index AND worktree from HEAD (full discard).
  await run(cwd, ['checkout', 'HEAD', '--', path]);
}

export async function gitPush(cwd: string): Promise<string> {
  // VSCode "publish branch" grammar: a branch without an upstream publishes
  // to origin, otherwise a plain push (terminal prompts are disabled).
  let hasUpstream = true;
  try {
    await run(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  } catch {
    hasUpstream = false;
  }
  return run(cwd, hasUpstream ? ['push'] : ['push', '-u', 'origin', 'HEAD']);
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{4,64}$/i;
export function requiredCommitHash(value: unknown): string {
  const hash = typeof value === 'string' ? value.trim() : '';
  if (!COMMIT_HASH_PATTERN.test(hash)) throw new TypeError('A commit hash is required.');
  return hash;
}

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  subject: string;
  when: string;
  pushed: boolean;
}

// History view (claudecodeui HistoryView grammar): recent commits with an
// unpushed marker so "committed but not pushed" is visible at a glance.
export async function gitLog(cwd: string): Promise<GitLogEntry[]> {
  let raw = '';
  try {
    raw = await run(cwd, ['log', '-n', '30', '--pretty=format:%H%x1f%h%x1f%s%x1f%cr']);
  } catch {
    return []; // Empty repository (no commits yet).
  }
  let unpushed: Set<string> | 'all' = 'all';
  try {
    unpushed = new Set((await run(cwd, ['rev-list', '@{u}..HEAD'])).split(/\s+/).filter(Boolean));
  } catch {
    unpushed = 'all'; // No upstream: every commit is local-only.
  }
  return raw.split('\n').filter(Boolean).map((line) => {
    const [hash = '', shortHash = '', subject = '', when = ''] = line.split('\u001f');
    return {
      hash,
      shortHash,
      subject,
      when,
      pushed: unpushed === 'all' ? false : !unpushed.has(hash),
    };
  });
}

export function gitShow(cwd: string, hash: string): Promise<string> {
  return run(cwd, ['show', hash, '--patch', '--format=', '--no-color']);
}
