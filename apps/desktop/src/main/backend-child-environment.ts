// @ts-expect-error Shared runtime modules are plain ESM without declarations.
import { scrubProviderSecrets, scrubRuntimeRootVars } from '../../../../src/runtime/agent/orchestrator/tools/env-scrub.mjs';

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

/** Repository hooks are project-controlled executable code. They receive the
 * normal Git environment, but never provider/cloud credentials owned by the
 * daemon process. Ordinary Git commands keep their authentication environment. */
export function backendHookEnvironment(
  overrides: NodeJS.ProcessEnv = {},
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = backendChildEnvironment(overrides, source);
  scrubProviderSecrets(env);
  return env;
}
