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

export const methodInfo: MethodLookup = (method) => methods.get(method);
/** App-feed notifications whose params are a `SectionUpdate`. */
export const isSectionMethod = (method: string): boolean => sectionMethods.has(method);
