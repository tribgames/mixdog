import { useState, useCallback, useLayoutEffect } from 'react';
import type { DesktopProjectSummary } from '../shared/contract';
import { displayProject } from './text-format';
import type { NavigationSelection } from './navigation';
import type { paneActiveSelection } from './pane-layout';

export const LAST_PROJECT_KEY = 'mixdog.desktop-last-project.v1';

interface AppToolProjectProps {
  navigationSelection: NavigationSelection;
  focusedPaneSelection: ReturnType<typeof paneActiveSelection>;
  selectedSessionProjectPath: string;
  newTaskProjectPath: string;
  effectiveDraftProjectPath: (preferred?: string) => string;
  registeredProjectPath: (path: string) => string;
  preferredDraftProjectPath: string;
  projects: DesktopProjectSummary[];
}

function activeProjectPathFor({
  navigationSelection,
  selectedSessionProjectPath,
  newTaskProjectPath,
  effectiveDraftProjectPath,
  registeredProjectPath,
}: Pick<
  AppToolProjectProps,
  | 'navigationSelection'
  | 'selectedSessionProjectPath'
  | 'newTaskProjectPath'
  | 'effectiveDraftProjectPath'
  | 'registeredProjectPath'
>): string {
  if (navigationSelection.kind === 'session') return registeredProjectPath(selectedSessionProjectPath);
  if (navigationSelection.kind === 'project') return navigationSelection.path;
  return effectiveDraftProjectPath(newTaskProjectPath);
}

function focusedPaneProjectPathFor(selection: AppToolProjectProps['focusedPaneSelection']): string {
  if (!selection) return '';
  if (selection.kind === 'file' || selection.kind === 'diff' || selection.kind === 'pull-request') {
    return selection.project;
  }
  if (selection.kind === 'terminal' && selection.cwd) return selection.cwd;
  return '';
}

function rememberLastToolProject(path: string): void {
  try {
    window.localStorage.setItem(LAST_PROJECT_KEY, path);
  } catch {
    /* persistence is a convenience only */
  }
}

export function useAppToolProject({
  navigationSelection,
  focusedPaneSelection,
  selectedSessionProjectPath,
  newTaskProjectPath,
  effectiveDraftProjectPath,
  registeredProjectPath,
  preferredDraftProjectPath,
  projects,
}: AppToolProjectProps) {
  const activeProjectPath = activeProjectPathFor({
    navigationSelection,
    selectedSessionProjectPath,
    newTaskProjectPath,
    effectiveDraftProjectPath,
    registeredProjectPath,
  });
  const focusedPaneProjectPath = focusedPaneProjectPathFor(focusedPaneSelection);
  const activeToolProjectPath = focusedPaneProjectPath || activeProjectPath;
  const [lastToolProjectPath, setLastToolProjectPath] = useState(() => {
    try {
      return window.localStorage.getItem(LAST_PROJECT_KEY) || '';
    } catch {
      return '';
    }
  });
  // Explorer, Source Control and Pull Requests share ONE sticky project
  // context. Projectless panes never clear it; focusing a pane with an
  // explicit project resumes automatic following and releases a manual pick.
  const [toolProjectOverride, setToolProjectOverride] = useState('');
  useLayoutEffect(() => {
    if (!activeToolProjectPath) return;
    setToolProjectOverride('');
    setLastToolProjectPath((current) => (current === activeToolProjectPath ? current : activeToolProjectPath));
    rememberLastToolProject(activeToolProjectPath);
  }, [activeToolProjectPath]);
  const selectToolProject = useCallback((path: string) => {
    if (!path) return;
    setToolProjectOverride(path);
    setLastToolProjectPath(path);
    rememberLastToolProject(path);
  }, []);
  const toolProjectPath = toolProjectOverride || activeToolProjectPath || lastToolProjectPath;

  // Only registered projects get project chrome, for both the header and panes.
  const projectChromeLabel = useCallback(
    (path: string): string => {
      const summary = projects.find(
        (project) =>
          project.path.replace(/[\\/]+/g, '/').toLocaleLowerCase() === path.replace(/[\\/]+/g, '/').toLocaleLowerCase()
      );
      return summary
        ? summary.alias?.trim() || summary.name?.trim() || displayProject(summary.path).name || 'Project'
        : '';
    },
    [projects]
  );

  const activeProjectLabel = projectChromeLabel(activeProjectPath);
  const selectedProjectPath = activeProjectPath || preferredDraftProjectPath;

  return {
    activeProjectPath,
    focusedPaneProjectPath,
    activeToolProjectPath,
    toolProjectPath,
    selectToolProject,
    projectChromeLabel,
    activeProjectLabel,
    selectedProjectPath,
  };
}
