// The representative agent's display name. Its id stays `lead`; the user may
// rename it (agents/lead/agent.json `name`, user data dir), Mixy by default.
// Every model- or user-facing string that names it reads this, re-read on each
// use so a rename applies at once. Text shared across agents (tool schemas,
// other agents' shared prompt block) says "the representative agent" instead,
// so a rename never changes cached bytes.
import { join } from 'node:path';
import { mixdogGlobalDir, readSafe } from '../context/skill-catalog.mjs';

export const DEFAULT_MIXY_NAME = 'Mixy';

/** The display name in a lead manifest (agent.json), else Mixy. */
export function mixyNameOf(manifest) {
  const name = typeof manifest?.name === 'string' ? manifest.name.replace(/\s+/g, ' ').trim() : '';
  return name || DEFAULT_MIXY_NAME;
}

export function mixyDisplayName() {
  try {
    return mixyNameOf(JSON.parse(readSafe(join(mixdogGlobalDir('agents'), 'lead', 'agent.json')) || '{}'));
  } catch {
    return DEFAULT_MIXY_NAME;
  }
}
