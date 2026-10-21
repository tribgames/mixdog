// session/human-gate/gate.mjs
// The one policy hook for human approval, applied to every model tool call
// after the PreToolUse hooks (loop/tool-exec/before-hook.mjs):
//   humanGateDecision(call, decision, ctx) → { decision, request }
// turns an outbound call (outbound-policy.mjs) into an `ask` whatever the
// hooks or the agent's permission said short of a deny, unless the agent's
// permission for that action kind (store.mjs) is `allow`; `block` denies it
// without a card. The outbound rule applies ONLY while a bot acts (see
// actingBotId); an ordinary coding session's outbound call passes with the
// hook decision unchanged. Other surfaces (group rooms) call it with their own
// decision to get the same outbound rule. After the user answered,
// recordHumanDecision stores a "don't ask again" grant and the audit line. Unattended runs (schedule, webhook, room member) register a
// port here (session-runtime/held-requests.mjs) that turns their asks into
// held requests instead of an approval card.
import { MIXY_AGENT_ID, agentHomeSessionId, agentIdOfHomeSession } from '../agent-home.mjs';
import { serverConnector } from '../../mcp/server-connectors.mjs';
import { readAgentDefinitionKind } from '../../../../shared/agent-kind.mjs';
import { isContactAgentId } from '../../../../shared/agent-route-config.mjs';
import { mixdogRoot, resolvePluginData } from '../../../../shared/plugin-paths.mjs';
import { roomMemberOfSession } from '../agent-room.mjs';
import { agentDisplayName } from '../../context/role-instructions.mjs';
import { delegationOf } from './delegation.mjs';
import { setUnattendedApprovalPort, unattendedApprovalPort } from './unattended-port.mjs';
import { classifyAsDelete, classifyOutboundCall, isRememberableAction } from './outbound-policy.mjs';
import { humanGateStore } from './store.mjs';
import {
  AUTOMATION_GRANT_REASON,
  RUN_FORBIDDEN_REASON,
  isGrantedRun,
  isRemoteDeleteInRun,
  savesAutomation,
} from './run-policy.mjs';

export const OUTBOUND_APPROVAL_REASON = 'This sends or posts outside Mixdog; it needs your approval.';
export const BLOCKED_ACTION_REASON = "This agent's permission blocks this action.";
/** Outbound grants may be remembered for this agent, never for every agent;
 *  payments and deletes never. */
const outboundRemember = (category) => (isRememberableAction(category) ? ['once', 'agent'] : ['once']);

// The unattended runs' port lives in unattended-port.mjs (delegation.mjs reads
// it when a session is created); its setter and getter are re-exported here.
export { setUnattendedApprovalPort, unattendedApprovalPort };

/** The agent a session is bound to by itself: its unattended run's owner, a
 *  room member, a home thread's agent; '' for any other session. */
function ownBoundAgentId(sessionId) {
  const run = unattendedApprovalPort()?.runOf?.(sessionId);
  if (run?.agentId) return run.agentId;
  return roomMemberOfSession(sessionId)?.agentId || agentIdOfHomeSession(sessionId) || '';
}

/** The agent a session is bound to: its own binding, else — a sub-agent at
 *  any depth, a task session a bot created — the root recorded on it when it
 *  was created (delegation.mjs); '' for a coding Lead and every agent under
 *  it, and for a delegated session whose root is unknown (see isUnresolved). */
function boundAgentId(sessionId) {
  const own = ownBoundAgentId(sessionId);
  if (own) return own;
  const delegation = delegationOf(sessionId);
  return delegation.state === 'resolved' ? delegation.rootAgentId : '';
}

/** A delegated session whose root could not be established: it may act for a
 *  bot, so the gate fails closed (outbound asks, nothing is remembered). */
const isUnresolved = (sessionId) => !ownBoundAgentId(sessionId) && delegationOf(sessionId).state === 'unresolved';

/** The agent a session acts for: its unattended run's owner, a room member,
 *  a home thread's agent, else Mixy. */
export function agentIdForSession(sessionId) {
  return boundAgentId(sessionId) || MIXY_AGENT_ID;
}

/** The bot a session acts for, or '' when none: Mixy in her own home thread
 *  (or her unattended run / room member session), or a contact agent (`kind:
 *  bot`, isContactAgentId) in its home thread, room member session or
 *  unattended run — or any session delegated from one of those (a sub-agent,
 *  a task session the bot created, nested at any depth), which acts as that
 *  root bot. A coding Lead (also id 'lead'), its workflow agents and their
 *  sub-agent sessions are bound to nothing here, so they are no bot. */
function actingBotId(sessionId) {
  const id = boundAgentId(sessionId);
  if (!id) return '';
  if (id === MIXY_AGENT_ID) return id;
  const kind = readAgentDefinitionKind({ dataDir: resolvePluginData(), shippedRoot: mixdogRoot(), id });
  return isContactAgentId(id, kind) ? id : '';
}

/** The contact bot (`kind: bot`) a session acts for, or '' for Mixy, a coding
 *  Lead, a workflow agent and every other session. Mixy shares the `lead` id
 *  with the coding Lead (her connector policy is hers alone, never the Lead's:
 *  connectorPolicyAgentOf), and a standing allow is a contact bot's own policy
 *  entry: none is offered to Mixy, a Lead or a workflow agent. */
export function actingContactBotId(sessionId) {
  const id = actingBotId(sessionId);
  // Only where a remembering answer can be given in the bot's OWN home thread
  // (rememberSurfaceOf). A room member, an unattended run (a schedule, a
  // webhook) and work they started act for the bot in a session that is not its chat.
  return id && id !== MIXY_AGENT_ID && rememberSurfaceOf(sessionId) === agentHomeSessionId(id) ? id : '';
}

/** The one session where an answer to `sessionId`'s request may be
 *  remembered ("don't ask again", "always allow"): the bot's home chat when
 *  the request lives there, or surfaces there because the work was started
 *  from that attended chat; '' otherwise (a room, a run, a coding Lead, an
 *  unresolved delegation). The approval queue honours a remembering answer
 *  only from that session (tui/session/tool-approval.mjs). */
export function rememberSurfaceOf(sessionId) {
  // A schedule/webhook running in the home itself is not the attended chat.
  if (unattendedApprovalPort()?.runOf?.(sessionId)) return '';
  if (agentIdOfHomeSession(sessionId)) return sessionId;
  if (ownBoundAgentId(sessionId)) return '';
  const delegation = delegationOf(sessionId);
  return delegation.state === 'resolved' && delegation.via === 'home' ? delegation.rootSessionId : '';
}

// Chain tokens the desktop translates (ApprovalCard approvalChainLabel).
const LEAD_NAME = 'Lead';
const TASK_SESSION_NAME = 'Task session';

/** Where a delegated session's approval cards also surface, and who is
 *  asking: `{ sessionId, chain }` — the top-level conversation the user
 *  watches (the root bot's home chat, a room member session, a coding Lead's
 *  session) and the names from there down to the asker ("사무관 › Worker",
 *  "사무관 › Task session", "Lead › Reviewer"). A sub-agent at any depth and
 *  a task session a bot created have one; null for a top-level session. */
export function approvalSurface(sessionId) {
  const delegation = delegationOf(sessionId);
  if (delegation.state !== 'resolved') return null;
  const chain = [delegation.rootAgentId ? agentDisplayName(delegation.rootAgentId) : LEAD_NAME];
  for (const step of delegation.path) {
    chain.push(step.kind === 'agent' ? agentDisplayName(step.agent) || step.agent : TASK_SESSION_NAME);
  }
  return { sessionId: delegation.rootSessionId, chain };
}

const actionOf = (decision) => String(decision?.action || decision?.decision || '').toLowerCase();

async function mcpAnnotations(name, scopeId) {
  if (!String(name).startsWith('mcp__')) return undefined;
  try {
    const { getMcpTools } = await import('../../mcp/client.mjs');
    const tool = getMcpTools(scopeId || undefined).find((entry) => entry.name === name);
    if (!tool) return undefined;
    return { ...(tool.annotations || {}), ...(tool.mcpToolName ? { mcpToolName: tool.mcpToolName } : {}) };
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
 * @returns {Promise<{ decision: object|null, request: object|null, gate: object|null, remembered?: true }>}
 *   `request` holds the kind-specific fields an `ask` presents; `gate` the
 *   audit identity `{ agentId, kind, action, tool, target }`; `remembered`
 *   marks an outbound call a stored grant already answered.
 */
export async function humanGateDecision(call, decision, ctx = {}) {
  const action = actionOf(decision);
  if (action === 'deny' || action === 'block') return { decision, request: null, gate: null };
  // Delegated, but its root is unknown: treated as a bot whose identity, grants
  // and remember surface are unknown — every outbound call asks, once only.
  const unresolved = isUnresolved(ctx.sessionId);
  const agentId = unresolved ? '' : agentIdForSession(ctx.sessionId);
  const annotations = ctx.annotations ?? (await mcpAnnotations(call?.name, ctx.mcpScopeId));
  let classified = classifyOutboundCall({ name: call?.name, args: call?.args, annotations });
  const remoteDelete = isRemoteDeleteInRun({ name: call?.name, annotations }, classified);
  // In a schedule/webhook run only a recoverable trash may delete remote items.
  if (isGrantedRun(unattendedApprovalPort()?.runOf?.(ctx.sessionId)) && remoteDelete) {
    const store = ctx.store || (await humanGateStore());
    await store.recordAudit({
      agentId,
      kind: 'outbound',
      action: 'delete',
      tool: String(call?.name || ''),
      target: '',
      decision: 'run-forbidden',
      device: '',
    });
    const base = decision && typeof decision === 'object' ? decision : {};
    return { decision: { ...base, action: 'deny', reason: RUN_FORBIDDEN_REASON }, request: null, gate: null };
  }
  // Where a bot is attended, the same connector delete the runs refuse
  // (delete_message, remove_member…) is a permanent delete: it asks, never remembered.
  if (remoteDelete && classified?.category !== 'delete' && classified?.category !== 'payment') {
    classified = classifyAsDelete({ name: call?.name, args: call?.args });
  }
  const outbound = classified && (unresolved || actingBotId(ctx.sessionId)) ? classified : null;
  if (!outbound) {
    if (action !== 'ask') return { decision, request: null, gate: null };
    return {
      // Saving a schedule or webhook says plainly what the approval grants.
      decision: savesAutomation(call) ? { ...decision, reason: AUTOMATION_GRANT_REASON } : decision,
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
    remember: ['once'],
  };
  // "Don't ask again" only where it can be answered in the bot's own chat.
  const rememberAt = unresolved ? '' : rememberSurfaceOf(ctx.sessionId);
  if (rememberAt && isRememberableAction(outbound.category)) {
    request.remember = outboundRemember(outbound.category);
    request.rememberAt = rememberAt;
  }
  const store = ctx.store || (await humanGateStore());
  const mode = unresolved ? 'ask' : await store.modeFor({ agentId, action: outbound.category });
  const base = decision && typeof decision === 'object' ? decision : {};
  if (mode === 'block') {
    await store.recordAudit({ ...gate, decision: 'blocked', device: '' });
    return { decision: { ...base, action: 'deny', reason: BLOCKED_ACTION_REASON }, request: null, gate: null };
  }
  if (action !== 'ask' && mode === 'allow') {
    await store.recordAudit({ ...gate, decision: 'remembered', device: '' });
    // The remembered grant answers this call: no later layer asks it again.
    return { decision, request: null, gate: null, remembered: true };
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
    // The scopes this request offered: a grant is stored only for one of them.
    gate: { ...gate, remember: request.remember },
  };
}

/** Audit one answered request and store its remembered grant. `approval` is
 *  the waiter's result ({ approved, response, remember, device, timedOut }). */
export async function recordHumanDecision(gate, approval, { store } = {}) {
  if (!gate) return;
  const target = store || (await humanGateStore());
  let decision = approval?.response || (approval?.approved === true ? 'approve' : 'deny');
  if (approval?.timedOut) decision = 'timeout';
  const device = typeof approval?.device === 'string' ? approval.device : '';
  // A scope the request did not offer (an answer from a place that may not
  // remember) stores nothing.
  const offered = !Array.isArray(gate.remember) || gate.remember.includes(approval?.remember);
  if (approval?.approved === true && gate.action && offered) {
    await target.grant({ agentId: gate.agentId, action: gate.action, scope: approval.remember, device });
  }
  const { remember: _offered, ...audit } = gate;
  await target.recordAudit({ ...audit, decision, device });
}
