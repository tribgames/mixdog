export interface RoutineProvenance {
  kind: 'schedule' | 'webhook';
  name: string;
  status: 'ok' | 'failed';
  summary?: string;
  error?: string;
}
export type RoutineHumanNeededOutcome = 'login_required' | 'human_action_required' | 'sensitive_confirmation_required';
export function normalizeRoutineProvenance(value: unknown): RoutineProvenance | null;
export function routineHumanNeeded(summary: unknown): { outcome: RoutineHumanNeededOutcome; site: string } | null;
export function routineLoginRequiredText(site: string): string;
export function routineLoginRequiredSite(summary: unknown): string | null;
