const NON_BUDGETED_ACTIONS = new Set([
  'list_tabs', 'downloads', 'status', 'console', 'network', 'handle_dialog', 'close_tab',
]);

export function resolveBrowserActionsPerTurn(raw: unknown): number {
  const parsed = Number(raw);
  return Math.min(500, Math.max(10, Number.isFinite(parsed) ? Math.trunc(parsed) : 100));
}

export class BrowserActionBudget {
  readonly limit: number;
  private readonly entries = new Map<string, { count: number; touchedAt: number }>();

  constructor(limit = 100) {
    this.limit = resolveBrowserActionsPerTurn(limit);
  }

  consume(command: { session_id?: string; turn_id?: number }, action: string, now = Date.now()): void {
    if (NON_BUDGETED_ACTIONS.has(action)) return;
    const sessionId = String(command.session_id || '').trim();
    const turnId = Number(command.turn_id);
    if (!sessionId || !Number.isFinite(turnId) || turnId <= 0) return;
    const key = `${sessionId}:${Math.trunc(turnId)}`;
    const existing = this.entries.get(key) || { count: 0, touchedAt: now };
    if (existing.count >= this.limit) {
      throw new Error(
        `Browser Use reached the per-turn action limit (${this.limit}); `
        + 'stop this browser loop and return the best result collected so far',
      );
    }
    existing.count += 1;
    existing.touchedAt = now;
    this.entries.set(key, existing);
    if (this.entries.size <= 512) return;
    for (const [entryKey, entry] of this.entries) {
      if (now - entry.touchedAt > 60 * 60_000) this.entries.delete(entryKey);
    }
    while (this.entries.size > 512) this.entries.delete(this.entries.keys().next().value as string);
  }

  clear(): void {
    this.entries.clear();
  }
}
