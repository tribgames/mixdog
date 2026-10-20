export interface RoutineProvenance {
  kind: 'schedule' | 'webhook';
  name: string;
  status: 'ok' | 'failed';
  summary?: string;
  error?: string;
}

export interface RoutineMessageMeta {
  source: string;
  routine: Record<string, unknown>;
  transcript: { at: number; messageId?: string; attachments?: unknown[] };
}
export interface RoutineMessage {
  role: 'user';
  content: string;
  meta: RoutineMessageMeta;
}
export interface RoutineNotice {
  text: string;
  tone: 'info' | 'warn';
  routine: Record<string, unknown>;
  /** Live run notices only (routineRunNotice). */
  messageId?: string;
  /** A task report's stored files (handoff-artifacts.mjs). */
  attachments?: Array<{
    id: string;
    attachmentRef: string;
    kind: string;
    name: string;
    mimeType: string;
    size: number;
  }>;
}

export const ROUTINE_RESULT_SOURCE: 'schedule-result';
export const TASK_LOOP_CAP: number;
export function routineSummary(text: unknown): string;
export function routineResultMessage(options: {
  kind?: 'schedule' | 'webhook';
  name: string;
  ok: boolean;
  text?: unknown;
  runId?: string | null;
  runSessionId?: string | null;
  reason?: string | null;
  paused?: boolean;
  at?: number;
  messageId?: string;
}): RoutineMessage;
export function routineOmittedMessage(options: { count: number; at?: number; messageId?: string }): RoutineMessage;
export function agentTaskMessage(options: {
  title: string;
  status: string;
  text?: unknown;
  taskSessionId: string;
  /** 'session': any session other than a task session the agent created. */
  target?: 'task' | 'session';
  round?: number;
  /** false: the report was posted without waking the agent (round-trip cap). */
  woken?: boolean;
  /** The files the turn produced (handoff-artifacts.mjs). */
  files?: ReadonlyArray<{ name: string; path: string; mimeType?: string; size?: number; kind?: string; id?: string }>;
  omitted?: number;
  at?: number;
  messageId?: string;
}): RoutineMessage;
export function agentTaskWakePrompt(messages: ReadonlyArray<{ content: string }>): string;
export function isRoutineResultMessage(message: unknown): boolean;
export function normalizeRoutineProvenance(value: unknown): RoutineProvenance | null;
export function routineProvenance(message: unknown): RoutineProvenance | null;
export function routineResultNotice(message: unknown): RoutineNotice;
export function routineRunNotice(options: {
  kind?: 'schedule' | 'webhook';
  name: string;
  runId: string;
  state: string;
  ok?: boolean;
  runSessionId?: string | null;
  messageId?: string;
}): RoutineNotice;
export type RoutineHumanNeededOutcome = 'login_required' | 'human_action_required' | 'sensitive_confirmation_required';
export function routineHumanNeededText(outcome: RoutineHumanNeededOutcome, site: string): string;
export function routineHumanNeeded(summary: unknown): { outcome: RoutineHumanNeededOutcome; site: string } | null;
export function routineLoginRequiredText(site: string): string;
export function routineLoginRequiredSite(summary: unknown): string | null;
