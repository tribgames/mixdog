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
import { IMPLICIT_APPROVAL_MODE } from '../agent/orchestrator/session/approval-mode.mjs';

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

/** Non-interactive createSession opts, plus workflow context when the id resolves. */
export function automationWorkflowOpts(workflowId) {
  const approvalOpts = { approvalMode: IMPLICIT_APPROVAL_MODE };
  const id = String(workflowId || '').trim();
  if (!id) return approvalOpts;
  try {
    const h = helpers();
    const pack = h.loadWorkflowPack(undefined, id);
    if (!pack) return approvalOpts;
    const resolved = h.activeWorkflowContext({ workflow: { active: id } }, undefined);
    return {
      ...approvalOpts,
      workflow: resolved.summary,
      workflowContext: resolved.context,
      orchestrationMode: resolved.orchestrationMode,
    };
  } catch {
    return approvalOpts;
  }
}
