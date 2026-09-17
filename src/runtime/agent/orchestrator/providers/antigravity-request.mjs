import { randomUUID, createHash } from 'node:crypto';
import { createProviderReplay, providerReplayItems } from './lib/provider-replay.mjs';
import { toGeminiContents, toGeminiTools, toGeminiToolConfig } from './gemini-schema.mjs';
import { geminiThinkingConfig } from './gemini-thinking.mjs';

const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';
const CLAUDE_MAX_OUTPUT_TOKENS = 64000;

export function isAntigravityClaude(model) {
  return /^claude-/i.test(String(model || ''));
}

// Default function-calling mode when the caller sets no toolChoice. VALIDATED
// (schema-constrained function calls) is what the Antigravity client sends;
// MIXDOG_ANTIGRAVITY_FC_MODE=AUTO|ANY|VALIDATED overrides it for A/B runs.
const FUNCTION_CALLING_MODES = new Set(['AUTO', 'ANY', 'VALIDATED']);
export function antigravityFunctionCallingMode(env = process.env) {
  const raw = String(env?.MIXDOG_ANTIGRAVITY_FC_MODE || '')
    .trim()
    .toUpperCase();
  return FUNCTION_CALLING_MODES.has(raw) ? raw : 'VALIDATED';
}

// A replay recorded by the other model family (Claude vs Gemini) carries
// signatures the target model rejects; rebuild it from the plain history
// with the recovery sentinel instead.
function replayFamilyMatches(message, model) {
  const recorded = message?.providerReplay?.requestContext?.model;
  if (typeof recorded !== 'string' || !recorded) return true;
  return isAntigravityClaude(recorded) === isAntigravityClaude(model);
}

function signatureSafeMessages(messages, model) {
  return messages.map((message) => {
    if (message?.role !== 'assistant') return message;
    const ownParts = replayFamilyMatches(message, model) ? providerReplayItems(message, 'antigravity') : undefined;
    // Repair tool signatures only after the complete history establishes
    // the active turn, not while normalizing an isolated older message.
    const parts = ownParts || toGeminiContents([message], model, { repairToolSignatures: false })[0]?.parts;
    if (!parts?.length) return message;
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.thought === true || typeof part.thoughtSignature === 'string') {
        // Preserve opaque signatures from this provider's recorded
        // response. Unknown/foreign legacy metadata keeps the recovery
        // sentinel, and missing signatures are never fabricated.
        if (!ownParts || !part.thoughtSignature) part.thoughtSignature = THOUGHT_SIGNATURE_SENTINEL;
      }
    }
    return { ...message, providerReplay: createProviderReplay('antigravity', parts) };
  });
}

function sessionId(contents) {
  const first = contents.find((content) => content?.role === 'user');
  const text = first?.parts?.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('') || '';
  if (!text.trim()) return `-${randomUUID()}`;
  const digest = createHash('sha256').update(text).digest();
  return `-${digest.readBigUInt64BE(0) % 9223372036854775807n}`;
}

export function buildAntigravityRequest(messages, model, tools, opts = {}, projectId) {
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const chatMessages = messages.filter((message) => message.role !== 'system');
  const contents = toGeminiContents(signatureSafeMessages(chatMessages, model), model);
  if (!contents.length) throw new Error('No messages to send');
  const claude = isAntigravityClaude(model);
  let thinkingConfig;
  if (claude) {
    const budget = opts.thinkingBudget ?? opts.thinkingBudgetTokens;
    if (opts.thinkingLevel != null || (budget == null && opts.effort != null)) {
      throw new TypeError(
        'Antigravity Claude uses thinkingBudget; effort levels cannot be converted to a token budget automatically.'
      );
    }
    thinkingConfig = { includeThoughts: true };
    if (budget != null) {
      const value = Number(budget);
      if (!Number.isInteger(value) || value < 1024 || value >= CLAUDE_MAX_OUTPUT_TOKENS) {
        throw new TypeError('Antigravity Claude thinkingBudget must be an integer from 1024 to 63999.');
      }
      thinkingConfig.thinkingBudget = value;
    }
  } else {
    // Tiered wire ids (gemini-3.8-flash-high) already encode the thinking
    // level; the provider resolves them from the catalog and clears the
    // effort, so only bare ids reach this field.
    thinkingConfig = geminiThinkingConfig(model, opts, {
      includeThoughts: /^gemini-3/i.test(model) ? true : undefined,
    });
  }
  const generationConfig = {
    ...(claude ? { maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
  const request = { contents };
  if (systemText) request.systemInstruction = { role: 'user', parts: [{ text: systemText }] };
  if (tools?.length) {
    request.tools = [toGeminiTools(tools)];
    request.toolConfig = toGeminiToolConfig(opts.toolChoice) || {
      functionCallingConfig: { mode: antigravityFunctionCallingMode() },
    };
  }
  if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
  request.sessionId = sessionId(contents);
  return {
    project: projectId,
    model,
    request,
    requestType: 'agent',
    userAgent: 'antigravity',
    requestId: `agent-${randomUUID()}`,
  };
}
