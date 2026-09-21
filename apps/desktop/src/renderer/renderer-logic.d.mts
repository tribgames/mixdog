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
  scopes?: Record<
    string,
    {
      failedTurnKeys: string[];
      activeToastTurns: Record<string, string>;
      turnKeys: string[];
    }
  >;
};

export function transcriptTurnKeys<T>(items: T[] | undefined): string[];
export function turnReviewScope<
  T extends {
    id?: string | number;
    kind?: string;
  },
>(
  items: T[] | undefined
): {
  startIndex: number;
  key: string;
  hasActivity: boolean;
};
export function shouldShowFastControl(
  routeFastCapable: boolean,
  selectedModelFastCapable: boolean | undefined
): boolean;
export function reconcileTurnFailures<
  T extends {
    id?: string | number;
    kind?: string;
    text?: string;
    message?: string;
    tone?: string;
  },
>(
  previous: TurnFailureModel | undefined,
  items: T[] | undefined,
  toasts: T[] | undefined,
  scope?: string
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
  allowNonEmpty?: boolean;
}): boolean;
export function nextComposerShiftLatch(
  latched?: boolean,
  event?: {
    type?: string;
    key?: string;
    shiftKey?: boolean;
  }
): boolean;
export function isComposerNewlineChord(input?: {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftLatched?: boolean;
}): boolean;
export function shouldInterruptPrompt(input?: {
  turnBusy?: boolean;
  pendingSubmissionId?: string;
  draftMode?: boolean;
}): boolean;
export function shouldBlockPromptSubmit(input?: {
  submitting?: boolean;
  draftMode?: boolean;
  slashCommand?: boolean;
}): boolean;
export function hasSendablePromptContent(input?: {
  text?: string;
  attachments?: Array<{ token?: string; chipOnly?: boolean }>;
}): boolean;
export function shouldStopComposerGeneration(input?: {
  turnBusy?: boolean;
  text?: string;
  attachments?: Array<{ token?: string; chipOnly?: boolean }>;
}): boolean;
export function approvalInstanceKey(id: unknown): string;
export function isApprovalDismissKey(key: string): boolean;
export function normalizeApplyPatch(value: unknown): string;
export function diffFileStatus(section: unknown): string;
export function parseUnifiedDiff(patch: string): DiffData[];
export function startupRestorePlan(input?: {
  storedSessionId?: string;
  storedSessionKnown?: boolean;
  engineSessionId?: string;
}): {
  action: 'activate' | 'resume' | 'fallback';
  sessionId: string;
  clearStored: boolean;
};
