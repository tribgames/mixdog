// Pieces the Schedules and Webhooks panels share: they edit the same
// automation shape (model route, project, workflow) in the same dialog grammar.
import type { DesktopModelOption, DesktopProjectSummary } from '../shared/contract';
import { cachedAutoEffortCapable, hostRouteAutoEffort } from './auto-effort-store';
import type { RecordValue } from './desktop-types';
import { t } from './i18n';
import { NO_AUTO_EFFORT_SUFFIX, parseModelRef, routeSpeed } from './model-route-utils';
import { modelDisplayName, modelFastAvailable, routeDaybreakBlue } from './provider-display';

/** `+fast` route suffix, emitted only when the selected model supports fast
 *  mode for the current effort/parameters (shared by Schedules and Webhooks). */
export function automationFastSuffix(
  selected: DesktopModelOption | undefined,
  effort: string,
  modelParameters: Record<string, string>,
  fast: boolean
): string {
  return fast && modelFastAvailable(selected, effort, modelParameters) ? '+fast' : '';
}

/** `+noauto` route suffix: only a route that turned Auto reasoning off carries
 *  it, and only for a host that reads it (an older host would take it as part
 *  of the model id). */
export function automationAutoEffortSuffix(autoEffort: boolean): string {
  return autoEffort || !hostRouteAutoEffort() ? '' : NO_AUTO_EFFORT_SUFFIX;
}

/** `provider/model` route split at its first slash; a bare id has no provider. */
export function splitModelRoute(route: string): { provider: string; id: string } {
  const slash = route.indexOf('/');
  return slash > 0 ? { provider: route.slice(0, slash), id: route.slice(slash + 1) } : { provider: '', id: '' };
}

/** The list-row model label parts for a stored `provider/model@effort+fast`
 *  reference, or null when the row carries no model. */
export function automationRouteSummary(
  rawModel: string
): {
  model: string;
  effort: string;
  fast: boolean;
  ultra: boolean;
  blue: boolean;
  autoEffortCapable: boolean;
  autoEffort: boolean;
} | null {
  const ref = parseModelRef(rawModel);
  if (!ref.route) return null;
  const slash = ref.route.indexOf('/');
  const model = slash > 0 ? modelDisplayName(ref.route.slice(slash + 1), ref.route.slice(0, slash)) : ref.route;
  const autoEffortCapable = slash > 0 && cachedAutoEffortCapable(ref.route.slice(0, slash), ref.route.slice(slash + 1));
  return {
    model,
    effort: ref.effort || '',
    fast: ref.fast,
    ultra: routeSpeed(ref.fast, ref.modelParameters) === 'ultrafast',
    blue: slash > 0 && routeDaybreakBlue(ref.modelParameters),
    autoEffortCapable,
    autoEffort: ref.autoEffort,
  };
}

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

/** Workflow picker options from the shared reference rows. */
export function automationWorkflowOptions(workflows: readonly RecordValue[]): Array<{ value: string; label: string }> {
  return workflows
    .map((row) => ({ value: String(row.id || ''), label: String(row.name || row.id || '') }))
    .filter((option) => option.value);
}
