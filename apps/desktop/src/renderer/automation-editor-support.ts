// Pieces the Schedules and Webhooks panels share: they edit the same
// automation shape (who runs it, project) in the same dialog grammar.
import { useEffect, useState } from 'react';
import type { DesktopApi, DesktopProjectSummary } from '../shared/contract';
import { isTaskWorkspaceFolder } from '../shared/task-workspace';
import { t } from './i18n';
import { reportRendererFailure } from './RendererRecovery';

export const AUTOMATION_NO_PROJECT = '__none__';

/** The host's exact task workspace path ('' until it answers, or when the host
 *  cannot say), read while the panel is active. */
export function useTaskWorkspace(api: Partial<Pick<DesktopApi, 'getTaskWorkspace'>> | undefined, active: boolean) {
  const [taskWorkspace, setTaskWorkspace] = useState('');
  useEffect(() => {
    if (!active || !api?.getTaskWorkspace) return undefined;
    let live = true;
    api
      .getTaskWorkspace()
      .then((path) => {
        if (live) setTaskWorkspace(path);
      })
      .catch((error: unknown) => reportRendererFailure('unhandled-rejection', error));
    return () => {
      live = false;
    };
  }, [api, active]);
  return taskWorkspace;
}

/** A cwd as the project picker shows it: the task workspace means no project ('').
 *  Presentation only; the editor saves the cwd it holds, never this. */
export function automationDraftCwd(cwd: unknown, taskWorkspace: string): string {
  const value = String(cwd || '');
  return isTaskWorkspaceFolder(value, taskWorkspace) ? '' : value;
}

/** The editor's cwd state. `edit` is null until the user picks a project, so
 *  the automation's stored cwd (`stored`) is saved back unchanged; `shown` is
 *  the picker value, derived from the workspace as it is now. */
export function automationEditorCwd(stored: string, edit: string | null, taskWorkspace: string) {
  const cwd = edit ?? stored;
  return { cwd, shown: automationDraftCwd(cwd, taskWorkspace) };
}

/** Project picker options; `cwd` is the picker's value (see
 *  `automationDraftCwd`); one outside the project list stays selectable. */
export function automationProjectOptions(
  projects: readonly DesktopProjectSummary[],
  cwd: string
): Array<{ value: string; label: string }> {
  const options = [
    { value: AUTOMATION_NO_PROJECT, label: t('No project') },
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || project.path,
    })),
  ];
  if (cwd && !options.some((option) => option.value === cwd)) options.push({ value: cwd, label: cwd });
  return options;
}
