// Agent-scoped role markdown and 4-BP system prompt composition.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { compareCodePoints } from '../../../shared/code-point-order.mjs';
import { BOTS_DIR, MIXY_BOT_ID, botStoreActive, isStoreBot, mixyIdentityDir } from '../../../shared/agent-store.mjs';
import { mixdogRoot } from '../../../shared/plugin-paths.mjs';
import { readMarkdownDocument } from '../../../shared/markdown-frontmatter.mjs';
import { listHiddenAgentsByKind, getAgentCatalogShareAgents } from '../internal-agents.mjs';
import { mixdogGlobalDir, mtimeWithTtl, readSafe } from './skill-catalog.mjs';
import { mixyDisplayName } from '../session/mixy-name.mjs';

// --- Agent-scoped instruction loader ---
// Emits a BP2 agent/system block scoped to the calling agent:
//   - Public/custom agents: their own agents/<agent>.md when present,
//     plus the public agent-worker contract.
//   - Hidden agents: their own rules/agent/<agent>.md section only.
//   - Null agent: falls back to the full all-in-one block
//     (explicit-cache unified-shard path).
//
// Agent-specific markdown intentionally rides BP2, behind the shared BP1 tool
// and skill manifest prefix, so agent changes do not disturb the common layer.
//
// Classification is dynamic — hidden retrieval/maintenance sets come from the
// `kind` field in internal-agents.mjs. Any other non-null agent is public/custom.

// One catalog/rules section; selectRoleInstructionSections matches sections
// by this `## <name>\n` heading.
function roleSection(name, body) {
  return `## ${name}\n\n${body}`;
}

function loadAgentClassification() {
  // Not cached — called only on instruction rebuild (mtime-busted), and
  // listHiddenAgentsByKind now reads from the mtime-aware cache inside
  // internal-agents.mjs so the classification always reflects the current
  // agents.json on disk.
  return {
    retrieval: new Set(listHiddenAgentsByKind('retrieval')),
    maintenance: new Set(listHiddenAgentsByKind('maintenance')),
  };
}

const _scopedRoleInstructionsCache = new Map();
// Like collectSkillsCached(), trust cached mtimes within the TTL to avoid
// re-statting role trees on repeated same-turn calls.
const _scopedRoleInstructionsMtimeCache = new Map();
const _ROLE_INSTRUCTIONS_MTIME_TTL_MS = 2000;

/** A saved AGENT.md applies to the next composition, even inside the mtime TTL. */
export function invalidateRoleInstructionsCache() {
  _scopedRoleInstructionsCache.clear();
  _scopedRoleInstructionsMtimeCache.clear();
}

function loadHiddenAgentSnippets(pluginRoot) {
  try {
    const agentRulesDir = join(pluginRoot, 'rules', 'agent');
    if (!existsSync(agentRulesDir)) return [];
    const files = readdirSync(agentRulesDir)
      .filter((f) => f.endsWith('.md') && f !== 'AGENT.md')
      .sort();
    const pairs = [];
    for (const f of files) {
      const raw = readSafe(join(agentRulesDir, f));
      if (!raw) continue;
      const { body } = readMarkdownDocument(raw);
      if (!body) continue;
      const name = f.replace(/^\d+-/, '').replace(/\.md$/, '');
      pairs.push({ name, body });
    }
    return pairs;
  } catch {
    return [];
  }
}

// Role-markdown roots, in precedence order (later wins on the same name):
// the shipped agents/ tree, then the user data dir. User-authored roles and
// built-in overrides written by the Workflows editor live in the data dir —
// reading only the install root left a custom agent with an EMPTY role
// catalog while Lead already saw the edited AGENT.md.
function agentSectionDirs(pluginRoot) {
  const dirs = [];
  if (pluginRoot) dirs.push(join(pluginRoot, 'agents'));
  try {
    const userDir = mixdogGlobalDir('agents');
    if (userDir && !dirs.includes(userDir)) dirs.push(userDir);
  } catch {
    /* unresolvable data dir — built-in roles still load */
  }
  // Bots of the store (agent-store.mjs), last: a bot's own folder wins over
  // the agents/ original the split left behind.
  const root = userDataRoot();
  if (root && botStoreActive(root)) dirs.push(join(root, BOTS_DIR));
  return dirs;
}

// The user data dir (parent of agents/), or '' when it cannot be resolved.
function userDataRoot() {
  try {
    const userDir = mixdogGlobalDir('agents');
    return userDir ? dirname(userDir) : '';
  } catch {
    return '';
  }
}

// A store bot's own folder, or ''.
function storeBotDir(agent) {
  const root = userDataRoot();
  return root && isStoreBot(root, agent) ? join(root, BOTS_DIR, agent) : '';
}

// Mixy's identity folder: bots/mixy with the store, agents/lead before.
function mixyDir() {
  const root = userDataRoot();
  return root ? mixyIdentityDir(root) : '';
}

function loadAgentSections(pluginRoot) {
  // agents/ accepts both the compatibility flat layout and the current
  // nested agents/<agent>/AGENT.md layout.
  const byName = new Map();
  for (const agentsDir of agentSectionDirs(pluginRoot)) {
    if (!existsSync(agentsDir)) continue;
    let entries;
    try {
      entries = readdirSync(agentsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      let name = '';
      let raw = null;
      if (entry.isDirectory()) {
        name = entry.name;
        raw = readSafe(join(agentsDir, entry.name, 'AGENT.md'));
      } else if (entry.isFile() && entry.name.endsWith('.md')) {
        name = entry.name.replace(/\.md$/, '');
        raw = readSafe(join(agentsDir, entry.name));
      }
      // Mixy's own AGENT.md (agents/lead/) rides only Mixy's agent-mode
      // prompt (loadMixyRoleSection), never another role catalog.
      if (!name || !raw || name === 'lead') continue;
      if (name === MIXY_BOT_ID && basename(agentsDir) === BOTS_DIR) continue;
      const { body } = readMarkdownDocument(raw);
      if (!body) continue;
      byName.set(name, roleSection(name, body));
    }
  }
  return [...byName.entries()].sort((a, b) => compareCodePoints(a[0], b[0])).map(([, text]) => text);
}

// Empty by design: scoped agent markdown already rides BP2 for every provider.
// Keeping the set in place preserves the old branch point for a future
// provider-specific experiment without changing today's cache layout.
const EXPLICIT_CACHE_PROVIDERS = new Set();

function hiddenRuleSections(hiddenPairs) {
  return hiddenPairs.map((p) => roleSection(p.name, p.body));
}

function selfHiddenRuleSection(hiddenPairs, agent) {
  const self = hiddenPairs.find((p) => p.name === agent);
  return self ? [roleSection(self.name, self.body)] : [];
}

function selectRoleInstructionSections({
  useUnified,
  agent,
  classification,
  agentSharesCatalog,
  agentSections,
  hiddenPairs,
}) {
  if (useUnified || !agent) {
    return {
      agentRuleSectionsToEmit: hiddenRuleSections(hiddenPairs),
      agentSectionsToEmit: agentSections,
    };
  }
  if (classification.retrieval.has(agent)) {
    return {
      agentRuleSectionsToEmit: selfHiddenRuleSection(hiddenPairs, agent),
      agentSectionsToEmit: agentSections.filter((s) =>
        [...agentSharesCatalog].some((name) => s.startsWith(`## ${name}\n`))
      ),
    };
  }
  if (classification.maintenance.has(agent)) {
    const selfRules = selfHiddenRuleSection(hiddenPairs, agent);
    const fromAgent = agentSections.find((s) => s.startsWith(`## ${agent}\n`));
    const fallbackRules = fromAgent ? [fromAgent] : [];
    return {
      agentRuleSectionsToEmit: selfRules.length ? selfRules : fallbackRules,
      agentSectionsToEmit: [],
    };
  }
  return {
    agentRuleSectionsToEmit: [],
    agentSectionsToEmit: agentSections.filter((s) => s.startsWith(`## ${agent}\n`)),
  };
}

export function loadScopedRoleInstructions(agent, provider = null) {
  const useUnified = !!(provider && EXPLICIT_CACHE_PROVIDERS.has(provider));
  const cacheKey = useUnified ? '__unified__' : agent || '__all__';
  const cached = _scopedRoleInstructionsCache.get(cacheKey);
  const pluginRoot = mixdogRoot();
  // Use maxMtimeRecursive so edits to .md files inside agents/ and
  // rules/agent/ propagate — parent dir mtime is unchanged on
  // Linux/macOS when only a nested file's content changes. Gate the stat
  // behind a short TTL so repeated same-turn calls reuse the last mtime
  // instead of re-walking the trees on every invocation.
  const mtime = pluginRoot
    ? mtimeWithTtl(
        _scopedRoleInstructionsMtimeCache,
        cacheKey,
        [
          ...agentSectionDirs(pluginRoot),
          join(pluginRoot, 'rules', 'agent'),
          join(pluginRoot, 'defaults', 'agents.json'),
        ],
        _ROLE_INSTRUCTIONS_MTIME_TTL_MS
      )
    : 0;
  if (cached && mtime <= cached.mtime) {
    return cached.value;
  }
  // Compute classification before file loading — internal-agents metadata
  // failures (malformed/missing agents.json) must propagate, not be
  // silently swallowed by the file-IO catch below.
  const classification = loadAgentClassification();
  const agentSharesCatalog =
    agent && classification.retrieval.has(agent) ? new Set(getAgentCatalogShareAgents(agent)) : new Set();
  try {
    const agentSections = loadAgentSections(pluginRoot);
    const hiddenPairs = loadHiddenAgentSnippets(pluginRoot);

    const { agentRuleSectionsToEmit, agentSectionsToEmit } = selectRoleInstructionSections({
      useUnified,
      agent,
      classification,
      agentSharesCatalog,
      agentSections,
      hiddenPairs,
    });

    const blocks = [];
    if (agentSectionsToEmit.length) {
      blocks.push(`# Agent Role Catalog\n\n${agentSectionsToEmit.join('\n\n---\n\n')}`);
    }
    if (agentRuleSectionsToEmit.length) {
      blocks.push(`# Agent Role Rules\n\n${agentRuleSectionsToEmit.join('\n\n---\n\n')}`);
    }
    const value = blocks.join('\n\n---\n\n');
    _scopedRoleInstructionsCache.set(cacheKey, { mtime, value });
    return value;
  } catch {
    return '';
  }
}

// --- Agent persona (agents/<id>/PERSONA.md) ---
// Optional tone/addressing/personality guide, rendered right after the
// agent's role section. Read from the same directory that supplies the
// agent's AGENT.md (user data dir first, then shipped); the Lead (`lead`,
// Mixy) has no AGENT.md, so its persona is the first PERSONA.md found.
// The text depends only on the file, so the BP3 prefix is stable until the
// file changes; it is re-read per composition, so an edit applies next turn.
export const PERSONA_MAX_CHARS = 4000;
export const PERSONA_TRUNCATION_MARKER = '\n\n[persona truncated]';
const PERSONA_AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function truncatePersona(text, max = PERSONA_MAX_CHARS) {
  const value = typeof text === 'string' ? text.trim() : '';
  if (value.length <= max) return value;
  return value.slice(0, max).trimEnd() + PERSONA_TRUNCATION_MARKER;
}

export function loadAgentPersonaSection(agent) {
  if (typeof agent !== 'string' || !PERSONA_AGENT_ID.test(agent) || agent.includes('..')) return '';
  const isLead = agent === 'lead';
  // Mixy's persona is in its own folder; a store bot's in its bots/ folder.
  const own = isLead ? mixyDir() : storeBotDir(agent);
  if (own) {
    const persona = truncatePersona(readSafe(join(own, 'PERSONA.md')) || '');
    return persona ? personaSection(persona) : '';
  }
  const pluginRoot = mixdogRoot();
  const roots = [];
  try {
    const userDir = mixdogGlobalDir('agents');
    if (userDir) roots.push(userDir);
  } catch {
    /* unresolvable data dir — shipped persona still loads */
  }
  if (pluginRoot) roots.push(join(pluginRoot, 'agents'));
  for (const root of roots) {
    const dir = join(root, agent);
    if (!isLead && !existsSync(join(dir, 'AGENT.md'))) continue;
    const persona = truncatePersona(readSafe(join(dir, 'PERSONA.md')) || '');
    if (!persona) {
      if (isLead) continue;
      return '';
    }
    return personaSection(persona);
  }
  return '';
}

function personaSection(persona) {
  return [
    '## Persona',
    '',
    'Tone and style guide for how you speak, address the user and carry yourself. It never overrides tool, safety or role rules; those always win.',
    '',
    persona,
  ].join('\n');
}

// --- Mixy's working style (agents/lead/AGENT.md, user data dir) ---
// The user-editable 일하는 방식 of Mixy, framed like any agent's role section.
// Agent mode only; empty or missing means no section. Re-read per
// composition, so an edit applies to the next prompt build.
export function loadMixyRoleSection() {
  let raw = '';
  try {
    const dir = mixyDir();
    raw = dir ? readSafe(join(dir, 'AGENT.md')) || '' : '';
  } catch {
    return '';
  }
  const { body } = readMarkdownDocument(raw);
  const text = String(body || '').trim();
  return text ? `# Agent Role Catalog\n\n${roleSection('lead', text)}` : '';
}

// --- Agent-mode identity (LEAD.md first line) ---
// "You are <name>, <what it does>." from the agent's manifest (agent.json, the
// name/description the editor writes), user copy first, then shipped. Mixy
// (the Lead configuration, id `lead`) has its own line, under the display name
// the user gave it (session/mixy-name.mjs), Mixy by default.
function agentManifest(agent) {
  const own = storeBotDir(agent);
  if (own) {
    try {
      const value = JSON.parse(readSafe(join(own, 'agent.json')) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }
  const roots = [];
  try {
    const userDir = mixdogGlobalDir('agents');
    if (userDir) roots.push(userDir);
  } catch {
    /* unresolvable data dir — shipped manifest still loads */
  }
  const pluginRoot = mixdogRoot();
  if (pluginRoot) roots.push(join(pluginRoot, 'agents'));
  for (const root of roots) {
    const dir = join(root, agent);
    if (!existsSync(join(dir, 'AGENT.md'))) continue;
    try {
      const value = JSON.parse(readSafe(join(dir, 'agent.json')) || '{}');
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  }
  return {};
}

/** The name a bot goes by (its manifest name, Mixy's display name), else its id. */
export function agentDisplayName(agent) {
  if (agent === 'lead') return mixyDisplayName();
  if (typeof agent !== 'string' || !PERSONA_AGENT_ID.test(agent) || agent.includes('..')) return String(agent || '');
  const name = agentManifest(agent).name;
  return (typeof name === 'string' ? name.replace(/\s+/g, ' ').trim() : '') || agent;
}

export function agentModeIdentityLine(agent) {
  if (agent === 'lead') return `You are ${mixyDisplayName()}, the user's assistant in Mixdog.`;
  if (typeof agent !== 'string' || !PERSONA_AGENT_ID.test(agent) || agent.includes('..')) return '';
  const oneLine = (value) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '');
  const manifest = agentManifest(agent);
  const name = oneLine(manifest.name) || agent;
  const role = oneLine(manifest.description).replace(/[.。]+$/, '');
  return role ? `You are ${name}. Your role: ${role}.` : `You are ${name}.`;
}

// --- Agent profile revision ---
// The files an agent's prompt sections (identity line, role, persona) are
// read from — its agent.json, AGENT.md and PERSONA.md in the user data dir and
// the shipped tree — as one hash. A session stamps it when its prompt is
// composed; another value means the profile was edited since
// (session-runtime/tool-policy-refresh.mjs refreshAgentProfile). '' for an
// invalid id. A coding Lead (`lead` outside Mixy's own thread) embeds no
// profile file at all, so its stamp is a constant: editing Mixy never
// rebuilds a coding session's prompt.
export const CODING_LEAD_PROFILE_REVISION = 'coding-lead';
export function agentProfileRevision(agent, { mixy = true } = {}) {
  if (typeof agent !== 'string' || !PERSONA_AGENT_ID.test(agent) || agent.includes('..')) return '';
  if (agent === 'lead' && !mixy) return CODING_LEAD_PROFILE_REVISION;
  const roots = [mixdogGlobalDir('agents')];
  const pluginRoot = mixdogRoot();
  if (pluginRoot) roots.push(join(pluginRoot, 'agents'));
  const hash = createHash('sha256');
  for (const root of roots) {
    for (const file of ['agent.json', 'AGENT.md', 'PERSONA.md']) {
      hash.update(`${root}\0${file}\0${readSafe(join(root, agent, file)) ?? '\u0001'}\0`);
    }
  }
  // Mixy's or a store bot's own folder, when it has one.
  const own = agent === 'lead' ? mixyDir() : storeBotDir(agent);
  if (own && own !== join(roots[0] || '', agent)) {
    for (const file of ['agent.json', 'AGENT.md', 'PERSONA.md']) {
      hash.update(`${own}\0${file}\0${readSafe(join(own, file)) ?? '\u0001'}\0`);
    }
  }
  return hash.digest('hex').slice(0, 24);
}

// --- Lead roster revision ---
// The bot roster a Lead's prompt lists (workflow/context.mjs leadPromptParts:
// the agent catalog and Mixy's contact catalog — never the orchestration
// mode, a setting that applies to new sessions), as one hash, stamped beside
// agentProfileRevision. A bot created, renamed, archived or restored changes
// it for every Lead whose prompt lists that bot.
export function leadRosterRevision(parts) {
  const hash = createHash('sha256');
  for (const slice of [parts?.agentCatalogContext, parts?.contactCatalogContext]) {
    hash.update(`${slice || ''}\0`);
  }
  return hash.digest('hex').slice(0, 24);
}

// --- Compose system prompt — 4-BP cache layout ---
// Returns the three stable system blocks and the BP3 core used for refreshes.
// They map directly to the breakpoint plan:
//   BP1 (1h, system block #1) = baseRules — shared tool policy
//   BP2 (1h, system block #2) = stableSystemContext — profile, skills, deferred/MCP
//   BP3 (1h, system block #3) = sessionMarker — workflow/role, memory, session/project environment
//   BP4 (5m/1h, messages tail) = live user/task/tool message tail
//
// Dynamic schedule/webhook/task payloads stay in normal user messages so
// changing one event does not rewrite the stable memory layer.
//
// `profile.skip` still filters specific buckets (claudemd, skills, memory)
// for backward compatibility with existing profiles.
function trimmedPromptSlice(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function joinPromptSlices(parts) {
  return parts.filter(Boolean).join('\n\n---\n\n');
}

export function composeSystemPrompt(opts) {
  const skip = opts.profile?.skip || {};

  // ── BP1: globally shared tool policy ────────────────────────────────
  const baseRules = opts.agentRules || '';

  // ── BP2: persistent profile/tool catalog layer ──────────────────────
  // deferredToolManifest: optional BP2 slice; production path is
  // applyInitialDeferredToolManifestToBp2 once after applyDeferredToolSurface.
  const stableSystemContext = joinPromptSlices([
    trimmedPromptSlice(opts.metaContext),
    skip.skills ? '' : trimmedPromptSlice(opts.skillManifest),
    trimmedPromptSlice(opts.deferredToolManifest),
  ]);

  // ── BP3: workflow/role + session environment layer ─────────────────
  let roleInstructionContext = '';
  if (!opts.skipRoleCatalog) {
    roleInstructionContext =
      opts.agent === 'lead'
        ? loadMixyRoleSection()
        : loadScopedRoleInstructions(opts.agent || null, opts.provider || null);
  }
  // Persona follows the role; Mixy's own thread carries Mixy's persona
  // (bots/mixy/PERSONA.md) — a coding Lead's prompt never does (skipPersona).
  const personaContext = opts.agent && !opts.skipPersona ? loadAgentPersonaSection(opts.agent) : '';
  const coreMemory = skip.memory ? '' : trimmedPromptSlice(opts.coreMemoryContext);
  // User AGENTS.md / CLAUDE.md block (context/instruction-files.mjs), already
  // headed `# Instruction Files`; rides right before core memory.
  const instructionFiles = skip.claudemd ? '' : trimmedPromptSlice(opts.instructionFilesContext);
  // Ordered for the longest shared prefix (session-prompt-composition.mjs):
  // 1. shared by every Lead — the workflow pack and LEAD.md's common lines;
  // 2. the mode block — coding: orchestration mode, LEAD.md's two passages,
  //    the full agent catalog; agent mode: the delegation block, their
  //    variants, AGENT_MODE.md, the sub-agent catalog (the same for every
  //    agent other than Mixy);
  // 3. Mixy only — MIXY.md and its contact-agent catalog;
  // 4. per session or agent, last — identity, caller prompt,
  //    role, persona, instruction files and core memory (changes most).
  const sessionMarkerCore = joinPromptSlices([
    trimmedPromptSlice(opts.workflowContext),
    opts.roleRules || '',
    trimmedPromptSlice(opts.orchestrationContext),
    opts.leadModeRules || '',
    opts.agentModeRules || '',
    trimmedPromptSlice(opts.agentCatalogContext),
    opts.mixyRules || '',
    trimmedPromptSlice(opts.contactCatalogContext),
    opts.identityContext || '',
    opts.userPrompt || '',
    roleInstructionContext,
    personaContext,
    instructionFiles,
    coreMemory ? `# Core Memory\n${coreMemory}` : '',
  ]);
  // Response language is the LAST system text before the conversation. It
  // rides the environment block (not the tier3 core) because the `# Session`
  // / shell / git lines are English and would otherwise trail it, pulling the
  // pre-tool preamble toward English.
  const environmentParts = [opts.sessionStartContext, opts.environmentContext, opts.languageContext].map(
    trimmedPromptSlice
  );
  // Volatile session/project environment. Kept OUT of sessionMarkerCore so
  // Anthropic providers can leave it as an UNMARKED system block (covered by
  // the messages-tail breakpoint) while prefix-order providers still see it
  // after the stable context. sessionMarker keeps the combined legacy shape
  // for callers that consume a single BP3 string.
  const sessionEnvironment = joinPromptSlices(environmentParts);
  const sessionMarker = joinPromptSlices([sessionMarkerCore, sessionEnvironment]);

  return { baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment, sessionMarker };
}
