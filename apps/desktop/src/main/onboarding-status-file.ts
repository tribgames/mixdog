// Engine-free onboarding probe. The renderer asks whether onboarding is done
// the moment the window is up; booting an engine under the transition lock to
// answer that delayed the user's first session click by seconds, so a cold host
// answers from the config file instead and leaves the first real engine boot to
// the navigation that actually needs it.
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DesktopOnboardingStatus {
  completed: boolean;
  version: number;
  default: unknown;
  workflowRoutes: unknown[];
}

/** Same resolution the runtime uses for its shared config file. */
export function mixdogConfigPath(): string {
  const dataDir = process.env.MIXDOG_DATA_DIR
    || join(process.env.MIXDOG_HOME || join(homedir(), '.mixdog'), 'data');
  return join(dataDir, 'mixdog-config.json');
}

/** Null when the file is missing or unreadable: the caller then falls back to
 *  the authoritative engine capability. */
export async function readOnboardingStatusFromDisk(): Promise<DesktopOnboardingStatus | null> {
  try {
    const parsed = JSON.parse(await readFile(mixdogConfigPath(), 'utf8')) as Record<string, unknown>;
    const agent = parsed?.agent && typeof parsed.agent === 'object'
      ? parsed.agent as Record<string, unknown>
      : null;
    if (!agent) return null;
    const onboarding = agent.onboarding && typeof agent.onboarding === 'object'
      ? agent.onboarding as Record<string, unknown>
      : null;
    return {
      completed: onboarding?.completed === true,
      version: Number(onboarding?.version) || 0,
      default: agent.default ?? null,
      // Route summaries need the live registry; the boot probe only reads
      // `completed`, and the wizard re-reads through the engine once it opens.
      workflowRoutes: [],
    };
  } catch {
    return null;
  }
}
