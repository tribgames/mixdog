export const PROMPT_ESCAPE_CLEAR_WINDOW_MS: number;
export const PROMPT_ESCAPE_HINT_TIMEOUT_MS: number;

export type PromptEscapeAction =
  | 'interrupt'
  | 'collapse-selection'
  | 'restore-queue'
  | 'idle'
  | 'message-selector'
  | 'arm-select'
  | 'clear'
  | 'arm-clear';

export function classifyPromptEscape(input?: {
  interruptActive?: boolean;
  hasSelection?: boolean;
  hasQueuedMessages?: boolean;
  hasMessages?: boolean;
  value?: unknown;
  lastClearPressAt?: number;
  now?: number;
}): {
  action: PromptEscapeAction;
  nextClearPressAt: number;
};
