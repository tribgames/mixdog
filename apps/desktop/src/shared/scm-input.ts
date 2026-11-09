// The argument grammar of the source-control calls (git, GitHub login), shared by the host (main/ipc-validation.ts re-exports it) and
// the phone's protocol adapter (renderer/remote-protocol-scm.ts), so a malformed call fails with the same text on both.
import { DESKTOP_GIT_GLOBAL_CONFIG_KEYS, type DesktopGitGlobalConfigKey } from './contract';
import { isAbsolutePath } from './git-contract.mjs';

/** Optional `{ openBrowser?: boolean }` for GitHub CLI sign-in. */
export function optionalGithubLoginOptions(value: unknown): { openBrowser?: boolean } {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) throw new TypeError('options must be an object.');
  const { openBrowser } = value as { openBrowser?: unknown };
  if (openBrowser !== undefined && typeof openBrowser !== 'boolean') {
    throw new TypeError('openBrowser must be a boolean.');
  }
  return openBrowser === undefined ? {} : { openBrowser };
}

export function requiredString(value: unknown, name: string, maximum = 32_768): string {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string.`);
  const text = value.trim();
  if (!text || text.length > maximum) throw new TypeError(`${name} is invalid.`);
  return text;
}

export function requiredGitGlobalConfigKey(value: unknown): DesktopGitGlobalConfigKey {
  if (typeof value === 'string' && (DESKTOP_GIT_GLOBAL_CONFIG_KEYS as readonly string[]).includes(value)) {
    return value as DesktopGitGlobalConfigKey;
  }
  throw new TypeError('key must be user.name, user.email, or init.defaultBranch.');
}

export function requiredGitPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw new TypeError('git paths are invalid.');
  }
  return value.map(requiredGitPath);
}

/** Island Git request: the listed files (may be empty) and an optional base branch. */
export function requiredGitRequestContextInput(value: unknown): { paths: string[]; base: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('git request input is invalid.');
  const { paths, base } = value as Record<string, unknown>;
  if (!Array.isArray(paths) || paths.length > 500) throw new TypeError('git paths are invalid.');
  return {
    paths: paths.map(requiredGitPath),
    base: base === undefined || base === '' ? '' : requiredGitBranchName(base),
  };
}

export function requiredReviewDiffFiles(value: unknown): { path: string; untracked: boolean }[] {
  if (!Array.isArray(value) || value.length > 512) throw new TypeError('git review files are invalid.');
  return value.map((entry) => {
    if (typeof entry !== 'object' || entry === null) throw new TypeError('git review file is invalid.');
    const { path, untracked } = entry as { path?: unknown; untracked?: unknown };
    return { path: requiredGitPath(path), untracked: untracked === true };
  });
}

export function requiredGitPath(value: unknown): string {
  const path = requiredString(value, 'git path', 4_096);
  if (
    isAbsolutePath(path) ||
    path.includes('\0') ||
    path
      .replace(/\\/g, '/')
      .split('/')
      .some((part) => part === '..')
  ) {
    throw new TypeError('git path is invalid.');
  }
  return path;
}

export function requiredGitPatch(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4_000_000 || value.includes('\0')) {
    throw new TypeError('git patch is invalid.');
  }
  return value;
}

export function requiredGitDiscardMode(value: unknown): 'worktree' | 'all' {
  if (value === undefined || value === 'all') return 'all';
  if (value === 'worktree') return 'worktree';
  throw new TypeError('git discard mode is invalid.');
}

export function requiredGitBranchName(value: unknown): string {
  const branch = requiredString(value, 'git branch', 512);
  if (branch.startsWith('-') || branch.includes('\0') || /[\r\n]/.test(branch)) {
    throw new TypeError('git branch is invalid.');
  }
  return branch;
}

export function requiredGitOptionalMessage(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 20_000 || value.includes('\0')) {
    throw new TypeError('git message is invalid.');
  }
  return value.trim();
}

export function requiredGitLogQuery(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.length > 200 || value.includes('\0')) {
    throw new TypeError('git history query is invalid.');
  }
  return value.trim();
}

export function requiredGitLogOffset(value: unknown): number {
  if (value === undefined || value === null) return 0;
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1_000_000) {
    throw new TypeError('git history offset is invalid.');
  }
  return offset;
}

export function requiredGitLogLimit(value: unknown): number {
  if (value === undefined || value === null) return 40;
  const limit = Number(value);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('git history limit is invalid.');
  }
  return limit;
}
