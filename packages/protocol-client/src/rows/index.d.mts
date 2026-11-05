// Types of the ported Node row helpers (index.mjs). Tool arguments and results are untyped JSON as in the product.
export interface CategoryEntry {
  key: string;
  category: string;
  active: string;
  done: string;
  noun: string;
  pluralNoun: string;
  effect: boolean;
  count: number;
}
export interface ToolOutcome {
  isCallError: boolean;
  isExitError: boolean;
  exitCode: number | null;
}
/** A resolved call as the aggregate builders read it. */
export interface AggregateCall {
  callId?: unknown;
  name: string;
  args: unknown;
  category: string;
  isError: boolean;
  isCallError: boolean;
  isExitError: boolean;
  exitCode: number | null;
  resultText: string;
  rawResultText: string;
  uiDiff?: string;
  resolved: boolean;
  startedAt?: unknown;
  completedAt?: unknown;
  summary: string | null;
}
export interface AggregateHeader {
  categories: Map<string, CategoryEntry>;
  categoryOrder: string[];
}

export function classifyToolCategory(name: string, args?: unknown): string;
/** The members every aggregate pass handles between two yields. */
export const STEP: number;
export function aggregateDoneCategoriesSteps(calls: readonly { name: string; args: unknown; category: string }[]): Generator<void, Record<string, CategoryEntry>, void>;
export function aggregateToolCategoryEntries(name: string, args?: unknown, category?: string): CategoryEntry[];
export function isTaskWaitToolCall(name: string, args?: unknown): boolean;
export function aggregateBucketForCategory(category: string, options?: { agentBatch?: string }): string;
export function aggregateLoadingTargetsSteps(calls: readonly AggregateCall[]): Generator<void, string[], void>;
export function aggregateRawResultSteps(calls: readonly AggregateCall[]): Generator<void, string, void>;
export function aggregateResultPatchSteps(
  aggregate: { calls: readonly AggregateCall[] },
  allCalls: readonly AggregateCall[],
  completedCount: number,
): Generator<void, Record<string, unknown>, void>;
export function mergeAggregateCategoryEntries(aggregate: AggregateHeader, entries: readonly CategoryEntry[]): void;
export function stringUiDiffPatch(value: unknown): { uiDiff?: string };
export function toolCallOutcome(message: { isError?: boolean; toolName?: string; name?: string; toolKind?: string }, rawText: string): ToolOutcome;
export function isTranscriptHiddenControlToolName(name: unknown): boolean;
export function isTranscriptHiddenToolItem(item: { name?: unknown; result?: unknown } | null | undefined): boolean;
export function toolResultTerminalStatus(text: unknown): string;
export function summarizeToolResult(name: string, args: unknown, resultText: string, isError?: boolean): string | null;
