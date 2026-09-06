import { randomUUID, createHash } from 'node:crypto';
import { createProviderReplay, providerReplayItems } from './lib/provider-replay.mjs';
import { toGeminiContents, toGeminiTools, toGeminiToolConfig } from './gemini-schema.mjs';
import { geminiThinkingConfig } from './gemini-thinking.mjs';

const THOUGHT_SIGNATURE_SENTINEL = 'skip_thought_signature_validator';
const CLAUDE_MAX_OUTPUT_TOKENS = 64000;

export function isAntigravityClaude(model) {
    return /^claude-/i.test(String(model || ''));
}

function signatureSafeMessages(messages, model) {
    return messages.map(message => {
        if (message?.role !== 'assistant') return message;
        const ownParts = providerReplayItems(message, 'antigravity');
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
    const first = contents.find(content => content?.role === 'user');
    const text = first?.parts?.map(part => typeof part?.text === 'string' ? part.text : '').join('') || '';
    if (!text.trim()) return `-${randomUUID()}`;
    const digest = createHash('sha256').update(text).digest();
    return `-${digest.readBigUInt64BE(0) % 9223372036854775807n}`;
}

export function buildAntigravityRequest(messages, model, tools, opts = {}, projectId) {
    const systemText = messages.filter(message => message.role === 'system').map(message => message.content).join('\n\n');
    const chatMessages = messages.filter(message => message.role !== 'system');
    const contents = toGeminiContents(signatureSafeMessages(chatMessages, model), model);
    if (!contents.length) throw new Error('No messages to send');
    const claude = isAntigravityClaude(model);
    let thinkingConfig;
    if (claude) {
        const budget = opts.thinkingBudget ?? opts.thinkingBudgetTokens;
        if (opts.thinkingLevel != null || (budget == null && opts.effort != null)) {
            throw new TypeError('Antigravity Claude uses thinkingBudget; effort levels cannot be converted to a token budget automatically.');
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
        thinkingConfig = geminiThinkingConfig(model, opts, {
            includeThoughts: /^gemini-3/i.test(model) ? true : undefined,
        });
        // This gateway selects Gemini Pro thinking tiers by model ID; Flash
        // uses the bare model ID plus the ordinary thinkingLevel field.
        if (thinkingConfig?.thinkingLevel && /^gemini-3(?:\.\d+)?-pro(?:-|$)/i.test(model)) {
            const level = thinkingConfig.thinkingLevel;
            if (!['low', 'high'].includes(level)) {
                throw new TypeError('Antigravity Gemini Pro supports low/high model tiers.');
            }
            model = `${model.replace(/-(?:low|medium|high)$/i, '')}-${level}`;
        } else if (thinkingConfig?.thinkingLevel && /^gemini-3(?:\.\d+)?-flash(?:-|$)/i.test(model)) {
            model = model.replace(/-(?:minimal|low|medium|high)$/i, '');
        }
    }
    const generationConfig = {
        ...(claude ? { maxOutputTokens: CLAUDE_MAX_OUTPUT_TOKENS } : {}),
        ...(thinkingConfig ? { thinkingConfig } : {}),
    };
    const request = { contents };
    if (systemText) request.systemInstruction = { role: 'user', parts: [{ text: systemText }] };
    if (tools?.length) {
        request.tools = [toGeminiTools(tools)];
        request.toolConfig = toGeminiToolConfig(opts.toolChoice) || { functionCallingConfig: { mode: 'VALIDATED' } };
    }
    if (Object.keys(generationConfig).length) request.generationConfig = generationConfig;
    request.sessionId = sessionId(contents);
    return { project: projectId, model, request, requestType: 'agent', userAgent: 'antigravity', requestId: `agent-${randomUUID()}` };
}
