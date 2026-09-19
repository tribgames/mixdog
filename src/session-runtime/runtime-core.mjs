// The session runtime assembler. Each boot stage takes the shared boot
// record (session-runtime/boot/*.mjs), wires one group of factories against
// the runtime state `rt`, and stores its products for the later stages; the
// facade stage returns the object callers use.
import '../runtime/shared/uv-threadpool-boot.mjs';
import './hitch-profile.mjs';
import { beginBoot, loadModules } from './boot/begin.mjs';
import { resolveConfig } from './boot/config.mjs';
import { wireInfrastructure } from './boot/infrastructure.mjs';
import { wireTools } from './boot/tools.mjs';
import { wireProviders } from './boot/providers.mjs';
import { wireSessionLifecycle } from './boot/session.mjs';
import { wireApis } from './boot/apis.mjs';
import { buildFacade } from './boot/facade.mjs';

function bootParams({
  provider,
  model,
  effort,
  fast,
  modelParameters,
  cwd = process.cwd(),
  toolMode = 'full',
  toolProfile = 'interactive',
  approvalMode = null,
  disallowDelegation = false,
  autoWakeCompletions = true,
  initialConfig = null,
  desktopSession = null,
  sessionProfile = null,
  executeAgentControl = null,
} = {}) {
  return {
    provider,
    model,
    effort,
    fast,
    modelParameters,
    cwd,
    toolMode,
    toolProfile,
    approvalMode,
    disallowDelegation,
    autoWakeCompletions,
    initialConfig,
    desktopSession,
    sessionProfile,
    executeAgentControl,
  };
}

export async function createMixdogSessionRuntime(options = {}) {
  const boot = beginBoot(bootParams(options));
  await loadModules(boot);
  await resolveConfig(boot);
  wireInfrastructure(boot);
  wireTools(boot);
  wireProviders(boot);
  wireSessionLifecycle(boot);
  wireApis(boot);
  return buildFacade(boot);
}
