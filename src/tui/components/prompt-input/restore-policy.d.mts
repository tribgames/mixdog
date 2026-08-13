export type PromptDraft = {
  value?: string;
  cursor?: number;
  selectionAnchor?: number | null;
};

export type MergedPromptDraft = {
  value: string;
  cursor: number;
  selectionAnchor: number | null;
};

export function mergeQueuedRestoreText(queuedText?: string, currentText?: string): string;
export function mergeQueuedRestoreDraft(
  queuedText?: string,
  currentDraft?: PromptDraft | string,
): MergedPromptDraft;
export function queuedRestoreProjection(
  entries?: unknown[],
  selectedId?: string,
): {
  count: number;
  ids: string[];
  text: string;
};
export function queuedRestorePrefix(queuedText?: string, currentText?: string): string;
export function replaceQueuedRestorePrefix(
  optimisticPrefix?: string,
  authoritativePrefix?: string,
  currentDraft?: PromptDraft | string,
): MergedPromptDraft & { replaced: boolean };
export function paletteOwnsPromptVerticalArrow(optionCount?: number): boolean;
