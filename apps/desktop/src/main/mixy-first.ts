// The "대표 에이전트 먼저" first run, host side.
//
// Mixy exists once the explicit `created` flag in agents/lead/agent.json is
// true (runtime getLeadStatus / setLeadCreated). The flag is decided once per
// profile: a profile that already has a Mixy home thread, any contact agent or
// any session is an existing user and is marked created without asking; only
// a fresh profile with none of them is marked not created and sees the empty
// Agents pane until the 대표 에이전트 dialog creates Mixy.
//
// New agents greet the user once. The dialogs greet the agents they create;
// an agent a chat's setup tool created never passes through them, so the host
// greets every custom agent it has not seen before (agent-greetings.json keeps
// the seen ids; the first read records the existing ones without greeting).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { MIXY_AGENT_ID, contactAgentRows } from '../shared/agent-contacts';

export interface MixyStatusDeps {
  /** Runtime getLeadStatus: `{ created: true | false | null }`. */
  status: unknown;
  listAgents(): Promise<unknown>;
  /** The user's sessions, Mixy's home thread included even when empty. */
  sessionIds(): Promise<readonly string[]>;
  /** Runtime setLeadCreated. */
  setCreated(created: boolean): Promise<unknown>;
}

/** Whether Mixy exists, deciding (and persisting) an undecided profile. */
export async function resolveMixyCreated(deps: MixyStatusDeps): Promise<boolean> {
  const created = (deps.status as { created?: unknown } | null)?.created;
  if (typeof created === 'boolean') return created;
  const existing = (await deps.sessionIds()).length > 0 || contactAgentRows(await deps.listAgents()).length > 0;
  await deps.setCreated(existing);
  return existing;
}

/** Custom agent ids of a catalog (`listAgents`), switched off ones included. */
function customAgentIds(agents: unknown): string[] {
  if (!Array.isArray(agents)) return [];
  return agents
    .filter((row) => row && typeof row === 'object' && (row as { custom?: unknown }).custom === true)
    .map((row) => (row as { id?: unknown }).id)
    .filter((id): id is string => typeof id === 'string' && Boolean(id) && id !== MIXY_AGENT_ID);
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
      await mkdir(dirname(filePath), { recursive: true });
      const temp = `${filePath}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ seen: [...new Set(ids)].sort() }, null, 2)}\n`, 'utf8');
      await rename(temp, filePath);
    },
  };
}
