// Shared request controls for Chat Completions and Responses gateways.
import { emitProviderRetryStage, retryDelayLabel } from './retry-classifier.mjs';
import { isTogetherBaseURL } from './openai-compat-reasoning-field.mjs';

// withRetry onRetry for the compat stream sends: one stderr line plus a
// display-only 'reconnecting' stage for the UI.
export function compatStreamRetryReporter(label, opts) {
  return ({ attempt, maxAttempts, lastErr, delayMs, delayReason }) => {
    const delayLabel = retryDelayLabel(delayMs, delayReason);
    process.stderr.write(
      `[${label}] retry attempt ${attempt + 1} after ${lastErr?.message || lastErr?.code || 'transient error'}${delayLabel}\n`
    );
    emitProviderRetryStage(opts?.onStageChange, { attempt: attempt + 1, maxAttempts, lastErr, delayMs });
  };
}

// Providers whose docs accept `required` / named tool_choice, and the subset
// that also documents `parallel_tool_calls`. DeepSeek documents no
// parallel_tool_calls, and rejects forced choices in thinking mode.
const FORCED_CHOICE_PROVIDERS = new Set([
  'xai',
  'deepseek',
  'openrouter',
  'mistral',
  'groq',
  'fireworks',
  'together',
  'command-code-oauth',
]);
const PARALLEL_CALLS_PROVIDERS = new Set([
  'xai',
  'openrouter',
  'mistral',
  'groq',
  'fireworks',
  'together',
  'command-code-oauth',
]);

function hostMatches(baseURL, domain) {
  try {
    const host = new URL(String(baseURL || '')).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

function compatToolFamily(provider, baseURL) {
  if (FORCED_CHOICE_PROVIDERS.has(provider)) return provider;
  if (isTogetherBaseURL(baseURL)) return 'together';
  if (hostMatches(baseURL, 'fireworks.ai')) return 'fireworks';
  if (hostMatches(baseURL, 'mistral.ai')) return 'mistral';
  if (hostMatches(baseURL, 'groq.com')) return 'groq';
  return null;
}

function forcedToolChoice(choice, wire) {
  if (choice === 'required') return 'required';
  if (!choice || typeof choice !== 'object') return null;
  const name = choice.function?.name || choice.name;
  if (typeof name !== 'string' || !name) return null;
  return wire === 'responses' ? { type: 'function', name } : { type: 'function', function: { name } };
}

/**
 * Tool-choice controls. `none` is universal. With `ctx` ({ provider, baseURL,
 * wire: 'chat'|'responses', thinking: 'enabled'|'disabled'|null }) the
 * documented providers also get explicit `required` / named tool_choice and an
 * explicit boolean `opts.parallelToolCalls`; without it only `none` applies.
 * DeepSeek rejects forced choices while thinking is explicitly enabled and
 * keeps omitting them when thinking is left to the server default.
 */
export function applyCompatToolChoice(body, opts = {}, ctx = null) {
  if (!(body.tools?.length > 0)) return body;
  if (opts.toolChoice === 'none') body.tool_choice = 'none';
  const family = ctx?.provider ? compatToolFamily(ctx.provider, ctx.baseURL) : null;
  if (!family) return body;
  const forced = forcedToolChoice(opts.toolChoice, ctx.wire);
  if (forced) {
    if (family === 'deepseek' && ctx.thinking === 'enabled') {
      throw Object.assign(
        new Error(
          '[deepseek] tool_choice "required" or a named tool is not supported in thinking mode; disable thinking (effort none) to force a tool call'
        ),
        { code: 'unsupported_tool_choice' }
      );
    }
    if (family !== 'deepseek' || ctx.thinking === 'disabled') body.tool_choice = forced;
  }
  if (typeof opts.parallelToolCalls === 'boolean' && PARALLEL_CALLS_PROVIDERS.has(family)) {
    body.parallel_tool_calls = opts.parallelToolCalls;
  }
  return body;
}

export function compatResponsesReplayProvider(provider) {
  return `compat-responses:${provider}`;
}

// Older gateway transcripts used the public OpenAI replay tag. Their opaque
// items have no trustworthy origin, so inheritance keeps the flattened
// conversation instead. Newly scoped envelopes remain available to their owner.
export function inheritedCompatReplayMessages(messages, sourceProvider) {
  if (sourceProvider !== 'opencode-go') return messages;
  return messages.map((message) => {
    if (message?.providerReplay?.provider !== 'openai-responses') return message;
    const { providerReplay: _legacyReplay, ...rest } = message;
    return rest;
  });
}
