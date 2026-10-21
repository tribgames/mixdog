/**
 * Unattended runs. A schedule or webhook run never asks (its saved routine is
 * the user's grant; human-gate/run-policy.mjs), so only group-room members
 * still use held requests: an approval-needing call is HELD instead of shown as
 * a card: the run pauses on it, a structured held-request row lands in the
 * owning agent's home thread (agent-home-delivery.mjs queue), a phone push
 * says only "<agent>가 승인을 기다립니다" (no tool, arguments or text), and the
 * request waits, like any approval, until the user answers it (Approve/Deny,
 * through the ordinary approval call with the held id,
 * runtime/shared/held-request-host.mjs) or the run is cancelled (Stop, abort,
 * app quit), which denies it. It never expires on a timer.
 *
 * Importing this module installs the unattended port of human-gate/gate.mjs.
 * Rooms: a room member session counts as unattended by its id; a surface that
 * hosts its own approval UI (a room) keeps it, and may call holdApprovalRequest
 * itself to hold one request for the member's agent.
 */
import { randomUUID } from 'node:crypto';
import { MIXY_AGENT_ID, agentHomeSessionId } from '../runtime/agent/orchestrator/session/agent-home.mjs';
import { roomMemberOfSession } from '../runtime/agent/orchestrator/session/agent-room.mjs';
import { mixyDisplayName } from '../runtime/agent/orchestrator/session/mixy-name.mjs';
import {
  recordHumanDecision,
  setUnattendedApprovalPort,
} from '../runtime/agent/orchestrator/session/human-gate/gate.mjs';
import { normalizeHumanResponse } from '../runtime/agent/orchestrator/session/human-gate/requests.mjs';
import { normalizeHeldRequest } from '../runtime/agent/orchestrator/session/human-gate/held-message.mjs';
import { delegationOf } from '../runtime/agent/orchestrator/session/human-gate/delegation.mjs';
import {
  notifyHeldRequest,
  recordRunOwner,
  registerHeldRequestResolver,
} from '../runtime/shared/held-request-host.mjs';

const runs = new Map(); // sessionId → { kind, agentId, name }

/** Mark `sessionId` as an unattended schedule/webhook run of `agentId`. */
export function markUnattendedRun(sessionId, { kind, agentId, name = '' }) {
  if (!sessionId) return () => {};
  const run = {
    kind: kind === 'webhook' ? 'webhook' : 'schedule',
    agentId: agentId || MIXY_AGENT_ID,
    name: String(name),
  };
  runs.set(sessionId, run);
  recordRunOwner(sessionId, run.agentId);
  return () => {
    if (runs.get(sessionId) === run) runs.delete(sessionId);
  };
}

/** The unattended run `sessionId` belongs to, or null for an attended session.
 *  Work delegated from a run or a room (a sub-agent at any depth, a task
 *  session the bot created) belongs to it by the origin recorded on its own
 *  session record when it was created (human-gate/delegation.mjs) — however
 *  long ago that run ended, across restarts: its approvals are held like the
 *  run's own. */
export function unattendedRunOf(sessionId) {
  const run = runs.get(sessionId);
  if (run) return run;
  const member = roomMemberOfSession(sessionId);
  if (member) return { kind: 'room', agentId: member.agentId, name: member.roomId };
  const delegation = delegationOf(sessionId);
  if (delegation.state !== 'resolved') return null;
  if (delegation.via === 'run') {
    return {
      kind: delegation.run.kind === 'webhook' ? 'webhook' : 'schedule',
      agentId: delegation.rootAgentId,
      name: String(delegation.run.name || ''),
    };
  }
  const root = delegation.via === 'room' ? roomMemberOfSession(delegation.rootSessionId) : null;
  return root ? { kind: 'room', agentId: root.agentId, name: root.roomId } : null;
}

/**
 * A schedule or webhook turn has nobody to hand a step to: a takeover there
 * (an expired sign-in, 2FA, a CAPTCHA, a confirmation) ends the turn at once
 * instead of waiting, and the routine turn (routine-home-turn.mjs) fails with
 * routineHumanNeededText. `outcome` is login_required, human_action_required
 * or sensitive_confirmation_required. Rooms keep their own UI. Resolves false
 * for a session that is not such a run.
 */
export async function failRunForHuman(sessionId, outcome, site, abortTurn = defaultAbortTurn) {
  const run = runs.get(sessionId);
  if (!run) return false;
  run.humanNeeded = { outcome, site: String(site || '') };
  await abortTurn(sessionId);
  return true;
}

async function defaultAbortTurn(sessionId) {
  const { abortSessionTurn } = await import('../runtime/agent/orchestrator/session/manager/session-close.mjs');
  abortSessionTurn(sessionId, 'login-required');
}

/** Push name of an agent; the representative's display name for the Lead. */
function defaultAgentName(agentId) {
  return agentId === MIXY_AGENT_ID ? mixyDisplayName() : agentId;
}

/**
 * The held-request registry. `deliver(agentId, held)` posts a row into the
 * home thread; `push(event)` sends the sanitized phone push; `record(gate,
 * approval)` writes the audit line.
 */
export function createHeldRequests({
  deliver,
  push = notifyHeldRequest,
  record = recordHumanDecision,
  agentName = defaultAgentName,
  runOf = unattendedRunOf,
  log = (line) => process.stderr.write(`mixdog held-requests: ${line}\n`),
}) {
  const pending = new Map();
  const post = (agentId, held) =>
    Promise.resolve()
      .then(() => deliver(agentId, held))
      .catch((error) => log(`held request ${held.id} could not be delivered: ${error?.message || error}`));

  function settle(id, approval, status) {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.release();
    void post(entry.agentId, { ...entry.held, status, ...(approval.device ? { device: approval.device } : {}) });
    void Promise.resolve()
      .then(() => record(entry.gate, approval))
      .catch((error) => log(`held request ${id} audit failed: ${error?.message || error}`));
    entry.resolve(approval);
    return true;
  }

  /** Hold `request` (the approval hook's payload) until answered or the run is cancelled. */
  function hold(request = {}, { signal } = {}) {
    const run = runOf(request.sessionId) || { kind: 'schedule', agentId: MIXY_AGENT_ID, name: '' };
    const id = `held_${randomUUID()}`;
    const held = normalizeHeldRequest({
      id,
      status: 'pending',
      agentId: run.agentId,
      kind: request.kind || 'approval',
      tool: request.name,
      target: request.outbound?.target || '',
      reason: request.reason || '',
      ...(request.kind === 'outbound'
        ? {
            payload: request.outbound?.payload || '',
            action: request.outbound?.category,
            account: request.outbound?.account,
            editable: request.outbound?.editable,
            details: request.outbound?.details,
          }
        : {}),
      // An unattended run never remembers: its held row offers once only.
      remember: ['once'],
      run: { kind: run.kind, name: run.name, sessionId: request.sessionId },
    });
    const shape = { kind: held.kind, outbound: request.outbound, remember: ['once'] };
    const gate = {
      remember: ['once'],
      agentId: run.agentId,
      kind: held.kind,
      ...(held.action ? { action: held.action } : {}),
      tool: held.tool,
      target: held.target,
    };
    return new Promise((resolve) => {
      const onAbort = () => settle(id, { ...normalizeHumanResponse(shape, false), reason: 'run cancelled' }, 'denied');
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const entry = {
        held,
        shape,
        gate,
        agentId: run.agentId,
        resolve,
        release: () => signal?.removeEventListener?.('abort', onAbort),
      };
      pending.set(id, entry);
      void post(run.agentId, held);
      try {
        push({
          sessionId: agentHomeSessionId(run.agentId) || agentHomeSessionId(MIXY_AGENT_ID),
          agentId: run.agentId,
          agentName: agentName(run.agentId),
          requestId: id,
        });
      } catch (error) {
        log(`held request ${id} push failed: ${error?.message || error}`);
      }
    });
  }

  /** Answer held request `id`; false when it is not pending (already settled). */
  function resolve(id, decision = {}) {
    const entry = pending.get(id);
    if (!entry) return false;
    const approved = decision === true || decision?.approved === true;
    const approval = {
      ...normalizeHumanResponse(entry.shape, approved, decision),
      reason: String(decision?.reason || (approved ? 'approved by user' : 'denied by user')),
      ...(typeof decision?.device === 'string' && decision.device ? { device: decision.device } : {}),
    };
    return settle(id, approval, approved ? 'approved' : 'denied');
  }

  return { hold, resolve, pending: () => [...pending.values()].map((entry) => entry.held) };
}

let processHeld = null;
async function defaultDeliver(agentId, held) {
  const { deliverHeldRequest } = await import('./agent-home-delivery.mjs');
  return deliverHeldRequest(agentId, held);
}
function heldRequests() {
  processHeld ??= createHeldRequests({ deliver: defaultDeliver });
  return processHeld;
}

/** The held requests still waiting for an answer (session bots reads them). */
export function pendingHeldRequests() {
  return processHeld ? processHeld.pending() : [];
}

/** Hold one request for its session's agent (rooms call this from their own hook). */
export function holdApprovalRequest(request, options) {
  return heldRequests().hold(request, options);
}

setUnattendedApprovalPort({ runOf: unattendedRunOf, hold: holdApprovalRequest, humanNeeded: failRunForHuman });
registerHeldRequestResolver((id, decision) => heldRequests().resolve(id, decision));
