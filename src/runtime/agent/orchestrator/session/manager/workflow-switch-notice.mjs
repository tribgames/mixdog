// manager/workflow-switch-notice.mjs
// A mid-conversation workflow switch (session-runtime/tool-policy-refresh.mjs
// switchSessionWorkflow) rebuilds the session's prompt and tool surface and
// stages `session.workflowSwitch`, the one-time notice the next user turn
// carries in its reminder block. Lifecycle mirrors the working-folder notice
// (prompt-utils snapshotPendingWorkspaceNotice): snapshot when the turn is
// built, acknowledge once the provider accepted it, so a failed turn re-sends
// it. The state object is replaced, never mutated:
//   from — the workflow the model was last told about (kept across switches
//          made before a notice reached it);
//   to   — the workflow the prompt carries now.

function workflowRef(workflow) {
  const id = String(workflow?.id || '').trim();
  return id ? { id, name: String(workflow?.name || id).trim() } : null;
}

/** Stage the notice of a switch from `from` to `to`; a switch back to what the
 *  model was last told drops it. Returns the staged state or null. */
export function stageWorkflowSwitchNotice(session, from, to) {
  const prior = session.workflowSwitch;
  const told = prior ? prior.from : workflowRef(from);
  const next = workflowRef(to);
  if (!next || told?.id === next.id) {
    delete session.workflowSwitch;
    return null;
  }
  session.workflowSwitch = { version: 1, revision: (Number(prior?.revision) || 0) + 1, from: told, to: next };
  return session.workflowSwitch;
}

function workflowNoticeContent({ from, to }) {
  const before = from?.name || 'the previous workflow';
  return [
    '<system-reminder>',
    '# Workflow Changed',
    `The workflow changed from ${before} to ${to.name}. Earlier turns of this conversation ran under ${before}; the system prompt was updated in place, so its Active Workflow rules, delegation instructions, available agents and tools are now those of ${to.name}. Follow them from this turn on.`,
    `Agents already started under ${before} keep running with their own instructions; new delegation uses the current tools and agents.`,
    '</system-reminder>',
  ].join('\n');
}

/**
 * The workflow notice the next user turn carries, or null.
 * @returns {{ revision: number, content: string } | null}
 */
export function snapshotPendingWorkflowNotice(session) {
  const pending = session?.workflowSwitch;
  if (!pending?.to?.id) return null;
  return { revision: pending.revision, content: workflowNoticeContent(pending) };
}

/** The notice of `revision` reached the model: nothing is due any more. */
export function acknowledgePendingWorkflowNotice(session, revision) {
  if (!session?.workflowSwitch || session.workflowSwitch.revision !== Number(revision)) return false;
  delete session.workflowSwitch;
  return true;
}
