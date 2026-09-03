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
const {
  DEFAULT_OUTPUT_STYLE_ID,
  matchOutputStyle,
  outputStyleMetaFromMarkdown,
  sortOutputStyles,
} = require('./output-style-meta.cjs');

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
  // No configured preference means no section: a bare heading would ship an
  // empty block to every model that has neither a title nor an experience level.
  return lines.length ? `# Profile Preferences\n\n${lines.join('\n')}` : '';
}

function buildLanguageSection(dataDir) {
  const profile = normalizeProfileConfig(readAgentConfig(dataDir).profile);
  const language = profileLanguagePrompt(profile.language);
  if (!language?.prompt) return '';
  const lines = [
    `- Always respond in ${language.prompt}. Use ${language.prompt} for all user-facing text: pre-tool preamble, progress updates, questions, reports, notices. This overrides output style. Code comments follow the file's existing language.`,
    `- English rules, tool results, and runtime/system tags never change the response language; write the preamble and progress lines in ${language.prompt} even when the text just before them is English.`,
    `- Preamble and reply language follow this setting and the user's latest instruction only; earlier lines in this conversation set no precedent.`,
  ];
  // Translation guards only bind when the output language differs from the
  // language of code, docs, and errors. English output has nothing to
  // mistranslate, so the two clauses would be dead text.
  if (language.prompt !== 'English') {
    lines.push(
      `- Keep code identifiers, paths, commands, symbols, API names, and exact errors in original form.`,
      `- Never coin a word-for-word translation of source jargon; use the established original term or a plain functional description.`,
    );
  }
  return `# Language\n\n${lines.join('\n')}`;
}

function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();
}

// Tool dependency is declared as metadata, not matched against prose. A
// `<!-- tools: a, b -->` marker binds the block that follows it: the block
// survives while any listed tool is on the session surface and disappears
// once every one of them is omitted. Markers never reach the model.
const TOOL_MARKER_RE = /^[ \t]*<!--[ \t]*tools:[ \t]*([^>]*?)[ \t]*-->[ \t]*$/;

function markerTools(line) {
  const match = TOOL_MARKER_RE.exec(String(line ?? ''));
  if (!match) return null;
  return match[1].split(',').map((name) => name.trim().toLowerCase()).filter(Boolean);
}

// A marked block runs from the line after the marker through every deeper
// indented continuation line, ending at the next marker, blank line, or a
// line at the same or shallower indent.
function markedBlockEnd(lines, start) {
  const indent = lines[start].search(/\S/);
  let end = start + 1;
  while (end < lines.length) {
    const line = lines[end];
    if (!line.trim() || markerTools(line)) break;
    if (line.search(/\S/) <= indent) break;
    end += 1;
  }
  return end;
}

function omitKeySet(omitTools) {
  return new Set((Array.isArray(omitTools) ? omitTools : []).map((name) => String(name || '').toLowerCase()).filter(Boolean));
}

/** Drop routing clauses for tools that are not on the session surface. */
function omitToolRoutes(text, omitTools = []) {
  const deny = omitKeySet(omitTools);
  const lines = String(text || '').split(/\r?\n/);
  const kept = [];
  let index = 0;
  while (index < lines.length) {
    const tools = markerTools(lines[index]);
    if (!tools) {
      kept.push(lines[index]);
      index += 1;
      continue;
    }
    index += 1;
    if (index >= lines.length) break;
    const end = markedBlockEnd(lines, index);
    if (!tools.length || !tools.every((name) => deny.has(name))) {
      kept.push(...lines.slice(index, end));
    }
    index = end;
  }
  return kept.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// Framing line under the style header: the block owns user-facing prose only,
// so a style (including a `keep-shared-format: false` replacement) never reads
// as guidance for code or tool payloads.
const OUTPUT_STYLE_ANCHOR = 'The section below governs how you write user-facing text; it outranks any other formatting habit and does not apply to code or tool calls.';

function listOutputStyleEntries({ PLUGIN_ROOT, DATA_DIR }) {
  const byId = new Map();
  for (const { dir, source } of [
    { dir: path.join(PLUGIN_ROOT, 'output-styles'), source: 'builtin' },
    { dir: path.join(DATA_DIR, 'output-styles'), source: 'user' },
  ]) {
    let files = [];
    try { files = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.md')).sort(); } catch {}
    for (const name of files) {
      const raw = readOptional(path.join(dir, name));
      const meta = raw ? outputStyleMetaFromMarkdown(raw, name) : null;
      if (meta) byId.set(meta.id, { ...meta, source, raw });
    }
  }
  return sortOutputStyles([...byId.values()]);
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
  const style = matchOutputStyle(configured, styles)
    || matchOutputStyle(DEFAULT_OUTPUT_STYLE_ID, styles)
    || styles[0];
  if (!style) return '';
  const selected = stripFrontmatter(style.raw);
  if (!selected) return '';
  const common = style.keepSharedFormat ? readSharedFormatPartial({ PLUGIN_ROOT, DATA_DIR }) : '';
  return [`# Output Style: ${style.label}`, OUTPUT_STYLE_ANCHOR, common, selected].filter(Boolean).join('\n\n');
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

  // The response-language section is NOT part of meta: it closes the session
  // environment block (buildLeadLanguageContent) so no later English text
  // (workflow, role, persona, memory, session lines) sits between it and the
  // first reply.

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
 * Lead response-language block. Delivered as the closing part of the
 * session-environment system block so the language directive is the last
 * system text the model reads before the conversation — the pre-tool
 * preamble and progress lines follow the most recent instruction, so nothing
 * English (session/shell/git lines included) may trail it.
 */
function buildLeadLanguageContent({ DATA_DIR }) {
  return buildLanguageSection(DATA_DIR);
}

/**
 * Build the Lead injection content.
 */
function buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const parts = [];

  const tool = buildSharedToolContent({ PLUGIN_ROOT, DATA_DIR });
  if (tool) parts.push(tool);

  const meta = buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR });
  if (meta) parts.push(meta);

  const role = buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR });
  if (role) parts.push(role);

  const language = buildLeadLanguageContent({ DATA_DIR });
  if (language) parts.push(language);

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
  buildLeadLanguageContent,
  buildAgentRoleContent,
  buildInjectionContent,
  buildAgentInjectionContent,
  buildAgentRetrievalInjectionContent,
  omitToolRoutes,
};
