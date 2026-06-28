'use strict';

/**
 * mixdog rules builder.
 *
 * Three surfaces:
 *   - buildInjectionContent              — Lead session
 *   - buildAgentInjectionContent        — agent session BP1 (true cross-role common)
 *   - buildAgentRoleSpecificContent     — agent session BP3 (role-specific instructions)
 *
 * 4-BP cache layout (composeSystemPrompt):
 *   BP1 = agent BP1 content (this file's buildAgentInjectionContent) — every role identical
 *   BP2 = reserved stable system layer — role-independent only
 *   BP3 = stable session marker: role md + workflow/role-specific instructions
 *   BP4 = compact carry-over memory only (5m volatile when present)
 *
 * Source files (rules/):
 *   - shared/01-tool.md              — universal tool policy (Lead + agent BP1, identical full set)
 *   - lead/00-tool-lead.md           — Lead-specific control-tower / delegation / ToolSearch guidance
 *   - lead/01-04                     — Lead workflow / channels / team / general
 *   - output-styles/<name>.md        — Lead output style, selected by config outputStyle
 *   - agent/00-common.md             — agent common behavior + universal worker contract (BP1)
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
 * Resolve the DATA_DIR subdir whose *.md instruction tree folds into a hidden
 * role's BP3 role-specific block, from the role's `instructionDir` metadata in
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

/**
 * Build the Lead injection content.
 */
function buildInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const SHARED_DIR = path.join(RULES_DIR, 'shared');
  const LEAD_DIR = path.join(RULES_DIR, 'lead');
  const HISTORY_DIR = path.join(DATA_DIR, 'history');

  const memoryConfig = readConfigSection(DATA_DIR, 'memory');
  const parts = [];

  // Language policy now lives in lead/01-general.md (Lead-only). Agent
  // sessions keep their own English contract (agent/00-common.md) without a
  // conflicting "follow user language" line.
  const general = readOptional(path.join(LEAD_DIR, '01-general.md'));
  if (general) {
    const addressBullet = composeUserAddressBullet(memoryConfig);
    parts.push(addressBullet ? `${general}\n${addressBullet}` : general);
  }

  const tool = readOptional(path.join(SHARED_DIR, '01-tool.md'));
  if (tool) parts.push(tool);

  const toolLead = readOptional(path.join(LEAD_DIR, '00-tool-lead.md'));
  if (toolLead) parts.push(toolLead);

  const channels = readOptional(path.join(LEAD_DIR, '02-channels.md'));
  if (channels) parts.push(channels);

  const workflow = readOptional(path.join(LEAD_DIR, '04-workflow.md'));
  if (workflow) parts.push(workflow);

  const userProfile = readOptional(path.join(HISTORY_DIR, 'user.md'));
  if (userProfile) parts.push(`# User Profile\n\n${userProfile}`);

  const botPersona = readOptional(path.join(HISTORY_DIR, 'bot.md'));
  if (botPersona) parts.push(`# Bot Persona\n\n${botPersona}`);

  // User workflow context — low-token, optional
  const userWorkflowMd = readOptional(path.join(DATA_DIR, 'user-workflow.md'));
  if (userWorkflowMd) parts.push(`# User Workflow\n\n${userWorkflowMd}`);

  // Keep output style last so user/profile/workflow context cannot soften the
  // final formatting contract for user-visible replies.
  const outputStyle = loadOutputStyle({ PLUGIN_ROOT, DATA_DIR });
  if (outputStyle) parts.push(outputStyle);

  return parts.join('\n\n');
}

/**
 * BP1 — true cross-role common. Identical for every agent role; the
 * role-specific stuff (per-event webhook instructions, per-task schedule
 * instructions, hidden role tool detail) lives in BP3 instead.
 *
 * @param {object} opts
 * @param {string} opts.PLUGIN_ROOT
 * @param {string} opts.DATA_DIR
 * @returns {string}
 */
function buildAgentInjectionContent({ PLUGIN_ROOT, DATA_DIR }) {
  const RULES_DIR = path.join(PLUGIN_ROOT, 'rules');
  const SHARED_DIR = path.join(RULES_DIR, 'shared');
  const AGENT_DIR = path.join(RULES_DIR, 'agent');
  const parts = [];

  // Universal tool policy — same full set Lead receives. No shared language
  // policy here: agent language is governed by agent/00-common.md
  // ("Use English for agent task communication").
  const tool = readOptional(path.join(SHARED_DIR, '01-tool.md'));
  if (tool) parts.push(tool);

  // Agent common behavior.
  const common = readOptional(path.join(AGENT_DIR, '00-common.md'));
  if (common) parts.push(common);

  // userTitle / address form is intentionally NOT injected here — agent
  // workers produce tool I/O, not user-facing replies, so the persona signal
  // only biases response language/tone without serving a purpose. Lead BP1
  // (buildInjectionContent above) still carries it.

  return parts.join('\n\n');
}

/**
 * BP1 for narrow hidden retrieval roles. These roles already carry a separate
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
  ].join('\n');
}

/**
 * BP3 role-specific instructions. Only the calling role's own task / tool
 * detail body emits — webhook-handler gets webhooks/<all-events>/, scheduler
 * gets schedules/<all-tasks>/, hidden retrieval roles get their own tool
 * detail. Other roles return ''.
 *
 * NOTE: webhook-event narrowing (one event per call) requires the inbound
 * payload's event id at compose time; not implemented yet, so all 4 webhook
 * instructions still bake into webhook-handler BP3 for now.
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
  buildInjectionContent,
  buildAgentInjectionContent,
  buildAgentRetrievalInjectionContent,
  buildAgentRoleSpecificContent,
};
