'use strict';

/**
 * mixdog rules builder.
 *
 * Exported surfaces:
 *   - buildSharedToolContent            — BP1: shared tool policy
 *   - buildLeadRoleContent              — BP3: Lead role/system rules
 *   - buildAgentRoleContent             — BP3: agent role/system rules
 *   - buildAgentRetrievalInjectionContent — BP3: narrow read-only retrieval role
 *   - buildLeadMetaContent              — BP2: Lead profile/settings context
 *   - buildInjectionContent             — legacy joined Lead session content
 *
 * 4-BP cache layout (composeSystemPrompt):
 *   BP1 = shared tool policy
 *   BP2 = profile/settings + compact skills + deferred/MCP catalog
 *   BP3 = workflow/role + memory + session/project environment
 *   BP4 = live user/task messages and compacted tail
 *
 * Source files (rules/):
 *   - shared/01-tool.md              — universal tool policy (Lead + agent BP1, identical full set)
 *   - lead/lead-tool.md             — Lead-specific control-tower / delegation / ToolSearch guidance
 *   - lead/lead-brief.md            — Lead brief contract (delegating workflows only)
 *   - lead/01-general.md             — Lead general
 *   - output-styles/<name>.md        — Lead output style, selected by config outputStyle
 *   - agent/00-core.md               — universal agent constraints (BP3, all profiles)
 *   - agent/00-common.md             — public-agent-only extras (BP3 full profile)
 *   - agent/10..50-*.md              — per-hidden-agent bodies (consumed by loadScopedRoleInstructions)
 *
 * Core memory snapshot is injected separately from the memory worker (pgdata)
 * (Lead only).
 */

const fs = require('fs');
const path = require('path');

/**
 * Read a single section from mixdog-config.json (unified config).
 *
 * @param {string} dataDir  — DATA_DIR passed into build* functions
 * @param {string} section  — top-level key ('memory' | 'search' | …)
 * @returns {object}
 */
function readConfigSection(dataDir, section) {
  try {
    const unified = JSON.parse(fs.readFileSync(path.join(dataDir, 'mixdog-config.json'), 'utf8'));
    if (unified && typeof unified === 'object') return unified[section] || {};
  } catch {}
  return {};
}

function readOptional(filePath) {
  try { return fs.readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
}

function readUnifiedConfig(dataDir) {
  try {
    const unified = JSON.parse(fs.readFileSync(path.join(dataDir, 'mixdog-config.json'), 'utf8'));
    return unified && typeof unified === 'object' ? unified : {};
  } catch {}
  return {};
}

function readAgentConfig(dataDir) {
  const unified = readUnifiedConfig(dataDir);
  return unified.agent && typeof unified.agent === 'object' ? unified.agent : unified;
}

const PROFILE_LANGUAGE_PROMPTS = Object.freeze({
  en: 'English',
  ko: 'Korean',
  ja: 'Japanese (日本語)',
  'zh-Hans': 'Simplified Chinese (简体中文)',
  'zh-Hant': 'Traditional Chinese (繁體中文)',
  es: 'Spanish (Español)',
  fr: 'French (Français)',
  de: 'German (Deutsch)',
  pt: 'Portuguese (Português)',
  ru: 'Russian (Русский)',
  it: 'Italian (Italiano)',
  vi: 'Vietnamese (Tiếng Việt)',
  th: 'Thai (ภาษาไทย)',
  id: 'Indonesian (Bahasa Indonesia)',
  hi: 'Hindi (हिन्दी)',
  ar: 'Arabic (العربية)',
  tr: 'Turkish (Türkçe)',
  pl: 'Polish (Polski)',
  nl: 'Dutch (Nederlands)',
  uk: 'Ukrainian (Українська)',
});

const PROFILE_TITLE_MAX = 64;

function normalizeProfileConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const title = String(raw.title ?? raw.name ?? '').trim().slice(0, PROFILE_TITLE_MAX);
  const requested = String(raw.language ?? raw.lang ?? 'system').trim();
  const language = requested === 'system' || PROFILE_LANGUAGE_PROMPTS[requested] ? requested : 'system';
  return { title, language };
}

function systemLocaleId(locale) {
  let parsed = null;
  try { parsed = new Intl.Locale(locale || ''); } catch {}
  const language = parsed?.language || String(locale || '').split(/[-_]/)[0] || '';
  if (language === 'zh') {
    const script = parsed?.script;
    const region = parsed?.region;
    return script === 'Hant' || ['HK', 'MO', 'TW'].includes(region) ? 'zh-Hant' : 'zh-Hans';
  }
  return PROFILE_LANGUAGE_PROMPTS[language] ? language : null;
}

function profileLanguagePrompt(language) {
  const selected = String(language || 'system');
  if (selected !== 'system') {
    return PROFILE_LANGUAGE_PROMPTS[selected]
      ? { prompt: PROFILE_LANGUAGE_PROMPTS[selected], source: 'profile', locale: null }
      : null;
  }
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
  const id = systemLocaleId(locale);
  if (!id || !PROFILE_LANGUAGE_PROMPTS[id]) return null;
  return { prompt: PROFILE_LANGUAGE_PROMPTS[id], source: 'system-locale', locale };
}

function buildProfilePreferencesContent(dataDir) {
  const profile = normalizeProfileConfig(readAgentConfig(dataDir).profile);
  const lines = [];
  if (profile.title) {
    lines.push(`- User title: ${profile.title}.`);
    lines.push(`- Use "${profile.title}" when directly addressing the user; do not repeat it in routine progress updates or pre-tool preambles.`);
  }
  return `# Profile Preferences${lines.length ? `\n\n${lines.join('\n')}` : ''}`;
}

function buildLanguageSection(dataDir) {
  const profile = normalizeProfileConfig(readAgentConfig(dataDir).profile);
  const language = profileLanguagePrompt(profile.language);
  if (!language?.prompt) return '';
  const source = language.source === 'system-locale' && language.locale
    ? ` from system locale ${language.locale}`
    : '';
  const lines = [
    `- Default user-facing language${source}: ${language.prompt}. Use it for all user-facing text (preambles, progress, questions, reports, notices), overriding output style; switch only when the user does or asks.`,
    `- Keep code identifiers, paths, commands, symbols, API names, and exact errors in original form.`,
  ];
  return `# Language\n\n${lines.join('\n')}`;
}

function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();
}

const SEARCH_ROUTE_RE = /web\/current→`search`;\s*returned URL body→`web_fetch`;\s*/g;
const RECALL_ROUTE_RE = /prior work→`recall`\s*\(history only, never current local state\);\s*/g;
const MEMORY_ROUTE_RE = /durable compact English memory→`memory`;\s*/g;

function omitKeySet(omitTools) {
  return new Set((Array.isArray(omitTools) ? omitTools : []).map((name) => String(name || '').toLowerCase()).filter(Boolean));
}

/** Drop routing clauses for tools that are not on the session surface. */
function omitToolRoutes(text, omitTools = []) {
  const deny = omitKeySet(omitTools);
  let out = String(text || '');
  if (deny.has('search') || deny.has('web_fetch')) out = out.replace(SEARCH_ROUTE_RE, '');
  if (deny.has('recall')) out = out.replace(RECALL_ROUTE_RE, '');
  if (deny.has('memory')) out = out.replace(MEMORY_ROUTE_RE, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

function normalizeOutputStyleName(value) {
  const name = String(value || 'simple').trim();
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : 'simple';
}

function loadOutputStyle({ PLUGIN_ROOT, DATA_DIR }) {
  const config = readUnifiedConfig(DATA_DIR);
  const configured = config.outputStyle || (config.agent && config.agent.outputStyle);
  const styleName = normalizeOutputStyleName(configured);
  const candidates = [
    path.join(DATA_DIR, 'output-styles', `${styleName}.md`),
    path.join(PLUGIN_ROOT, 'output-styles', `${styleName}.md`),
  ];
  for (const candidate of candidates) {
    const body = stripFrontmatter(readOptional(candidate));
    if (body) return body;
  }
  if (styleName !== 'simple') {
    const fallback = [
      path.join(DATA_DIR, 'output-styles', 'simple.md'),
      path.join(PLUGIN_ROOT, 'output-styles', 'simple.md'),
    ];
    for (const candidate of fallback) {
      const body = stripFrontmatter(readOptional(candidate));
      if (body) return body;
    }
  }
  return '';
}

function buildSharedToolContent({ PLUGIN_ROOT, omitTools = [] } = {}) {
  const SHARED_DIR = path.join(PLUGIN_ROOT, 'rules', 'shared');
  return omitToolRoutes(readOptional(path.join(SHARED_DIR, '01-tool.md')), omitTools);
}

function buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR, includeLeadBrief = true }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const general = readOptional(path.join(LEAD_DIR, '01-general.md'));
  const parts = [];

  const toolLead = readOptional(path.join(LEAD_DIR, 'lead-tool.md'));
  if (toolLead) parts.push(toolLead);

  if (includeLeadBrief) {
    const briefLead = readOptional(path.join(LEAD_DIR, 'lead-brief.md'));
    if (briefLead) parts.push(briefLead);
  }

  if (general) parts.push(general);

  return parts.join('\n\n');
}

function buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const parts = [];

  const profilePreferences = buildProfilePreferencesContent(DATA_DIR);
  if (profilePreferences) parts.push(profilePreferences);

  const languageSection = buildLanguageSection(DATA_DIR);
  if (languageSection) parts.push(languageSection);

  // Common instructions (renamed from user-workflow.md; legacy file still
  // honored so existing installs keep their guidance without migration).
  const commonInstructionsMd = readOptional(path.join(DATA_DIR, 'instructions.md'))
    || readOptional(path.join(DATA_DIR, 'user-workflow.md'));
  if (commonInstructionsMd) parts.push(`# Common Instructions\n\n${commonInstructionsMd}`);

  const outputStyle = loadOutputStyle({ PLUGIN_ROOT, DATA_DIR });
  if (outputStyle) parts.push(outputStyle);

  return parts.join('\n\n');
}

/**
 * Build the Lead injection content.
 */
function buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const parts = [];

  const tool = buildSharedToolContent({ PLUGIN_ROOT, DATA_DIR });
  if (tool) parts.push(tool);

  const role = buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR });
  if (role) parts.push(role);

  const meta = buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR });
  if (meta) parts.push(meta);

  return parts.join('\n\n');
}

/**
 * Legacy joined agent injection. New sessions consume shared tool policy as
 * BP1 and buildAgentRoleContent() as BP3; this export remains for older smoke
 * tests / callers that expect the combined shape.
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT
 * @param {string} opts.DATA_DIR
 * @returns {string}
 */
function buildAgentInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const parts = [];

  const tool = buildSharedToolContent({ PLUGIN_ROOT, DATA_DIR });
  if (tool) parts.push(tool);

  const role = buildAgentRoleContent({ PLUGIN_ROOT, DATA_DIR });
  if (role) parts.push(role);

  return parts.join('\n\n');
}

function buildAgentRoleContent({ PLUGIN_ROOT, profile = 'full' }) {
  const AGENT_DIR = path.join(PLUGIN_ROOT, 'rules', 'agent');
  if (String(profile || 'full') === 'retrieval') {
    return buildAgentRetrievalInjectionContent({ PLUGIN_ROOT });
  }
  const core = readOptional(path.join(AGENT_DIR, '00-core.md'));
  const common = readOptional(path.join(AGENT_DIR, '00-common.md'));
  return [core, common].filter(Boolean).join('\n\n');
}

/**
 * BP2 role rules for narrow hidden retrieval roles. These roles already carry a separate
 * read-only tool schema shard, so keeping the full agent worker prefix does
 * not improve cross-role cache reuse and only adds unrelated shell/edit/git
 * guidance.
 *
 * @returns {string}
 */
function buildAgentRetrievalInjectionContent({ PLUGIN_ROOT }) {
  const AGENT_DIR = path.join(PLUGIN_ROOT, 'rules', 'agent');
  const core = readOptional(path.join(AGENT_DIR, '00-core.md'));
  // Full shared tool policy (01-tool.md) now ships via BP1 for retrieval
  // roles too; no compact duplicate here.
  const parts = [];
  if (core) parts.push(core.trim());
  parts.push('', '- Read-only retrieval role: do not edit files, run shell, or use git.');
  return parts.join('\n');
}

module.exports = {
  buildSharedToolContent,
  buildLeadRoleContent,
  buildLeadMetaContent,
  buildAgentRoleContent,
  buildInjectionContent,
  buildAgentInjectionContent,
  buildAgentRetrievalInjectionContent,
  omitToolRoutes,
};
