import { randomUUID, createHash } from 'node:crypto';
import { createProviderReplay, providerReplayItems } from './lib/provider-replay.mjs';
import { toGeminiContents, toGeminiRequestTools, toGeminiToolConfig } from './gemini-schema.mjs';
import { geminiThinkingConfig } from './gemini-thinking.mjs';
import { isGeminiFamilyModel } from './gemini-family.mjs';

const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';
const CLAUDE_MAX_OUTPUT_TOKENS = 64000;

// Claude models behind the gateway speak a different thinking/replay dialect
// (token budgets, anthropic-beta header, their own signatures). The roster
// carries no protocol marker, and a wrong guess is rejected upstream, so the
// vendor prefix of the wire id decides.
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

// The gateway validates Claude's level against Google's ThinkingLevel enum,
// whose highest value is `high`; anything it does not name is left out.
const CLAUDE_GATEWAY_LEVELS = new Set(['low', 'medium', 'high']);
function claudeGatewayLevel(value) {
  const level = String(value ?? '').toLowerCase();
  if (level === 'xhigh' || level === 'max' || level === 'ultra') return 'high';
  return CLAUDE_GATEWAY_LEVELS.has(level) ? level : null;
}

// An explicit token budget is sent as-is; otherwise the chosen effort rides
// on thinkingLevel with the wire id unchanged.
function claudeThinkingConfig(opts) {
  const budget = opts.thinkingBudget ?? opts.thinkingBudgetTokens;
  const thinkingConfig = { includeThoughts: true };
  if (budget == null) {
    const level = claudeGatewayLevel(opts.thinkingLevel ?? opts.effort);
    if (level) thinkingConfig.thinkingLevel = level;
    return thinkingConfig;
  }
  const value = Number(budget);
  if (!Number.isInteger(value) || value < 1024 || value >= CLAUDE_MAX_OUTPUT_TOKENS) {
    throw new TypeError('Antigravity Claude thinkingBudget must be an integer from 1024 to 63999.');
  }
  thinkingConfig.thinkingBudget = value;
  return thinkingConfig;
}

// Tiered wire ids (gemini-3.8-flash-high) already encode the thinking
// level; the provider resolves them from the catalog and clears the
// effort, so only bare ids reach this field.
// Thought summaries on by default for every Gemini-family model, matching the
// API-key provider. The gateway also serves GPT-OSS, which rejects the
// thinking fields outright and which the roster's thinking flag does not
// separate from Gemini, so the flag stays Gemini-only.
function antigravityGeminiThinkingConfig(model, opts) {
  return geminiThinkingConfig(model, opts, {
    provider: 'antigravity-oauth',
    includeThoughts: isGeminiFamilyModel(model) ? true : undefined,
  });
}

// Claude on Antigravity requires standard JSON Schema (draft 2020-12) via
// parametersJsonSchema without top-level oneOf/anyOf/allOf combinators.
function sanitizeClaudeInputSchema(schema) {
  const out = structuredClone(schema || { type: 'object', properties: {} });
  delete out.oneOf;
  delete out.anyOf;
  delete out.allOf;
  if (!out.type) out.type = 'object';
  if (!out.properties) out.properties = {};
  return out;
}

function toAntigravityClaudeTools(tools) {
  if (!tools?.length) return [];
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parametersJsonSchema: sanitizeClaudeInputSchema(t.inputSchema),
      })),
    },
  ];
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
  const thinkingConfig = claude ? claudeThinkingConfig(opts) : antigravityGeminiThinkingConfig(model, opts);
  const generationConfig = {
    ...(claude ? { maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
  const request = { contents };
  if (systemText) request.systemInstruction = { role: 'user', parts: [{ text: systemText }] };
  const requestTools = claude ? toAntigravityClaudeTools(tools) : toGeminiRequestTools(tools, opts.nativeTools);
  if (requestTools.length) request.tools = requestTools;
  if (tools?.length) {
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
