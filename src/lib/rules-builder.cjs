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
 *   - shared/*.md                    — ordered universal policies (Lead + agent BP1, identical full set)
 *   - lead/lead-tool.md             — Lead-specific control-tower / delegation / ToolSearch guidance
 *   - lead/lead-brief.md            — Lead brief contract (delegating workflows only)
 *   - lead/01-general.md             — Lead general
 *   - lead/02-persona.md             — Lead communication personality
 *   - output-styles/common.md        — shared built-in output composition policy
 *   - output-styles/<name>.md        — selected built-in depth variant or standalone user style
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

function readMarkdownDirectory(dirPath) {
  try {
    return fs.readdirSync(dirPath)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => readOptional(path.join(dirPath, name)))
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
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
const PROFILE_EXPERIENCE_LEVELS = Object.freeze({
  beginner: {
    label: 'Beginner',
    prompt: 'Assume no development background; briefly explain only the terms and prerequisites needed to understand the answer.',
  },
  'vibe-coder': {
    label: 'Vibe coder',
    prompt: 'Lead with what the result does and how to use it; briefly unpack implementation jargon when it is needed for understanding.',
  },
  junior: {
    label: 'Junior',
    prompt: 'Assume basic development knowledge; make otherwise implicit connections clear when they are needed for easy understanding.',
  },
  expert: {
    label: 'Expert',
    prompt: 'Do not unnecessarily unpack familiar basics, but preserve the explanations needed for accurate understanding and judgment. Use familiar technical terminology naturally.',
  },
});

function normalizeProfileConfig(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const title = String(raw.title ?? raw.name ?? '').trim().slice(0, PROFILE_TITLE_MAX);
  const requested = String(raw.language ?? raw.lang ?? 'system').trim();
  const language = requested === 'system' || PROFILE_LANGUAGE_PROMPTS[requested] ? requested : 'system';
  const requestedExperienceLevel = String(raw.experienceLevel ?? '')
    .trim().toLowerCase().replace(/[\s_]+/g, '-');
  const experienceLevel = Object.prototype.hasOwnProperty.call(PROFILE_EXPERIENCE_LEVELS, requestedExperienceLevel)
    ? requestedExperienceLevel
    : '';
  return { title, language, experienceLevel };
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
  const experience = PROFILE_EXPERIENCE_LEVELS[profile.experienceLevel];
  if (experience) {
    lines.push(`- Development experience: ${experience.label}. ${experience.prompt}`);
    lines.push('- Adapt vocabulary and assumed background to this level without adding lessons, examples, or tips unless the task needs them; output style still controls information depth.');
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

const WEB_SEARCH_ROUTE_RE = /^[ \t]*current or external information discovery→`web_search`;[ \t]*\r?\n?/gm;
const WEB_FETCH_ROUTE_RE = /^[ \t]*page or documentation body retrieval from a known URL→`web_fetch`\.[ \t]*\r?\n?/gm;
const RECALL_ROUTE_RE = /^-[ \t]*past facts recorded in prior work or sessions→`recall`[ \t]*\r?\n[ \t]*\(stored history only, never current local state\)\.[ \t]*\r?\n?/gm;
const MEMORY_ROUTE_RE = /^-[ \t]*Durable memory creation or update→`memory`; store a compact English[ \t]*\r?\n[ \t]*statement\.[\s\S]*$/m;
const EMPTY_RESEARCH_RE = /^# Research[ \t]*\r?\n(?:[ \t]*\r?\n)*-[ \t]*Research routes:[ \t]*\r?\n?/gm;
const EMPTY_MEMORY_RE = /^# Memory[ \t]*\r?\n(?:[ \t]*\r?\n)*/gm;

function omitKeySet(omitTools) {
  return new Set((Array.isArray(omitTools) ? omitTools : []).map((name) => String(name || '').toLowerCase()).filter(Boolean));
}

/** Drop routing clauses for tools that are not on the session surface. */
function omitToolRoutes(text, omitTools = []) {
  const deny = omitKeySet(omitTools);
  let out = String(text || '');
  if (deny.has('web_search')) out = out.replace(WEB_SEARCH_ROUTE_RE, '');
  if (deny.has('web_fetch')) out = out.replace(WEB_FETCH_ROUTE_RE, '');
  if (deny.has('recall')) out = out.replace(RECALL_ROUTE_RE, '');
  if (deny.has('memory')) out = out.replace(MEMORY_ROUTE_RE, '');
  if (deny.has('web_search') && deny.has('web_fetch')) {
    out = out.replace(EMPTY_RESEARCH_RE, '');
  }
  if (deny.has('recall') && deny.has('memory')) out = out.replace(EMPTY_MEMORY_RE, '');
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
}

const DEFAULT_OUTPUT_STYLE_ID = 'simple';
const OUTPUT_STYLE_ORDER = ['detailed', 'simple', 'minimal', 'extreme-minimal'];
const OUTPUT_STYLE_ALIASES = new Map([
  ['extreme', 'extreme-minimal'],
  ['extremesimple', 'extreme-minimal'],
  ['extreme-simple', 'extreme-minimal'],
  ['extreme_simple', 'extreme-minimal'],
  ['extrememinimal', 'extreme-minimal'],
  ['extreme_minimal', 'extreme-minimal'],
  ['mono', 'extreme-minimal'],
  ['oneline', 'extreme-minimal'],
  ['one-line', 'extreme-minimal'],
  ['one_line', 'extreme-minimal'],
]);

function normalizeOutputStyleId(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  const slug = raw.replace(/[_\s]+/g, '-').replace(/^-+|-+$/g, '');
  const compact = slug.replace(/[_.-]+/g, '');
  if (OUTPUT_STYLE_ALIASES.has(slug)) return OUTPUT_STYLE_ALIASES.get(slug);
  if (OUTPUT_STYLE_ALIASES.has(compact)) return OUTPUT_STYLE_ALIASES.get(compact);
  return /^[a-z0-9.-]+$/.test(slug) ? slug : '';
}

function outputStyleCompactKey(value) {
  return normalizeOutputStyleId(value).replace(/[_.-]+/g, '');
}

function titleCaseOutputStyle(id) {
  return String(id || '')
    .split(/[_.-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ') || 'Default';
}

function parseOutputStyleFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (!kv) continue;
    meta[kv[1]] = kv[2].replace(/^['"]|['"]$/g, '').trim();
  }
  return meta;
}

function outputStyleFlag(value, fallback) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  if (/^(?:true|1|yes|on)$/.test(raw)) return true;
  if (/^(?:false|0|no|off)$/.test(raw)) return false;
  return fallback;
}

function readOutputStyleEntry(filePath, source) {
  const raw = readOptional(filePath);
  if (!raw) return null;
  const meta = parseOutputStyleFrontmatter(raw);
  if (/^(?:true|1|yes)$/i.test(String(meta.partial || '').trim())) return null;
  const fileId = normalizeOutputStyleId(path.basename(filePath).replace(/\.md$/i, ''));
  const id = normalizeOutputStyleId(meta.name) || fileId;
  if (!id) return null;
  return {
    id,
    label: String(meta.title || meta.label || '').trim() || titleCaseOutputStyle(id),
    aliases: String(meta.aliases || '').split(',')
      .map((alias) => normalizeOutputStyleId(alias))
      .filter(Boolean),
    // Built-in and custom styles both inherit the shared format partial; a
    // style opts out only by declaring `keep-shared-format: false`.
    keepSharedFormat: outputStyleFlag(meta['keep-shared-format'], true),
    source,
    raw,
  };
}

function listOutputStyleEntries({ PLUGIN_ROOT, DATA_DIR }) {
  const byId = new Map();
  for (const { dir, source } of [
    { dir: path.join(PLUGIN_ROOT, 'output-styles'), source: 'builtin' },
    { dir: path.join(DATA_DIR, 'output-styles'), source: 'user' },
  ]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')).sort(); } catch {}
    for (const name of files) {
      const style = readOutputStyleEntry(path.join(dir, name), source);
      if (style) byId.set(style.id, style);
    }
  }
  return [...byId.values()].sort((a, b) => {
    const ai = OUTPUT_STYLE_ORDER.indexOf(a.id);
    const bi = OUTPUT_STYLE_ORDER.indexOf(b.id);
    if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
    return a.label.localeCompare(b.label, 'en', { sensitivity: 'base' });
  });
}

function findOutputStyleEntry(value, styles) {
  const id = normalizeOutputStyleId(value);
  const compact = outputStyleCompactKey(value);
  if (!id && !compact) return null;
  return styles.find((style) => {
    if (style.id === id || outputStyleCompactKey(style.id) === compact) return true;
    if (outputStyleCompactKey(style.label) === compact) return true;
    return style.aliases.some((alias) => alias === id || outputStyleCompactKey(alias) === compact);
  }) || null;
}

/** Shared format partial: a user copy in DATA_DIR overrides the built-in one. */
function readSharedFormatPartial({ PLUGIN_ROOT, DATA_DIR }) {
  return stripFrontmatter(readOptional(path.join(DATA_DIR, 'output-styles', 'common.md')))
    || stripFrontmatter(readOptional(path.join(PLUGIN_ROOT, 'output-styles', 'common.md')));
}

function loadOutputStyle({ PLUGIN_ROOT, DATA_DIR }) {
  // Root `outputStyle` is the only configured location; the retired
  // `agent.outputStyle` key is dropped by config canonicalization.
  const configured = String(readUnifiedConfig(DATA_DIR).outputStyle || '').trim() || DEFAULT_OUTPUT_STYLE_ID;
  const styles = listOutputStyleEntries({ PLUGIN_ROOT, DATA_DIR });
  const style = findOutputStyleEntry(configured, styles)
    || findOutputStyleEntry(DEFAULT_OUTPUT_STYLE_ID, styles)
    || styles[0];
  if (!style) return '';
  const selected = stripFrontmatter(style.raw);
  if (!selected) return '';
  const common = style.keepSharedFormat ? readSharedFormatPartial({ PLUGIN_ROOT, DATA_DIR }) : '';
  return [`# Output Style: ${style.label}`, common, selected].filter(Boolean).join('\n\n');
}

function buildSharedToolContent({ PLUGIN_ROOT, omitTools = [] } = {}) {
  const SHARED_DIR = path.join(PLUGIN_ROOT, 'rules', 'shared');
  return omitToolRoutes(readMarkdownDirectory(SHARED_DIR), omitTools);
}

function buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR, includeLeadBrief = true }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const general = readOptional(path.join(LEAD_DIR, '01-general.md'));
  const persona = readOptional(path.join(LEAD_DIR, '02-persona.md'));
  const parts = [];

  if (includeLeadBrief) {
    const briefLead = readOptional(path.join(LEAD_DIR, 'lead-brief.md'));
    if (briefLead) parts.push(briefLead);
  }

  if (general) parts.push(general);
  if (persona) parts.push(persona);

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
  // Full ordered shared policy now ships via BP1 for retrieval
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
