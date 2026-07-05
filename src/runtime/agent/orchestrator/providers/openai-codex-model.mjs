/**
 * OpenAI Codex OAuth model-catalog transforms.
 *
 * Extracted from openai-oauth.mjs: pure catalog helpers — API-shape
 * normalization, family classification, version comparison, and the
 * per-family "latest" pass. No module state; openai-oauth.mjs re-exports
 * _displayCodexModel for existing importers.
 */

// OAuth catalog returns dated ids (gpt-5.4-mini-2026-03-17). Strip the trailing
// -YYYY-MM-DD to get the version alias (gpt-5.4-mini). Unknown shapes pass
// through unchanged.
export function _displayCodexModel(id) {
    if (!id || typeof id !== 'string') return id;
    return id.replace(/-\d{4}-\d{2}-\d{2}$/, '');
}

function _positiveCodexContextWindow(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function _codexContextWindowFromApi(m) {
    return _positiveCodexContextWindow(m?.context_window)
        || _positiveCodexContextWindow(m?.max_context_window)
        || null;
}

export function _codexFamily(id) {
    const s = String(id || '').toLowerCase();
    if (s.includes('nano')) return 'gpt-nano';
    if (s.includes('mini')) return 'gpt-mini';
    if (s.includes('codex')) return 'gpt-codex';
    if (s.startsWith('gpt-5.5')) return 'gpt-5.5';
    if (s.startsWith('gpt-5.4')) return 'gpt-5.4';
    if (s.startsWith('gpt-5.2')) return 'gpt-5.2';
    if (s.startsWith('gpt-5')) return 'gpt-5';
    return 'gpt';
}

export function _normalizeCodexModel(m) {
    const id = m?.slug || m?.id;
    const family = _codexFamily(id);
    const serviceTiers = Array.isArray(m?.service_tiers)
        ? m.service_tiers
            .map(t => ({
                id: String(t?.id || '').trim(),
                name: String(t?.name || '').trim(),
                description: String(t?.description || '').trim(),
            }))
            .filter(t => t.id)
        : [];
    const additionalSpeedTiers = Array.isArray(m?.additional_speed_tiers)
        ? m.additional_speed_tiers.map(t => String(t || '').trim()).filter(Boolean)
        : [];
    // Catalog ids are version aliases without separate display dating.
    return {
        id,
        name: m?.display_name || id,
        display: m?.display_name || id,
        family,
        provider: 'openai-oauth',
        contextWindow: _codexContextWindowFromApi(m),
        maxContextWindow: _positiveCodexContextWindow(m?.max_context_window),
        outputTokens: m?.max_output_tokens || m?.output_tokens || 32768,
        autoCompactTokenLimit: m?.auto_compact_token_limit || null,
        effectiveContextWindowPercent: m?.effective_context_window_percent || null,
        tier: 'version',
        latest: false,
        description: m?.description || '',
        reasoningLevels: (m?.supported_reasoning_levels || []).map(r => r.effort),
        serviceTiers,
        defaultServiceTier: m?.default_service_tier || null,
        additionalSpeedTiers,
    };
}

// Compare two model ids by the X.Y version embedded in `gpt-X.Y`. Mirrors
// anthropic-oauth's _compareVersion; these ids have no trailing date so
// the version lives in the dotted number, not a -YYYY-MM-DD suffix.
export function _compareVersion(a, b) {
    const na = (String(a).match(/gpt-(\d+)\.(\d+)/) || []).slice(1).map(Number);
    const nb = (String(b).match(/gpt-(\d+)\.(\d+)/) || []).slice(1).map(Number);
    for (let i = 0; i < Math.max(na.length, nb.length); i++) {
        if ((na[i] || 0) !== (nb[i] || 0)) return (na[i] || 0) - (nb[i] || 0);
    }
    return String(a).localeCompare(String(b));
}

// Main gpt-5 chat family only: exclude the mini/nano/codex variants so "latest"
// resolves to the flagship, not a smaller sibling.
export function _isMainCodexFamily(family) {
    return typeof family === 'string' && family.startsWith('gpt-5');
}

// Mark the highest-version model per family as `latest: true`. VERSION-based
// (ids carry no `created`), mirroring anthropic-oauth's per-family pass.
export function _markLatestCodex(models) {
    const byFamily = new Map();
    for (const m of models) {
        if (!m?.id) continue;
        const cur = byFamily.get(m.family);
        if (!cur || _compareVersion(m.id, cur.id) > 0) {
            byFamily.set(m.family, m);
        }
    }
    for (const m of byFamily.values()) m.latest = true;
}
