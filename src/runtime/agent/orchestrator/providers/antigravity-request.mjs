import { randomUUID, createHash } from 'node:crypto';
import { createProviderReplay, providerReplayItems } from './lib/provider-replay.mjs';
import { toGeminiContents, toGeminiRequestTools, toGeminiToolConfig } from './gemini-schema.mjs';
import { geminiThinkingConfig } from './gemini-thinking.mjs';
import { isGeminiFamilyModel } from './gemini-family.mjs';
import { splitTailReminder } from './lib/tail-reminder-split.mjs';

const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';
const CLAUDE_MAX_OUTPUT_TOKENS = 64000;

// Claude models behind the gateway speak a different thinking/replay dialect
// (token budgets, anthropic-beta header, their own signatures). The roster
// carries no protocol marker, and a wrong guess is rejected upstream, so the
// vendor prefix of the wire id decides.
export function isAntigravityClaude(model) {
  return /^claude-/i.test(String(model || ''));
}

// Claude declarations are validated for the gateway's Anthropic bridge in
// toGeminiTools (claudeBridge: true); a tool with an invalid schema is left
// out of the request and reported through `onToolExcluded` / console.warn.
const claudeRequestTools = (tools, nativeTools, onToolExcluded) =>
  toGeminiRequestTools(tools, nativeTools, { claudeBridge: true, onToolExcluded });

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

// The stream records empty text parts around Claude tool calls; Cloud Code's
// Claude bridge rejects them on replay ("text.text: Field required").
const isEmptyPlainTextPart = (part) =>
  part?.text === '' && part.thought !== true && typeof part.thoughtSignature !== 'string';

// Streamed Claude thinking arrives as many thought deltas with the signature
// on the closing (often empty) delta; the bridge turns every part into its own
// thinking block and rejects the unsigned ones ("thinking.signature: Field
// required"). Rejoin each run into one block that ends at its signature.
function coalesceClaudeThoughts(parts) {
  const out = [];
  let open = null;
  for (const part of parts) {
    if (part?.thought !== true) {
      if (open) out.push(open);
      open = null;
      out.push(part);
      continue;
    }
    const partText = typeof part.text === 'string' ? part.text : '';
    open = open ? { ...open, ...part, text: `${open.text}${partText}` } : { ...part, text: partText };
    if (typeof part.thoughtSignature === 'string') {
      out.push(open);
      open = null;
    }
  }
  if (open) out.push(open);
  return out;
}

// The validator-bypass sentinel is a Gemini wire token: the Claude bridge
// sends a thinking block carrying it (or no signature at all) without a
// signature and Anthropic rejects the request ("thinking.signature: Field
// required"). Only a signature this route recorded is replayed to Claude;
// any other signature is removed, and a thinking block left without one (an
// interrupted run, another model's or provider's turn, legacy metadata) is
// dropped rather than turned into visible text.
const hasOwnClaudeSignature = (part) =>
  typeof part.thoughtSignature === 'string' &&
  part.thoughtSignature !== '' &&
  part.thoughtSignature !== THOUGHT_SIGNATURE_SENTINEL;

function claudeReplayParts(parts, own) {
  const signed = parts.map((part) => {
    if (!part || typeof part !== 'object' || !('thoughtSignature' in part)) return part;
    if (own && hasOwnClaudeSignature(part)) return part;
    const { thoughtSignature: _foreign, ...unsigned } = part;
    return unsigned;
  });
  return coalesceClaudeThoughts(signed.filter((part) => !isEmptyPlainTextPart(part))).filter(
    (part) => part?.thought !== true || hasOwnClaudeSignature(part)
  );
}

function signatureSafeMessages(messages, model) {
  const claude = isAntigravityClaude(model);
  return messages.flatMap((message) => {
    if (message?.role !== 'assistant') return [message];
    const ownParts = replayFamilyMatches(message, model) ? providerReplayItems(message, 'antigravity') : undefined;
    // Repair tool signatures only after the complete history establishes
    // the active turn, not while normalizing an isolated older message.
    const sourceParts = ownParts || toGeminiContents([message], model, { repairToolSignatures: false })[0]?.parts;
    const parts = claude && sourceParts ? claudeReplayParts(sourceParts, !!ownParts) : sourceParts;
    // A turn that held only empty or dropped parts is omitted, not sent as parts:[].
    if (sourceParts?.length && !parts.length) return [];
    if (!parts?.length) return [message];
    for (const part of parts) {
      if (!part || typeof part !== 'object') continue;
      if (part.thought === true || typeof part.thoughtSignature === 'string') {
        // Preserve opaque signatures from this provider's recorded
        // response. Unknown/foreign legacy metadata keeps the recovery
        // sentinel, and missing signatures are never fabricated.
        if (!ownParts || !part.thoughtSignature) part.thoughtSignature = THOUGHT_SIGNATURE_SENTINEL;
      }
    }
    return [{ ...message, providerReplay: createProviderReplay('antigravity', parts) }];
  });
}

const isToolResultTurn = (content) =>
  content?.role === 'user' && !!content.parts?.some((part) => part?.functionResponse);
const isPromptTurn = (content) => content?.role === 'user' && !isToolResultTurn(content);
const hasSignedThinking = (content) =>
  !!content?.parts?.some((part) => part?.thought === true && hasOwnClaudeSignature(part));

// With thinking on, Claude rejects a tool loop whose turn did not open with a
// signed thinking block, and a block that was dropped (unsigned, foreign or
// compacted away) cannot be restored. The outgoing request closes that loop
// instead: the closed part loses its thinking, a short model reply
// acknowledges the tool results, and a user nudge opens a fresh turn that
// Claude starts with new thinking. The closure sits after the results of the
// turn's last unthought model message, so later steps keep the signed
// thinking that the fresh turn produced. Wire-only: the caller's messages and
// recorded replays are never touched.
function closeUnthoughtToolLoop(contents) {
  if (!isToolResultTurn(contents.at(-1))) return contents;
  const promptIndex = contents.findLastIndex(isPromptTurn);
  const modelIndexes = [];
  for (let index = promptIndex + 1; index < contents.length; index += 1) {
    if (contents[index]?.role === 'model') modelIndexes.push(index);
  }
  if (!modelIndexes.length || hasSignedThinking(contents[modelIndexes[0]])) return contents;
  const unthought = modelIndexes.findLast((index) => !hasSignedThinking(contents[index]));
  let cut = unthought + 1;
  let results = 0;
  while (isToolResultTurn(contents[cut])) {
    results += contents[cut].parts.filter((part) => part?.functionResponse).length;
    cut += 1;
  }
  if (!results) return contents;
  const closed = contents.slice(0, cut).flatMap((content) => {
    if (content?.role !== 'model') return [content];
    const parts = content.parts.filter((part) => part?.thought !== true);
    return parts.length ? [{ ...content, parts }] : [];
  });
  const ack = results === 1 ? '[Tool result received.]' : `[${results} tool results received.]`;
  return [
    ...closed,
    { role: 'model', parts: [{ text: ack }] },
    { role: 'user', parts: [{ text: '[Continue.]' }] },
    ...contents.slice(cut),
  ];
}

// The request turns Claude thinking on through an effort level or token
// budget; a `-thinking` wire id thinks without either.
const claudeThinkingEnabled = (model, thinkingConfig) =>
  !!(thinkingConfig.thinkingLevel || thinkingConfig.thinkingBudget) || /-thinking$/i.test(String(model));

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

export function buildAntigravityRequest(requestMessages, model, tools, opts = {}, projectId) {
  // The tail reminder is not history: the tool-loop closure below must see the
  // real tail, so the reminder is appended to the wire contents last.
  const { messages, reminder } = splitTailReminder(requestMessages);
  const systemText = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const chatMessages = messages.filter((message) => message.role !== 'system');
  const history = toGeminiContents(signatureSafeMessages(chatMessages, model), model);
  if (!history.length) throw new Error('No messages to send');
  const claude = isAntigravityClaude(model);
  const thinkingConfig = claude ? claudeThinkingConfig(opts) : antigravityGeminiThinkingConfig(model, opts);
  const contents = claude && claudeThinkingEnabled(model, thinkingConfig) ? closeUnthoughtToolLoop(history) : history;
  const generationConfig = {
    ...(claude ? { maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS } : {}),
    ...(thinkingConfig ? { thinkingConfig } : {}),
  };
  const request = { contents: reminder ? [...contents, { role: 'user', parts: [{ text: reminder }] }] : contents };
  if (systemText) request.systemInstruction = { role: 'user', parts: [{ text: systemText }] };
  const requestTools = claude
    ? claudeRequestTools(tools, opts.nativeTools, opts.onToolExcluded)
    : toGeminiRequestTools(tools, opts.nativeTools, {
        onToolExcluded: opts.onToolExcluded,
        // Other families (GPT-OSS) keep the plain conversion.
        validate: isGeminiFamilyModel(model),
      });
  if (requestTools.length) request.tools = requestTools;
  // Tool config only accompanies function declarations that were kept.
  if (requestTools.some((entry) => entry.functionDeclarations?.length)) {
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
