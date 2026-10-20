import { createOnboardingApi } from './workflow-agents-api/onboarding.mjs';
import { createAgentEditorApi } from './workflow-agents-api/agent-editor.mjs';
import { createAgentConnectorsApi } from './workflow-agents-api/agent-connectors.mjs';
import { createAgentRouteApi } from './workflow-agents-api/agent-route.mjs';
import { createWorkflowPacksApi } from './workflow-agents-api/workflow-packs.mjs';
import { createStyleAndModeApi } from './workflow-agents-api/style-and-mode.mjs';

// Onboarding + agents/workflows/output-style selection surface. Stateless
// helpers are imported by the phase modules under workflow-agents-api/; the
// runtime injects live getters/setters for the mutable config/route/session
// locals plus the closure callbacks. completeOnboarding reads
// getOnboardingStatus from the composed runtime API through `this`.
export function createWorkflowAgentsApi(deps) {
  const routeApi = createAgentRouteApi(deps);
  const editorApi = createAgentEditorApi({ ...deps, setAgentRoute: routeApi.setAgentRoute });
  return {
    ...createOnboardingApi(deps),
    ...editorApi,
    ...createAgentConnectorsApi(deps, editorApi),
    ...routeApi,
    ...createWorkflowPacksApi(deps),
    ...createStyleAndModeApi(deps),
  };
}
