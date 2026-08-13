import { useCallback, useEffect, useMemo, useState } from 'react';

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

export function workspaceWithFolder(
  workspace: DesktopWorkspace,
  folder: DesktopWorkspaceFolder,
): DesktopWorkspace {
  const folders = [...workspace.folders];
  const existing = folders.findIndex((entry) => pathKey(entry.path) === pathKey(folder.path));
  if (existing >= 0) folders[existing] = { ...folders[existing], ...folder };
  else folders.push(folder);
  return {
    ...workspace,
    kind: workspace.workspaceFile || folders.length > 1 ? 'workspace' : 'folder',
    name: workspace.workspaceFile
      ? workspace.name
      : folders.length === 1 ? folders[0].name || folderName(folders[0].path) : 'Untitled Project',
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

export function useWorkbenchWorkspace(fallbackFolder: string) {
  const [explicitWorkspace, setExplicitWorkspace] = useState<DesktopWorkspace | null>(
    readStoredWorkspace,
  );
  useEffect(() => {
    try {
      if (explicitWorkspace) {
        window.localStorage.setItem(
          WORKBENCH_WORKSPACE_KEY,
          JSON.stringify(explicitWorkspace),
        );
      } else {
        window.localStorage.removeItem(WORKBENCH_WORKSPACE_KEY);
      }
    } catch {
      // Workspace persistence is a convenience only.
    }
  }, [explicitWorkspace]);

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

  const openFolder = useCallback(async () => {
    const api = window.mixdogDesktop;
    const path = await api?.chooseProject();
    if (!path) return;
    await api?.addProject(path);
    setExplicitWorkspace({
      kind: 'folder',
      name: folderName(path),
      folders: [{ path }],
    });
  }, []);

  const openWorkspace = useCallback(async () => {
    const next = await window.mixdogDesktop?.chooseWorkspace?.();
    if (next) setExplicitWorkspace(next);
  }, []);

  const addFolder = useCallback(async () => {
    const api = window.mixdogDesktop;
    const path = await api?.chooseProject();
    if (!path) return;
    await api?.addProject(path);
    setExplicitWorkspace((current) => workspaceWithFolder(
      current ?? workspace,
      { path },
    ));
  }, [workspace]);

  const removeFolder = useCallback((path: string) => {
    setExplicitWorkspace((current) => {
      const source = current ?? workspace;
      const folders = source.folders.filter((folder) => pathKey(folder.path) !== pathKey(path));
      return {
        ...source,
        kind: source.workspaceFile || folders.length > 1 ? 'workspace'
          : folders.length === 1 ? 'folder' : 'empty',
        name: source.workspaceFile
          ? source.name
          : folders.length === 1 ? folders[0].name || folderName(folders[0].path) : 'Project',
        folders,
      };
    });
  }, [workspace]);

  const saveWorkspace = useCallback(async () => {
    const saved = await window.mixdogDesktop?.saveWorkspace?.(
      workspace.workspaceFile ?? null,
      workspace.folders,
    );
    if (saved) setExplicitWorkspace(saved);
  }, [workspace]);

  const closeWorkspace = useCallback(() => {
    setExplicitWorkspace({
      kind: 'empty',
      name: 'Project',
      folders: [],
    });
  }, []);

  return {
    workspace,
    openFolder,
    openWorkspace,
    addFolder,
    removeFolder,
    saveWorkspace,
    closeWorkspace,
  };
}
