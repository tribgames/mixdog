export type DiffData = {
  oldFile: { fileName: string; content: string };
  newFile: { fileName: string; content: string };
  hunks: string[];
  patch: string;
  renderPatch: string;
  renderable: boolean;
  status: string;
};
/** `held`: the keys of a list that holds the same items before index `kept`; they are carried on. */
export function transcriptTurnKeys<T>(
  items: readonly T[] | undefined,
  held?: { keys: readonly string[]; kept: number }
): string[];
/** The leading keys a list took over from the one it was carried on from. */
export function turnKeysTakenOver(keys: readonly string[]): number;
export function shouldShowFastControl(
  routeFastCapable: boolean,
  selectedModelFastCapable: boolean | undefined
): boolean;
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
export function isComposerNewlineChord(input?: {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
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
export function normalizeApplyPatch(value: unknown): string;
export function diffFileStatus(section: unknown): string;
export function parseUnifiedDiff(patch: string): DiffData[];
export function splitUnifiedDiff(patch: string): string[];
export function hasLeadingDiffContent(prefix: string): boolean;
export function parseUnifiedDiffSection(section: string): DiffData;
export function capPatchLines(patch: string, max: number): { text: string; cut: boolean };
export function patchLineCounts(patch: string): { additions: number; deletions: number };
export interface PatchFileAnalysis {
  name: string;
  additions: number;
  deletions: number;
  lineStats: boolean;
  status: string;
  binary: boolean;
  part: DiffData;
}
export function analyzePatchFiles(patch: string): PatchFileAnalysis[];
export interface PatchDigest {
  counts: { additions: number; deletions: number };
  statuses: string[];
  targetPath: string;
  files: Array<Omit<PatchFileAnalysis, 'part'>>;
}
export function patchDigest(patch: string): PatchDigest;
export interface PatchSectionDigest extends PatchDigest {
  names: string[];
}
export function diffSectionNames(section: string): string[];
export function patchSectionDigests(patch: string): PatchSectionDigest[];
export function mergePatchDigests(digests: readonly PatchDigest[]): PatchDigest;
export function startupRestorePlan(input?: {
  storedSessionId?: string;
  storedSessionKnown?: boolean;
  engineSessionId?: string;
}): {
  action: 'activate' | 'resume' | 'fallback';
  sessionId: string;
  clearStored: boolean;
};
