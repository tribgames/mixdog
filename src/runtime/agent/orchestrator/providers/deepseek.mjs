/**
 * DeepSeek: Chat Completions at https://api.deepseek.com plus the Anthropic
 * Messages endpoint at https://api.deepseek.com/anthropic (the SDK appends
 * /v1/messages). Per DeepSeek's Anthropic API docs that endpoint carries
 * thinking and tool_use/tool_result blocks and ignores cache_control and
 * anthropic-beta; agent/tool sessions use it, tool-less one-shot requests stay
 * on Chat (wire-route.mjs). DeepSeek has no Responses endpoint.
 */
import { WireGatewayProvider, messagesBaseFromOpenAIBase } from './wire-gateway.mjs';
import { OPENAI_COMPAT_PRESETS } from './openai-compat-presets.mjs';

export function deepSeekMessagesBaseURL(configuredBaseURL) {
  return `${messagesBaseFromOpenAIBase(configuredBaseURL || OPENAI_COMPAT_PRESETS.deepseek.baseURL)}/anthropic`;
}

// Requested effort → output_config.effort (thinking_mode docs: minimal/low →
// low, medium/high/xhigh → high, max/ultra → max).
const DEEPSEEK_EFFORT = Object.freeze({
  minimal: 'low',
  low: 'low',
  medium: 'high',
  high: 'high',
  xhigh: 'high',
  max: 'max',
  ultra: 'max',
});
const DEEPSEEK_OFF = new Set(['none', 'off', 'disabled']);

/**
 * DeepSeek's own effort contract on its Messages endpoint: thinking is on by
 * default and `budget_tokens` is ignored, so an effort goes in
 * `output_config.effort`; off is `thinking:{type:'disabled'}` together with the
 * documented Anthropic-format toggle `reasoning:{effort:'none'}`. No effort
 * leaves the default (thinking on, effort high). Always handles the request.
 */
export function deepSeekEffortProjection(body, { effort } = {}) {
  const level = String(effort ?? '')
    .trim()
    .toLowerCase();
  if (DEEPSEEK_OFF.has(level)) {
    body.thinking = { type: 'disabled' };
    body.reasoning = { effort: 'none' };
    return true;
  }
  const mapped = DEEPSEEK_EFFORT[level];
  if (mapped) {
    const existing = body.output_config && typeof body.output_config === 'object' ? body.output_config : {};
    body.output_config = { ...existing, effort: mapped };
  }
  return true;
}

export class DeepSeekProvider extends WireGatewayProvider {
  constructor(config = {}) {
    super('deepseek', config, {
      baseURL: deepSeekMessagesBaseURL(config.baseURL),
      // The endpoint has no document block of any kind (PDFs included).
      nativePdf: false,
      nativeDocuments: false,
      // disable_parallel_tool_use is ignored on every tool_choice.
      supportsDisableParallelToolUse: false,
      // Image `source.type: file` needs the Files API beta, on those requests only.
      fileIdImageBeta: 'files-api-2025-04-14',
      messagesEffortProjection: deepSeekEffortProjection,
    });
  }
}
