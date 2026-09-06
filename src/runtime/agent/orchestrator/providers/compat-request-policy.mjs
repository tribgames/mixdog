// Shared request controls for Chat Completions and Responses gateways.
export function applyCompatToolChoice(body, opts = {}) {
    if (body.tools?.length && opts.toolChoice === 'none') body.tool_choice = 'none';
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
