export function isRootLeadSession(value: unknown): boolean;
export function sessionVisibility(value: unknown): 'ordinary' | 'agent-only';
export function isAgentOnlySession(value: unknown): boolean;
export function agentDescendantIds(rows: readonly unknown[], rootId: unknown): string[];
