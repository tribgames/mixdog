import { SESSION_ID_PATTERN } from '../../runtime/agent/orchestrator/runtime-core/session-id.mjs';

// The route methods the setup tool reaches on another session (all on the
// session protocol's configure allowlist), through the same configure lane
// the desktop's model picker and quota card use.
const ROUTE_METHODS = new Set(['setRoute', 'continueSessionInModel', 'scheduleQuotaResume', 'cancelQuotaResume']);
const ROUTE_FIELDS = [
  'provider',
  'model',
  'effort',
  'fast',
  'autoEffort',
  'modelParameters',
  'contextPercent',
  'contextTokens',
];

// Only route fields cross: no option of the picker's write (keepMainModel,
// applyToCurrentSession) can ride along and change the Lead route.
function routeFields(input) {
  const route = {};
  for (const key of ROUTE_FIELDS) if (input?.[key] !== undefined && input[key] !== null) route[key] = input[key];
  if (!route.provider || !route.model) throw new Error('session: route provider and model are required');
  return route;
}

/**
 * One route method on another session, for the setup tool
 * (setup-tool/session-route-actions.mjs): `setRoute` is the session's own
 * model pick (session-only, from its next turn: a running turn finishes on
 * its model), the others its quota card's buttons. The caller's own session
 * is changed by its runtime directly, never through here.
 */
export function createRouteControl(getSessionService) {
  return async function routeControl(args, caller) {
    const sessionId = typeof args.session_id === 'string' ? args.session_id.trim() : '';
    if (!SESSION_ID_PATTERN.test(sessionId)) throw new Error('session: session_id is required for action=route');
    if (sessionId === caller) throw new Error('session: route control must target another session');
    if (!ROUTE_METHODS.has(args.method)) throw new Error(`session: unsupported route method "${args.method}"`);
    const service = getSessionService();
    if (!service) throw new Error('session: session service is unavailable');
    let input = [sessionId];
    if (args.method === 'setRoute') input = [{ ...routeFields(args.input), sessionOnly: true }];
    else if (args.method === 'continueSessionInModel') input = [sessionId, routeFields(args.input)];
    const result = await service.configureSession({ sessionId, action: args.method, args: input }, { revision: 1 });
    return result.value;
  };
}
