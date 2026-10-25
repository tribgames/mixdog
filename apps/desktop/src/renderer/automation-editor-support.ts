// Pieces the Schedules and Webhooks panels share: they edit the same
// automation shape (who runs it, project) in the same dialog grammar.
import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';

export const AUTOMATION_NO_PROJECT = '__none__';

/** The app's internal "no project" task workspace (<userData>/workspace/unclassified),
 *  the same test the main process uses (desktop-state.ts isDesktopTaskWorkspace). */
function isTaskWorkspacePath(value: string): boolean {
  return value
    .replace(/[\\/]+/g, '/')
    .replace(/\/$/, '')
    .toLowerCase()
    .endsWith('/workspace/unclassified');
}

/** A stored cwd as the editor holds it: the task workspace means no project (''). */
export function automationDraftCwd(cwd: unknown): string {
  const value = String(cwd || '');
  return isTaskWorkspacePath(value) ? '' : value;
}

/** Project picker options; a stored cwd outside the project list stays selectable. */
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
  if (automationDraftCwd(cwd) && !options.some((option) => option.value === cwd)) options.push({ value: cwd, label: cwd });
  return options;
}
