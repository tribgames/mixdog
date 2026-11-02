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
  autoEffort,
  modelParameters,
  contextPercent,
  contextTokens,
  selectedContextWindow,
  cwd = process.cwd(),
  toolMode = 'full',
  toolProfile = 'interactive',
  approvalMode = null,
  disallowDelegation = false,
  autoWakeCompletions = true,
  initialConfig = null,
  desktopSession = null,
  sessionProfile = null,
  worktree = null,
  executeAgentControl = null,
  executeSessionControl = null,
} = {}) {
  return {
    provider,
    model,
    effort,
    fast,
    autoEffort,
    modelParameters,
    contextPercent,
    contextTokens,
    selectedContextWindow,
    cwd,
    toolMode,
    toolProfile,
    approvalMode,
    disallowDelegation,
    autoWakeCompletions,
    initialConfig,
    desktopSession,
    sessionProfile,
    // Creation-time worktree intent (workspace/transitions.mjs creationIntent).
    worktree,
    executeAgentControl,
    executeSessionControl,
  };
}

// A boot that throws returns no runtime to close, so whatever its stages already
// subscribed to process-wide registries is released here. Each release is
// independent of the late disposeGlobalExtensionSubscription aggregate (wired by
// the last stage) and tolerates a stage that never ran.
function releaseFailedBoot(boot) {
  for (const release of [
    () => boot.disposeProviderReadiness(),
    () => boot.disposeConfigSync?.(),
    () => boot.disposeAgentProfileChanges?.(),
    () => boot.resourceApi?.disposeGlobalExtensionSubscription?.(),
    () => boot.setupTool?.dispose(),
    () => boot.disposeInternalTools?.(),
    () => boot.sessionTitles?.disposeAll(),
  ]) {
    try {
      release();
    } catch {
      /* the boot error is the one to report */
    }
  }
}

export async function createMixdogSessionRuntime(options = {}) {
  const boot = beginBoot(bootParams(options));
  try {
    await loadModules(boot);
    await resolveConfig(boot);
    wireInfrastructure(boot);
    wireTools(boot);
    wireProviders(boot);
    wireSessionLifecycle(boot);
    wireApis(boot);
    return buildFacade(boot);
  } catch (error) {
    releaseFailedBoot(boot);
    throw error;
  }
}
