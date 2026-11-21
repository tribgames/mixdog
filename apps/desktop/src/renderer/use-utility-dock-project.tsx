import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DesktopProjectSummary, DesktopWorkspaceFolder } from '../shared/contract';
import type { Snapshot } from './desktop-types';
import { t } from './i18n';
import { OpenSelect } from './OpenSelect';

/** Final folder or file name of a path, ignoring trailing separators. */
function lastPathSegment(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, '')
      .split(/[\\/]/)
      .at(-1) || ''
  );
}

/** The project the dock presents (controlled by App, or a local override for
 *  standalone hosts), its switcher options and the stable switcher element. */
export function useUtilityDockProject({
  open,
  projectPath,
  workspaceFolders,
  snapshot,
  onSelectProject,
}: {
  open: boolean;
  projectPath: string;
  workspaceFolders?: readonly DesktopWorkspaceFolder[];
  snapshot: Snapshot;
  onSelectProject?(projectPath: string): void;
}) {
  const [localProjectOverride, setLocalProjectOverride] = useState('');
  const [knownProjects, setKnownProjects] = useState<DesktopProjectSummary[]>([]);
  useEffect(() => {
    if (!open) return undefined;
    let live = true;
    void window.mixdogDesktop
      ?.listProjects?.()
      .then((rows) => {
        if (live) setKnownProjects(rows ?? []);
      })
      .catch(() => {
        /* the switcher simply lists fewer options */
      });
    return () => {
      live = false;
    };
  }, [open]);
  const baseFolders = useMemo(() => {
    if (workspaceFolders?.length) return workspaceFolders;
    return projectPath ? [{ path: projectPath }] : [];
  }, [projectPath, workspaceFolders]);
  const baseProjectPath =
    projectPath || baseFolders[0]?.path || String(snapshot.currentProject || snapshot.project || '');
  const dockProjectPath = onSelectProject ? baseProjectPath : localProjectOverride || baseProjectPath;
  const selectDockProject = useCallback(
    (path: string) => {
      if (onSelectProject) onSelectProject(path);
      else setLocalProjectOverride(path);
    },
    [onSelectProject]
  );
  // Search owns its project toolbar inside the stable Search layer, but the
  // project options remain dock-scoped so switching surfaces preserves them.
  const dockRootName = lastPathSegment(dockProjectPath);
  const dockProjectOptions = useMemo(() => {
    const seen = new Set<string>();
    const rows: Array<{ path: string; name: string }> = [];
    const push = (path: string, name?: string | null) => {
      const key = path.replace(/[\\/]+/g, '/').toLocaleLowerCase();
      if (!path || seen.has(key)) return;
      seen.add(key);
      rows.push({ path, name: name || lastPathSegment(path) || path });
    };
    push(dockProjectPath, dockRootName);
    for (const folder of baseFolders) push(folder.path, (folder as { name?: string }).name);
    for (const project of knownProjects) push(project.path, project.alias || project.name);
    return rows;
  }, [baseFolders, dockProjectPath, dockRootName, knownProjects]);
  // Stable project-picker element: this JSX is a MemoSourceControlDock prop.
  // Rebuilt inline it re-rendered the entire SCM tree on every dock commit
  // (profiled during fast tab switches — the dock never changed).
  const dockProjectSelectOptions = useMemo(
    () => dockProjectOptions.map((option) => ({ value: option.path, label: option.name })),
    [dockProjectOptions]
  );
  const projectSelectControl = useMemo(() => {
    if (dockProjectOptions.length === 0) return null;
    return (
      <OpenSelect
        ariaLabel={t('Switch project')}
        className="dock-project-select"
        value={dockProjectPath}
        displayValue={dockProjectPath ? undefined : t('Select project')}
        options={dockProjectSelectOptions}
        onChange={selectDockProject}
      />
    );
  }, [dockProjectOptions.length, dockProjectPath, dockProjectSelectOptions, selectDockProject]);
  return { dockProjectPath, dockProjectOptions, projectSelectControl };
}
