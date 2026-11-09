export type QuietWaitKind = 'provider' | 'thinking' | 'model' | 'tool' | 'slot' | 'cancel' | '';

export const MODEL_THINKING_STAGE: 'model_thinking';
export function awaitingModelResponse(liveness: unknown): boolean;
export function displayProgressStage(liveness: unknown): string | null;

export interface QuietProgress {
  since: number;
  wait: QuietWaitKind;
  tool?: string;
}

export interface QuietProgressParts {
  quietMs: number;
  minutes: number;
  wait: QuietWaitKind;
  tool: string;
  escalated: boolean;
}

export const QUIET_PROGRESS_CUE_MS: number;
export function lastProgressAt(liveness: unknown): number;
export function quietWaitKind(stage: unknown): QuietWaitKind;
export function quietProgress(options: {
  progressAt: unknown;
  stage: unknown;
  tool?: unknown;
  now?: number;
}): QuietProgress | null;
export function quietProgressParts(
  quiet: { since?: unknown; wait?: unknown; tool?: unknown } | null | undefined,
  now: number,
  warnMs?: unknown
): QuietProgressParts | null;
export function quietProgressLabel(parts: QuietProgressParts | null): string;
