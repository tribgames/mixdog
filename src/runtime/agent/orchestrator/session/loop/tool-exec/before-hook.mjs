/**
 * before-hook.mjs — the PreToolUse policy hook: deny, rewrite the call, or
 * ask for approval before the tool runs.
 */
import { resolvePreToolAskApproval } from '../tool-helpers.mjs';
import { runAbortable, throwIfAborted } from '../../../../../shared/abort-race.mjs';
import { beginSessionApprovalWait } from '../../manager/runtime-liveness.mjs';

const isArgsObject = (value) => value && typeof value === 'object' && !Array.isArray(value);

async function askApproval(call, { callerSessionId, executeOpts, toolApprovalHook, decision }) {
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
  if (approval && typeof approval === 'object' && isArgsObject(approval.args)) call.args = approval.args;
  return null;
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
