/**
 * Resolve a stored automation workflow id (schedule/webhook row) into
 * createSession options: the workflow summary meta plus the WORKFLOW.md
 * context block, exactly like a desktop New task session gets for the
 * active workflow. An empty/unknown id resolves to the default pack via
 * loadWorkflowPack's fallback; resolution failures degrade to no workflow
 * context (the session still runs with the base lead ruleset).
 */
import { createWorkflowHelpers } from '../../session-runtime/workflow.mjs';
import { STANDALONE_ROOT, STANDALONE_DATA_DIR } from '../../session-runtime/runtime-paths.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from './markdown-frontmatter.mjs';

let _helpers = null;
function helpers() {
  if (!_helpers) {
    _helpers = createWorkflowHelpers({
      rootDir: STANDALONE_ROOT,
      dataDir: STANDALONE_DATA_DIR,
      readMarkdownDocument,
      normalizeAgentPermissionOrNone,
    });
  }
  return _helpers;
}

/** { workflow, workflowContext } createSession opts for a workflow id, or {} when unset/unresolvable. */
export function automationWorkflowOpts(workflowId) {
  const id = String(workflowId || '').trim();
  if (!id) return {};
  try {
    const h = helpers();
    const pack = h.loadWorkflowPack(undefined, id);
    if (!pack) return {};
    return {
      workflow: h.workflowSummary(pack),
      workflowContext: h.workflowContextBlock({ workflow: { active: id } }, undefined),
    };
  } catch {
    return {};
  }
}
