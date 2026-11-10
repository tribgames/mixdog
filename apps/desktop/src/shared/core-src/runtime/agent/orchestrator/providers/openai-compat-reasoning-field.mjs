/**
 * openai-compat-reasoning-field.mjs — provider-specific reasoning shapes on the
 * Chat Completions wire that the plain `reasoning_content` string path misses.
 *
 * Together AI (docs.together.ai/docs/inference/chat/reasoning): the chain of
 * thought arrives on `reasoning` OR `reasoning_content` (model dependent), on
 * the message and on each streaming delta, and must be passed back "under the
 * same key" on prior assistant turns. vLLM reports it on `reasoning` (formerly
 * `reasoning_content`), Groq on `message.reasoning` (reasoning_format parsed).
 * OpenRouter reports plain text on `reasoning` next to `reasoning_details`.
 *
 * Mistral (docs.mistral.ai/studio/conversations/reasoning): with reasoning on,
 * `message.content` / `delta.content` is a list of typed chunks —
 * `{type:'thinking', thinking:[{type:'text', text}]}` and `{type:'text', text}`
 * — and the full assistant message, thinking chunk included, goes back in the
 * history. Receiving is by the response shape (an array), never by model name.
 */

/** `message.providerMetadata[key].reasoningField`: the key a reply's reasoning arrived on. */
export const COMPAT_REASONING_METADATA_KEY = 'openaiCompat';

const TOGETHER_HOSTS = ['together.xyz', 'together.ai'];
const GROQ_HOSTS = ['groq.com'];
const MISTRAL_HOSTS = ['mistral.ai'];

function hostMatches(baseURL, domains) {
  let host;
  try {
    host = new URL(String(baseURL || '')).hostname.toLowerCase();
  } catch {
    return false;
  }
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

export function isTogetherBaseURL(baseURL) {
  return hostMatches(baseURL, TOGETHER_HOSTS);
}

/**
 * Where an endpoint family reports reasoning and how a prior turn's reasoning
 * goes back. `readsReasoningAlias`: the `reasoning` key is a reasoning field
 * (otherwise only `reasoning_content` is). `resend`:
 *   same_key        — back under the key it arrived on (Together, vLLM)
 *   reasoning       — plain text as `reasoning`; reasoning_details win (OpenRouter)
 *   content_chunks  — as a `thinking` chunk in the assistant content (Mistral)
 *   none            — never echoed; the docs do not ask for it (Groq)
 */
const SHAPES = Object.freeze({
  together: Object.freeze({ id: 'together', readsReasoningAlias: true, resend: 'same_key' }),
  vllm: Object.freeze({ id: 'vllm', readsReasoningAlias: true, resend: 'same_key' }),
  groq: Object.freeze({ id: 'groq', readsReasoningAlias: true, resend: 'none' }),
  mistral: Object.freeze({ id: 'mistral', readsReasoningAlias: false, resend: 'content_chunks' }),
  openrouter: Object.freeze({ id: 'openrouter', readsReasoningAlias: true, resend: 'reasoning' }),
});

/**
 * The reasoning shape of a provider, or null for the plain `reasoning_content`
 * path. OpenRouter is by provider name, Together/Groq/Mistral by the provider's
 * own base URL, vLLM (no fixed host) by the model row's `vllm` wire format.
 */
export function compatReasoningShape({ providerName, baseURL, wireFormat } = {}) {
  if (providerName === 'openrouter') return SHAPES.openrouter;
  if (wireFormat === 'together' || isTogetherBaseURL(baseURL)) return SHAPES.together;
  if (wireFormat === 'vllm') return SHAPES.vllm;
  if (hostMatches(baseURL, GROQ_HOSTS)) return SHAPES.groq;
  if (hostMatches(baseURL, MISTRAL_HOSTS)) return SHAPES.mistral;
  return null;
}

/**
 * The receive field worth recording for replay: `reasoning` (non-default key)
 * or `content_chunks` (Mistral), per shape; `reasoning_content` is the default
 * and needs no record. Null when nothing needs remembering.
 */
export function replayReasoningField(shape, source) {
  if (!shape) return null;
  if (shape.resend === 'same_key' && source === 'reasoning') return 'reasoning';
  if (shape.resend === 'content_chunks' && source === 'content_chunks') return 'content_chunks';
  return null;
}

/** Whether a reply's reasoning source is captured under this shape. */
export function capturesShapeReasoning(shape, source) {
  if (!shape) return source === 'content_chunks';
  if (source === 'content_chunks') return true;
  return source === 'reasoning_content' || (shape.readsReasoningAlias && source === 'reasoning');
}

/** Assistant content with the prior reasoning replayed as a leading `thinking` chunk. */
export function contentWithThinkingChunk(content, reasoning) {
  const thinking = { type: 'thinking', thinking: [{ type: 'text', text: reasoning }] };
  if (Array.isArray(content)) return [thinking, ...content];
  return typeof content === 'string' && content ? [thinking, { type: 'text', text: content }] : [thinking];
}

function thinkingText(thinking) {
  if (typeof thinking === 'string') return thinking;
  if (!Array.isArray(thinking)) return '';
  return thinking
    .map((inner) => {
      if (typeof inner === 'string') return inner;
      return typeof inner?.text === 'string' ? inner.text : '';
    })
    .join('');
}

/**
 * Ordered `{kind:'reasoning'|'text', text}` parts of an array-shaped `content`,
 * or null when `content` is not an array (the plain string/absent shape).
 */
export function chatContentParts(content) {
  if (!Array.isArray(content)) return null;
  const parts = [];
  for (const chunk of content) {
    if (typeof chunk === 'string') {
      parts.push({ kind: 'text', text: chunk });
    } else if (chunk?.type === 'thinking') {
      parts.push({ kind: 'reasoning', text: thinkingText(chunk.thinking) });
    } else if (chunk?.type === 'text' && typeof chunk.text === 'string') {
      parts.push({ kind: 'text', text: chunk.text });
    }
  }
  return parts;
}

/**
 * Content text, reasoning and reasoning source of one non-streaming message.
 * `reasoning_content` keeps priority; the `reasoning` alias is read only under
 * a shape that reports reasoning there; thinking chunks fill in when no field
 * carried reasoning.
 */
export function readChatMessage(message, { shape = null } = {}) {
  const parts = chatContentParts(message?.content);
  let content;
  if (parts) {
    content = parts
      .filter((part) => part.kind === 'text')
      .map((part) => part.text)
      .join('');
  } else {
    content = typeof message?.content === 'string' ? message.content : '';
  }
  if (typeof message?.reasoning_content === 'string') {
    return { content, reasoningContent: message.reasoning_content, reasoningSource: 'reasoning_content' };
  }
  if (shape?.readsReasoningAlias && typeof message?.reasoning === 'string') {
    return { content, reasoningContent: message.reasoning, reasoningSource: 'reasoning' };
  }
  const thinking = parts?.filter((part) => part.kind === 'reasoning');
  if (thinking?.length) {
    return { content, reasoningContent: thinking.map((part) => part.text).join(''), reasoningSource: 'content_chunks' };
  }
  return { content, reasoningContent: null, reasoningSource: null };
}
