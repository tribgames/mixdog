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
import { toGeminiContents, toGeminiNativeTools, toGeminiToolConfig, toGeminiTools } from './gemini-schema.mjs';

// Request pieces shared by the cached REST path and the SDK path.
export function buildGeminiRequest(messages, useModel, tools, opts) {
  // Gemini returns thought summaries only when the request asks for them.
  // Without this the reasoning channel stays empty for the whole turn and
  // the model's only visible output is the plain pre-tool text, so every
  // round reads as another preamble. On by default for every model; an
  // explicit opts.includeThoughts still wins.
  const thinkingConfig = geminiThinkingConfig(useModel, opts, { includeThoughts: true });
  const generationConfig = thinkingConfig ? { thinkingConfig } : undefined;
  const systemInstruction =
    messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n') || undefined;
  const chatMsgs = messages.filter((m) => m.role !== 'system');
  const contents = toGeminiContents(chatMsgs, useModel);
  if (!contents.length) throw new Error('No messages to send');

  const nativeGeminiTools = toGeminiNativeTools(opts.nativeTools);
  const functionGeminiTools = tools?.length ? [toGeminiTools(tools)] : [];
  const geminiTools =
    nativeGeminiTools.length || functionGeminiTools.length ? [...nativeGeminiTools, ...functionGeminiTools] : undefined;
  const toolConfig = functionGeminiTools.length ? toGeminiToolConfig(opts.toolChoice) : undefined;
  return { generationConfig, systemInstruction, contents, geminiTools, toolConfig };
}

// The generateContent body for a cached prefix. The cache carries the
// recorded prefix; every uncached tail turn is sent, not just the last
// message, so reused cachedContents preserve full conversation context
// between periodic refreshes.
export function geminiCachedRestBody({ opts, contents, cachedContent, generationConfig }) {
  const cachedPrefixContentCount = Number.isFinite(Number(opts.providerState?.gemini?.cachePrefixContentCount))
    ? Math.max(0, Math.min(contents.length, Math.trunc(Number(opts.providerState.gemini.cachePrefixContentCount))))
    : 0;
  const deltaContents = contents.slice(cachedPrefixContentCount);
  return {
    contents: deltaContents.length ? deltaContents : contents.slice(-1),
    cachedContent,
    ...(generationConfig ? { generationConfig } : {}),
  };
}
