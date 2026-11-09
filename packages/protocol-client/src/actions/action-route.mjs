// Session action (today's finite read/configure surface) -> one protocol request.
import { ACTION_NAMESPACES } from './action-namespaces.mjs';
import { ACTION_OVERRIDES } from './action-overrides.mjs';
import { METHOD_ARGS } from './method-args.generated.mjs';

const NAMESPACE_OF = new Map(
  Object.entries(ACTION_NAMESPACES).flatMap(([namespace, actions]) => actions.map((action) => [action, namespace]))
);

/** Every finite session action a view exposes as an async method. */
export const SESSION_ACTIONS = Object.freeze([...new Set([...NAMESPACE_OF.keys(), ...Object.keys(ACTION_OVERRIDES)])]);

/**
 * `{ method, params }` for `action(...args)` on the thread the view is bound to. `opId` is not set here: the client
 * library assigns it to every mutation. A method the generated protocol types do not (yet) declare is an
 * `unknownMethod` error, the same one the client library gives, raised before anything is sent.
 */
export function resolveAction(action, args, ctx) {
  const override = ACTION_OVERRIDES[action];
  if (override) return override(args, ctx);
  const namespace = NAMESPACE_OF.get(action);
  if (!namespace) throw new TypeError(`session action ${action} is unavailable`);
  const method = `${namespace}/${action}`;
  const spec = METHOD_ARGS[method];
  if (!spec) throw Object.assign(new Error(`session action ${action} has no protocol method ${method}`), { code: 'unknownMethod' });
  if (args.length > spec.args.length) {
    throw new TypeError(`session action ${action} takes at most ${spec.args.length} arguments`);
  }
  const params = spec.thread && ctx.threadId ? { threadId: ctx.threadId } : {};
  spec.args.forEach((name, index) => {
    if (args[index] !== undefined) params[name] = args[index];
  });
  return { method, params };
}
