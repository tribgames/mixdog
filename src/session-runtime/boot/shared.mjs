// Module-level helpers bound to this runtime's root/data layout, shared by
// the boot stages.
import { isKnownProvider } from '../../standalone/provider-admin.mjs';
import { normalizeAgentPermissionOrNone, readMarkdownDocument } from '../../runtime/shared/markdown-frontmatter.mjs';
import { makeWebSearchCapableFor } from '../model-capabilities.mjs';
import { makeResolveDefaultProvider, findPreset, makeResolveRoute } from '../config-helpers.mjs';
import { outputStyleStatus as outputStyleStatusRaw } from '../output-styles.mjs';
import {
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
  normalizeWebSearchProviderId,
  isWebSearchCapableProvider,
} from '../workflow.mjs';
import { STANDALONE_ROOT, STANDALONE_DATA_DIR } from '../runtime-paths.mjs';

export const resolveRoute = makeResolveRoute(makeResolveDefaultProvider(isKnownProvider));
export const webSearchCapableFor = makeWebSearchCapableFor(normalizeWebSearchProviderId, isWebSearchCapableProvider);

export const outputStyleStatus = (dataDir = STANDALONE_DATA_DIR, opts = {}) =>
  outputStyleStatusRaw(STANDALONE_ROOT, dataDir || STANDALONE_DATA_DIR, opts);

// Workflow/agent pack loaders bound to this runtime's root/data layout.
export const workflowHelpers = createWorkflowHelpers({
  rootDir: STANDALONE_ROOT,
  dataDir: STANDALONE_DATA_DIR,
  readMarkdownDocument,
  normalizeAgentPermissionOrNone,
});
export const { summarizeWorkflowRoutes, agentRouteFromConfig } = createWorkflowRouteHelpers({ findPreset });

export function dataDirOf(cfgMod) {
  return cfgMod.getPluginData?.() || STANDALONE_DATA_DIR;
}
