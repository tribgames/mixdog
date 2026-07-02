// Agent context-overflow error, extracted from loop.mjs. Raised when the latest
// turn cannot fit the target context budget even after compaction.

export class AgentContextOverflowError extends Error {
    constructor({ stage, sessionId, provider, model, contextWindow, budgetTokens, reserveTokens, messageTokensEst }, cause) {
        const target = [provider, model].filter(Boolean).join('/') || 'target model';
        const causeMsg = cause && cause.message ? `: ${cause.message}` : '';
        super(
            `agent context overflow (${target}, stage=${stage || 'compact'}): ` +
            `latest turn cannot fit target context budget=${budgetTokens ?? 'unknown'} ` +
            `reserve=${reserveTokens ?? 'unknown'} contextWindow=${contextWindow ?? 'unknown'} ` +
            `messageTokensEst=${messageTokensEst ?? 'unknown'}${causeMsg}`,
        );
        this.name = 'AgentContextOverflowError';
        this.code = 'AGENT_CONTEXT_OVERFLOW';
        this.sessionId = sessionId || null;
        this.provider = provider || null;
        this.model = model || null;
        this.contextWindow = contextWindow ?? null;
        this.budgetTokens = budgetTokens ?? null;
        this.reserveTokens = reserveTokens ?? null;
        this.messageTokensEst = messageTokensEst ?? null;
        if (cause) this.cause = cause;
    }
}

export function agentContextOverflowError({ stage, sessionId, sessionRef, model, budgetTokens, reserveTokens, messageTokensEst }, cause) {
    return new AgentContextOverflowError({
        stage,
        sessionId,
        provider: sessionRef?.provider || null,
        model: sessionRef?.model || model || null,
        contextWindow: sessionRef?.contextWindow ?? null,
        budgetTokens,
        reserveTokens,
        messageTokensEst,
    }, cause);
}
