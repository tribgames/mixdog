/**
 * Request shaping for both Gemini transports: the shared pieces of one turn
 * (generationConfig/systemInstruction/contents/tools/toolConfig) and the
 * generateContent body used when a cachedContents prefix is attached.
 *
 * Wire contract: `generationConfig.thinkingConfig`, `systemInstruction`,
 * `contents`, `tools`, `toolConfig` and `cachedContent` are v1beta field
 * names and are produced verbatim; the schema mapping itself lives in
 * gemini-schema.mjs.
 */
import { geminiThinkingConfig } from './gemini-thinking.mjs';
import { toGeminiContents, toGeminiRequestTools, toGeminiToolConfig } from './gemini-schema.mjs';

// Request pieces shared by the cached REST path and the SDK path.
// Caller-supplied generation controls the wire carries in generationConfig.
// maxOutputTokens counts thought tokens too (see the thinking docs). Anything
// invalid is rejected here instead of being dropped. (safetySettings is a
// request-level field, forwarded separately.)
function geminiGenerationControls(opts) {
  const controls = {};
  const maxRaw = opts.maxOutputTokens ?? opts.max_output_tokens;
  if (maxRaw !== undefined && maxRaw !== null) {
    const max = Number(maxRaw);
    if (!Number.isInteger(max) || max <= 0) {
      throw new TypeError('maxOutputTokens must be a positive integer (it includes thinking tokens).');
    }
    controls.maxOutputTokens = max;
  }
  if (opts.temperature !== undefined && opts.temperature !== null) {
    const temperature = Number(opts.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
      throw new TypeError('temperature must be a number between 0 and 2.');
    }
    controls.temperature = temperature;
  }
  return controls;
}

export function buildGeminiRequest(messages, useModel, tools, opts) {
  // Gemini returns thought summaries only when the request asks for them.
  // Without this the reasoning channel stays empty for the whole turn and
  // the model's only visible output is the plain pre-tool text, so every
  // round reads as another preamble. On by default for every model; an
  // explicit opts.includeThoughts still wins.
  const thinkingConfig = geminiThinkingConfig(useModel, opts, { includeThoughts: true });
  const controls = geminiGenerationControls(opts);
  const generationConfig =
    thinkingConfig || Object.keys(controls).length
      ? { ...(thinkingConfig ? { thinkingConfig } : {}), ...controls }
      : undefined;
  const systemInstruction =
    messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n') || undefined;
  const chatMsgs = messages.filter((m) => m.role !== 'system');
  const contents = toGeminiContents(chatMsgs, useModel);
  if (!contents.length) throw new Error('No messages to send');

  const requestTools = toGeminiRequestTools(tools, opts.nativeTools, { onToolExcluded: opts.onToolExcluded });
  const geminiTools = requestTools.length ? requestTools : undefined;
  // Tool config only accompanies function declarations that were kept.
  const toolConfig = requestTools.some((entry) => entry.functionDeclarations?.length)
    ? toGeminiToolConfig(opts.toolChoice)
    : undefined;
  if (opts.safetySettings !== undefined && opts.safetySettings !== null && !Array.isArray(opts.safetySettings)) {
    throw new TypeError('safetySettings must be an array of { category, threshold } entries.');
  }
  const safetySettings = opts.safetySettings?.length ? opts.safetySettings : undefined;
  return { generationConfig, systemInstruction, contents, geminiTools, toolConfig, safetySettings };
}

// The generateContent body for a cached prefix. The cache carries the
// recorded prefix; every uncached tail turn is sent, not just the last
// message, so reused cachedContents preserve full conversation context
// between periodic refreshes.
export function geminiCachedRestBody({ opts, contents, cachedContent, generationConfig, safetySettings }) {
  const cachedPrefixContentCount = Number.isFinite(Number(opts.providerState?.gemini?.cachePrefixContentCount))
    ? Math.max(0, Math.min(contents.length, Math.trunc(Number(opts.providerState.gemini.cachePrefixContentCount))))
    : 0;
  const deltaContents = contents.slice(cachedPrefixContentCount);
  return {
    contents: deltaContents.length ? deltaContents : contents.slice(-1),
    cachedContent,
    ...(generationConfig ? { generationConfig } : {}),
    ...(safetySettings ? { safetySettings } : {}),
  };
}
