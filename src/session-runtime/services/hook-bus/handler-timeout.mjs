import {
  DEFAULT_AGENT_TIMEOUT_S,
  DEFAULT_COMMAND_TIMEOUT_S,
  DEFAULT_PROMPT_TIMEOUT_S,
  MESSAGE_DISPLAY_TIMEOUT_S,
  USER_PROMPT_TIMEOUT_S,
} from './constants.mjs';

export function handlerTimeoutS(handler, eventName) {
  if (Number.isFinite(handler.timeout) && handler.timeout > 0) return handler.timeout;
  if (handler.type === 'prompt') return DEFAULT_PROMPT_TIMEOUT_S;
  if (handler.type === 'agent') return DEFAULT_AGENT_TIMEOUT_S;
  if (handler.type === 'mcp_tool') return DEFAULT_COMMAND_TIMEOUT_S;
  if (eventName === 'UserPromptSubmit') return USER_PROMPT_TIMEOUT_S;
  if (eventName === 'MessageDisplay') return MESSAGE_DISPLAY_TIMEOUT_S;
  return DEFAULT_COMMAND_TIMEOUT_S;
}
