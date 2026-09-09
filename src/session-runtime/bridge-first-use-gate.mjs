// One approval per session before the first live browser or desktop call.
//
// Claude Code asks per app and per session before it controls a screen; here
// the ask is per capability (Browser Use, Computer Use), answered once, and
// remembered for the session in memory only, so a restart asks again. Without
// an approval UI (headless runs, agent-owned sessions) nobody can answer, so
// the gate stands aside and the workflow's own policies govern.
import {
  approvalGranted,
  approvalReason,
} from '../runtime/agent/orchestrator/session/loop/tool-helpers.mjs';
import { builtinFirstUseApproval } from './builtin-features.mjs';

const FAMILY_BY_TOOL = Object.freeze({
  browser: 'browser',
  browser_devtools: 'browser',
  computer: 'computer',
});
const FAMILY_LABEL = Object.freeze({
  browser: 'Browser Use',
  computer: 'Computer Use',
});

export function bridgeToolFamily(name) {
  return FAMILY_BY_TOOL[String(name || '')] || null;
}

function callSummary(args) {
  const action = typeof args?.action === 'string' ? args.action : '';
  const input = args?.input && typeof args.input === 'object' ? args.input : args;
  const target = input?.url || input?.app || input?.window_id || input?.tab || '';
  return [action, target].filter(Boolean).map((part) => String(part).slice(0, 120)).join(' ') || 'call';
}

/** `getConfig` reads the live profile; the returned `gate` resolves to null
 *  when the call may proceed, or to the error text the model receives. */
export function createBridgeFirstUseGate({ getConfig }) {
  const granted = new Set();
  return async function gate({
    name, args, cwd, sessionId, toolCallId, toolApprovalHook, invocationSource,
  }) {
    const family = bridgeToolFamily(name);
    if (!family || invocationSource !== 'model-tool') return null;
    if (typeof toolApprovalHook !== 'function') return null;
    if (!builtinFirstUseApproval(getConfig?.(), family)) return null;
    const key = `${String(sessionId || '')}:${family}`;
    if (granted.has(key)) return null;
    const label = FAMILY_LABEL[family];
    const reason = `first ${label} call in this session (${callSummary(args)}); allowing it covers the rest of the session`;
    let approval;
    try {
      approval = await toolApprovalHook({
        name, args, cwd, sessionId: sessionId || null, toolCallId: toolCallId || null, reason,
      });
    } catch (error) {
      return `Error: ${label} first-use approval failed: ${error?.message || String(error || 'approval failed')}`;
    }
    if (!approvalGranted(approval)) {
      return `Error: ${label} was not approved for this session: ${approvalReason(approval, 'the user declined')}. `
        + 'Do not retry it; reach the goal another way or ask the user.';
    }
    granted.add(key);
    return null;
  };
}
