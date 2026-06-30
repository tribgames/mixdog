'use strict';

/**
 * mixdog rules builder.
 *
 * Exported surfaces:
 *   - buildSharedToolContent            — BP1: shared tool policy
 *   - buildLeadRoleContent              — BP2: Lead role/system rules
 *   - buildAgentRoleContent             — BP2: agent role/system rules
 *   - buildAgentRetrievalInjectionContent — BP2: narrow read-only retrieval role
 *   - buildLeadMetaContent              — BP3: Lead memory/meta context
 *   - buildAgentRoleSpecificContent     — BP4-adjacent user/task data
 *   - buildInjectionContent             — legacy joined Lead session content
 *
 * 4-BP cache layout (composeSystemPrompt):
 *   BP1 = shared tool policy + compact skill manifest
 *   BP2 = role/system rules (Lead / agent / hidden role)
 *   BP3 = stable memory/meta context
 *   BP4 = live user/task messages and compacted tail
 *
 * Source files (rules/):
 *   - shared/01-tool.md              — universal tool policy (Lead + agent BP1, identical full set)
 *   - lead/lead-tool.md             — Lead-specific control-tower / delegation / ToolSearch guidance
 *   - lead/01-04                     — Lead workflow / channels / team / general
 *   - output-styles/<name>.md        — Lead output style, selected by config outputStyle
 *   - agent/00-common.md             — agent common behavior + universal worker contract (BP2)
 *   - agent/10..50-*.md              — per-hidden-role bodies (consumed by loadScopedRoleInstructions)
 *
 * Core memory snapshot and session recap are injected separately by
 * hooks/session-start.cjs from the memory worker (pgdata) (Lead only).
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
  ko: 'Korean (한국어)',
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
    lines.push(`- Use "${profile.title}" when directly addressing the user (greetings, answers, questions). Do not repeat it in routine progress updates or pre-tool preambles.`);
  }
  const shell = process.platform === 'win32' ? 'powershell' : 'bash';
  lines.push(`- Shell environment: ${shell}. When using shell, write commands and scripts in ${shell} syntax unless the user specifies otherwise. Keep commands, paths, symbols, and exact errors verbatim.`);
  return lines.length ? `# Profile Preferences\n\n${lines.join('\n')}` : '';
}

function buildLanguageSection(dataDir) {
  const profile = normalizeProfileConfig(readAgentConfig(dataDir).profile);
  const language = profileLanguagePrompt(profile.language);
  if (!language?.prompt) return '';
  const source = language.source === 'system-locale' && language.locale
    ? ` from system locale ${language.locale}`
    : '';
  const lines = [
    `- Default user-facing response language${source}: ${language.prompt}. Use it for ALL user-facing prose, including pre-tool preambles, progress updates, questions, final reports, and notices. Every such message — even a single-line preamble before a tool call — MUST be written in ${language.prompt}, and in no other language. This overrides any tone implied by the output style. Switch languages only when the user writes in another language or explicitly asks you to.`,
    `- Code identifiers, paths, commands, symbols, API names, and exact errors should remain in their original form.`,
  ];
  return `# Language\n\n${lines.join('\n')}`;
}

function stripFrontmatter(markdown) {
  return String(markdown || '').replace(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').trim();
}

function normalizeOutputStyleName(value) {
  const name = String(value || 'default').trim();
  return /^[A-Za-z0-9_.-]+$/.test(name) ? name : 'default';
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
  if (styleName !== 'default') {
    const fallback = [
      path.join(DATA_DIR, 'output-styles', 'default.md'),
      path.join(PLUGIN_ROOT, 'output-styles', 'default.md'),
    ];
    for (const candidate of fallback) {
      const body = stripFrontmatter(readOptional(candidate));
      if (body) return body;
    }
  }
  return '';
}

/**
 * Resolve the DATA_DIR subdir whose *.md instruction tree is sent as
 * BP4-adjacent user/task data, from the role's `instructionDir` metadata in
 * defaults/hidden-roles.json. Returns null when the role declares none.
 *
 * Mirrors internal-roles.mjs getRoleInstructionDir — rules-builder is CommonJS
 * and cannot import the ESM module, so it reads the same source of truth
 * directly. Keeps the webhook-handler→webhooks / scheduler-task→schedules
 * mapping declarative instead of a hard-coded role-name ternary.
 *
 * @param {string} mixdogRoot
 * @param {string} role
 * @returns {string|null}
 */
function resolveRoleInstructionDir(mixdogRoot, role) {
  if (!mixdogRoot || !role) return null;
  const metaPath = path.join(mixdogRoot, 'defaults', 'hidden-roles.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (e) {
    throw new Error(`[rules-builder] failed to read/parse hidden-roles.json at ${metaPath}: ${e.message}`);
  }
  for (const entry of (raw.roles || [])) {
    if (entry && entry.name === role) {
      const dir = typeof entry.instructionDir === 'string' ? entry.instructionDir.trim() : '';
      return dir || null;
    }
  }
  return null;
}

/**
 * Recursively collect all `.md` files under `dir`. Returns absolute paths
 * in stack-DFS order (callers sort before use). Missing/unreadable `dir`
 * yields an empty array — matches the previous inline `try {} catch {}`
 * behavior at every call site.
 */
function collectMarkdownFilesRecursive(dir) {
  const collected = [];
  try {
    const stack = [dir];
    while (stack.length) {
      const current = stack.pop();
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.isFile() && entry.name.endsWith('.md')) collected.push(full);
      }
    }
  } catch {}
  return collected;
}

// Address-form rule. Reads only `user.title` — `user.name` is intentionally
// not consumed; the user is addressed solely by the configured form.
// Returns '' when title is empty so nothing is injected.
function composeUserAddressBullet(memoryConfig) {
  const userTitle = (memoryConfig.user && memoryConfig.user.title || '').trim();
  if (!userTitle) return '';
  return `- User address form: ${userTitle} (use this address form exactly as written; do not combine it with any other name or honorific)`;
}

function splitLeadGeneral(general, addressBullet = '') {
  const lines = String(general || '').split(/\r?\n/);
  const roleLines = [];
  const metaLines = [];
  let inMeta = false;
  for (const line of lines) {
    if (/language used by the user/i.test(line)) {
      if (!inMeta) {
        metaLines.push('# General');
        metaLines.push('');
        inMeta = true;
      }
      metaLines.push(line);
    } else {
      roleLines.push(line);
    }
  }
  if (addressBullet) {
    if (!inMeta) {
      metaLines.push('# General');
      metaLines.push('');
      inMeta = true;
    }
    metaLines.push(addressBullet);
  }
  return {
    role: roleLines.join('\n').trim(),
    meta: metaLines.join('\n').trim(),
  };
}

function buildSharedToolContent({ PLUGIN_ROOT }) {
  const SHARED_DIR = path.join(PLUGIN_ROOT, 'rules', 'shared');
  return readOptional(path.join(SHARED_DIR, '01-tool.md'));
}

function buildLeadRoleContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const memoryConfig = readConfigSection(DATA_DIR, 'memory');
  const addressBullet = composeUserAddressBullet(memoryConfig);
  const general = readOptional(path.join(LEAD_DIR, '01-general.md'));
  const generalSplit = splitLeadGeneral(general, addressBullet);
  const parts = [];

  const toolLead = readOptional(path.join(LEAD_DIR, 'lead-tool.md'));
  if (toolLead) parts.push(toolLead);

  if (generalSplit.role) parts.push(generalSplit.role);

  const channels = readOptional(path.join(LEAD_DIR, '02-channels.md'));
  if (channels) parts.push(channels);

  const workflow = readOptional(path.join(LEAD_DIR, '04-workflow.md'));
  if (workflow) parts.push(workflow);

  return parts.join('\n\n');
}

function buildLeadMetaContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');
  const memoryConfig = readConfigSection(DATA_DIR, 'memory');
  const addressBullet = composeUserAddressBullet(memoryConfig);
  const general = readOptional(path.join(LEAD_DIR, '01-general.md'));
  const generalSplit = splitLeadGeneral(general, addressBullet);
  const parts = [];

  const profilePreferences = buildProfilePreferencesContent(DATA_DIR);
  if (profilePreferences) parts.push(profilePreferences);

  const languageSection = buildLanguageSection(DATA_DIR);
  if (languageSection) parts.push(languageSection);

  if (generalSplit.meta) parts.push(generalSplit.meta);

  const userProfile = readOptional(path.join(HISTORY_DIR, 'user.md'));
  if (userProfile) parts.push(`# User Profile\n\n${userProfile}`);

  const botPersona = readOptional(path.join(HISTORY_DIR, 'bot.md'));
  if (botPersona) parts.push(`# Bot Persona\n\n${botPersona}`);

  const userWorkflowMd = readOptional(path.join(DATA_DIR, 'user-workflow.md'));
  if (userWorkflowMd) parts.push(`# User Workflow\n\n${userWorkflowMd}`);

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
 * BP1 and buildAgentRoleContent() as BP2; this export remains for older smoke
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
  if (String(profile || 'full') === 'retrieval') {
    return buildAgentRetrievalInjectionContent();
  }
  const AGENT_DIR = path.join(PLUGIN_ROOT, 'rules', 'agent');
  return readOptional(path.join(AGENT_DIR, '00-common.md'));
}

/**
 * BP2 role rules for narrow hidden retrieval roles. These roles already carry a separate
 * read-only tool schema shard, so keeping the full agent worker prefix does
 * not improve cross-role cache reuse and only adds unrelated shell/edit/git
 * guidance.
 *
 * @returns {string}
 */
function buildAgentRetrievalInjectionContent() {
  return [
    '# Tool Use',
    '',
    '- Batch independent read-only lookups in the same tool turn.',
    '- Use code_graph for symbols/dependencies, grep for exact text, find/glob/list for files, and read only known paths/windows.',
    '',
    '# Agent Constraints',
    '',
    '- Read-only retrieval role: do not edit files, run shell, or use git.',
    '- Follow the role output contract exactly; do not add handoff prose.',
  ].join('\n');
}

/**
 * BP4-adjacent role-specific data. Only the calling role's own task / tool
 * detail body emits — webhook-handler gets webhooks/<all-events>/ and
 * scheduler gets schedules/<all-tasks>/. Other roles return ''.
 *
 * NOTE: webhook-event narrowing (one event per call) requires the inbound
 * payload's event id at compose time; not implemented yet, so all webhook
 * instruction files still ride with the webhook-handler user/task context.
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT
 * @param {string} opts.DATA_DIR
 * @param {string|null} opts.currentRole
 * @returns {string}
 */
function buildAgentRoleSpecificContent({ PLUGIN_ROOT, DATA_DIR, currentRole }) {
  if (!currentRole) return '';
  const parts = [];

  // The role's instruction subdir (webhook-handler → webhooks, scheduler-task
  // → schedules) is declared via `instructionDir` in defaults/hidden-roles.json
  // rather than hard-coded here, so adding a new inbound-event role needs only
  // a metadata entry.
  const subdirForRole = resolveRoleInstructionDir(PLUGIN_ROOT, currentRole);
  if (subdirForRole) {
    const dir = path.join(DATA_DIR, subdirForRole);
    const collected = collectMarkdownFilesRecursive(dir);
    if (collected.length > 0) {
      collected.sort();
      const blocks = collected.map(f => stripFrontmatter(readOptional(f))).filter(Boolean);
      if (blocks.length > 0) {
        parts.push([`# Agent ${subdirForRole}`, '', blocks.join('\n\n')].join('\n'));
      }
    }
  }

  return parts.join('\n\n');
}

module.exports = {
  buildSharedToolContent,
  buildLeadRoleContent,
  buildLeadMetaContent,
  buildAgentRoleContent,
  buildInjectionContent,
  buildAgentInjectionContent,
  buildAgentRetrievalInjectionContent,
  buildAgentRoleSpecificContent,
};
