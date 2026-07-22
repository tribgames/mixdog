export type DiffData = {
  oldFile: { fileName: string; content: string };
  newFile: { fileName: string; content: string };
  hunks: string[];
  patch: string;
  renderPatch: string;
  renderable: boolean;
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
export function shouldAutoFollow(
  viewport: { scrollTop?: number; clientHeight?: number; scrollHeight?: number },
  threshold?: number,
): boolean;
export function needsBottomPin(
  viewport: { scrollTop?: number; clientHeight?: number; scrollHeight?: number },
  epsilon?: number,
): boolean;
export function followAfterScroll(
  current: boolean,
  programmatic: boolean,
  viewport: { scrollTop?: number; clientHeight?: number; scrollHeight?: number },
): boolean;
export function isScrollIntentKey(key: string): boolean;
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
export function parseUnifiedDiff(patch: string): DiffData[];
export type ToolInputRow = { key: string; value: string; block: boolean };
export function toolInputRows(name: string, args: unknown): ToolInputRow[];
