// session/human-gate/gate.mjs
// The one policy hook for human approval, applied to every model tool call
// after the PreToolUse hooks (loop/tool-exec/before-hook.mjs):
//   humanGateDecision(call, decision, ctx) → { decision, request }
// turns an outbound call (outbound-policy.mjs) into an `ask` whatever the
// hooks or the agent's permission said short of a deny, unless the agent's
// permission for that action kind (store.mjs) is `allow`; `block` denies it
// without a card. Other surfaces (group rooms) call it with their own
// decision to get the same outbound rule. After the user answered,
// recordHumanDecision stores a "don't ask again" grant and the audit line. Unattended runs (schedule, webhook, room member) register a
// port here (session-runtime/held-requests.mjs) that turns their asks into
// held requests instead of an approval card.
import { MIXY_AGENT_ID, agentIdOfHomeSession } from '../agent-home.mjs';
import { serverConnector } from '../../mcp/server-connectors.mjs';
import { roomMemberOfSession } from '../agent-room.mjs';
import { classifyOutboundCall, isRememberableAction } from './outbound-policy.mjs';
import { humanGateStore } from './store.mjs';

export const OUTBOUND_APPROVAL_REASON = 'This sends or posts outside Mixdog; it needs your approval.';
export const BLOCKED_ACTION_REASON = "This agent's permission blocks this action.";
/** Outbound grants may be remembered for this agent, never for every agent;
 *  payments and deletes never. */
const outboundRemember = (category) => (isRememberableAction(category) ? ['once', 'agent'] : ['once']);

let unattendedPort = null;
/** `{ runOf(sessionId) → { kind, agentId, name } | null, hold(request, { signal }) → Promise<approval>,
 *  humanNeeded(sessionId, outcome, site) → Promise<boolean> }` — the last ends a schedule/webhook
 *  run that would need a takeover (session-runtime/held-requests.mjs). */
export function setUnattendedApprovalPort(port) {
  unattendedPort = port || null;
}
export function unattendedApprovalPort() {
  return unattendedPort;
}

/** The agent a session acts for: its unattended run's owner, a room member,
 *  a home thread's agent, else Mixy. */
export function agentIdForSession(sessionId) {
  const run = unattendedPort?.runOf?.(sessionId);
  if (run?.agentId) return run.agentId;
  return roomMemberOfSession(sessionId)?.agentId || agentIdOfHomeSession(sessionId) || MIXY_AGENT_ID;
}

const actionOf = (decision) => String(decision?.action || decision?.decision || '').toLowerCase();

async function mcpAnnotations(name, scopeId) {
  if (!String(name).startsWith('mcp__')) return undefined;
  try {
    const { getMcpTools } = await import('../../mcp/client.mjs');
    const tool = getMcpTools(scopeId || undefined).find((entry) => entry.name === name);
    return tool
      ? { ...(tool.annotations || {}), ...(tool.mcpToolName ? { mcpToolName: tool.mcpToolName } : {}) }
      : undefined;
  } catch {
    return undefined;
  }
}

/** Messages a trash card lists by sender and subject; the rest read "외 N통". */
const PREVIEW_MESSAGES = 3;

/** A connector that can say whose account it is and what its message ids are
 *  offers a read-only `describe_emails` tool (connectors/gmail-app-password.mjs).
 *  Returns `{ account, messages, more }` for the card, or null: the card then
 *  shows what the call itself carries. Never changes what is approved. */
async function describeEmails(call, outbound, ctx) {
  if (outbound.category !== 'email' && outbound.category !== 'trash') return null;
  const [, server = ''] = String(call?.name || '').split('__');
  // Only the Gmail connector offers it; any other mail server never sees an unlisted call.
  if (serverConnector(server) !== 'gmail') return null;
  const name = `mcp__${server}__describe_emails`;
  try {
    // Not a listed tool: the server answers it (or errors, and the card keeps the call's own content).
    const { executeMcpTool } = await import('../../mcp/client.mjs');
    const ids = outbound.category === 'trash' && Array.isArray(call.args?.ids) ? call.args.ids.map(String) : [];
    const shown = ids.slice(0, PREVIEW_MESSAGES);
    const raw = await executeMcpTool(name, { ids: shown }, { scopeId: ctx.mcpScopeId });
    const { account, emails } = JSON.parse(raw);
    const messages = (Array.isArray(emails) ? emails : []).map((mail) =>
      [mail.from, mail.subject, String(mail.date || '').slice(0, 10)].filter(Boolean).join(' · ')
    );
    return { account: String(account || ''), messages, more: Math.max(0, ids.length - shown.length) };
  } catch {
    return null;
  }
}

/**
 * @param {{ name: string, args: any }} call
 * @param {object|null} decision the PreToolUse decision so far
 * @param {{ sessionId?: string, mcpScopeId?: string, annotations?: object, store?: object }} ctx
 * @returns {Promise<{ decision: object|null, request: object|null, gate: object|null }>}
 *   `request` holds the kind-specific fields an `ask` presents; `gate` the
 *   audit identity `{ agentId, kind, action, tool, target }`.
 */
export async function humanGateDecision(call, decision, ctx = {}) {
  const action = actionOf(decision);
  if (action === 'deny' || action === 'block') return { decision, request: null, gate: null };
  const agentId = agentIdForSession(ctx.sessionId);
  const annotations = ctx.annotations ?? (await mcpAnnotations(call?.name, ctx.mcpScopeId));
  const outbound = classifyOutboundCall({ name: call?.name, args: call?.args, annotations });
  if (!outbound) {
    if (action !== 'ask') return { decision, request: null, gate: null };
    return {
      decision,
      request: { kind: 'approval', agentId, remember: ['once'] },
      gate: { agentId, kind: 'approval', tool: String(call?.name || ''), target: '' },
    };
  }
  const gate = { agentId, kind: 'outbound', action: outbound.category, tool: outbound.tool, target: outbound.target };
  const request = {
    kind: 'outbound',
    agentId,
    outbound: {
      category: outbound.category,
      target: outbound.target,
      account: outbound.account,
      payload: outbound.payload,
      editable: outbound.editable,
      details: outbound.details,
    },
    remember: outboundRemember(outbound.category),
  };
  const store = ctx.store || (await humanGateStore());
  const mode = await store.modeFor({ agentId, action: outbound.category });
  const base = decision && typeof decision === 'object' ? decision : {};
  if (mode === 'block') {
    await store.recordAudit({ ...gate, decision: 'blocked', device: '' });
    return { decision: { ...base, action: 'deny', reason: BLOCKED_ACTION_REASON }, request: null, gate: null };
  }
  if (action !== 'ask' && mode === 'allow') {
    await store.recordAudit({ ...gate, decision: 'remembered', device: '' });
    return { decision, request: null, gate: null };
  }
  const described = await describeEmails(call, outbound, ctx);
  if (described) {
    if (described.account) request.outbound.account = described.account;
    if (described.messages.length)
      request.outbound.details = { ...outbound.details, messages: described.messages.join('\n') };
    if (described.more) request.outbound.details = { ...request.outbound.details, more: String(described.more) };
  }
  // A hook that did not rewrite the call (allow / no decision) carries no
  // name or args into the ask: the card shows, and the run executes, the
  // call that was classified.
  const rewriting = action === 'ask' || action === 'modify' || action === 'rewrite';
  const { name: _name, args: _args, ...unrewritten } = base;
  return {
    decision: { ...(rewriting ? base : unrewritten), action: 'ask', reason: base.reason || OUTBOUND_APPROVAL_REASON },
    request,
    gate,
  };
}

/** Audit one answered request and store its remembered grant. `approval` is
 *  the waiter's result ({ approved, response, remember, device, timedOut }). */
export async function recordHumanDecision(gate, approval, { store } = {}) {
  if (!gate) return;
  const target = store || (await humanGateStore());
  const decision = approval?.timedOut
    ? 'timeout'
    : approval?.response || (approval?.approved === true ? 'approve' : 'deny');
  const device = typeof approval?.device === 'string' ? approval.device : '';
  if (approval?.approved === true && gate.action) {
    await target.grant({ agentId: gate.agentId, action: gate.action, scope: approval.remember, device });
  }
  await target.recordAudit({ ...gate, decision, device });
}
