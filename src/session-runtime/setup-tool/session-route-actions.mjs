/** Setup actions that act on one running session rather than a setting: its
 *  fallback position (read in status model/agents), a return to its primary
 *  route, and its quota card's actions. The caller's own session changes
 *  through its runtime; another session through the daemon's configure lane
 *  (daemon-session-control/route-control.mjs), the lane the model picker and
 *  quota card use. */
import {
  liveRouteFallbackPositions,
  routeFallbackHopped,
  routeFallbackPosition,
  routeLeaf,
  sessionChainSource,
  sessionRoutePrimary,
} from '../../runtime/agent/orchestrator/session/manager/route-fallback-chain.mjs';
import { sameRouteModel } from '../../runtime/agent/orchestrator/session/manager/owner-route-fallbacks.mjs';
import { resolveSessionMode } from '../../runtime/agent/orchestrator/session/agent-mode.mjs';
import { agentHomeSessionId } from '../../runtime/agent/orchestrator/session/agent-home.mjs';
import { _liveSessions } from '../../runtime/agent/orchestrator/session/store/live-state.mjs';
import { assertOwnAgentSettings } from '../services/schedule-access.mjs';
import { clean } from '../../runtime/agent/orchestrator/runtime-core/session-text.mjs';

const modelOf = (route) => ({ provider: route?.provider || '', model: route?.model || '' });

/** The calling session's fallback position, and those of the other sessions
 *  held here that `keep` selects (status model: Leads; status agents: bots and agents). */
export function routePositionsStatus({ caller, config, keep }) {
  return {
    ...(caller?.agent ? { session: routeFallbackPosition(caller, config) } : {}),
    sessions: liveRouteFallbackPositions(config, (row) => row.sessionId !== caller?.id && keep(row)),
  };
}

/** The route a reset returns `session` to: the one it left at its first hop,
 *  else its settings' route when that is still its primary. */
function primaryRoute(session, config) {
  if (session.routeFallbackPrimary?.provider) return routeLeaf(session.routeFallbackPrimary);
  const primary = sessionRoutePrimary(session);
  const source = sessionChainSource(session, config);
  return source && sameRouteModel(source, primary) ? routeLeaf(source) : routeLeaf(primary);
}

const actingAgentOf = (session) => resolveSessionMode({ session }).agentId || clean(session?.agent);

function createSessionTargets(ctx) {
  const { sessionId: callerId, caller, getSession, scope, executeSessionControl } = ctx;
  const load = (id) => (id === callerId ? caller : getSession?.(id)) || null;
  // A bot's thread acts only on its own sessions; the human's on any.
  const assertTarget = (session, action) => {
    if (scope) assertOwnAgentSettings(scope, actingAgentOf(session), action);
  };
  const target = (id, action, { other = false } = {}) => {
    const sessionId = clean(id) || callerId;
    if (!sessionId) throw new Error('sessionId is required');
    if (other && sessionId === callerId) {
      throw new Error(`${action} applies to another session: this one is running the setup call`);
    }
    const session = load(sessionId);
    if (!session || session.closed === true) throw new Error(`session ${sessionId} not found`);
    assertTarget(session, action);
    return session;
  };
  const control = async (session, method, input) => {
    if (typeof executeSessionControl !== 'function') {
      throw new Error('Another session is reachable only through the Mixdog app or daemon; none hosts this runtime');
    }
    return executeSessionControl(
      { action: 'route', session_id: session.id, method, ...(input ? { input } : {}) },
      { callerSessionId: callerId }
    );
  };
  return { load, target, control, assertTarget };
}

export const SESSION_ROUTE_HANDLERS = {
  async reset_route_fallback(rt, args, ctx) {
    if (Object.hasOwn(args, 'sessionId') && Object.hasOwn(args, 'agent')) {
      throw new Error('Pass sessionId or agent, not both');
    }
    const config = ctx.getConfig();
    const sessions = createSessionTargets(ctx);
    let targets;
    if (Object.hasOwn(args, 'agent')) {
      const agent = clean(args.agent);
      if (!agent) throw new Error('agent is required');
      if (ctx.scope) assertOwnAgentSettings(ctx.scope, agent, 'reset_route_fallback');
      // Its chats held here (home, room seats) and its home thread from disk.
      const byId = new Map();
      for (const session of _liveSessions.values()) {
        if (session?.id && session.closed !== true && resolveSessionMode({ session }).agentId === agent) {
          byId.set(session.id, session);
        }
      }
      const home = agentHomeSessionId(agent);
      if (home && !byId.has(home)) {
        const stored = sessions.load(home);
        if (stored && stored.closed !== true) byId.set(home, stored);
      }
      targets = [...byId.values()];
    } else {
      targets = [sessions.target(args.sessionId, 'reset_route_fallback')];
    }
    const reset = [];
    const unchanged = [];
    for (const session of targets) {
      if (!routeFallbackHopped(session)) {
        unchanged.push({ sessionId: session.id, current: modelOf(session) });
        continue;
      }
      const route = primaryRoute(session, config);
      // The session's own model pick, from its next turn: the switch restarts
      // its chain (fallback index and failures cleared).
      if (session.id === ctx.sessionId) {
        await rt.setRoute(route, { sessionOnly: true, switchEstablished: true, deferUntilNextTurn: true });
      } else {
        await sessions.control(session, 'setRoute', route);
      }
      reset.push({ sessionId: session.id, from: modelOf(session), to: modelOf(route) });
    }
    return { scope: 'session', reset, ...(unchanged.length ? { alreadyOnPrimary: unchanged } : {}) };
  },
  async continue_in_model(_rt, args, ctx) {
    const sessions = createSessionTargets(ctx);
    const session = sessions.target(args.sessionId, 'continue_in_model', { other: true });
    const route = routeLeaf(args.route);
    const continued = (await sessions.control(session, 'continueSessionInModel', route)) !== false;
    return {
      scope: 'session',
      sessionId: session.id,
      continued,
      route: modelOf(route),
      note: 'The stopped turn is not resent: the user resumes it from that conversation (Resume, or a new message).',
    };
  },
  async schedule_quota_resume(_rt, args, ctx) {
    const sessions = createSessionTargets(ctx);
    const session = sessions.target(args.sessionId, 'schedule_quota_resume', { other: true });
    return {
      scope: 'session',
      sessionId: session.id,
      scheduled: (await sessions.control(session, 'scheduleQuotaResume')) === true,
    };
  },
  async cancel_quota_resume(_rt, args, ctx) {
    const sessions = createSessionTargets(ctx);
    const session = sessions.target(args.sessionId, 'cancel_quota_resume', { other: true });
    return {
      scope: 'session',
      sessionId: session.id,
      cancelled: (await sessions.control(session, 'cancelQuotaResume')) === true,
    };
  },
};
