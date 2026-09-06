import { executeGithubRequest } from '../../../../src/runtime/github/client.mjs';
import { validateGithubRequest } from '../../../../src/runtime/github/contract.mjs';
import { childEnvironment } from './child-environment';
import { requiredRepositoryCwd } from './git-contract.mjs';
import { builtinFeatureActive, withGrandfatheredBuiltins } from '../../../../src/session-runtime/builtin-features.mjs';
import type { MixdogConfigModule } from './settings-store';

export function githubRequest(cwd: unknown, input: unknown) {
  return executeGithubRequest(validateGithubRequest(input), requiredRepositoryCwd(cwd), {
    env: childEnvironment(),
  });
}

export function createGithubService(
  loadConfig: () => Promise<MixdogConfigModule>,
  execute: typeof githubRequest = githubRequest,
) {
  return async (cwd: unknown, input: unknown) => {
    const request = validateGithubRequest(input);
    const config = await loadConfig();
    if (!builtinFeatureActive(withGrandfatheredBuiltins(await config.readConfig()), 'git')) {
      throw new Error('Enable Git & GitHub in Extensions → Plugin before using GitHub actions.');
    }
    return execute(cwd, request);
  };
}
