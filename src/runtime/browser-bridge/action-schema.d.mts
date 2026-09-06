export { BROWSER_ACTIONS, BROWSER_OBSERVATION_ACTIONS } from './browser-action-contract.mjs';
export const SEQUENCE_STEP_ACTIONS: readonly string[];
export function buildBrowserInputSchema(schema: Record<string, unknown>): Record<string, unknown>;
export function validateBrowserToolArgs(args: unknown):
  | { ok: true; action: string; input: Record<string, unknown> }
  | { ok: false; error: string };
