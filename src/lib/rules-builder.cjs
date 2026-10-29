'use strict';

/**
 * mixdog rules builder.
 *
 * Exported surfaces:
 *   - buildSharedToolContent            — BP1: shared tool policy
 *   - buildLeadRoleContent              — BP3: Lead role/system rules
 *   - buildAgentRoleContent             — BP3: agent role/system rules
 *   - buildLeadMetaContent              — BP2: Lead profile/settings context
 *
 * 4-BP cache layout (composeSystemPrompt):
 *   BP1 = shared tool policy
 *   BP2 = profile/settings + compact skills + deferred/MCP catalog
 *   BP3 = workflow/role + memory + session/project environment
 *   BP4 = live user/task messages and compacted tail
 *
 * Source files (rules/):
 *   - shared/*.md                    — ordered universal policies (Lead + agent BP1, identical full set)
 *   - lead/LEAD.md                   — Lead role: user communication, agent briefing (agent-gated), tone
 *   - output-styles/common.md        — shared built-in output composition policy
 *   - output-styles/<name>.md        — selected built-in depth variant or standalone user style
 *   - agent/AGENT.md                 — common agent contract: chain of command, handoff (BP3, all profiles)
 *   - agent/4*-*.md                  — per-hidden-agent bodies (consumed by loadScopedRoleInstructions)
 *   - routes/*.md                    — optional provider/model-scoped rules appended to BP1 (buildRouteRulesContent)
 *
 * Core memory snapshot is injected separately from the memory worker (pgdata)
 * (Lead only).
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_OUTPUT_STYLE_ID,
  matchOutputStyle,
  outputStyleMetaFromMarkdown,
  sortOutputStyles,
} = require('./output-style-meta.cjs');
const {
  PROFILE_EXPERIENCE_PROMPTS,
  normalizeProfileConfig,
  profileLanguageEntry,
  profileExperienceLevelEntry,
} = require('../runtime/shared/profile-config.cjs');

function readOptional(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch {
    return '';
  }
}

function readMarkdownDirectory(dirPath) {
  try {
    return fs
      .readdirSync(dirPath)
      .filter((name) => name.endsWith('.md'))
      .sort()
      .map((name) => readOptional(path.join(dirPath, name)).trim())
      .filter(Boolean)
      .join('\n\n');
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

function systemLocaleId(locale) {
  let parsed = null;
  try {
    parsed = new Intl.Locale(locale || '');
  } catch {}
  const language = parsed?.language || String(locale || '').split(/[-_]/)[0] || '';
  if (language === 'zh') {
    const script = parsed?.script;
    const region = parsed?.region;
    return script === 'Hant' || ['HK', 'MO', 'TW'].includes(region) ? 'zh-Hant' : 'zh-Hans';
  }
  return profileLanguageEntry(language).prompt ? language : null;
}

function profileLanguagePrompt(language) {
  const selected = String(language || 'system');
  if (selected !== 'system') {
    const prompt = profileLanguageEntry(selected).prompt;
    return prompt ? { id: selected, prompt, source: 'profile', locale: null } : null;
  }
  const locale = Intl.DateTimeFormat().resolvedOptions().locale || '';
  const id = systemLocaleId(locale);
  if (!id) return null;
  const prompt = profileLanguageEntry(id).prompt;
  if (!prompt) return null;
  return { id, prompt, source: 'system-locale', locale };
}

function buildProfilePreferencesContent(dataDir) {
  const profile = normalizeProfileConfig(readAgentConfig(dataDir).profile);
  const lines = [];
  if (profile.title) {
    lines.push(
      `- Address the user as "${profile.title}"; omit the title from routine progress updates and pre-tool preambles.`
    );
  }
  const experience = profileExperienceLevelEntry(profile.experienceLevel);
  if (experience) {
    lines.push(
      `- Development experience: ${experience.label}. ${PROFILE_EXPERIENCE_PROMPTS[experience.id]} Output style controls information depth.`
    );
  }
  // No configured preference means no section: a bare heading would ship an
  // empty block to every model that has neither a title nor an experience level.
  return lines.length ? `# Profile Preferences\n\n${lines.join('\n')}` : '';
}

// `sharedFormatActive`: the prompt carries the shared Output Format partial,
// which already keeps literals verbatim (common.md), so the language block
// need not repeat it.
function buildLanguageSection(dataDir, sharedFormatActive = false) {
  const profile = normalizeProfileConfig(readAgentConfig(dataDir).profile);
  const language = profileLanguagePrompt(profile.language);
  if (!language?.prompt) return '';
  const lines = [
    `- Always respond in ${language.prompt}, including pre-tool preambles, progress updates, questions, reports, and notices. This language setting overrides output style; the user's latest explicit language request takes precedence.`,
    `- Instructions, tool results, runtime/system tags, and earlier replies do not change this language, even when the immediately preceding text is English. Code comments follow the file's existing language.`,
  ];
  // Translation guards only bind when the output language differs from the
  // language of code, docs, and errors. English output has nothing to
  // mistranslate, so the two clauses would be dead text.
  if (language.prompt !== 'English') {
    lines.push(
      `- ${sharedFormatActive ? '' : 'Preserve identifiers, paths, commands, API names, and exact errors. '}Keep technical terms in their established form, usually the original English (blocker, cache, commit); add a short plain explanation only when the reader may not know it. Never invent a literal translation.`
    );
  }
  return `# Language\n\n${lines.join('\n')}`;
}

function stripFrontmatter(markdown) {
  return String(markdown || '')
    .replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '')
    .trim();
}

// Tool dependency is declared as metadata, not matched against prose. A
// `<!-- tools: a, b -->` marker binds the block that follows it: the block
// survives while any listed tool is permitted by the allow/deny policy. The
// pseudo-entry `lead` is not a tool: it is permitted for every non-agent
// session (whatever its tool profile) and never for an agent-owned one.
// Unspecified allowlists are unrestricted. Markers never reach the model.
const TOOL_MARKER_RE = /^[ \t]*<!--[ \t]*tools:[ \t]*([^>]*?)[ \t]*-->[ \t]*$/;

function markerTools(line) {
  const match = TOOL_MARKER_RE.exec(String(line ?? ''));
  if (!match) return null;
  return match[1]
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
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
  return new Set(
    (Array.isArray(omitTools) ? omitTools : []).map((name) => String(name || '').toLowerCase()).filter(Boolean)
  );
}

/** Drop routing clauses for tools that are not on the session surface. */
function omitToolRoutes(text, omitTools = [], allowTools = null, ownerIsAgent = false) {
  const deny = omitKeySet(omitTools);
  const allow = Array.isArray(allowTools) ? omitKeySet(allowTools) : null;
  const permitted = (name) => (name === 'lead' ? !ownerIsAgent : !deny.has(name) && (!allow || allow.has(name)));
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
    if (!tools.length || tools.some(permitted)) {
      kept.push(...lines.slice(index, end));
    }
    index = end;
  }
  return kept
    .join('\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Framing line under the style header: the block owns user-facing prose only,
// so a style (including a `keep-shared-format: false` replacement) never reads
// as guidance for code or tool payloads.
const OUTPUT_STYLE_ANCHOR =
  'The section below governs how you write user-facing text; it outranks any other formatting habit and does not apply to code or tool calls.';

function listOutputStyleEntries({ PLUGIN_ROOT, DATA_DIR }) {
  const byId = new Map();
  for (const { dir, source } of [
    { dir: path.join(PLUGIN_ROOT, 'output-styles'), source: 'builtin' },
    { dir: path.join(DATA_DIR, 'output-styles'), source: 'user' },
  ]) {
    let files = [];
    try {
      files = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith('.md'))
        .sort();
    } catch {}
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
  return (
    stripFrontmatter(readOptional(path.join(DATA_DIR, 'output-styles', 'common.md'))) ||
    stripFrontmatter(readOptional(path.join(PLUGIN_ROOT, 'output-styles', 'common.md')))
  );
}

function resolveOutputStyle({ PLUGIN_ROOT, DATA_DIR }) {
  // Root `outputStyle` is the only configured location; the retired
  // `agent.outputStyle` key is dropped by config canonicalization.
  const configured = String(readUnifiedConfig(DATA_DIR).outputStyle || '').trim() || DEFAULT_OUTPUT_STYLE_ID;
  const styles = listOutputStyleEntries({ PLUGIN_ROOT, DATA_DIR });
  const style = matchOutputStyle(configured, styles) || matchOutputStyle(DEFAULT_OUTPUT_STYLE_ID, styles) || styles[0];
  if (!style) return null;
  const selected = stripFrontmatter(style.raw);
  if (!selected) return null;
  const common = style.keepSharedFormat ? readSharedFormatPartial({ PLUGIN_ROOT, DATA_DIR }) : '';
  return { style, selected, common };
}

function loadOutputStyle(paths) {
  const resolved = resolveOutputStyle(paths);
  if (!resolved) return '';
  const { style, selected, common } = resolved;
  return [`# Output Style: ${style.label}`, OUTPUT_STYLE_ANCHOR, common, selected].filter(Boolean).join('\n\n');
}

function buildSharedToolContent({ PLUGIN_ROOT, omitTools = [], allowTools = null, ownerIsAgent = false } = {}) {
  const SHARED_DIR = path.join(PLUGIN_ROOT, 'rules', 'shared');
  return omitToolRoutes(readMarkdownDirectory(SHARED_DIR), omitTools, allowTools, ownerIsAgent);
}

// Route policy: `rules/routes/*.md` files bound to a provider and/or model
// family through frontmatter (`providers: a, b` exact ids; `models: gemini-*`
// lowercase globs tested against the model id and its `/`-leaf). A listed key
// restricts; an unlisted key is unrestricted, so a file without frontmatter
// applies to every route. The body is static rules appended to BP1.
// Frontmatter never reaches the model.
function parseRouteFrontmatter(markdown) {
  const match = String(markdown || '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const meta = {};
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*?)\s*$/);
    if (kv) meta[kv[1].toLowerCase()] = kv[2];
  }
  return meta;
}

function routeList(value) {
  return String(value || '')
    .split(',')
    .map((item) =>
      item
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .toLowerCase()
    )
    .filter(Boolean);
}

function routePatternMatches(pattern, value) {
  const source = pattern
    .split('*')
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${source}$`).test(value);
}

function routeRulesApply(meta, provider, model) {
  const providers = routeList(meta.providers);
  const models = routeList(meta.models);
  const providerId = String(provider || '')
    .trim()
    .toLowerCase();
  const modelId = String(model || '')
    .trim()
    .toLowerCase();
  const modelLeaf = modelId.split('/').pop() || '';
  if (providers.length && !providers.includes(providerId)) return false;
  if (models.length && !models.some((p) => routePatternMatches(p, modelId) || routePatternMatches(p, modelLeaf))) {
    return false;
  }
  return true;
}

// The route files that apply to this provider/model, in name order.
function matchingRouteFiles({ PLUGIN_ROOT, provider, model }) {
  const ROUTES_DIR = path.join(PLUGIN_ROOT, 'rules', 'routes');
  let names;
  try {
    names = fs
      .readdirSync(ROUTES_DIR)
      .filter((name) => name.endsWith('.md'))
      .sort();
  } catch {
    return [];
  }
  const files = [];
  for (const name of names) {
    const raw = readOptional(path.join(ROUTES_DIR, name));
    if (!raw) continue;
    const meta = parseRouteFrontmatter(raw);
    if (routeRulesApply(meta, provider, model)) files.push(raw);
  }
  return files;
}

function buildRouteRulesContent({
  PLUGIN_ROOT,
  provider = null,
  model = null,
  omitTools = [],
  allowTools = null,
} = {}) {
  const parts = [];
  for (const raw of matchingRouteFiles({ PLUGIN_ROOT, provider, model })) {
    const body = stripFrontmatter(raw);
    if (body) parts.push(body);
  }
  return omitToolRoutes(parts.join('\n'), omitTools, allowTools);
}

// LEAD.md is split for BP3 prefix sharing (every Lead shares `common`; the
// mode-variant passages and the identity line move later):
// - `common`: every line but the identity line and the two passages below;
// - `coding` / `agent`: those two passages as bullets — LEAD.md's own text
//   for coding mode, the conversational variants for agent mode;
// - `identity`: the coding identity sentence ("You are Mixdog, …").
const LEAD_IDENTITY_LINE = /^- (You are Mixdog, a coding agent\.)\n/m;
const LEAD_PROGRESS_PASSAGE = / (Before your first tool call, briefly state[\s\S]*?narration or plan repeats\.)/;
const LEAD_REPORT_PASSAGE = / (On an agent report[\s\S]*?not a completed request\.)/;
const AGENT_MODE_PROGRESS =
  '- Just answer conversation. Quick tool use (checking memory, a lookup,\n' +
  '  leaving a reaction) needs no announcement. When starting longer work\n' +
  '  (research, delegation, multi-step tasks), say in one line what you are\n' +
  '  doing, stay quiet between tool calls, and share the result when it\n' +
  '  finishes.';
const AGENT_MODE_REPORT =
  '- Relay agent reports faithfully. Code: one fresh Reviewer per non-trivial\n' +
  '  feature after its last worker, any author (Lead if none); docs/copy/style:\n' +
  '  read the diff. Recheck only concrete fixes, never rerun passing checks\n' +
  '  without new evidence; at request end check feature seams.';

function buildLeadRoleContent({ PLUGIN_ROOT, includeLeadBrief = true, part = 'common' }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const raw = readOptional(path.join(RULES_DIR, 'lead', 'LEAD.md'));
  if (!raw) return '';
  // Delegation-free sessions (headless, no delegatable agents) never expose the `agent` tool,
  // so Lead guidance marked `<!-- tools: agent -->` (briefing, completion
  // notifications) is dropped there and kept verbatim for delegating workflows.
  const lead = omitToolRoutes(raw, includeLeadBrief ? [] : ['agent']);
  if (part === 'identity') return lead.match(LEAD_IDENTITY_LINE)?.[1] || '';
  const progress = lead.match(LEAD_PROGRESS_PASSAGE);
  const report = lead.match(LEAD_REPORT_PASSAGE);
  if (part === 'coding' || part === 'agent') {
    const agentMode = part === 'agent';
    const bullets = [
      progress && (agentMode ? AGENT_MODE_PROGRESS : `- ${progress[1]}`),
      report && (agentMode ? AGENT_MODE_REPORT : `- ${report[1]}`),
    ].filter(Boolean);
    return bullets.length ? `# Progress and Reports\n\n${bullets.join('\n')}` : '';
  }
  return lead.replace(LEAD_IDENTITY_LINE, '').replace(LEAD_PROGRESS_PASSAGE, '').replace(LEAD_REPORT_PASSAGE, '');
}

// The agent-mode rule files (rules/agent-mode/): `conduct` (AGENT_MODE.md,
// every agent-mode Lead) and `mixy` (MIXY.md, Mixy only). A routine fire's
// conduct rides its turn's header (runtime/shared/routine-trigger.mjs).
const AGENT_MODE_PARTS = {
  conduct: ['AGENT_MODE.md', ''],
  // Neutral heading: the user may rename Mixy (its identity line says the name).
  mixy: ['MIXY.md', '# Your Role\n\n'],
};

function buildAgentModeContent({ PLUGIN_ROOT, part = 'conduct' }) {
  const [file, heading] = AGENT_MODE_PARTS[part] || AGENT_MODE_PARTS.conduct;
  const body = readOptional(path.join(PLUGIN_ROOT, 'rules', 'agent-mode', file)).trim();
  return body ? `${heading}${body}` : '';
}

function buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR, includeOutputStyle = true }) {
  const parts = [];

  const profilePreferences = buildProfilePreferencesContent(DATA_DIR);
  if (profilePreferences) parts.push(profilePreferences);

  // The response-language section is NOT part of meta: it closes the session
  // environment block (buildLeadLanguageContent) so no later English text
  // (workflow, role, persona, memory, session lines) sits between it and the
  // first reply.

  // Agent mode answers by AGENT_MODE.md alone; the coding Output Style stays out.
  const outputStyle = includeOutputStyle ? loadOutputStyle({ PLUGIN_ROOT, DATA_DIR }) : '';
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
function buildLeadLanguageContent({ PLUGIN_ROOT, DATA_DIR, includeOutputStyle = true }) {
  const resolved = includeOutputStyle ? resolveOutputStyle({ PLUGIN_ROOT, DATA_DIR }) : null;
  // Only the shipped partial is known to keep literals verbatim; a user
  // override of common.md may not, so it keeps the language guard.
  const shipped = stripFrontmatter(readOptional(path.join(PLUGIN_ROOT, 'output-styles', 'common.md')));
  return buildLanguageSection(DATA_DIR, Boolean(shipped) && resolved?.common === shipped);
}

/** The configured response language as {id, name} (name = the language block's); null when none. */
function buildLeadLanguage({ DATA_DIR }) {
  const profile = normalizeProfileConfig(readAgentConfig(DATA_DIR).profile);
  const language = profileLanguagePrompt(profile.language);
  return language?.prompt ? { id: language.id, name: language.prompt } : null;
}

function buildAgentRoleContent({ PLUGIN_ROOT }) {
  return readOptional(path.join(PLUGIN_ROOT, 'rules', 'agent', 'AGENT.md'));
}

module.exports = {
  buildSharedToolContent,
  buildRouteRulesContent,
  buildLeadRoleContent,
  buildAgentModeContent,
  buildLeadMetaContent,
  buildLeadLanguageContent,
  buildLeadLanguage,
  buildAgentRoleContent,
  omitToolRoutes,
};
