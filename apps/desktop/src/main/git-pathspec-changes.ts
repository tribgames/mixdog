// The files a pathspec-taking Git call would actually touch, read from Git
// itself so a folder, `.` or a glob is expanded exactly as `git add`,
// `git commit -- <paths>`, `git restore` and `git clean` expand it. A remote
// device's staging, path commit and discard check this list for secrets.
import { resolve } from 'node:path';

import { run } from './git-runner';

const names = (output: string): string[] => output.split('\0').filter(Boolean);

/** Absolute paths of every file under `paths` (pathspecs relative to `cwd`)
 *  that differs from the index or HEAD: changed or deleted tracked files,
 *  untracked files Git does not ignore, and staged changes. */
export async function gitPathspecChanges(cwd: string, paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const root = (await run(cwd, ['rev-parse', '--show-toplevel'])).trim();
  const [worktree, staged] = await Promise.all([
    run(cwd, [
      'ls-files',
      '-z',
      '--full-name',
      '--modified',
      '--deleted',
      '--others',
      '--exclude-standard',
      '--',
      ...paths,
    ]),
    // An unborn branch has no HEAD to diff the index against: everything in
    // the index is staged.
    run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z', '--', ...paths]).catch(() =>
      run(cwd, ['ls-files', '-z', '--full-name', '--cached', '--', ...paths])
    ),
  ]);
  return [...new Set([...names(worktree), ...names(staged)])].map((path) => resolve(root, path));
}
