// Prompt-layer rules builders + mtime-invalidated caches, extracted verbatim
// from manager.mjs. Behavior-preserving: same createRequire lookup, same cache
// semantics, same error messages.
import { createRequire } from 'module';
import { join } from 'path';
import { resolvePluginData, mixdogRoot } from '../../../../shared/plugin-paths.mjs';
import { maxMtimeRecursive } from '../../cache-mtime.mjs';
import { getAgentInstructionDir } from '../../internal-agents.mjs';

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

// BP1/BP2/BP3 prompt-layer caches — invalidated by source file mtime, not a
// timer. Cheap: O(sentinel-count) stat calls on each session creation, no file
// I/O when warm.
let _sharedRulesCache = null;
let _sharedRulesMtime = 0;
const _agentRulesCacheByProfile = new Map();
let _leadRulesCache = null;
let _leadRulesMtime = 0;
let _leadMetaCache = null;
let _leadMetaMtime = 0;

export function _buildSharedRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildSharedToolContent !== 'function') return '';
    const PLUGIN_ROOT = mixdogRoot();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
    ]);
    if (_sharedRulesCache !== null && mtime <= _sharedRulesMtime) {
        return _sharedRulesCache;
    }
    try {
        const built = _rulesBuilder.buildSharedToolContent({ PLUGIN_ROOT, DATA_DIR: resolvePluginData() });
        _sharedRulesCache = built;
        _sharedRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] shared tool rules build failed: ${e.message}`);
    }
}

export function _buildAgentRules(profile = 'full') {
    if (!_rulesBuilder || typeof _rulesBuilder.buildAgentRoleContent !== 'function') return '';
    const key = String(profile || 'full');
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'agent'),
        join(DATA_DIR, 'mixdog-config.json'),
    ]);
    const cached = _agentRulesCacheByProfile.get(key);
    if (cached && mtime <= cached.mtime) {
        return cached.value;
    }
    try {
        const built = _rulesBuilder.buildAgentRoleContent({ PLUGIN_ROOT, DATA_DIR, profile: key });
        _agentRulesCacheByProfile.set(key, { mtime, value: built });
        return built;
    } catch (e) {
        throw new Error(`[session] agent role rules build failed: ${e.message}`);
    }
}

export function _buildLeadRules() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildLeadRoleContent !== 'function') return '';
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'mixdog-config.json'),
    ]);
    if (_leadRulesCache !== null && mtime <= _leadRulesMtime) {
        return _leadRulesCache;
    }
    try {
        const built = _rulesBuilder.buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR });
        _leadRulesCache = built;
        _leadRulesMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] lead role rules build failed: ${e.message}`);
    }
}

export function _buildLeadMetaContext() {
    if (!_rulesBuilder || typeof _rulesBuilder.buildLeadMetaContent !== 'function') return '';
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'lead'),
        join(DATA_DIR, 'history'),
        join(DATA_DIR, 'mixdog-config.json'),
        join(DATA_DIR, 'user-workflow.md'),
        join(PLUGIN_ROOT, 'output-styles'),
        join(DATA_DIR, 'output-styles'),
    ]);
    if (_leadMetaCache !== null && mtime <= _leadMetaMtime) {
        return _leadMetaCache;
    }
    try {
        const built = _rulesBuilder.buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR });
        _leadMetaCache = built;
        _leadMetaMtime = mtime;
        return built;
    } catch (e) {
        throw new Error(`[session] lead meta context build failed: ${e.message}`);
    }
}

// BP4-adjacent agent-specific data cache — keyed by agent. webhook / schedule
// agents each have their own scoped instruction set; other agents return ''.
const _roleSpecificCache = new Map(); // agent → { value, mtime }
export function _buildAgentSpecific(currentAgent) {
    if (!_rulesBuilder || typeof _rulesBuilder.buildAgentRoleSpecificContent !== 'function') return '';
    if (!currentAgent) return '';
    const PLUGIN_ROOT = mixdogRoot();
    const DATA_DIR = resolvePluginData();
    const RULES_DIR = join(PLUGIN_ROOT, 'rules');
    const roleInstructionDir = getAgentInstructionDir(currentAgent);
    const mtime = maxMtimeRecursive([
        join(RULES_DIR, 'shared'),
        join(DATA_DIR, 'mixdog-config.json'),
        join(DATA_DIR, 'webhooks'),
        join(DATA_DIR, 'schedules'),
        ...(roleInstructionDir ? [join(DATA_DIR, roleInstructionDir)] : []),
        join(PLUGIN_ROOT, 'defaults', 'agents.json'),
    ]);
    const entry = _roleSpecificCache.get(currentAgent);
    if (entry && mtime <= entry.mtime) {
        return entry.value;
    }
    try {
        const built = _rulesBuilder.buildAgentRoleSpecificContent({ PLUGIN_ROOT, DATA_DIR, currentAgent });
        _roleSpecificCache.set(currentAgent, { mtime, value: built });
        return built;
    } catch (e) {
        throw new Error(`[session] agent-specific rules build failed (agent: ${currentAgent}): ${e.message}`);
    }
}
