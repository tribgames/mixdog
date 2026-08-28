import type { DesktopProjectSummary } from "../shared/contract";

export const PROJECT_CATALOG_CACHE_KEY = "mixdog.desktop-project-catalog.v1";

type ProjectCatalogStorage = Pick<Storage, "getItem" | "setItem">;

function normalizedPath(path: string): string {
  return path.replace(/[\\/]+/g, "/").replace(/\/$/, "").toLocaleLowerCase();
}

export function normalizeProjectCatalog(value: unknown): DesktopProjectSummary[] {
  if (!Array.isArray(value)) return [];
  const projects: DesktopProjectSummary[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object") continue;
    const row = item as Partial<DesktopProjectSummary>;
    const path = typeof row.path === "string" ? row.path.trim() : "";
    const identity = normalizedPath(path);
    if (!path || !identity || seen.has(identity)) continue;
    seen.add(identity);
    projects.push({
      path,
      name: typeof row.name === "string" ? row.name : "",
      alias: typeof row.alias === "string" ? row.alias : null,
    });
    if (projects.length >= 128) break;
  }
  return projects;
}

export function readCachedProjectCatalog(
  storage: ProjectCatalogStorage = window.localStorage,
): DesktopProjectSummary[] {
  try {
    const raw = storage.getItem(PROJECT_CATALOG_CACHE_KEY);
    return raw ? normalizeProjectCatalog(JSON.parse(raw)) : [];
  } catch {
    return [];
  }
}

export function writeCachedProjectCatalog(
  projects: readonly DesktopProjectSummary[],
  storage: ProjectCatalogStorage = window.localStorage,
): void {
  try {
    storage.setItem(
      PROJECT_CATALOG_CACHE_KEY,
      JSON.stringify(normalizeProjectCatalog(projects)),
    );
  } catch {
    // Catalog persistence only accelerates the next mobile boot.
  }
}

export function acceptedProjectCatalog(
  value: unknown,
  acceptEmpty: boolean,
): DesktopProjectSummary[] | null {
  const projects = normalizeProjectCatalog(value);
  return projects.length || acceptEmpty ? projects : null;
}

export function resolveProjectPathAgainstCatalog(
  requestedPath: string,
  catalogValidated: boolean,
  registeredPath: string,
  fallbackPath: string,
): string {
  if (!requestedPath || !catalogValidated) return requestedPath;
  return registeredPath || fallbackPath;
}
