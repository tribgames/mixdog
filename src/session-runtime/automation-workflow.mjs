/**
 * Resolve a stored automation workflow id (schedule/webhook row) into
 * createSession options: the workflow summary meta plus the WORKFLOW.md
 * context block, exactly like a desktop New task session gets for the
 * active workflow. An empty/unknown id resolves to the default pack via
 * loadWorkflowPack's fallback; resolution failures degrade to no workflow
 * context (the session still runs with the base lead ruleset).
 */
import { createWorkflowHelpers } from '../runtime/agent/orchestrator/runtime-core/workflow.mjs';
import { STANDALONE_ROOT, STANDALONE_DATA_DIR } from './runtime-paths.mjs';
import { readMarkdownDocument, normalizeAgentPermissionOrNone } from '../runtime/shared/markdown-frontmatter.mjs';
import { IMPLICIT_APPROVAL_MODE } from '../runtime/agent/orchestrator/session/approval-mode.mjs';
import { loadConfig } from '../runtime/agent/orchestrator/config.mjs';
import { configuredOrchestrationMode } from '../runtime/shared/orchestration.mjs';
import { AUTOMATION_TOOL_SCOPE } from './automation-agents.mjs';

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
  const config = loadConfig({ secrets: false });
  // The user's orchestration setting governs an automation exactly as it does a
  // New task: a workflow id alone never turns delegation on, and the agent
  // tool reaches the run through the automation tool scope.
  const baseOpts = {
    approvalMode: IMPLICIT_APPROVAL_MODE,
    orchestrationMode: configuredOrchestrationMode(config),
    mcpScopeId: AUTOMATION_TOOL_SCOPE,
  };
  const id = String(workflowId || '').trim();
  if (!id) return baseOpts;
  try {
    const h = helpers();
    const pack = h.loadWorkflowPack(undefined, id);
    if (!pack) return baseOpts;
    // The whole config, so disabled agents and the orchestration mode are the
    // user's, with only the active workflow swapped for the automation's own.
    const resolved = h.activeWorkflowContext({ ...config, workflow: { ...config.workflow, active: id } }, undefined);
    return {
      ...baseOpts,
      workflow: resolved.summary,
      workflowContext: resolved.context,
      orchestrationMode: resolved.orchestrationMode,
    };
  } catch {
    return baseOpts;
  }
}
