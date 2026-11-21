// "Clear finished": settled agent rows the user removed from view, kept in the
// same per-session dismissed store as finished shell rows.
import { useMemo } from 'react';
import {
  desktopAgentActivityState,
  hasPendingDesktopAgentWork,
  type DesktopAgentActivityState,
} from '../shared/agent-activity';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { agentPoolStore, flattenAgentActivityNodes, type AgentActivityNode } from './agent-activity-model';
import {
  type DismissedListing,
  dismissedShellJobs,
  dismissShellJobs,
  useDismissedJobsRevision,
} from './background-jobs-dismissed-store';
import { timeMs } from './transcript-primitives';

/** The outcomes "Clear finished" removes: a completion or rest, a failure and
 *  a confirmed cancel. Work in flight, an unproven cancel and a row whose
 *  state is unknown are never cleared. */
const CLEARABLE_AGENT_STATES: ReadonlySet<DesktopAgentActivityState> = new Set(['idle', 'done', 'failed', 'cancelled']);

function agentSessionId(agent: DesktopAgentPoolRow): string {
  return String(agent.sessionId || '').trim();
}

/** The session whose dismissed set holds the row: its root owner. */
function agentDismissOwner(agent: DesktopAgentPoolRow): string {
  return String(agent.ownerSessionId || '').trim() || agentSessionId(agent);
}

/** One settled outcome of one agent: its session plus the settle identity the
 *  core fixed for that outcome (`settledAt`). New work settles under a new
 *  identity, so a cleared agent comes back as soon as it runs again. */
function agentDismissKey(agent: DesktopAgentPoolRow): string {
  const sessionId = agentSessionId(agent);
  return sessionId ? `agent:${sessionId}@${timeMs(agent.settledAt)}` : '';
}

/** Whether "Clear finished" may remove this row: a settled outcome the core
 *  fixed an identity for. The owner's own Lead row is the group itself and
 *  always stays. */
function clearableAgentRow(agent: DesktopAgentPoolRow): boolean {
  const sessionId = agentSessionId(agent);
  return (
    Boolean(sessionId) &&
    timeMs(agent.settledAt) > 0 &&
    sessionId !== String(agent.ownerSessionId || '').trim() &&
    String(agent.agent || '').toLowerCase() !== 'lead' &&
    CLEARABLE_AGENT_STATES.has(desktopAgentActivityState(agent))
  );
}

/** Whether "Clear finished" may remove this tree node. A settled parent whose
 *  descendants still work is waiting on them, not finished, and stays. */
export function clearableAgentNode(node: AgentActivityNode): boolean {
  return (
    clearableAgentRow(node.agent) &&
    !flattenAgentActivityNodes(node.children).some(({ agent }) => hasPendingDesktopAgentWork(agent))
  );
}

/** The clearable rows of an agent tree. */
export function clearableAgentTreeRows(nodes: readonly AgentActivityNode[]): DesktopAgentPoolRow[] {
  return flattenAgentActivityNodes(nodes)
    .filter(clearableAgentNode)
    .map((node) => node.agent);
}

function isDismissedAgentRow(agent: DesktopAgentPoolRow): boolean {
  return clearableAgentRow(agent) && dismissedShellJobs(agentDismissOwner(agent)).has(agentDismissKey(agent));
}

/** The pool without the rows the user cleared; `null` (not loaded) stays null. */
export function withoutDismissedAgentRows(
  rows: readonly DesktopAgentPoolRow[] | null | undefined
): DesktopAgentPoolRow[] | null {
  if (!rows) return null;
  return rows.filter((agent) => !isDismissedAgentRow(agent));
}

/** The dismiss keys of the settled outcomes `listing` (the runtime's current,
 *  unfiltered listing) holds for `owner`; `null` without a listing. A row with
 *  no settle identity yet (its turn still runs) names no outcome. */
export function listedAgentDismissKeys(
  owner: string,
  listing: readonly DesktopAgentPoolRow[] | null | undefined
): ReadonlySet<string> | null {
  if (!listing) return null;
  const keys = new Set<string>();
  for (const agent of listing) {
    if (agentDismissOwner(agent) === owner && timeMs(agent.settledAt) > 0) keys.add(agentDismissKey(agent));
  }
  return keys;
}

/** The host pool's current listing, read at call time; never the rows merely shown. */
export function hostAgentListing(): readonly DesktopAgentPoolRow[] | null {
  const host = globalThis.window?.mixdogDesktop;
  return host ? agentPoolStore(host).getListing() : null;
}

/** What a dismissal in `owner`'s set prunes against now: the host's agent
 *  listing and the session's own `shells` keys. */
export function hostDismissListing(owner: string, shells: ReadonlySet<string> | null): DismissedListing {
  return { agents: listedAgentDismissKeys(owner, hostAgentListing()), shells };
}

/** Clears every clearable row of `rows`; returns how many were cleared.
 *  `listing` is the runtime's current listing (the host's by default) that
 *  decides which earlier keys are still worth keeping (`null`: none, nothing
 *  is pruned); `shells` lists the shell rows of that one session, used only
 *  for its own dismissed set. */
export function dismissFinishedAgentRows(
  rows: readonly DesktopAgentPoolRow[],
  listing: readonly DesktopAgentPoolRow[] | null | undefined = hostAgentListing(),
  shells?: { sessionId: string; keys: ReadonlySet<string> | null }
): number {
  const byOwner = new Map<string, string[]>();
  for (const agent of rows) {
    if (!clearableAgentRow(agent)) continue;
    const owner = agentDismissOwner(agent);
    byOwner.set(owner, [...(byOwner.get(owner) || []), agentDismissKey(agent)]);
  }
  let cleared = 0;
  for (const [owner, keys] of byOwner) {
    dismissShellJobs(owner, keys, {
      agents: listedAgentDismissKeys(owner, listing),
      shells: shells?.sessionId === owner ? shells.keys : null,
    });
    cleared += keys.length;
  }
  return cleared;
}

/** The pool as the agent surfaces show it: cleared rows removed, recomputed
 *  whenever any session's dismissed set changes. */
export function useVisibleAgentPool(
  rows: readonly DesktopAgentPoolRow[] | null | undefined
): DesktopAgentPoolRow[] | null {
  const revision = useDismissedJobsRevision();
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the dismissed-store change cue
  return useMemo(() => withoutDismissedAgentRows(rows), [rows, revision]);
}
