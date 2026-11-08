// The workflow-agents API of the 1.4.5 desktop editors' backend (agents, bots, workflows), wired as the product wires it,
// over a data directory. Shared by record-migration-145.mjs and migration-145-leftovers.mjs.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function workflowAgentsApi(tree, data) {
  const at = (p) => import(pathToFileURL(join(tree, p)).href);
  const wf = await at('src/runtime/agent/orchestrator/runtime-core/workflow.mjs');
  const md = await at('src/runtime/shared/markdown-frontmatter.mjs');
  const { createWorkflowAgentsApi } = await at('src/session-runtime/workflow-agents-api.mjs');
  const routeHelpers = wf.createWorkflowRouteHelpers({ findPreset: () => null });
  const helpers = wf.createWorkflowHelpers({ rootDir: join(tree, 'src'), dataDir: data, readMarkdownDocument: md.readMarkdownDocument, normalizeAgentPermissionOrNone: md.normalizeAgentPermissionOrNone });
  const state = { config: { workflow: { active: 'default' } } };
  return createWorkflowAgentsApi({
    ...helpers,
    getConfig: () => state.config,
    displayConfig: () => state.config,
    cfgMod: { getPluginData: () => data },
    STANDALONE_DATA_DIR: data,
    resolveRoute: (_config, requested) => (Object.keys(requested).length ? { ...requested } : { provider: 'stub', model: 'stub-model' }),
    agentRouteFromConfig: routeHelpers.agentRouteFromConfig,
    saveConfigAndAdopt: (value) => {
      state.config = value;
    },
    lookupModelMeta: async () => ({}),
    ensureProvidersReady: async () => {},
    invalidateContextStatusCache() {},
  });
}
