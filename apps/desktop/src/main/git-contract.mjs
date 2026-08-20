import { isAbsolute } from 'node:path';

export function requiredRepositoryCwd(value) {
  const cwd = typeof value === 'string' ? value.trim() : '';
  if (!cwd || !isAbsolute(cwd)) throw new TypeError('A project directory is required.');
  return cwd;
}

export function requiredGitIgnoreScope(value) {
  if (value === undefined || value === 'file') return 'file';
  if (value === 'extension') return 'extension';
  throw new TypeError('Git ignore scope is invalid.');
}

const COMMIT_HASH_PATTERN = /^[0-9a-f]{4,64}$/i;
export function requiredCommitHash(value) {
  const hash = typeof value === 'string' ? value.trim() : '';
  if (!COMMIT_HASH_PATTERN.test(hash)) throw new TypeError('A commit hash is required.');
  return hash;
}

export function requiredGitResetMode(value) {
  if (value === 'soft' || value === 'mixed' || value === 'hard') return value;
  throw new TypeError('Git reset mode is invalid.');
}

/** Diff-tab editor mode revision: `HEAD`/`:0` (index) or a commit hash,
 *  optionally `^`-suffixed for its first parent. */
export function requiredGitRevision(value) {
  const rev = typeof value === 'string' ? value.trim() : '';
  if (!rev || rev.length > 128) throw new TypeError('A git revision is required.');
  if (rev === 'HEAD' || rev === ':0') return rev;
  const parent = rev.endsWith('^');
  return `${requiredCommitHash(parent ? rev.slice(0, -1) : rev)}${parent ? '^' : ''}`;
}
