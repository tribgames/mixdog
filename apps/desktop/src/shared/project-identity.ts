/** Comparison key for a project path: separators unified, trailing slash and
 *  surrounding whitespace dropped, case folded (Windows paths are
 *  case-insensitive). The one identity every project lookup compares by. */
export function projectIdentity(path: unknown): string {
  return String(path || '')
    .trim()
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLocaleLowerCase();
}

/** Whether `path` is the project folder itself or inside it. Both sides are
 *  project identities (already normalized). */
function identityContains(projectKey: string, pathKey: string): boolean {
  return Boolean(projectKey) && (pathKey === projectKey || pathKey.startsWith(`${projectKey}/`));
}

/** Identity of the registered project a session belongs to, or '': the
 *  deepest project containing the session's project, its managed-worktree
 *  project, or its folder. */
export function sessionProjectKey(
  session: {
    projectPath?: string | null;
    cwd?: string;
    workspace?: { projectPath?: string; cwd?: string } | null;
  },
  projectKeys: readonly string[]
): string {
  const candidates = [session.workspace?.projectPath, session.projectPath, session.cwd, session.workspace?.cwd]
    .map(projectIdentity)
    .filter(Boolean);
  let best = '';
  for (const key of projectKeys) {
    if (key.length > best.length && candidates.some((candidate) => identityContains(key, candidate))) best = key;
  }
  return best;
}
