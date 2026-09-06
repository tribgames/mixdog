// Transcript lowering is independent of request/turn metadata. A retained
// message must have the same wire representation in every subsequent request.
import { providerReplayItems } from './lib/provider-replay.mjs';
import { ensureResponsesCallOutputs } from './lib/wire-pairing.mjs';
import {
    normalizeContentForOpenAIResponses,
    splitToolContentForOpenAIResponses,
} from './media-normalization.mjs';
import {
    customToolInputFromArguments,
    isCustomToolCallRecord,
    nativeToolSearchCallInput,
    nativeToolSearchOutputInput,
} from './custom-tool-wire.mjs';

export function convertMessagesToResponsesInput(messages, opts = {}) {
    const out = [];
    const pendingToolMedia = [];
    const customToolCallNameById = new Map();
    const replayEncryptedReasoning = opts.replayEncryptedReasoning === true;
    const wireParity = opts.codexWireParity === true;
    const wireMessage = (role, content, phase) => ({
        ...(wireParity ? { type: 'message' } : {}),
        role,
        content,
        ...(role === 'assistant' && (phase === 'commentary' || phase === 'final_answer')
            ? { phase }
            : {}),
        // Current turn_id belongs to request-level client metadata/headers,
        // never every historical message. Native replay items below retain
        // their original metadata instead of being restamped.
        ...(wireParity ? { internal_chat_message_metadata_passthrough: {} } : {}),
    });
    // `phase` replays each retained item on the side of the assistant text it
    // was emitted on, so the rebuilt turn keeps the response's own item order.
    const pushReasoningItems = (message, phase = 'before') => {
        if (!replayEncryptedReasoning || message?.role !== 'assistant' || !Array.isArray(message.reasoningItems)) return;
        for (const item of message.reasoningItems) {
            if ((item?.afterText === true) !== (phase === 'after')) continue;
            // Collector shape contract: the WS/HTTP stream collectors store
            // retained items as {id, encrypted_content, summary} WITHOUT a
            // type tag (openai-ws-stream pushReasoningItem). Requiring
            // type:'reasoning' here silently dropped every retained item, so
            // replay never actually fired. Accept untagged items; only an
            // explicit non-reasoning tag is rejected.
            if (!item || (item.type != null && item.type !== 'reasoning')) continue;
            if (typeof item.encrypted_content !== 'string' || !item.encrypted_content) continue;
            out.push({
                type: 'reasoning',
                ...(typeof item.id === 'string' && item.id ? { id: item.id } : {}),
                encrypted_content: item.encrypted_content,
                summary: Array.isArray(item.summary) ? item.summary : [],
            });
        }
    };
    const flushToolMedia = () => {
        if (!pendingToolMedia.length) return;
        out.push(wireMessage('user', pendingToolMedia.splice(0)));
    };
    for (const m of messages) {
        if (!m || m.role === 'system') continue;
        const changedEffort = opts.effortProjection?.updates.get(m);
        if (changedEffort) {
            flushToolMedia();
            out.push({ type: 'configuration_update', reasoning: { effort: changedEffort } });
        }
        if (m.role === 'tool') {
            const { output, mediaContent } = splitToolContentForOpenAIResponses(m.content);
            if (customToolCallNameById.has(m.toolCallId || '')) {
                out.push({
                    type: 'custom_tool_call_output',
                    call_id: m.toolCallId || '',
                    name: customToolCallNameById.get(m.toolCallId || '') || undefined,
                    output,
                });
                if (mediaContent) pendingToolMedia.push(...mediaContent);
                continue;
            }
            const nativeSearchOutput = nativeToolSearchOutputInput(
                m,
                opts.nativeToolSearchProvider || 'openai-oauth',
            );
            if (nativeSearchOutput) {
                out.push(nativeSearchOutput);
                if (mediaContent) pendingToolMedia.push(...mediaContent);
                continue;
            }
            out.push({
                type: 'function_call_output',
                call_id: m.toolCallId || '',
                output,
            });
            if (mediaContent) pendingToolMedia.push(...mediaContent);
            continue;
        }
        flushToolMedia();
        // Preserve original assistant phases and item order even when encrypted
        // reasoning is explicitly disabled. Never replay another provider's data.
        const orderedReplay = m.role === 'assistant'
            ? providerReplayItems(m, 'openai-responses')
                ?.filter((item) => replayEncryptedReasoning || item?.type !== 'reasoning')
            : undefined;
        if (orderedReplay?.length) {
            for (const item of orderedReplay) {
                if (item?.type === 'custom_tool_call' && item.call_id) {
                    customToolCallNameById.set(item.call_id, item.name || '');
                }
                out.push(item);
            }
            continue;
        }
        pushReasoningItems(m, 'before');
        if (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length) {
            // Legacy sessions may have only flattened messages and reasoning.
            if (m.content) out.push(wireMessage('assistant', normalizeContentForOpenAIResponses(m.content, { role: 'assistant' }), m.phase));
            pushReasoningItems(m, 'after');
            for (const tc of m.toolCalls) {
                const nativeSearchCall = nativeToolSearchCallInput(tc);
                if (nativeSearchCall) {
                    out.push(nativeSearchCall);
                } else if (isCustomToolCallRecord(tc)) {
                    if (tc.id) customToolCallNameById.set(tc.id, tc.name || '');
                    out.push({
                        type: 'custom_tool_call',
                        call_id: tc.id,
                        name: tc.name,
                        input: customToolInputFromArguments(tc.name, tc.arguments),
                    });
                } else {
                    out.push({
                        type: 'function_call',
                        call_id: tc.id,
                        name: tc.name === 'tool_search' ? 'load_tool' : tc.name,
                        arguments: JSON.stringify(tc.arguments),
                    });
                }
            }
            continue;
        }
        out.push(wireMessage(
            m.role === 'assistant' ? 'assistant' : 'user',
            normalizeContentForOpenAIResponses(m.content, { role: m.role }),
            m.phase,
        ));
        pushReasoningItems(m, 'after');
    }
    flushToolMedia();
    // Wire-level pairing guard: replay envelopes can carry a call whose
    // result never committed (cancel/abort). The provider hard-rejects the
    // unpaired call, so synthesize the missing outputs here.
    return ensureResponsesCallOutputs(out);
}
