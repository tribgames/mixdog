// Module-level helpers bound to this runtime's root/data layout, shared by
// the boot stages.
import { isKnownProvider } from '../services/provider-admin.mjs';
import { normalizeAgentPermissionOrNone, readMarkdownDocument } from '../../runtime/shared/markdown-frontmatter.mjs';
import { makeWebSearchCapableFor } from '../../runtime/agent/orchestrator/runtime-core/model-capabilities.mjs';
import {
  makeResolveDefaultProvider,
  findPreset,
  makeResolveRoute,
} from '../../runtime/agent/orchestrator/runtime-core/config-helpers.mjs';
import { outputStyleStatus as outputStyleStatusRaw } from '../output-styles.mjs';
import {
  createWorkflowHelpers,
  createWorkflowRouteHelpers,
  webSearchProviderFamily,
} from '../../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { STANDALONE_ROOT, standaloneDataDir } from '../runtime-paths.mjs';

export const resolveRoute = makeResolveRoute(makeResolveDefaultProvider(isKnownProvider));
export const webSearchCapableFor = makeWebSearchCapableFor(webSearchProviderFamily);

export const outputStyleStatus = (dataDir = standaloneDataDir(), opts = {}) =>
  outputStyleStatusRaw(STANDALONE_ROOT, dataDir || standaloneDataDir(), opts);

// Workflow/agent pack loaders bound to this runtime's root/data layout. The
// default data dir is the resolver itself, read per call, so a later runtime
// start in the same process uses its own data folder.
export const workflowHelpers = createWorkflowHelpers({
  rootDir: STANDALONE_ROOT,
  dataDir: standaloneDataDir,
  readMarkdownDocument,
  normalizeAgentPermissionOrNone,
});
export const { summarizeWorkflowRoutes, agentRouteFromConfig } = createWorkflowRouteHelpers({ findPreset });

export { pluginDataDir as dataDirOf } from '../runtime-paths.mjs';
