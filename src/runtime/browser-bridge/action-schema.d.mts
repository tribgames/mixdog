export {
  BROWSER_ACTIONS,
  BROWSER_DEVTOOLS_ACTIONS,
  BROWSER_OBSERVATION_ACTIONS,
  BROWSER_PAGE_ACTIONS,
} from './browser-action-contract.mjs';
export const SEQUENCE_STEP_ACTIONS: readonly string[];
export function buildBrowserInputSchema(
  schema: Record<string, unknown>,
  actions?: readonly string[],
): Record<string, unknown>;
export function validateBrowserToolArgs(args: unknown, options?: { tool?: string }):
  | { ok: true; action: string; input: Record<string, unknown> }
  | { ok: false; error: string };
