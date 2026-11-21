import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { mixdogDataDirectory } from './data-directory';

interface DesktopOnboardingStatus {
  completed: boolean;
  version: number;
  default: unknown;
  workflowRoutes: unknown[];
  starterGuide: unknown;
}

/** Same resolution the runtime uses for its shared config file. */
export function mixdogConfigPath(): string {
  return join(mixdogDataDirectory(), 'mixdog-config.json');
}

/** Null when the file is missing or unreadable: the caller then falls back to
 *  the authoritative engine capability. */
export async function readOnboardingStatusFromDisk(): Promise<DesktopOnboardingStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(mixdogConfigPath(), 'utf8')) as Record<string, unknown>;
    const agent = parsed?.agent && typeof parsed.agent === 'object' ? (parsed.agent as Record<string, unknown>) : null;
    if (!agent) return null;
    const onboarding =
      agent.onboarding && typeof agent.onboarding === 'object' ? (agent.onboarding as Record<string, unknown>) : null;
    return {
      completed: onboarding?.completed === true,
      version: Number(onboarding?.version) || 0,
      default: agent.default ?? null,
      // Route summaries need the live registry; the boot probe only reads
      // `completed`, and the wizard re-reads through the engine once it opens.
      workflowRoutes: [],
      starterGuide: onboarding?.starterGuide ?? null,
    };
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return {
        completed: false,
        version: 0,
        default: null,
        workflowRoutes: [],
        starterGuide: null,
      };
    }
    return null;
  }
}
