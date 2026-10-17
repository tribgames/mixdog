import { createHash } from 'node:crypto';
import { isAbsolute, resolve, sep } from 'node:path';

export const MAX_SELECTED_FILE_GRANTS = 100;

export const comparablePath = (path: string): string =>
  process.platform === 'win32' ? path.toLocaleLowerCase() : path;

/** The deepest registered project that contains the file, or null when it
 *  lies outside every project (such a file needs a one-off grant). */
export function owningProject<T extends { path: string }>(
  projects: readonly T[],
  absolutePath: string
): { project: T; root: string } | null {
  const file = comparablePath(absolutePath);
  return (
    projects
      .map((project) => ({ project, root: resolve(project.path) }))
      .filter(({ root }) => {
        const normalizedRoot = comparablePath(root);
        return file.startsWith(normalizedRoot + sep) || file === normalizedRoot;
      })
      .sort((left, right) => right.root.length - left.root.length)[0] ?? null
  );
}

/** Whether a requested path is exactly the file a grant names. */
export function sameGrantedPath(granted: string, requested: string): boolean {
  return comparablePath(requested) === comparablePath(granted);
}

export function selectedFileGrantKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function parseSelectedFileGrants(text: string): {
  grants: Map<string, string>;
  migrated: boolean;
} {
  const grants = new Map<string, string>();
  let migrated = false;
  const rows = JSON.parse(text) as unknown;
  if (!Array.isArray(rows)) return { grants, migrated };
  for (const row of rows.slice(-MAX_SELECTED_FILE_GRANTS)) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    const file = String(record.file || '');
    if (!isAbsolute(file)) continue;
    const tokenHash = String(record.tokenHash || '');
    if (/^[0-9a-f]{64}$/.test(tokenHash)) {
      grants.set(tokenHash, resolve(file));
      continue;
    }
    const legacyToken = String(record.token || '');
    if (!legacyToken) continue;
    grants.set(selectedFileGrantKey(legacyToken), resolve(file));
    migrated = true;
  }
  return { grants, migrated };
}

export function serializeSelectedFileGrants(grants: Map<string, string>): string {
  return JSON.stringify(
    [...grants.entries()].slice(-MAX_SELECTED_FILE_GRANTS).map(([tokenHash, file]) => ({ tokenHash, file }))
  );
}
