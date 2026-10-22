/**
 * before-hook.mjs — the PreToolUse policy hook: deny, rewrite the call, or
 * ask for approval before the tool runs.
 */
import { resolvePreToolAskApproval } from '../tool-helpers.mjs';
import { runAbortable, throwIfAborted } from '../../../../../shared/abort-race.mjs';
import { evaluateExecPolicy } from '../../../tools/bash-policy-scan.mjs';
import { beginSessionApprovalWait } from '../../manager/runtime-liveness.mjs';
import { agentMcpToolPermission, writeAgentMcpToolPermission } from '../../../mcp/agent-connectors.mjs';
import { actingBotId, actingContactBotId, humanGateDecision, recordHumanDecision } from '../../human-gate/gate.mjs';
import { applyEditedArgs } from '../../human-gate/requests.mjs';

const isArgsObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

async function askApproval(
  call,
  { callerSessionId, executeOpts, toolApprovalHook, decision, request = null, gate = null, onApproved = null }
) {
  const askReason = String(decision?.reason || 'approval requested by hook').trim();
  // While the user decides, the session is waiting on them, not working.
  const releaseApprovalWait = beginSessionApprovalWait(callerSessionId);
  let askOutcome;
  try {
    askOutcome = await runAbortable(executeOpts.signal, () =>
      resolvePreToolAskApproval({
        toolName: call.name,
        args: call.args,
        cwd: call.cwd,
        sessionId: callerSessionId,
        toolCallId: executeOpts.toolCallId || null,
        askReason,
        toolApprovalHook,
        request,
      })
    );
  } finally {
    releaseApprovalWait();
  }
  const approval = askOutcome.approval;
  await recordHumanDecision(gate, approval);
  if (askOutcome.denial) return { denial: askOutcome.denial };
  if (approval && typeof approval === 'object' && isArgsObject(approval.args)) call.args = approval.args;
  // The card's edited text replaces the model's before the call runs.
  if (request?.kind === 'outbound' && approval?.editedArgs) {
    call.args = applyEditedArgs(call.args, approval.editedArgs, request.outbound?.editable);
  }
  // The user approved this very call on the richer outbound card.
  if (request?.kind === 'outbound') call.outboundApproved = true;
  await onApproved?.(approval);
  return null;
}

/** The renderer translates this exact text (desktop-toasts.tsx ALLOW_NOT_SAVED_TEXT). */
export const ALLOW_NOT_SAVED_NOTICE = 'Allowed this once. The setting could not be saved.';
export const CONNECTOR_APPROVAL_REASON = 'This connector tool is set to ask before it runs for this agent.';

/**
 * A connector tool a bot's own session (its home chat or room seat; a
 * schedule/webhook run, which the approval hook then answers by run policy)
 * runs, and the bot set to `needs_approval`, asks through the ordinary
 * approval hook, whatever the PreToolUse hooks decided. Any other session (a
 * coding Lead, a task session, a workflow agent, a sub-agent) runs it unasked.
 * Run after the hooks, on the final call: a renamed call is judged under its
 * final name. A call the outbound gate owns (its card approved it, or a
 * remembered outbound grant answered it) is not asked a second time.
 * @returns {Promise<{ denial: string } | null>} the denial, or null to run
 */
export function applyConnectorApproval(call, { agentId, callerSessionId, executeOpts, toolApprovalHook }) {
  if (call.outboundApproved) return null;
  if (!actingBotId(callerSessionId)) return null;
  if (agentMcpToolPermission(agentId, call.name) !== 'needs_approval') return null;
  // "Always allow" is offered only to the contact bot that is acting, for its
  // own policy entry for this one tool: never another bot or Mixy.
  const botId = actingContactBotId(callerSessionId);
  const rememberable = Boolean(botId) && botId === agentId;
  return askApproval(call, {
    callerSessionId,
    executeOpts,
    toolApprovalHook,
    decision: { reason: CONNECTOR_APPROVAL_REASON },
    request: rememberable ? { kind: 'approval', agentId: botId, remember: ['once', 'agent'] } : null,
    onApproved: async (approval) => {
      if (!rememberable || approval?.remember !== 'agent') return;
      try {
        if (await writeAgentMcpToolPermission(botId, call.name, 'auto')) return;
      } catch {
        // fall through to the notice below
      }
      // Not saved: this call still runs once, and the next one asks again.
      toolApprovalHook?.notice?.(ALLOW_NOT_SAVED_NOTICE, 'warn');
    },
  });
}

/**
 * Elevation pass for a shell call (or a terminal `run`) whose exec policy
 * decision is 'ask' (elevated launch). Runs after the final call is known.
 * Mixdog does not prompt first: the OS elevation prompt (Windows UAC) is the
 * user's confirmation. A deny is never lifted.
 * @returns {{ elevationApproved: boolean }}
 */
export function applyShellElevationGate(call) {
  const gated = call.name === 'shell' || (call.name === 'terminal' && call.args?.action === 'run');
  if (!gated || !isArgsObject(call.args) || call.args.command == null) {
    return { elevationApproved: false };
  }
  return { elevationApproved: evaluateExecPolicy(String(call.args.command)).decision === 'ask' };
}

/**
 * @returns {Promise<{ denial: string } | { name: string, args: any }>}
 *   the call as the hook left it, or the denial text to return instead
 */
export async function applyBeforeToolHook({
  name,
  args,
  cwd,
  callerSessionId,
  executeOpts,
  beforeToolHook,
  toolApprovalHook,
  mcpScopeId = null,
}) {
  const call = { name, args, cwd };
  // ask_user is itself the user prompt; it never goes through the ordinary approval gate.
  if (name === 'ask_user') return call;
  try {
    const hookDecision = beforeToolHook
      ? await runAbortable(executeOpts.signal, () =>
          beforeToolHook(
            {
              name,
              args,
              cwd,
              sessionId: callerSessionId,
              toolCallId: executeOpts.toolCallId || null,
            },
            { signal: executeOpts.signal }
          )
        )
      : null;
    // Outbound sends ask the user whatever the hooks allowed (human-gate/gate.mjs).
    // Judged as the call will run: only a rewriting decision changes name/args.
    const hookAction = String(hookDecision?.action || hookDecision?.decision || '').toLowerCase();
    const rewritten = hookAction === 'ask' || hookAction === 'modify' || hookAction === 'rewrite';
    const { decision, request, gate, remembered } = await humanGateDecision(
      {
        name:
          rewritten && typeof hookDecision?.name === 'string' && hookDecision.name.trim()
            ? hookDecision.name.trim()
            : name,
        args: rewritten && isArgsObject(hookDecision?.args) ? hookDecision.args : args,
      },
      hookDecision,
      { sessionId: callerSessionId, mcpScopeId }
    );
    const action = String(decision?.action || decision?.decision || '').toLowerCase();
    // A remembered outbound grant answered this call: the connector ask is not repeated.
    if (remembered) call.outboundApproved = true;
    if (action === 'deny' || action === 'block') {
      const reason = decision?.reason ? `: ${decision.reason}` : '';
      return { denial: `Error: tool "${name}" denied by hook${reason}` };
    }
    if (action === 'ask' || action === 'modify' || action === 'rewrite') {
      if (isArgsObject(decision?.args)) call.args = decision.args;
      if (typeof decision?.name === 'string' && decision.name.trim()) call.name = decision.name.trim();
    }
    if (action === 'ask') {
      const denied = await askApproval(call, {
        callerSessionId,
        executeOpts,
        toolApprovalHook,
        decision,
        request,
        gate,
      });
      if (denied) return denied;
    }
  } catch (error) {
    throwIfAborted(executeOpts.signal);
    // A failed policy check fails closed: the tool must not run.
    return {
      denial: `Error: tool "${name}" denied: PreToolUse policy check failed: ${error?.message || String(error)}`,
    };
  }
  return call;
}
