// Per-method facts from the generated method table exported by @mixdog/protocol.
import { methodTable } from '@mixdog/protocol';
import type { MethodSpec } from '@mixdog/protocol';
import type { Json, MethodInfo, MethodLookup, OpScope } from './api.ts';

type OpScopeRule = MethodSpec['opScope'];

/** The table's `field` is a wire path: a dotted path (`args.sessionId`) walks nested objects. */
function fieldPath(params: Json, field: string): Json | undefined {
  let v: Json | undefined = params;
  for (const seg of field.split('.')) v = typeof v === 'object' && v !== null && !Array.isArray(v) ? v[seg] : undefined;
  return v;
}

function scopeOf(rule: OpScopeRule): (params: Json) => OpScope | undefined {
  const thread = (params: Json, field: string): OpScope | undefined => {
    const id = fieldPath(params, field);
    return typeof id === 'string' ? `thread:${id}` : undefined;
  };
  switch (rule.kind) {
    case 'none':
      return () => undefined;
    case 'domain':
      return () => rule.domain;
    case 'thread':
      return (p) => thread(p, rule.field);
    case 'threadOrDomain':
      return (p) => thread(p, rule.field) ?? rule.domain;
  }
}

const methods = new Map<string, MethodInfo>(
  methodTable.clientMethods.map((m) => [m.method, { class: m.class, mutation: m.opScope.kind !== 'none', opScope: scopeOf(m.opScope) }]),
);
const sectionMethods = new Set<string>(
  methodTable.serverNotifications.filter((n) => n.delivery === 'app' && n.params === 'SectionUpdate').map((n) => n.method),
);

const scopedMethods = new Set<string>(
  methodTable.serverNotifications
    .filter((n) => n.delivery === 'anyScoped' || (typeof n.delivery === 'object' && 'scoped' in n.delivery))
    .map((n) => n.method),
);
/** Notifications delivered on a scoped feed (`fs:<watchId>`, `ports`, ...). */
export const isScopedMethod = (method: string): boolean => scopedMethods.has(method);

const offeredRequests = new Set<string>(methodTable.serverRequests.filter((r) => r.requires === null).map((r) => r.method));
/** Server requests the core offers every eligible connection (`requires: null`, the approvals): each stays open until the core
 *  resolves it (`serverRequest/resolved`) or the socket closes (P §8.3-8.4), so a client holds it until then. The others are sent
 *  to the one connection holding a capability (`requires`: `host.*`, `modelProxy`; DS §12): that connection's answer ends one, and
 *  when the core stops waiting it says so (`serverRequest/resolved` for `host/*`, `model/proxy/cancel` for `model/proxy/execute`).
 *  A method this table does not list (a newer core's) is not offered by any rule this client knows, so it is not held either: held
 *  by mistake it reads as the thread's approval card, while the core keeps a real approval open for every eligible connection, where
 *  a client that knows the method answers it. The Rust client agrees: its `ServerRequest` does not parse an unknown method. */
export const isOfferedRequest = (method: string): boolean => offeredRequests.has(method);

export const methodInfo: MethodLookup = (method) => methods.get(method);
/** App-feed notifications whose params are a `SectionUpdate`. */
export const isSectionMethod = (method: string): boolean => sectionMethods.has(method);
