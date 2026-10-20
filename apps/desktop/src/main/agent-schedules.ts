// The schedules and webhooks a deleted agent owns are switched off, never deleted: they
// stay in the Schedules page and can be moved to another agent and resumed.
// Idempotent: only schedules still on are touched, so every later check of a
// deleted agent retries a switch-off that failed part way.

type Invoke = (method: string, args: unknown[]) => Promise<unknown>;

// Webhooks the agent owns follow the same rule.
const SWITCHES = [
  ['schedules', 'setScheduleEnabled'],
  ['webhooks', 'setWebhookEnabled'],
] as const;

export async function disableAgentSchedules(invoke: Invoke, agentId: string): Promise<void> {
  const setup = (await invoke('getChannelSetup', [])) as Record<string, unknown> | null;
  for (const [list, method] of SWITCHES) {
    const rows = setup?.[list];
    for (const row of Array.isArray(rows) ? rows : []) {
      const { name, owner, enabled } = (row ?? {}) as { name?: unknown; owner?: unknown; enabled?: unknown };
      if (owner !== agentId || enabled === false || typeof name !== 'string') continue;
      await invoke(method, [name, false]);
    }
  }
}
