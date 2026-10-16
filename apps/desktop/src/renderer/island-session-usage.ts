// The composer island's agents-panel summary: the Lead session's and each of
// its agent sessions' lifetime totals from the usage ledger. The server owns
// cumulative membership, independent of the visible pool (getSessionUsage).
// A figure is shown only when every
// session it covers was fully measured; nothing is estimated or apportioned.
import { useEffect, useRef, useState } from 'react';
import { record } from './record-utils';

/** Re-read no more often than this while the agents panel stays open. */
export const ISLAND_USAGE_REFRESH_MS = 5_000;
/** Same bound the desktop main process enforces on the request. */
const MAX_AGENT_SESSION_IDS = 64;
const SESSION_ID = /^[A-Za-z0-9_-]+$/;

interface MeasuredUsage {
  turns: number;
  tokens: number;
  prompt: number;
  cacheRead: number;
  costUsd: number;
  unpricedTurns: number;
}

export interface IslandUsageSummary {
  /** Lead + all owned agents, closed included; null unless both parts are exact. */
  totalTokens: number | null;
  leadTokens: number | null;
  /** All owned agent sessions together; null while membership or usage is unknown. */
  agentTokens: number | null;
  /** Share of prompt tokens read from cache over the same sessions as the total. */
  cacheHitRate: number | null;
  /** Estimated value over the same sessions; null when any turn is unpriced. */
  costUsd: number | null;
  /** Each requested row's own total, keyed by session id, where exact. */
  agentRowTokens: ReadonlyMap<string, number>;
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** One getSessionUsage snapshot whose every turn was measured, or null. */
function measuredUsage(value: unknown): MeasuredUsage | null {
  const usage = record(value);
  const turns = count(usage.turns);
  const tokens = count(usage.tokens);
  const input = count(usage.input);
  const cacheRead = count(usage.cacheRead);
  const cacheWrite = count(usage.cacheWrite);
  const unmeasured = count(usage.unmeasuredTurns);
  if (turns === null || tokens === null || input === null || cacheRead === null || cacheWrite === null) return null;
  // A turn without a usage measurement makes every token figure a floor.
  if (unmeasured !== 0) return null;
  return {
    turns,
    tokens,
    prompt: input + cacheRead + cacheWrite,
    cacheRead,
    costUsd: count(usage.costUsd) ?? 0,
    // Unknown pricing coverage counts as unpriced.
    unpricedTurns: count(usage.costUnpricedTurns) ?? turns,
  };
}

/** The agent sessions a usage read can name: real ids, bounded. */
export function islandUsageSessionIds(sessionIds: readonly string[]): string[] {
  return [...new Set(sessionIds.filter((id) => SESSION_ID.test(id)))].slice(0, MAX_AGENT_SESSION_IDS);
}

export function islandUsageSummary(value: unknown, agentSessionIds: readonly string[]): IslandUsageSummary {
  const result = record(value);
  const lead = value ? measuredUsage(result) : null;
  const sessions = record(result.sessions);
  const agentRowTokens = new Map<string, number>();
  for (const id of agentSessionIds) {
    const usage = Object.hasOwn(sessions, id) ? measuredUsage(sessions[id]) : null;
    if (usage) agentRowTokens.set(id, usage.tokens);
  }
  const agents = measuredUsage(result.agents);
  const agentTokens = agents?.tokens ?? null;
  const all = lead && agents ? [lead, agents] : null;
  const sum = (field: keyof MeasuredUsage) => (all ?? []).reduce((total, usage) => total + usage[field], 0);
  const prompt = sum('prompt');
  const turns = sum('turns');
  return {
    totalTokens: all ? sum('tokens') : null,
    leadTokens: lead?.tokens ?? null,
    agentTokens,
    cacheHitRate: all && prompt > 0 ? sum('cacheRead') / prompt : null,
    costUsd: all && turns > 0 && sum('unpricedTurns') === 0 ? sum('costUsd') : null,
    agentRowTokens,
  };
}

/**
 * The Lead session's getSessionUsage with its cumulative agent aggregate and
 * the visible rows' individual totals, read while the
 * agents panel is open: at once on opening or when the agent set changes,
 * otherwise at most every ISLAND_USAGE_REFRESH_MS, and only when `revision`
 * (the shared agent-pool and session-lane snapshots, already pushed and
 * polled) moved. The read
 * runs on the ledger worker; a failed read keeps the last answer.
 */
export function useIslandSessionUsage(
  sessionId: string,
  agentSessionIds: readonly string[],
  open: boolean,
  revision: unknown
): unknown {
  const [usage, setUsage] = useState<{ sessionId: string; value: unknown } | null>(null);
  const lastRead = useRef({ at: 0, ids: '' });
  const ids = islandUsageSessionIds(agentSessionIds);
  const idsKey = ids.join('\n');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision is the refresh trigger; ids ride idsKey
  useEffect(() => {
    if (!open || !sessionId) {
      lastRead.current = { at: 0, ids: '' };
      return undefined;
    }
    const api = window.mixdogDesktop;
    if (typeof api?.invokeCapability !== 'function') return undefined;
    const since = lastRead.current.ids === idsKey ? Date.now() - lastRead.current.at : Number.POSITIVE_INFINITY;
    const timer = window.setTimeout(
      () => {
        lastRead.current = { at: Date.now(), ids: idsKey };
        Promise.resolve(
          api.invokeCapability({
            capability: 'getSessionUsage',
            args: [{ sessionIds: ids, includeAgents: true }],
            sessionId,
          })
        ).then(
          (result) => {
            if (mounted.current) setUsage({ sessionId, value: result?.value ?? null });
          },
          () => undefined
        );
      },
      Math.max(0, ISLAND_USAGE_REFRESH_MS - since)
    );
    return () => window.clearTimeout(timer);
  }, [open, sessionId, idsKey, revision]);
  return usage?.sessionId === sessionId ? usage.value : null;
}
