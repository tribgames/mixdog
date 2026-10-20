// The "대표 에이전트 먼저" first run, host side.
//
// Mixy exists once the explicit `created` flag in Mixy's agent.json (bots/mixy
// with the bot store, agents/lead before) is true (runtime getLeadStatus /
// setLeadCreated). The flag is decided once per
// profile: only a profile that already has Mixy's home thread is marked
// created; every other profile, existing users with sessions or agents
// included, is marked not created and sees the 대표 에이전트 dialog once.
//
// New agents greet the user once. The dialogs greet the agents they create;
// an agent a chat's setup tool created never passes through them, so the host
// greets every custom agent it has not seen before (agent-greetings.json keeps
// the seen ids; the first read records the existing ones without greeting).
import { readFile } from 'node:fs/promises';
import { agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import { writeJsonAtomicAsync } from '../../../../src/runtime/shared/atomic-file.mjs';
import { MIXY_AGENT_ID, contactAgentRows } from '../shared/agent-contacts';

export interface MixyStatusDeps {
  /** Runtime getLeadStatus: `{ created: true | false | null, name, homeChatted }`. */
  status: unknown;
  /** The user's sessions, Mixy's home thread included even when empty. */
  sessionIds(): Promise<readonly string[]>;
  /** Runtime setLeadCreated. */
  setCreated(created: boolean): Promise<unknown>;
}

/** Whether Mixy exists, deciding (and persisting) an undecided profile.
 *  v1.3.0 marked every existing profile created without asking; such a Mixy
 *  the user never named nor talked with (`created` with no `name`, and a
 *  home thread missing or without any conversation) reads as not created,
 *  so the 대표 에이전트 dialog shows — nothing is rewritten, and completing
 *  the dialog names it. */
export async function resolveMixyCreated(deps: MixyStatusDeps): Promise<boolean> {
  const status = (deps.status ?? {}) as { created?: unknown; name?: unknown; homeChatted?: unknown };
  const created = status.created;
  if (created === true && !String(status.name ?? '').trim() && status.homeChatted !== true) return false;
  if (typeof created === 'boolean') return created;
  const existing = (await deps.sessionIds()).includes(agentHomeSessionId(MIXY_AGENT_ID));
  await deps.setCreated(existing);
  // The same answer the next read gives: an unnamed Mixy needs a conversation.
  return existing && status.homeChatted === true;
}

/** Custom agent ids of a catalog (`listAgents`), switched off ones included. */
function customAgentIds(agents: unknown): string[] {
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((row) => row && typeof row === 'object' && (row as { custom?: unknown }).custom === true)
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string' && Boolean(id) && id !== MIXY_AGENT_ID);
}

/** Whether a catalog route (or its chain) names a model. */
function hasRouteModel(route: unknown): boolean {
  const leaf = (Array.isArray(route) ? route[0] : route) as { provider?: unknown; model?: unknown } | null | undefined;
  return Boolean(leaf?.provider && leaf?.model);
}

export interface AgentGreetingsDeps {
  /** The seen ids, or null before the first record. */
  read(): Promise<string[] | null>;
  write(ids: string[]): Promise<void>;
  listAgents(): Promise<unknown>;
  /** Opens the agent's home thread and sends its hidden greeting turn. */
  greet(agent: { id: string; name: string; description: string }): Promise<void>;
}

export function createAgentGreetings(deps: AgentGreetingsDeps) {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run, run);
    queue = next.catch(() => undefined);
    return next;
  };
  const seen = async (): Promise<Set<string>> => {
    const stored = await deps.read();
    if (stored) return new Set(stored);
    const baseline = customAgentIds(await deps.listAgents());
    await deps.write(baseline);
    return new Set(baseline);
  };

  /** A dialog created (or saved) this agent: the dialog greets it itself. */
  function noteCreated(agentId: string): Promise<void> {
    return serial(async () => {
      const ids = await seen();
      if (ids.has(agentId)) return;
      await deps.write([...ids, agentId]);
    });
  }

  /** A catalog read: greets the contacts that appeared since the last one. */
  function reconcile(agents: unknown): Promise<void> {
    return serial(async () => {
      const ids = await seen();
      const fresh = customAgentIds(agents).filter((id) => !ids.has(id));
      if (!fresh.length) return;
      await deps.write([...ids, ...fresh]);
      for (const row of contactAgentRows(agents)) {
        if (!fresh.includes(row.id)) continue;
        // Recorded, not greeted: with no model its greeting turn would only fail.
        if (!hasRouteModel(row.route)) continue;
        await deps
          .greet({ id: row.id, name: String(row.label || row.id), description: String(row.description || '') })
          .catch((error) => console.warn('[mixdog-session] Could not greet the new agent:', error));
      }
    });
  }

  return { noteCreated, reconcile };
}

/** agent-greetings.json: `{ "seen": [...] }`. */
export function agentGreetingsFileStore(filePath: string): Pick<AgentGreetingsDeps, 'read' | 'write'> {
  return {
    async read() {
      try {
        const doc = JSON.parse(await readFile(filePath, 'utf8')) as { seen?: unknown };
        return Array.isArray(doc.seen) ? doc.seen.filter((id): id is string => typeof id === 'string') : null;
      } catch {
        return null;
      }
    },
    async write(ids) {
      await writeJsonAtomicAsync(filePath, { seen: [...new Set(ids)].sort() });
    },
  };
}
