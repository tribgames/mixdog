export const EXTENDED_CACHE_TTL_BETA_HEADER = 'extended-cache-ttl-2025-04-11';
export const INTERLEAVED_THINKING_BETA_HEADER = 'interleaved-thinking-2025-05-14';
export const FAST_MODE_BETA_HEADER = 'fast-mode-2026-02-01';

export function supportsAnthropicFastMode(model) {
    const id = String(model || '').toLowerCase().replace(/\./g, '-');
    return /^claude-opus-4-(6|7|8)(?:$|[-@])/.test(id);
}

export function buildAnthropicBetaHeaders({
    base = `${INTERLEAVED_THINKING_BETA_HEADER},${EXTENDED_CACHE_TTL_BETA_HEADER}`,
    fastMode = false,
} = {}) {
    const headers = String(base || '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    if (fastMode && !headers.includes(FAST_MODE_BETA_HEADER)) {
        headers.push(FAST_MODE_BETA_HEADER);
    }
    return headers.join(',');
}
