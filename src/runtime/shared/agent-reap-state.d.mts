// Types for the Agents-pane window the desktop renderer reads; the reap and
// tombstone helpers beside them are runtime-only (.mjs consumers).
export const AGENT_PANE_VISIBLE_MS: number;
export function agentPaneVisible(finishedAtMs: number, now: number): boolean;
