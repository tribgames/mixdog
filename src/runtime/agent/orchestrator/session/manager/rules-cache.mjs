// Prompt-layer rules builders. Source revision tracking lives separately so
// every layer observes deletions, replacements and timestamp rollbacks alike.
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { resolvePluginData, mixdogRoot } from '../../../../shared/plugin-paths.mjs';
import { createRulesSourceCache } from './rules-source-cache.mjs';
import {
  AGENT_MODE_DELEGATION,
  MIXY_CONTACTS_INTRO,
  orchestrationInstructions,
} from '../../runtime-core/orchestration.mjs';

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

export function _buildSharedRules({ omitTools = [], allowTools = null, ownerIsAgent = false } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  const RULES_DIR = join(PLUGIN_ROOT, 'rules');
  return buildCachedRules(
    'buildSharedToolContent',
    'shared tool rules',
    [join(RULES_DIR, 'shared')],
    { PLUGIN_ROOT, DATA_DIR: resolvePluginData(), omitTools, allowTools, ownerIsAgent },
    JSON.stringify([
      omitToolsKey(omitTools),
      Array.isArray(allowTools) ? omitToolsKey(allowTools) : null,
      ownerIsAgent === true,
    ])
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

// BP1 = shared tool policy followed by this route's rules. Every site that
// renders or re-identifies the BP1 block must use this one composition.
export function _buildBaseRules({
  provider = null,
  model = null,
  omitTools = [],
  allowTools = null,
  ownerIsAgent = false,
} = {}) {
  return [
    _buildSharedRules({ omitTools, allowTools, ownerIsAgent }),
    _buildRouteRules({ provider, model, omitTools, allowTools }),
  ]
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

// One `part` of LEAD.md (rules-builder buildLeadRoleContent): 'common' (the
// lines every Lead shares), 'coding' / 'agent' (the mode-variant passages),
// 'identity' (the coding identity sentence).
export function _buildLeadRules({ includeLeadBrief = true, part = 'common' } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  const DATA_DIR = resolvePluginData();
  const RULES_DIR = join(PLUGIN_ROOT, 'rules');
  const variant = includeLeadBrief ? 'delegating' : 'delegation-free';
  return buildCachedRules(
    'buildLeadRoleContent',
    'lead role rules',
    [join(RULES_DIR, 'lead'), join(DATA_DIR, 'mixdog-config.json')],
    { PLUGIN_ROOT, DATA_DIR, includeLeadBrief, part },
    `${variant}\n${part}`
  );
}

// One agent-mode rule file (rules/agent-mode): 'conduct' or 'mixy'.
export function _buildAgentModeRules({ part = 'conduct' } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  return buildCachedRules(
    'buildAgentModeContent',
    'agent mode rules',
    [join(PLUGIN_ROOT, 'rules', 'agent-mode')],
    { PLUGIN_ROOT, part },
    part
  );
}

// --- Rules revision ---
// The shipped rule texts a bot thread's prompt embeds — the shared tool
// policy (canonical variant), every LEAD.md part, the agent-mode files and
// the orchestration/delegation texts — as one hash. A bot thread stamps it
// at creation; another value (a release changed a rule) rebuilds its prompt
// once (session-runtime/tool-policy-refresh.mjs). Built from the cached
// builders, so a check costs a few stats.
export function promptRulesRevision() {
  const hash = createHash('sha256');
  const texts = [
    _buildSharedRules(),
    ...['common', 'coding', 'agent', 'identity'].flatMap((part) =>
      [true, false].map((includeLeadBrief) => _buildLeadRules({ includeLeadBrief, part }))
    ),
    _buildAgentModeRules({ part: 'conduct' }),
    _buildAgentModeRules({ part: 'mixy' }),
    AGENT_MODE_DELEGATION,
    MIXY_CONTACTS_INTRO,
    ...['none', 'focused', 'balanced', 'swarm'].map(orchestrationInstructions),
  ];
  for (const text of texts) hash.update(`${text}\0`);
  return hash.digest('hex').slice(0, 24);
}

export function _buildLeadMetaContext({ includeOutputStyle = true } = {}) {
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
    { PLUGIN_ROOT, DATA_DIR, includeOutputStyle },
    includeOutputStyle ? 'style' : 'no-style'
  );
}

// Trailing BP3 block: the configured response language. Kept out of BP2 so
// it is the last instruction before the conversation (see
// rules-builder.cjs buildLeadLanguageContent).
// The configured response language as {id, name}, or null (a rule's `language`
// condition compares the id; its text's {language} is the name).
export function _buildLeadLanguage() {
  const DATA_DIR = resolvePluginData();
  return buildCachedRules('buildLeadLanguage', 'lead language', [join(DATA_DIR, 'mixdog-config.json')], {
    DATA_DIR,
  });
}

export function _buildLeadLanguageContext({ includeOutputStyle = true } = {}) {
  const PLUGIN_ROOT = mixdogRoot();
  const DATA_DIR = resolvePluginData();
  return buildCachedRules(
    'buildLeadLanguageContent',
    'lead language context',
    [join(DATA_DIR, 'mixdog-config.json'), join(PLUGIN_ROOT, 'output-styles'), join(DATA_DIR, 'output-styles')],
    { PLUGIN_ROOT, DATA_DIR, includeOutputStyle },
    includeOutputStyle ? 'style' : 'no-style'
  );
}
