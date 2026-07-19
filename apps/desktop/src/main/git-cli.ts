// Dock Git panel backend (claudecodeui git-panel pattern): plain `git` CLI
// calls from the main process, scoped to the active project directory.
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface GitFileEntry {
  path: string;
  index: string;
  worktree: string;
  untracked: boolean;
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
    files.push({ path, index, worktree, untracked: index === '?' && worktree === '?' });
    // -z rename/copy records append the OLD path as the next NUL field.
    if (index === 'R' || index === 'C') i += 1;
  }
  return { repository: true, branch, upstream, ahead, behind, files };
}

export function gitDiff(cwd: string, path: string, staged: boolean): Promise<string> {
  return run(cwd, ['diff', ...(staged ? ['--cached'] : []), '--', path]);
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
  return run(cwd, ['commit', '-m', trimmed]);
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
