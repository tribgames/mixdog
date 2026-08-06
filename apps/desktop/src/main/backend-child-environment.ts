// @ts-expect-error Shared runtime modules are plain ESM without declarations.
import { scrubRuntimeRootVars } from '../../../../src/runtime/agent/orchestrator/tools/env-scrub.mjs';

/** Environment for user-facing processes spawned by the daemon-owned desktop
 * backend. Host identity belongs to the daemon itself and must never leak into
 * terminals, Git hooks, GitHub CLI, WSL probes, or language servers. */
export function backendChildEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = { ...source, ...overrides };
  scrubRuntimeRootVars(env);
  return env;
}
