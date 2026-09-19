// Exact input-token measurement, and the differential trick built on it.
//
// A local estimator prices the DELTA since a provider usage baseline; it was
// never meant to price a whole transcript, and it cannot price reasoning at
// all — Anthropic stores its thinking text as an empty string next to a
// signature, and the OpenAI-shaped providers hand back ciphertext. Both are
// still BILLED as input on keep-all models.
//
// Every major provider exposes a free pre-flight counter that runs the real
// tokenizer over the real request shape (messages, system, tools, images).
// Because the counter accepts an arbitrary request, the price of one
// ingredient is the difference between counting the request with it and
// counting the same request without it. That is how a reasoning row gets a
// measured number instead of a guess.
//
// Nothing here throws: a measurement is an optional improvement over the
// estimate, never a precondition for answering.

const COUNT_TIMEOUT_MS = 60_000;
const ANTHROPIC_COUNT_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const OPENAI_COUNT_URL = 'https://api.openai.com/v1/responses/input_tokens';
const GEMINI_COUNT_URL = 'https://generativelanguage.googleapis.com/v1beta';

const REASONING_BLOCK_TYPES = new Set(['thinking', 'redacted_thinking']);

/** Providers with a counter that sees the whole request, not just loose text. */
export function supportsInputTokenCount(provider) {
  const name = String(provider || '').toLowerCase();
  return (
    name.startsWith('anthropic') || name.startsWith('openai') || name.startsWith('gemini') || name.startsWith('google')
  );
}

function timeoutSignal(signal) {
  if (signal) return signal;
  return AbortSignal.timeout(COUNT_TIMEOUT_MS);
}

async function readCount(response, pick) {
  if (!response.ok) return null;
  try {
    const value = pick(await response.json());
    return Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  } catch {
    return null;
  }
}

/** Anthropic: the counter takes the message-shaped request minus sampling fields. */
export async function countAnthropicInputTokens({ accessToken, headers, payload, signal } = {}) {
  if (!payload?.model || !Array.isArray(payload.messages)) return null;
  try {
    const response = await fetch(ANTHROPIC_COUNT_URL, {
      method: 'POST',
      headers: headers ?? {
        Authorization: `Bearer ${accessToken}`,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: timeoutSignal(signal),
    });
    return await readCount(response, (body) => body?.input_tokens);
  } catch {
    return null;
  }
}

/** OpenAI: same input shape as Responses, so the send body works unchanged. */
export async function countOpenAIInputTokens({ accessToken, headers, payload, signal } = {}) {
  if (!payload?.model) return null;
  try {
    const response = await fetch(OPENAI_COUNT_URL, {
      method: 'POST',
      headers: headers ?? {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: timeoutSignal(signal),
    });
    return await readCount(response, (body) => body?.input_tokens);
  } catch {
    return null;
  }
}

/** Gemini: generateContentRequest carries system instructions and tools too. */
export async function countGeminiInputTokens({ apiKey, model, request, signal } = {}) {
  const name = String(model || '').replace(/^models\//, '');
  if (!apiKey || !name || !request) return null;
  try {
    const response = await fetch(
      `${GEMINI_COUNT_URL}/models/${encodeURIComponent(name)}:countTokens?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generateContentRequest: request }),
        signal: timeoutSignal(signal),
      }
    );
    return await readCount(response, (body) => body?.totalTokens);
  } catch {
    return null;
  }
}

// Removing a tool_use without its tool_result makes the request invalid, so a
// tool row cannot be priced by deletion the way reasoning can. Reasoning
// blocks carry no such pairing and drop cleanly.
export function withoutReasoningBlocks(messages) {
  if (!Array.isArray(messages)) return messages;
  let changed = false;
  const next = [];
  for (const message of messages) {
    if (!Array.isArray(message?.content)) {
      next.push(message);
      continue;
    }
    const content = message.content.filter((block) => !REASONING_BLOCK_TYPES.has(block?.type));
    if (content.length === message.content.length) {
      next.push(message);
      continue;
    }
    changed = true;
    // A turn that was nothing but reasoning leaves no block behind; an empty
    // content array is rejected, so the turn goes away with it.
    if (content.length) next.push({ ...message, content });
  }
  return changed ? next : messages;
}

export function countReasoningBlocks(messages) {
  if (!Array.isArray(messages)) return 0;
  let total = 0;
  for (const message of messages) {
    if (!Array.isArray(message?.content)) continue;
    for (const block of message.content) if (REASONING_BLOCK_TYPES.has(block?.type)) total += 1;
  }
  return total;
}

/**
 * Price the reasoning already sitting in a transcript: count the request, then
 * count it again without the reasoning blocks. Returns null when the provider
 * has no counter or either call fails — the caller keeps its estimate.
 */
export async function measureReasoningTokens({ count, payload, signal } = {}) {
  if (typeof count !== 'function' || !Array.isArray(payload?.messages)) return null;
  const blocks = countReasoningBlocks(payload.messages);
  if (blocks === 0) return { total: null, reasoning: 0, blocks: 0 };
  const stripped = withoutReasoningBlocks(payload.messages);
  if (stripped === payload.messages) return { total: null, reasoning: 0, blocks };
  const total = await count(payload, signal);
  if (total === null) return null;
  const withoutReasoning = await count({ ...payload, messages: stripped }, signal);
  if (withoutReasoning === null) return null;
  return { total, reasoning: Math.max(0, total - withoutReasoning), blocks };
}
