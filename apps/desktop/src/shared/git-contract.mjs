// Git argument grammar shared by the desktop's host (main/git-contract.mjs re-exports it) and the phone's protocol adapter
// (renderer/remote-protocol-scm.ts): no Node imports, so the web build can take it.

/** `path.isAbsolute` on the PC's platform. `family` is the `platformFamily` the PC's core named in `initialize` ('windows' or
 *  'unix'): on a PC running Windows `/x`, `\x`, `\\host\share`, `C:\x` and `C:/x` are absolute (node:path's win32 rule), on any
 *  other only `/x` is. Without one (the desktop's own host) the win32 rule applies, which holds every posix-absolute path too. */
export function isAbsolutePath(value, family = 'windows') {
  return family === 'windows' ? /^(?:[A-Za-z]:[\\/]|[\\/])/.test(value) : value.startsWith('/');
}

export function requiredRepositoryCwd(value, family) {
  const cwd = typeof value === 'string' ? value.trim() : '';
  if (!cwd || !isAbsolutePath(cwd, family)) throw new TypeError('A project directory is required.');
  return cwd;
}

export function requiredGitIgnoreScope(value) {
  if (value === undefined || value === 'file') return 'file';
  if (value === 'extension') return 'extension';
  throw new TypeError('Git ignore scope is invalid.');
}

/** Changes-view source; omitted means the cumulative `branch` view. */
export function requiredReviewSource(value) {
  if (value === undefined || value === 'branch') return 'branch';
  if (value === 'uncommitted') return 'uncommitted';
  throw new TypeError('Git review source is invalid.');
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
