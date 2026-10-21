// manager/workflow-switch-notice.mjs
// A mid-conversation workflow switch (session-runtime/tool-policy-refresh.mjs
// switchSessionWorkflow) leaves the request prefix — system blocks and tool
// schemas — byte-identical, so the provider cache survives. The switch lives
// in two pieces of session state:
//   session.workflowOverlay — while the session's workflow differs from the
//     one its system prompt carries: the prompt's workflow (`prompt`, and the
//     orchestration mode its tool surface was built with), the new workflow,
//     its tools that are refused at call time (`deniedTools`), the tools it
//     allows that this session cannot reach (`unavailableTools`) and the
//     self-contained reminder (`content`) with the new workflow's rules,
//     orchestration and agents. It is folded into the prompt (and dropped) at
//     the next point where the cache is cold anyway (tool-policy-refresh.mjs).
//   session.workflowSwitch — the notice the next user turn carries in its
//     reminder block. Lifecycle mirrors the working-folder notice
//     (prompt-utils snapshotPendingWorkspaceNotice): snapshot when the turn is
//     built, acknowledge once the provider accepted it, so a failed turn
//     re-sends it. Delivered, it stays in the conversation. Replaced, never
//     mutated:
//       from — the workflow the model was last told about (kept across
//              switches made before a notice reached it);
//       to   — the session's workflow now.
// Every notice says it replaces the earlier ones, so the latest one wins.

function workflowRef(workflow) {
  const id = String(workflow?.id || '').trim();
  return id ? { id, name: String(workflow?.name || id).trim() } : null;
}

/** The workflow the session's system prompt and tool surface were built with. */
export function promptWorkflowOf(session) {
  return session?.workflowOverlay?.prompt || session?.workflow || null;
}

const lower = (name) => String(name || '').toLowerCase();

/** The refusal of a call to a tool the session's current workflow denies
 *  while its schema (built for the prompt's workflow) still carries it; null
 *  for any other call. */
export function workflowOverlayDenial(session, name) {
  const overlay = session?.workflowOverlay;
  if (!overlay?.deniedTools?.some((denied) => lower(denied) === lower(name))) return null;
  return `Error: tool "${name}" is not available in workflow ${overlay.workflow.name}: this conversation switched to it. Do the work without it.`;
}

const listed = (names) => names.map((name) => `\`${name}\``).join(', ');

/** The reminder that makes the Lead follow `workflow` while its system prompt
 *  still carries `promptName`'s: self-contained (rules, orchestration, agents,
 *  tool changes) and superseding every earlier one. */
export function workflowOverlayContent({
  promptName,
  workflow,
  instructions,
  deniedTools = [],
  loadableTools = [],
  unavailableTools = [],
}) {
  const name = workflow.name;
  return [
    '<system-reminder>',
    '# Workflow Changed',
    `This conversation now runs the ${name} workflow. The system prompt's Active Workflow, orchestration mode and available agents are still ${promptName}'s: they no longer apply; follow ${name}'s below instead. This replaces every earlier Workflow Changed reminder in this conversation.`,
    ...(deniedTools.length ? [`Not available in ${name} (calls are refused): ${listed(deniedTools)}.`] : []),
    ...(loadableTools.length
      ? [
          `${name} adds ${listed(loadableTools)}: not among your directly defined tools yet; load ${loadableTools.length === 1 ? 'it' : 'them'} with \`load_tool\` before the first call.`,
        ]
      : []),
    ...(unavailableTools.length
      ? [`${name} allows ${listed(unavailableTools)}, but this session cannot use them; a new session can.`]
      : []),
    `Agents already started under ${promptName} keep running with their own instructions; new delegation follows ${name}.`,
    '',
    instructions,
    '</system-reminder>',
  ].join('\n');
}

function messageText(message) {
  if (typeof message?.content === 'string') return message.content;
  if (!Array.isArray(message?.content)) return '';
  return message.content.map((part) => (typeof part === 'string' ? part : part?.text || '')).join('');
}

/** The conversation still holds `content` (a delivered reminder); false once
 *  a compaction or a clear dropped it. */
export function conversationHolds(session, content) {
  if (!content) return false;
  return (Array.isArray(session?.messages) ? session.messages : []).some(
    (message) => message?.role !== 'system' && messageText(message).includes(content)
  );
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

// The prompt itself carries `to` (a switch back to it, or the overlay folded in).
function promptWorkflowNoticeContent({ from, to }) {
  const before = from?.name || 'the previous workflow';
  return [
    '<system-reminder>',
    '# Workflow Changed',
    `This conversation now runs the ${to.name} workflow, the one the system prompt carries: its Active Workflow, orchestration mode, available agents and tools apply. This replaces every earlier Workflow Changed reminder in this conversation.`,
    `Agents already started under ${before} keep running with their own instructions; new delegation follows ${to.name}.`,
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
  const overlay = session.workflowOverlay;
  const content =
    overlay?.workflow?.id === pending.to.id && overlay.content ? overlay.content : promptWorkflowNoticeContent(pending);
  return { revision: pending.revision, content };
}

/** The notice of `revision` reached the model: nothing is due any more. */
export function acknowledgePendingWorkflowNotice(session, revision) {
  if (!session?.workflowSwitch || session.workflowSwitch.revision !== Number(revision)) return false;
  delete session.workflowSwitch;
  return true;
}
