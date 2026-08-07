export type DiffData = {
  oldFile: { fileName: string; content: string };
  newFile: { fileName: string; content: string };
  hunks: string[];
  patch: string;
  renderPatch: string;
  renderable: boolean;
  status: string;
};
export type TurnFailureModel = {
  scope: string;
  failedTurnKeys: string[];
  activeToastTurns: Record<string, string>;
  turnKeys: string[];
  scopes?: Record<string, {
    failedTurnKeys: string[];
    activeToastTurns: Record<string, string>;
    turnKeys: string[];
  }>;
};

export function mergeTranscript<T>(items: T[] | undefined, streamingTail: T | null | undefined): T[];
export function transcriptTurnKeys<T>(items: T[] | undefined): string[];
export function shouldShowFastControl(
  routeFastCapable: boolean,
  selectedModelFastCapable: boolean | undefined,
): boolean;
export function reconcileTurnFailures<T extends {
  id?: string | number;
  kind?: string;
  text?: string;
  message?: string;
  tone?: string;
}>(
  previous: TurnFailureModel | undefined,
  items: T[] | undefined,
  toasts: T[] | undefined,
  scope?: string,
): TurnFailureModel;
export function shouldNavigatePromptHistory(input?: {
  key?: string;
  value?: string;
  selectionStart?: number;
  selectionEnd?: number;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  historyActive?: boolean;
}): boolean;
export function mergeModelCatalog<T extends { provider?: string; model?: string }>(
  current: T[] | undefined,
  incoming: T[] | undefined,
): T[];
export function approvalInstanceKey(id: unknown): string;
export function isApprovalDismissKey(key: string): boolean;
export function focusTrapIndex(currentIndex: number, count: number, backwards?: boolean): number;
export function draftAfterSubmission(
  currentDraft: string,
  submittedText: string,
  accepted: unknown,
): string;
export function attemptApproval(
  resolve: (approved: boolean) => unknown | Promise<unknown>,
  approved: boolean,
): Promise<boolean>;
export function normalizeApplyPatch(value: unknown): string;
export function diffFileStatus(section: unknown): string;
export function parseUnifiedDiff(patch: string): DiffData[];
export type ToolInputRow = { key: string; value: string; block: boolean };
export function toolInputRows(name: string, args: unknown): ToolInputRow[];
export interface SessionScopedSnapshotGate<T> {
  select(live: T | null | undefined): {
    snapshot: T | null;
    suppressedSessionId: string;
  };
}
export function createSessionScopedSnapshotGate<T>(
  scopeSessionId: string,
): SessionScopedSnapshotGate<T>;
export function startupRestorePlan(input?: {
  storedSessionId?: string;
  storedSessionKnown?: boolean;
  engineSessionId?: string;
}): {
  action: 'activate' | 'resume' | 'fallback';
  sessionId: string;
  clearStored: boolean;
};
