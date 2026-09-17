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
  const candidates = [join(mixdogRoot(), 'lib', 'rules-builder.cjs')].filter(Boolean);
  for (const p of candidates) {
    try {
      return _require(p);
    } catch {
      /* fall through */
    }
  }
  // Fallback: walk up from this file's location to find lib/rules-builder.cjs.
  try {
    return _require('../../../../../lib/rules-builder.cjs');
  } catch {
    return null;
  }
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
  return [
    ...new Set(
      (Array.isArray(omitTools) ? omitTools : []).map((name) => String(name || '').toLowerCase()).filter(Boolean)
    ),
  ]
    .sort()
    .join(',');
}

export function _buildSharedRules({ omitTools = [], allowTools = null } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  const RULES_DIR = join(PLUGIN_ROOT, 'rules');
  return buildCachedRules(
    'buildSharedToolContent',
    'shared tool rules',
    [join(RULES_DIR, 'shared')],
    { PLUGIN_ROOT, DATA_DIR: resolvePluginData(), omitTools, allowTools },
    JSON.stringify([omitToolsKey(omitTools), Array.isArray(allowTools) ? omitToolsKey(allowTools) : null])
  );
}

// Provider/model-bound rules (`rules/routes/*.md`, matched by frontmatter).
// Cached per route so a model switch renders its own variant.
export function _buildRouteRules({ provider = null, model = null, omitTools = [], allowTools = null } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  const RULES_DIR = join(PLUGIN_ROOT, 'rules');
  const providerKey = String(provider || '')
    .trim()
    .toLowerCase();
  const modelKey = String(model || '')
    .trim()
    .toLowerCase();
  return buildCachedRules(
    'buildRouteRulesContent',
    'route rules',
    [join(RULES_DIR, 'routes')],
    { PLUGIN_ROOT, provider: providerKey, model: modelKey, omitTools, allowTools },
    JSON.stringify([
      providerKey,
      modelKey,
      omitToolsKey(omitTools),
      Array.isArray(allowTools) ? omitToolsKey(allowTools) : null,
    ])
  );
}

function buildRouteLine(method, label, { provider = null, model = null } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  const providerKey = String(provider || '')
    .trim()
    .toLowerCase();
  const modelKey = String(model || '')
    .trim()
    .toLowerCase();
  return buildCachedRules(
    method,
    label,
    [join(PLUGIN_ROOT, 'rules', 'routes')],
    { PLUGIN_ROOT, provider: providerKey, model: modelKey },
    JSON.stringify([providerKey, modelKey])
  );
}

// The matching route's one-line runtime reminder (`round-reminder:`),
// appended after every tool round by the provider or the tool batch.
export function _buildRouteRoundReminder(route = {}) {
  return buildRouteLine('buildRouteRoundReminderContent', 'route round reminder', route);
}

// The matching route's one-line turn reminder (`turn-reminder:`), part of
// the user turn's trailing <system-reminder> block.
export function _buildRouteTurnReminder(route = {}) {
  return buildRouteLine('buildRouteTurnReminderContent', 'route turn reminder', route);
}

// BP1 = shared tool policy followed by this route's rules. Every site that
// renders or re-identifies the BP1 block must use this one composition.
export function _buildBaseRules({ provider = null, model = null, omitTools = [], allowTools = null } = {}) {
  return [_buildSharedRules({ omitTools, allowTools }), _buildRouteRules({ provider, model, omitTools, allowTools })]
    .filter(Boolean)
    .join('\n\n---\n\n');
}

export function _buildAgentRules(profile = 'full') {
  const key = String(profile || 'full');
  const PLUGIN_ROOT = mixdogRoot();
  const DATA_DIR = resolvePluginData();
  const RULES_DIR = join(PLUGIN_ROOT, 'rules');
  return buildCachedRules(
    'buildAgentRoleContent',
    'agent role rules',
    [join(RULES_DIR, 'agent'), join(DATA_DIR, 'mixdog-config.json')],
    { PLUGIN_ROOT, DATA_DIR, profile: key },
    key
  );
}

export function _buildLeadRules({ includeLeadBrief = true } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  const DATA_DIR = resolvePluginData();
  const RULES_DIR = join(PLUGIN_ROOT, 'rules');
  return buildCachedRules(
    'buildLeadRoleContent',
    'lead role rules',
    [join(RULES_DIR, 'lead'), join(DATA_DIR, 'mixdog-config.json')],
    { PLUGIN_ROOT, DATA_DIR, includeLeadBrief },
    includeLeadBrief ? 'delegating' : 'delegation-free'
  );
}

export function _buildLeadMetaContext() {
  const PLUGIN_ROOT = mixdogRoot();
  const DATA_DIR = resolvePluginData();
  const RULES_DIR = join(PLUGIN_ROOT, 'rules');
  return buildCachedRules(
    'buildLeadMetaContent',
    'lead meta context',
    [
      join(RULES_DIR, 'lead'),
      join(DATA_DIR, 'mixdog-config.json'),
      join(PLUGIN_ROOT, 'output-styles'),
      join(DATA_DIR, 'output-styles'),
    ],
    { PLUGIN_ROOT, DATA_DIR }
  );
}

// Trailing BP3 block: the configured response language. Kept out of BP2 so
// it is the last instruction before the conversation (see
// rules-builder.cjs buildLeadLanguageContent).
export function _buildLeadLanguageContext() {
  const DATA_DIR = resolvePluginData();
  return buildCachedRules('buildLeadLanguageContent', 'lead language context', [join(DATA_DIR, 'mixdog-config.json')], {
    DATA_DIR,
  });
}
