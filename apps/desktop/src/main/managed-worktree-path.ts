// A managed worktree is a folder a Lead session may execute in. It is never a
// Project: the host accepts such a folder only when the worktree manager's
// registry lists it AND its entry points at a registered Project. Any other
// directory keeps the "Project is not available" rejection.
import { realpath, stat } from 'node:fs/promises';
import { sep } from 'node:path';

import { type ManagedWorktreeEntry, normalizedProjectKey, type MixdogWorktreesModule } from './desktop-support';

export interface ManagedWorktreeScope {
  /** Registered Project (main repository) that owns the worktree. */
  projectPath: string;
  /** Canonical execution root: the worktree folder, or the subfolder of it a
   *  Project registered below the repository root runs in. */
  path: string;
}

async function canonicalDirectoryOrNull(path: string): Promise<string | null> {
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

/** The managed worktree at `requestedPath` — its folder, or the same subfolder
 *  a Project registered below the repository root runs in — or null for
 *  anything else. */
export async function resolveManagedWorktree(
  loadWorktrees: (() => Promise<MixdogWorktreesModule>) | undefined,
  knownProject: (projectPath: string) => Promise<string>,
  requestedPath: string
): Promise<ManagedWorktreeScope | null> {
  const requested = requestedPath.trim();
  if (!loadWorktrees || !requested) return null;
  const path = await canonicalDirectoryOrNull(requested);
  if (!path) return null;
  let entry: ManagedWorktreeEntry | null;
  try {
    const worktrees = await loadWorktrees();
    entry = await (worktrees.findWorktreeContaining ?? worktrees.getWorktreeByPath)(path);
  } catch {
    // An unreadable registry proves nothing: the folder stays rejected.
    return null;
  }
  if (!entry || (entry.state !== undefined && entry.state !== 'ready')) return null;
  if (typeof entry.path !== 'string' || typeof entry.projectPath !== 'string') return null;
  const entryPath = await canonicalDirectoryOrNull(entry.path);
  if (!entryPath) return null;
  const entryKey = normalizedProjectKey(entryPath);
  const key = normalizedProjectKey(path);
  if (key !== entryKey && !key.startsWith(`${entryKey}${sep}`)) return null;
  try {
    return { projectPath: await knownProject(entry.projectPath), path };
  } catch {
    return null;
  }
}
