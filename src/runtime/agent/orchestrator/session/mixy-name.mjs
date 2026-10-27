// The representative agent's display name. Its id stays `lead`; the user may
// rename it (agents/lead/agent.json `name`, user data dir), Mixy by default.
// Every model- or user-facing string that names it reads this, re-read on each
// use so a rename applies at once. Text shared across agents (tool schemas,
// other agents' shared prompt block) says "the representative agent" instead,
// so a rename never changes those cached bytes. Each other bot's own contact
// catalog (workflow/context.mjs) names her, so a request naming her finds her.
// Light imports only: the prompt's contact catalog (workflow/context.mjs) reads
// the name too, and must not pull the skill catalog and config in with it.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';
import { mixyIdentityDir } from '../../../shared/agent-store.mjs';

export const DEFAULT_MIXY_NAME = 'Mixy';

/** The display name in a lead manifest (agent.json), else Mixy. */
export function mixyNameOf(manifest) {
  const name = typeof manifest?.name === 'string' ? manifest.name.replace(/\s+/g, ' ').trim() : '';
  return name || DEFAULT_MIXY_NAME;
}

export function mixyDisplayName() {
  try {
    // bots/mixy once Mixy is its own bot, agents/lead before (agent-store.mjs).
    // A missing, empty or malformed agent.json falls back to Mixy below.
    const dir = mixyIdentityDir(resolvePluginData());
    return mixyNameOf(JSON.parse(readFileSync(join(dir, 'agent.json'), 'utf8')));
  } catch {
    return DEFAULT_MIXY_NAME;
  }
}
