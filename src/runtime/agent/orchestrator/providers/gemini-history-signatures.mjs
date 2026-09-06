const SYNTHETIC_TOOL_SIGNATURE = 'skip_thought_signature_validator';

// Gemini 3 validates the first functionCall in every step of the current turn.
// Foreign/interrupted histories may not have a native signature for that call.
// Preserve real signatures and unsigned siblings of a signed parallel batch.
export function ensureGeminiToolCallSignatures(contents, model) {
    if (!/^(?:models\/)?gemini-3(?:[.-]|$)/i.test(String(model || ''))) return contents;
    let activeTurnStart = 0;
    for (let index = contents.length - 1; index >= 0; index -= 1) {
        const content = contents[index];
        if (content?.role === 'user'
            && content.parts?.some(part => part && !part.functionResponse)
            && !content.parts?.some(part => part?.functionResponse)) {
            activeTurnStart = index;
            break;
        }
    }
    return contents.map((content, index) => {
        if (index < activeTurnStart || content?.role !== 'model' || !Array.isArray(content.parts)) return content;
        const callIndex = content.parts.findIndex(part => part?.functionCall);
        if (callIndex < 0) return content;
        const firstCall = content.parts[callIndex];
        if ([firstCall.thoughtSignature, firstCall.thought_signature]
            .some(signature => typeof signature === 'string' && signature.length > 0)) return content;
        const parts = content.parts.slice();
        parts[callIndex] = { ...firstCall, thoughtSignature: SYNTHETIC_TOOL_SIGNATURE };
        return { ...content, parts };
    });
}
