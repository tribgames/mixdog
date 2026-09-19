/**
 * How a handler gets the ref it works on: the caller's own ref, or one the
 * host resolves right now from a snapshot-free `target`. Resolution takes a
 * fresh observation, so recovery and the effect baseline move to it.
 */
import type { ResolvedBrowserTarget } from '../target-resolve';
import type { BrowserActionContext } from './types';

export function adoptResolvedTargets(context: BrowserActionContext, resolved: ResolvedBrowserTarget[]): void {
  const fresh = context.services.state.peek(context.guest)?.refSet;
  context.refRecovery.source = fresh;
  context.effectBaseline.current = fresh;
  for (const entry of resolved) {
    context.refRecovery.resolvedTargets.push(`${entry.description} -> ${entry.ref}`);
  }
}

/**
 * Both ends of a drag. Targets are resolved in one observation so the two refs
 * describe the same page state; a page that moves between two separate
 * resolutions would otherwise hand back a source and a destination that never
 * existed together.
 */
export async function dragRefs(context: BrowserActionContext): Promise<{ source?: string; destination?: string }> {
  const { guest, command, signal, services } = context;
  if (command.target === undefined || command.target === null) {
    return {
      source: command.ref ? String(command.ref) : undefined,
      destination: command.targetRef ? String(command.targetRef) : undefined,
    };
  }
  const resolved = await services.targets.resolveTargetRefs(guest, [command.target, command.dropTarget!], signal);
  adoptResolvedTargets(context, resolved);
  return { source: resolved[0].ref, destination: resolved[1].ref };
}

export async function actionRef(context: BrowserActionContext): Promise<string | undefined> {
  const { guest, command, signal, services } = context;
  if (command.ref) return String(command.ref);
  if (command.target === undefined || command.target === null) return undefined;
  const resolved = await services.targets.resolveTargetRefs(guest, [command.target], signal);
  adoptResolvedTargets(context, resolved);
  return resolved[0].ref;
}
