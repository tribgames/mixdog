import type { DesktopOrchestrationMode } from './contract-session';

/** Desktop event: the CONFIGURED orchestration default (the mode a New Task
 *  inherits) changed, by any writer: settings UI, the setup tool, another
 *  window or process. Published only when the value itself differs. */
export const ORCHESTRATION_MODE_EVENT = 'orchestration-mode-changed';

export interface OrchestrationModeChange {
  mode: DesktopOrchestrationMode;
}

const ORCHESTRATION_MODES: readonly string[] = ['none', 'focused', 'balanced', 'swarm'];

export function readOrchestrationModeChange(value: unknown): OrchestrationModeChange | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const mode = (value as Record<string, unknown>).mode;
  return typeof mode === 'string' && ORCHESTRATION_MODES.includes(mode)
    ? { mode: mode as DesktopOrchestrationMode }
    : null;
}
