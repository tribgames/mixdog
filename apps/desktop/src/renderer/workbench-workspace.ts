import { useMemo, useState } from 'react';

import type {
  DesktopWorkspace,
  DesktopWorkspaceFolder,
} from '../shared/contract';

const WORKBENCH_WORKSPACE_KEY = 'mixdog.desktop-workbench-workspace.v1';

function pathKey(path: string): string {
  return path.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLocaleLowerCase();
}

function folderName(path: string): string {
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path;
}

export function normalizedWorkspace(value: unknown): DesktopWorkspace | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.folders)) return null;
  const seen = new Set<string>();
  const folders: DesktopWorkspaceFolder[] = [];
  for (const value of record.folders.slice(0, 64)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    const path = typeof row.path === 'string' ? row.path.trim() : '';
    const key = pathKey(path);
    if (!path || seen.has(key)) continue;
    seen.add(key);
    folders.push({
      path,
      ...(typeof row.name === 'string' && row.name.trim()
        ? { name: row.name.trim() }
        : {}),
    });
  }
  const workspaceFile = typeof record.workspaceFile === 'string'
    && record.workspaceFile.trim()
    ? record.workspaceFile.trim()
    : undefined;
  const kind = workspaceFile || folders.length > 1 ? 'workspace'
    : folders.length === 1 ? 'folder'
      : 'empty';
  return {
    kind,
    name: typeof record.name === 'string' && record.name.trim()
      ? record.name.trim()
      : workspaceFile
        ? folderName(workspaceFile).replace(/\.code-workspace$/i, '')
        : folders.length === 1
          ? folders[0].name || folderName(folders[0].path)
          : 'Project',
    ...(workspaceFile ? { workspaceFile } : {}),
    folders,
  };
}

function readStoredWorkspace(): DesktopWorkspace | null {
  try {
    const raw = window.localStorage.getItem(WORKBENCH_WORKSPACE_KEY);
    return raw ? normalizedWorkspace(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

/**
 * The multi-root Project model consumed by the shell (editor settings scope,
 * dock search roots). It is READ-ONLY here on purpose: this build ships no
 * Project open/add/remove/save/close surface, so the mutators — and the
 * write-back that only ever rewrote what it had just read — were removed
 * instead of being left consumerless. An explicit Project persisted by an
 * older build still restores; the entry points return together with the
 * multi-root UI that can address individual folders.
 */
export function useWorkbenchWorkspace(fallbackFolder: string) {
  const [explicitWorkspace] = useState<DesktopWorkspace | null>(readStoredWorkspace);

  const workspace = useMemo<DesktopWorkspace>(() => {
    if (explicitWorkspace) return explicitWorkspace;
    const path = fallbackFolder.trim();
    return path
      ? {
        kind: 'folder',
        name: folderName(path),
        folders: [{ path }],
      }
      : {
        kind: 'empty',
        name: 'Project',
        folders: [],
      };
  }, [explicitWorkspace, fallbackFolder]);

  return { workspace };
}
