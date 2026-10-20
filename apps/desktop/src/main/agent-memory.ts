// An agent's own memory pool for its profile ("이 에이전트가 기억하는 것").
// The host reads and deletes it through the runtime's memory control, acting
// for the user: the memory runtime lets the host list and delete any agent's
// pool but never write one (runtime/memory/lib/core-memory-access.mjs). A
// deleted agent's pool is retained, unreferenced, until its entries are
// deleted here; an agent created again under the same id sees them.
import { agentHomeSessionId } from '../../../../src/runtime/agent/orchestrator/session/agent-home.mjs';
import type { DesktopAgentMemoryEntry } from '../shared/contract';

type MemoryControl = (method: string, args: unknown[]) => Promise<unknown>;
type AgentMemoryRef = Pick<DesktopAgentMemoryEntry, 'id' | 'indexRevision'>;

const PAGE_SIZE = 100;

function requiredAgentId(agentId: string): string {
  if (!agentHomeSessionId(agentId)) throw new TypeError('agent id is invalid.');
  return agentId;
}

/** IPC input of a delete: a positive list index and its list version. */
export function requiredAgentMemoryEntry(value: unknown): AgentMemoryRef {
  const { id, indexRevision } = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || (id as number) <= 0) throw new TypeError('memory id is invalid.');
  if (typeof indexRevision !== 'string' || !indexRevision || indexRevision.length > 200) {
    throw new TypeError('memory indexRevision is invalid.');
  }
  return { id: id as number, indexRevision };
}

/** Every active entry of `agentId`'s pool, in its list order. */
export async function listAgentMemory(control: MemoryControl, agentId: string): Promise<DesktopAgentMemoryEntry[]> {
  const agent = requiredAgentId(agentId);
  const entries: DesktopAgentMemoryEntry[] = [];
  let offset: number | null = 0;
  while (offset !== null) {
    const text = String(
      await control('memoryControl', [{ op: 'list', agent_id: agent, format: 'json', limit: PAGE_SIZE, offset }])
    );
    let page: { entries?: Array<Record<string, unknown>>; nextOffset?: number | null };
    try {
      page = JSON.parse(text);
    } catch {
      throw new Error(text || 'The agent memory could not be read.');
    }
    for (const row of page.entries ?? []) {
      entries.push({
        id: Number(row.id),
        indexRevision: String(row.index_revision),
        summary: String(row.summary ?? ''),
      });
    }
    offset = typeof page.nextOffset === 'number' && page.nextOffset > offset ? page.nextOffset : null;
  }
  return entries;
}

/** Delete one entry; a stale `indexRevision` is refused (list again). */
export async function deleteAgentMemory(control: MemoryControl, agentId: string, entry: AgentMemoryRef): Promise<void> {
  const agent = requiredAgentId(agentId);
  const { id, indexRevision } = requiredAgentMemoryEntry(entry);
  const text = String(
    await control('memoryControl', [{ op: 'delete', agent_id: agent, id, index_revision: indexRevision }])
  );
  if (!text.startsWith('core deleted ')) throw new Error(text || 'The agent memory entry could not be deleted.');
}
