// Prompt-layer rules builders. Source revision tracking lives separately so
// every layer observes deletions, replacements and timestamp rollbacks alike.
import { createRequire } from 'module';
import { join } from 'path';
import { resolvePluginData, mixdogRoot } from '../../../../shared/plugin-paths.mjs';
import { createRulesSourceCache } from './rules-source-cache.mjs';

// Phase B: Pool B Tier 2 content builder (common rules only).
// Loaded once per process via createRequire so the CJS module reaches us.
const _require = createRequire(import.meta.url);
const _rulesBuilder = (() => {
    const candidates = [
        join(mixdogRoot(), 'lib', 'rules-builder.cjs'),
    ].filter(Boolean);
    for (const p of candidates) {
        try { return _require(p); } catch { /* fall through */ }
    }
    // Fallback: walk up from this file's location to find lib/rules-builder.cjs.
    try { return _require('../../../../../lib/rules-builder.cjs'); } catch { return null; }
})();

const _ruleCaches = new Map();

function buildCachedRules(method, label, sources, options, variant = '') {
    if (!_rulesBuilder || typeof _rulesBuilder[method] !== 'function') return '';
    let cache = _ruleCaches.get(method);
    if (!cache) {
        cache = createRulesSourceCache();
        _ruleCaches.set(method, cache);
    }
    return cache(sources, variant, () => {
        try {
            return _rulesBuilder[method](options);
        } catch (e) {
            throw new Error(`[session] ${label} build failed: ${e.message}`);
        }
    });
}

function omitToolsKey(omitTools) {
    return [...new Set((Array.isArray(omitTools) ? omitTools : [])
        .map((name) => String(name || '').toLowerCase())
        .filter(Boolean))].sort().join(',');
}

export function _buildSharedRules({ omitTools = [] } = {}) {
    const PLUGIN_ROOT = mixdogRoot();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    return buildCachedRules('buildSharedToolContent', 'shared tool rules', [
        join(RULES_DIR, 'shared'),
    ], { PLUGIN_ROOT, DATA_DIR: resolvePluginData(), omitTools }, omitToolsKey(omitTools));
}

export function _buildAgentRules(profile = 'full') {
    const key = String(profile || 'full');
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    return buildCachedRules('buildAgentRoleContent', 'agent role rules', [
        join(RULES_DIR, 'agent'),
        join(DATA_DIR, 'mixdog-config.json'),
    ], { PLUGIN_ROOT, DATA_DIR, profile: key }, key);
}

export function _buildLeadRules({ includeLeadBrief = true } = {}) {
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    return buildCachedRules('buildLeadRoleContent', 'lead role rules', [
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'mixdog-config.json'),
    ], { PLUGIN_ROOT, DATA_DIR, includeLeadBrief }, includeLeadBrief ? 'delegating' : 'delegation-free');
}

export function _buildLeadMetaContext() {
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    return buildCachedRules('buildLeadMetaContent', 'lead meta context', [
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'mixdog-config.json'),
        join(DATA_DIR, 'instructions.md'),
        join(DATA_DIR, 'user-workflow.md'),
        join(PLUGIN_ROOT, 'output-styles'),
        join(DATA_DIR, 'output-styles'),
    ], { PLUGIN_ROOT, DATA_DIR });
}

// Trailing BP3 block: the configured response language. Kept out of BP2 so
// it is the last instruction before the conversation (see
// rules-builder.cjs buildLeadLanguageContent).
export function _buildLeadLanguageContext() {
    const DATA_DIR = resolvePluginData();
    return buildCachedRules('buildLeadLanguageContent', 'lead language context', [
        join(DATA_DIR, 'mixdog-config.json'),
    ], { DATA_DIR });
}
