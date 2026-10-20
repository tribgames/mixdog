// Pieces the Schedules and Webhooks panels share: they edit the same
// automation shape (who runs it, project) in the same dialog grammar.
import type { DesktopProjectSummary } from '../shared/contract';
import { t } from './i18n';

/** Project picker options; a stored cwd outside the project list stays selectable. */
export function automationProjectOptions(
  projects: readonly DesktopProjectSummary[],
  cwd: string
): Array<{ value: string; label: string }> {
  const options = [
    { value: '__none__', label: t('No project') },
    ...projects.map((project) => ({
      value: project.path,
      label: project.alias?.trim() || project.name?.trim() || project.path,
    })),
  ];
  if (cwd && !options.some((option) => option.value === cwd)) options.push({ value: cwd, label: cwd });
  return options;
}
