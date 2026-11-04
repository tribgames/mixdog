// The composer island's agents-panel summary: the Lead session's lifetime
// totals from the usage ledger beside one total of every agent it ever ran,
// closed and replaced ones included, and each listed agent's own row total
// (getSessionUsage). A figure is shown only when every session it covers was
// fully measured; nothing is estimated or apportioned.
import { useEffect, useRef, useState } from 'react';
import type { DesktopAgentPoolRow } from '../shared/contract';
import { record } from './record-utils';

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
  /** Lead + agents; null unless both parts are exact. */
  totalTokens: number | null;
  leadTokens: number | null;
  /** Every agent session the Lead ran, together; null unless exact. */
  agentTokens: number | null;
  /** Share of prompt tokens read from cache over the same sessions as the total. */
  cacheHitRate: number | null;
  /** Estimated value over the same sessions; null when any turn is unpriced. */
  costUsd: number | null;
  /** Each agent session's own total, keyed by session id, where exact. */
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

/** Each session's last answer, so reopening the panel paints its figures at
 *  once instead of growing when the next read lands. Most recent last. */
const LAST_USAGE_SESSIONS = 16;
const lastUsage = new Map<string, unknown>();

function rememberUsage(sessionId: string, value: unknown): void {
  if (value === null) return;
  lastUsage.delete(sessionId);
  lastUsage.set(sessionId, value);
  if (lastUsage.size > LAST_USAGE_SESSIONS) lastUsage.delete(lastUsage.keys().next().value as string);
}

/** The agent sessions a usage read can name: real ids, bounded. */
export function islandUsageSessionIds(sessionIds: readonly string[]): string[] {
  return [...new Set(sessionIds.filter((id) => SESSION_ID.test(id)))].slice(0, MAX_AGENT_SESSION_IDS);
}

export function islandUsageSummary(value: unknown, agentSessionIds: readonly string[]): IslandUsageSummary {
  const result = record(value);
  const lead = value ? measuredUsage(result) : null;
  const agents = value ? measuredUsage(result.agents) : null;
  const sessions = record(result.sessions);
  const agentRowTokens = new Map<string, number>();
  for (const id of agentSessionIds) {
    const usage = Object.hasOwn(sessions, id) ? measuredUsage(sessions[id]) : null;
    if (usage) agentRowTokens.set(id, usage.tokens);
  }
  const all = lead && agents ? [lead, agents] : null;
  const sum = (field: keyof MeasuredUsage) => (all ?? []).reduce((total, usage) => total + usage[field], 0);
  const prompt = sum('prompt');
  const turns = sum('turns');
  return {
    totalTokens: all ? sum('tokens') : null,
    leadTokens: lead?.tokens ?? null,
    agentTokens: agents?.tokens ?? null,
    cacheHitRate: all && prompt > 0 ? sum('cacheRead') / prompt : null,
    costUsd: all && turns > 0 && sum('unpricedTurns') === 0 ? sum('costUsd') : null,
    agentRowTokens,
  };
}

/**
 * What moves when a ledger figure for the session can have changed: the token
 * of the session's group that the pool rows carry (`ledgerToken`). The ledger
 * moves it for the group's own records, its agents at any depth, ownership,
 * and another session's record that changes which rows the ledger counts
 * for them; other sessions' commits leave it alone. A settled Lead turn also
 * moves the cue.
 */
export function islandUsageCue(
  pool: readonly DesktopAgentPoolRow[] | null | undefined,
  leadSessionId: string,
  settledTurns: number
): string {
  const token = (pool ?? []).find((row) => row.ownerSessionId === leadSessionId && row.ledgerToken)?.ledgerToken;
  return `${settledTurns}|${token ?? ''}`;
}

/**
 * The Lead session's getSessionUsage with its agents' total and rows for the
 * open agents panel. The ledger is the only source of the figures. It is read
 * on opening, when the agent set changes, and when `cue` moves: the cue is
 * the ledger's own token for the session's group that the agent pool already
 * pushes, plus settled turns, so nothing polls. No read starts while the session's
 * previous one is unanswered (the ledger worker serves one request at a time,
 * so it would only queue behind it); cues that land meanwhile collapse into
 * one follow-up read. A failed read keeps the last answer.
 */
export function useIslandSessionUsage(
  sessionId: string,
  agentSessionIds: readonly string[],
  open: boolean,
  cue: string
): unknown {
  const [usage, setUsage] = useState<{ sessionId: string; value: unknown } | null>(null);
  const known = usage?.sessionId === sessionId ? usage.value : (lastUsage.get(sessionId) ?? null);
  const reading = useRef(new Set<string>());
  const wanted = useRef('');
  const readAgain = useRef<(() => void) | null>(null);
  const ids = islandUsageSessionIds(agentSessionIds);
  const idsKey = ids.join('\n');
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: ids ride idsKey; cue is the trigger
  useEffect(() => {
    if (!open || !sessionId) {
      wanted.current = '';
      readAgain.current = null;
      return undefined;
    }
    const api = window.mixdogDesktop;
    if (typeof api?.invokeCapability !== 'function') return undefined;
    const read = () => {
      if (reading.current.has(sessionId)) {
        wanted.current = sessionId;
        return;
      }
      reading.current.add(sessionId);
      Promise.resolve(
        api.invokeCapability({ capability: 'getSessionUsage', args: [{ sessionIds: ids, agents: true }], sessionId })
      )
        .then(
          (result) => {
            rememberUsage(sessionId, result?.value ?? null);
            if (mounted.current) setUsage({ sessionId, value: result?.value ?? null });
          },
          () => undefined
        )
        .finally(() => {
          reading.current.delete(sessionId);
          if (wanted.current !== sessionId) return;
          wanted.current = '';
          readAgain.current?.();
        });
    };
    readAgain.current = read;
    read();
    return () => {
      readAgain.current = null;
    };
  }, [open, sessionId, idsKey, cue]);
  return known;
}
