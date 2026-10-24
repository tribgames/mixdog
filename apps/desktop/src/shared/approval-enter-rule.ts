// Which approvals a bare Enter allows: the one rule the approval card
// (renderer/ApprovalCard.tsx, approval-prompt.tsx) and a notification's Allow
// (main/push-notifier.ts, the phone's action, remote-session-methods.ts
// answerApprovalNotification) share. The card's Enter presses its primary; it
// allows once only where that primary is "Allow just once" (한 번만 허용): a
// tool or outbound approval, an Office commit, a permission request with a
// once option. Never a payment, a permanent delete, an Office rollback or
// recovery discard (allowing those takes a pointer), a permission whose only
// allow is "always" (Enter never grants a standing approval), a sign-in,
// takeover or secret (Enter does that step, it allows nothing), a question,
// or a kind this rule does not know.

export type PermissionScope = { id: string; kind: string; label: string };

// A permission request's options are mapped to buttons by their KIND (never by
// label text); a scope without a `kind` is read by its id. Rule:
//  - 항상 허용 ← the first allow_always / always option;
//  - 한 번만 허용 ← the narrowest once-type option: allow_once / once first,
//    else the first session-scoped one (allow_session / session / allow_scoped);
//  - reject / cancel kinds and unknown kinds get no button (거절 is the card's own).
// Ties go to the option listed first. With no always option there is no always button.
const ALWAYS_KINDS = ['allow_always', 'always'];
const ONCE_KINDS = ['allow_once', 'once', 'allow_session', 'session', 'allow_scoped'];

export function permissionChoices(scopes: readonly Record<string, unknown>[]): {
  always: PermissionScope | null;
  once: PermissionScope | null;
} {
  const list = scopes.map((scope) => ({
    id: String(scope.id),
    kind: String(scope.kind || scope.id).toLowerCase(),
    label: String(scope.label || scope.id),
  }));
  const always = list.find((scope) => ALWAYS_KINDS.includes(scope.kind)) ?? null;
  let once: PermissionScope | null = null;
  for (const kind of ONCE_KINDS) {
    once = list.find((scope) => scope.kind === kind) ?? null;
    if (once) break;
  }
  return { always, once };
}

const recordOf = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** A permission request's options, as the card's model reads them (each with an id). */
function permissionScopesOf(approval: unknown): Record<string, unknown>[] {
  const scopes = recordOf(recordOf(approval)?.permission)?.scopes;
  return (Array.isArray(scopes) ? scopes : [])
    .map(recordOf)
    .filter((scope): scope is Record<string, unknown> => Boolean(scope?.id));
}

/** An allow that takes a pointer (a click or a tap; Enter and Space never press
 *  it): a payment, a permanent delete, an Office rollback or recovery discard. */
export function approvalAllowIsPointerOnly(approval: unknown): boolean {
  const request = recordOf(approval);
  if (!request) return false;
  const category = request.kind === 'outbound' ? String(recordOf(request.outbound)?.category || '') : '';
  if (category === 'payment' || category === 'delete') return true;
  const action = String(recordOf(request.args)?.action || '').toLowerCase();
  return String(request.name || '').toLowerCase() === 'office' && (action === 'rollback' || action === 'discard');
}

/** A bare Enter on this PC's card allows the approval once (its 한 번만 허용). */
export function approvalEnterAllowsOnce(approval: unknown): boolean {
  const request = recordOf(approval);
  if (!request || approvalAllowIsPointerOnly(request)) return false;
  const kind = String(request.kind || 'approval');
  if (kind === 'permission') return permissionChoices(permissionScopesOf(request)).once !== null;
  return kind === 'approval' || kind === 'outbound';
}
