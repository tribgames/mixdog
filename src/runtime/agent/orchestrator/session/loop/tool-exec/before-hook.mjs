/**
 * before-hook.mjs — the PreToolUse policy hook: deny, rewrite the call, or
 * ask for approval before the tool runs.
 */
import { resolvePreToolAskApproval } from '../tool-helpers.mjs';
import { runAbortable, throwIfAborted } from '../../../../../shared/abort-race.mjs';
import { evaluateExecPolicy } from '../../../tools/bash-policy-scan.mjs';
import { beginSessionApprovalWait } from '../../manager/runtime-liveness.mjs';

const isArgsObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

async function askApproval(call, { callerSessionId, executeOpts, toolApprovalHook, decision, keepArgs = false }) {
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
      })
    );
  } finally {
    releaseApprovalWait();
  }
  if (askOutcome.denial) return { denial: askOutcome.denial };
  const approval = askOutcome.approval;
  if (!keepArgs && approval && typeof approval === 'object' && isArgsObject(approval.args)) call.args = approval.args;
  return null;
}

/**
 * Approval gate for a shell call (or a terminal `run`) whose exec policy
 * decision is 'ask' (elevated launch). Runs after the final call is known. The
 * approval is granted for the exact command being asked about: an approval
 * reply cannot rewrite the args.
 * @returns {Promise<{ denial: string } | { elevationApproved: boolean }>}
 */
export async function applyShellElevationGate(call, { callerSessionId, executeOpts, toolApprovalHook }) {
  const gated = call.name === 'shell' || (call.name === 'terminal' && call.args?.action === 'run');
  if (!gated || !isArgsObject(call.args) || call.args.command == null) {
    return { elevationApproved: false };
  }
  const decision = evaluateExecPolicy(String(call.args.command));
  if (decision.decision !== 'ask') return { elevationApproved: false };
  const denied = await askApproval(call, {
    callerSessionId,
    executeOpts,
    toolApprovalHook,
    decision,
    keepArgs: true,
  });
  if (denied) return denied;
  return { elevationApproved: true };
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
}) {
  const call = { name, args, cwd };
  // ask_user is itself the user prompt; it never goes through the ordinary approval gate.
  if (!beforeToolHook || name === 'ask_user') return call;
  try {
    const decision = await runAbortable(executeOpts.signal, () =>
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
    );
    const action = String(decision?.action || decision?.decision || '').toLowerCase();
    if (action === 'deny' || action === 'block') {
      const reason = decision?.reason ? `: ${decision.reason}` : '';
      return { denial: `Error: tool "${name}" denied by hook${reason}` };
    }
    if (action === 'ask' || action === 'modify' || action === 'rewrite') {
      if (isArgsObject(decision?.args)) call.args = decision.args;
      if (typeof decision?.name === 'string' && decision.name.trim()) call.name = decision.name.trim();
    }
    if (action === 'ask') {
      const denied = await askApproval(call, { callerSessionId, executeOpts, toolApprovalHook, decision });
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
