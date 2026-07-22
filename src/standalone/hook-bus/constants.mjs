export const DEFAULT_EVENTS = Object.freeze([
  'runtime:start',
  'session:create',
  'turn:start',
  'turn:end',
  'turn:error',
  'tool:planned',
  'tool:before',
  'tool:ask',
  'tool:deny',
  'tool:modify',
  'hook:error',
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
]);

export const DEFAULT_COMMAND_TIMEOUT_S = 600;
export const USER_PROMPT_TIMEOUT_S = 30;
export const MESSAGE_DISPLAY_TIMEOUT_S = 10;
export const DEFAULT_PROMPT_TIMEOUT_S = 30;
export const DEFAULT_AGENT_TIMEOUT_S = 60;
const MAX_OUTPUT_CHARS = 10_000;
export const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export const TOOL_IF_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'PermissionDenied',
]);

export const NO_MATCHER_EVENTS = new Set([
  'UserPromptSubmit',
  'PostToolBatch',
  'Stop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'WorktreeCreate',
  'WorktreeRemove',
  'CwdChanged',
  'MessageDisplay',
]);

export const EXIT2_BLOCK_EVENTS = new Set([
  'PreToolUse',
  'PermissionRequest',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'Stop',
  'SubagentStop',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'ConfigChange',
  'PostToolBatch',
  'PreCompact',
  'Elicitation',
  'ElicitationResult',
]);

export const TOP_LEVEL_DECISION_EVENTS = new Set([
  'UserPromptSubmit',
  'UserPromptExpansion',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Stop',
  'SubagentStop',
  'ConfigChange',
  'PreCompact',
]);

export const PLAIN_STDOUT_CONTEXT_EVENTS = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'UserPromptExpansion',
]);

export const SUPPORTED_HANDLER_TYPES = new Set(['command', 'http', 'mcp_tool', 'prompt']);

export function limitText(text) {
  const value = String(text || '');
  if (value.length <= MAX_OUTPUT_CHARS) return value;
  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n... [hook output truncated; original ${value.length} chars]`;
}
