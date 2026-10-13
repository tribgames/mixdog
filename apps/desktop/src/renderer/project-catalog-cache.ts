import type { DesktopProjectSummary } from '../shared/contract';
import { projectIdentity } from '../shared/project-identity';
import { catalogStorageKey } from './catalog-storage-scope';

export { projectIdentity };

export const PROJECT_CATALOG_CACHE_KEY = 'mixdog.desktop-project-catalog.v1';

type ProjectCatalogStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** Whether `path` is the project folder itself or inside it. Both sides are
 *  project identities (already normalized). */
function identityContains(projectKey: string, pathKey: string): boolean {
  return Boolean(projectKey) && (pathKey === projectKey || pathKey.startsWith(`${projectKey}/`));
}

/** Identity of the registered project a session belongs to, or ''. A user
 *  assignment ('' = none) wins while its project is still registered;
 *  otherwise the deepest project containing the session's project, its
 *  managed-worktree project, or its folder wins. */
export function sessionProjectKey(
  session: {
    projectPath?: string | null;
    cwd?: string;
    projectAssignment?: string;
    workspace?: { projectPath?: string; cwd?: string } | null;
  },
  projectKeys: readonly string[]
): string {
  if (typeof session.projectAssignment === 'string') {
    const assigned = projectIdentity(session.projectAssignment);
    if (!assigned) return '';
    if (projectKeys.includes(assigned)) return assigned;
  }
  const candidates = [session.workspace?.projectPath, session.projectPath, session.cwd, session.workspace?.cwd]
    .map(projectIdentity)
    .filter(Boolean);
  let best = '';
  for (const key of projectKeys) {
    if (key.length > best.length && candidates.some((candidate) => identityContains(key, candidate))) best = key;
  }
  return best;
}

function normalizeProjectCatalog(value: unknown): DesktopProjectSummary[] {
  if (!Array.isArray(value)) return [];
  const projects: DesktopProjectSummary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Partial<DesktopProjectSummary>;
    const path = typeof row.path === 'string' ? row.path.trim() : '';
    const identity = projectIdentity(path);
    if (!path || !identity || seen.has(identity)) continue;
    seen.add(identity);
    projects.push({
      path,
      name: typeof row.name === 'string' ? row.name : '',
      alias: typeof row.alias === 'string' ? row.alias : null,
    });
    if (projects.length >= 128) break;
  }
  return projects;
}

export function readCachedProjectCatalog(
  storage: ProjectCatalogStorage = window.localStorage
): DesktopProjectSummary[] {
  try {
    const raw = storage.getItem(catalogStorageKey(PROJECT_CATALOG_CACHE_KEY));
    return raw ? normalizeProjectCatalog(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeCachedProjectCatalog(
  projects: readonly DesktopProjectSummary[],
  storage: ProjectCatalogStorage = window.localStorage
): void {
  try {
    storage.setItem(catalogStorageKey(PROJECT_CATALOG_CACHE_KEY), JSON.stringify(normalizeProjectCatalog(projects)));
  } catch {
    // Catalog persistence only accelerates the next mobile boot.
  }
}

export function acceptedProjectCatalog(value: unknown, acceptEmpty: boolean): DesktopProjectSummary[] | null {
  const projects = normalizeProjectCatalog(value);
  return projects.length || acceptEmpty ? projects : null;
}

export function resolveProjectPathAgainstCatalog(
  requestedPath: string,
  catalogValidated: boolean,
  registeredPath: string,
  fallbackPath: string
): string {
  if (!requestedPath || !catalogValidated) return requestedPath;
  return registeredPath || fallbackPath;
}
