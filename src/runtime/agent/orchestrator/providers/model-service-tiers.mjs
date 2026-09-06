// Service-tier capability comes from the provider catalog, never the model id.
// UI speed labels (for example "fast") are not interchangeable with wire tiers
// (OpenAI OAuth accepts "priority", not "fast").
export function modelSupportsServiceTier(model, serviceTier) {
    if (!serviceTier || !model || typeof model !== 'object') return false;
    const tiers = Array.isArray(model.serviceTiers) ? model.serviceTiers : [];
    const speedTiers = Array.isArray(model.additionalSpeedTiers) ? model.additionalSpeedTiers : [];
    return tiers.some(tier => tier?.id === serviceTier)
        || speedTiers.includes(serviceTier)
        || model.defaultServiceTier === serviceTier;
}
