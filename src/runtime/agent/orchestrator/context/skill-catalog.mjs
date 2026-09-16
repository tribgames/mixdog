// Skill discovery, cache, resource loading, envelopes, manifests, and the
// Skill meta-tool. Extracted from collect.mjs so role-prompt assembly no
// longer shares a god-file with the catalog.

import { readFileSync, existsSync, readdirSync } from 'fs';
import { basename, dirname, join } from 'path';
import { maxMtimeRecursive } from '../cache-mtime.mjs';
import { mixdogHome, resolvePluginData, mixdogRoot } from '../../../shared/plugin-paths.mjs';
import { pluginSkillsRoots } from '../../../shared/plugin-manifest.mjs';
import { parseSkillDocument } from '../../../shared/skill-document.mjs';
import { readSkillToolDependencies, skillToolDependenciesRoot } from '../../../shared/skill-tool-dependencies.mjs';
import { loadConfig, normalizeSkillsConfig } from '../config.mjs';
import { builtinFeatureActive, withGrandfatheredBuiltins } from '../../../../session-runtime/builtin-features.mjs';
import { extensionScopesFromConfig, skillAllowedForCwd } from '../../../shared/extension-scopes.mjs';
import { currentSkillContext, latestSkillBodies, skillMessageText } from './skill-state.mjs';
import { compactPromptManifestText } from './deferred-tools.mjs';

function skillsDisabled() {
  return /^(?:1|true|on|yes)$/i.test(String(process.env.MIXDOG_DISABLE_SKILLS || ''));
}

// --- mixdog asset roots (standalone CLI owns its own paths; never .claude) ---
// Skills are machine-global under <mixdogData>/skills. Project-local skill
// directories are intentionally outside the runtime resolution chain.
export function mixdogGlobalDir(kind) {
  try {
    return join(resolvePluginData(), kind);
  } catch {
    return join(process.env.MIXDOG_DATA_DIR || join(mixdogHome(), 'data'), kind);
  }
}
function mixdogAssetDirs(_projectDir, kind) {
  return [mixdogGlobalDir(kind)];
}
/**
 * The package's own bundle (src/defaults/) is a plugin root like any other:
 * `plugin.json` + `skills/<name>/SKILL.md`, read in place through the same
 * manifest resolver as installed plugins, never copied — a release updates it
 * immediately, and a user-global or plugin skill of the same name shadows it.
 * It is not in the registry: the Built-in settings panel owns its UI.
 */
function builtinPluginRoot() {
  return join(mixdogRoot(), 'defaults');
}
function builtinSkillDirs() {
  return pluginSkillsRoots(builtinPluginRoot()).filter((dir) => existsSync(dir));
}
/**
 * Absolute path to the plugin registry file, or null when the data dir is
 * unresolvable. Included in the skills mtime gate so plugin add/remove
 * (which rewrites registry.json) invalidates the cached skill list even
 * when no surviving skills dir got a newer mtime.
 */
function pluginRegistryPath() {
  try {
    return join(resolvePluginData(), 'plugins', 'registry.json');
  } catch {
    return null;
  }
}
/**
 * Read `<resolvePluginData()>/plugins/registry.json` (safe JSON parse, ignore
 * errors) and yield every existing skill root of each enabled registered
 * plugin: `<root>/skills` plus the manifest `skills` path, from the same
 * resolver the Plugins panel counts with, so the two never disagree.
 */
function pluginSkillDirs() {
  const registryPath = pluginRegistryPath();
  if (!registryPath) return [];
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {
    return [];
  }
  if (!registry || !Array.isArray(registry.plugins)) return [];
  const dirs = [];
  for (const entry of registry.plugins) {
    if (entry?.enabled === false) continue;
    const root = entry && typeof entry.root === 'string' ? entry.root : null;
    if (!root || !existsSync(root)) continue;
    const plugin = String(entry.id || entry.name || '') || null;
    for (const skillsDir of pluginSkillsRoots(root)) {
      if (existsSync(skillsDir)) dirs.push({ dir: skillsDir, plugin });
    }
  }
  return dirs;
}

export function readSafe(path) {
  try {
    if (!existsSync(path)) return null;
    const content = readFileSync(path, 'utf-8').trim();
    return content || null;
  } catch {
    return null;
  }
}

const _CACHE_MAP_CAP = 16;

function capMapSize(map, max = _CACHE_MAP_CAP) {
  if (map.size > max) map.delete(map.keys().next().value);
}

export function mtimeWithTtl(cache, key, paths, ttlMs) {
  const cached = cache.get(key);
  if (cached && Date.now() - cached.checkedAt < ttlMs) return cached.mtime;
  const mtime = maxMtimeRecursive(paths);
  cache.set(key, { mtime, checkedAt: Date.now() });
  capMapSize(cache);
  return mtime;
}

/**
 * Collect available skills (frontmatter only — token efficient).
 * Full content is read on demand when a skill is loaded.
 */
export function collectSkills(cwd) {
  if (skillsDisabled()) return [];
  void cwd;
  const skills = [];
  // Plugin-provided skills load after user-global ones and built-ins last,
  // so the user keeps precedence; `seen` below dedupes by frontmatter name.
  // Each entry remembers its owner so a plugin's skills can be shown and
  // toggled with the plugin instead of as loose entries.
  const sources = [
    ...mixdogAssetDirs(null, 'skills').map((dir) => ({ dir, source: 'global', plugin: null })),
    ...pluginSkillDirs().map(({ dir, plugin }) => ({ dir, source: 'plugin', plugin })),
    ...builtinSkillDirs().map((dir) => ({ dir, source: 'builtin', plugin: null })),
  ];
  const seen = new Set();
  for (const { dir, source, plugin } of sources) {
    if (!existsSync(dir)) continue;
    try {
      const files = readdirSync(dir, { recursive: true });
      for (const f of files) {
        if (basename(String(f)) !== 'SKILL.md') continue;
        const filePath = join(dir, String(f));
        const content = readSafe(filePath);
        if (!content) continue;
        let skill;
        try {
          skill = parseSkillDocument(content);
        } catch {
          continue;
        }
        // Agent Skills requires the manifest name to match its folder.
        if (basename(dirname(filePath)) !== skill.name) continue;
        if (seen.has(skill.name)) continue;
        seen.add(skill.name);
        skills.push({
          name: skill.name,
          description: skill.description,
          whenToUse: skill.whenToUse,
          filePath,
          source,
          plugin,
          requires: requiredFeatures(skill.frontmatter),
          ...readSkillToolDependencies(filePath, skill.frontmatter),
        });
      }
    } catch {
      /* ignore */
    }
  }
  return skills;
}

function normalizeSkillNameKey(name) {
  return String(name || '')
    .trim()
    .toLowerCase();
}

/**
 * `metadata.requires` in the frontmatter names the built-in features a skill
 * depends on (`office`, `git`, `memory`, `webSearch`). A skill that describes
 * how to drive a tool must not be offered while that tool is uninstalled or
 * switched off, or the model is pointed at a call that cannot succeed.
 */
function requiredFeatures(frontmatter) {
  const metadata = frontmatter?.metadata;
  const raw = metadata && typeof metadata === 'object' ? metadata.requires : null;
  const list = Array.isArray(raw) ? raw : raw == null ? [] : String(raw).split(',');
  return list.map((value) => String(value || '').trim()).filter(Boolean);
}

function missingFeature(skill, config) {
  const requires = Array.isArray(skill?.requires) ? skill.requires : [];
  return requires.find((feature) => !builtinFeatureActive(config, feature)) || null;
}

/** Config for feature gating. A profile that predates the `builtins` section
 *  is grandfathered as installed exactly like the daemon does at adoption, so
 *  the skill list and the tool surface agree. */
function featureConfig(config = null) {
  return withGrandfatheredBuiltins(config || loadConfig({ secrets: false }));
}

function getDisabledSkillNameSet(config = null) {
  const cfg = config || loadConfig({ secrets: false });
  const keys = normalizeSkillsConfig(cfg.skills)
    .disabled.map((n) => normalizeSkillNameKey(n))
    .filter(Boolean);
  return new Set(keys);
}

// Feature-owned bundle entries follow their parent, including when an older
// profile still has their former individual OFF preference. User overrides
// and standalone built-ins retain their independent preference.
function followsBuiltinFeature(skill) {
  return skill?.source === 'builtin' && Array.isArray(skill.requires) && skill.requires.length > 0;
}

export function isSkillDisabled(name, config = null) {
  const n = normalizeSkillNameKey(name);
  if (!n) return false;
  const skill = collectSkillsCached(null).find((entry) => normalizeSkillNameKey(entry.name) === n);
  if (!followsBuiltinFeature(skill) && getDisabledSkillNameSet(config).has(n)) return true;
  return Boolean(skill && missingFeature(skill, featureConfig(config)));
}

/** The built-in feature a skill needs that is not active, or null. */
export function skillMissingFeature(name, config = null) {
  const n = normalizeSkillNameKey(name);
  const skill = collectSkillsCached(null).find((entry) => normalizeSkillNameKey(entry.name) === n);
  return skill ? missingFeature(skill, featureConfig(config)) : null;
}

/**
 * Skills a session may see: not switched off, feature available, and — when
 * `cwd` is given — inside the skill's (or its plugin's) project scope. Without
 * a cwd only global skills pass, since a scoped skill belongs to a project.
 */
export function filterSkillsExcludingDisabled(skills, config = null, cwd = null) {
  if (skillsDisabled()) return [];
  const cfg = featureConfig(config);
  const disabled = getDisabledSkillNameSet(cfg);
  const scopes = extensionScopesFromConfig(cfg);
  return (Array.isArray(skills) ? skills : []).filter((s) => {
    const key = normalizeSkillNameKey(s?.name);
    return (
      key &&
      (followsBuiltinFeature(s) || !disabled.has(key)) &&
      !missingFeature(s, cfg) &&
      skillAllowedForCwd(scopes, s, cwd)
    );
  });
}

export function collectPromptSkillsCached(cwd, config = null) {
  return filterSkillsExcludingDisabled(collectSkillsCached(cwd), config, cwd);
}
// --- Skill cache (mtime-based, keyed by cwd) ---
const _skillsCache = new Map();
const _mtimeCache = new Map();
const _MTIME_TTL_MS = 2000;

export function collectSkillsCached(cwd) {
  if (skillsDisabled()) return [];
  void cwd;
  const key = 'global';
  // Same mixdog-owned dirs collectSkills() reads, used as the freshness gate.
  const skillsDirs = mixdogAssetDirs(null, 'skills');
  skillsDirs.push(skillToolDependenciesRoot());
  skillsDirs.push(...pluginSkillDirs().map(({ dir }) => dir), ...builtinSkillDirs());
  // registry.json itself gates plugin add/remove: removal deletes the
  // plugin's skills dir (so no dir mtime advances), but saveRegistry()
  // always rewrites this file. maxMtimeRecursive stats plain files directly.
  const registryPath = pluginRegistryPath();
  if (registryPath) skillsDirs.push(registryPath);
  const mtime = mtimeWithTtl(_mtimeCache, key, skillsDirs, _MTIME_TTL_MS);
  const entry = _skillsCache.get(key);
  if (entry && entry.mtime >= mtime) {
    return entry.value;
  }
  const skills = collectSkills(cwd);
  _skillsCache.set(key, { value: skills, mtime });
  capMapSize(_skillsCache);
  return skills;
}
export function invalidateSkillsCache(cwd) {
  void cwd;
  _skillsCache.clear();
  _mtimeCache.clear();
}
/** Drop only the mtime TTL so the next call re-stats the skill roots while the
 *  cached list stays — lets a test prove the gate itself notices an edit. */
export function invalidateSkillsMtimeGate() {
  _mtimeCache.clear();
}

/**
 * Load full skill content plus its on-disk directory (for base-dir + ${MIXDOG_SKILL_DIR}).
 */
export function loadSkillResource(name, cwd) {
  const skillName = String(name || '').trim();
  if (!skillName) return null;
  const skills = collectSkillsCached(cwd);
  const skill = skills.find((s) => s.name === skillName);
  if (!skill) return null;
  const content = readSafe(skill.filePath);
  if (content == null) return null;
  try {
    return {
      content: parseSkillDocument(content).body,
      dir: dirname(skill.filePath),
      filePath: skill.filePath,
      source: skill.source || 'global',
      toolDependencies: skill.toolDependencies || [],
      declaredToolDependencies: skill.declaredToolDependencies || [],
      dependencySource: skill.dependencySource || 'none',
      dependencyIssues: skill.dependencyIssues || [],
    };
  } catch {
    return null;
  }
}

function escapeSkillXmlText(value) {
  return String(value || '').replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]);
}

/**
 * Wrap loaded SKILL.md body for Skill tool results (runtime + loop).
 */
export function buildSkillResultEnvelope(name, content, skillDir) {
  const escapedName = escapeSkillXmlText(name);
  let body = String(content == null ? '' : content);
  let dirLine = '';
  if (skillDir) {
    const normDir = String(skillDir).replace(/\\/g, '/');
    body = body.replace(/\$\{MIXDOG_SKILL_DIR\}/g, normDir);
    const escapedDir = escapeSkillXmlText(normDir);
    dirLine = `<base-dir>${escapedDir}</base-dir>\n`;
  }
  return `<skill>\n<name>${escapedName}</name>\n${dirLine}${body}\n</skill>`;
}

/**
 * Short, model-visible tool_result stub for a loaded skill. The full SKILL.md
 * body is delivered separately as ONE injected user message (newMessages),
 * never in the tool_result — so the body appears exactly once.
 */
function buildSkillStub(name, source) {
  // The stub doubles as the transcript's provenance marker: a built-in skill
  // (packaged with a built-in feature) loads silently, while user and plugin
  // skills surface as a card. `source` mirrors collectSkills() entries.
  const kind = source === 'builtin' ? 'built-in skill' : 'skill';
  return `Loaded ${kind}: ${String(name || '').trim()}`;
}

/**
 * Is this skill's body still present in the conversation the model will see?
 *
 * The check is deliberately about the LIVE transcript, not about whether the
 * skill was ever loaded. The live turn supersedes the saved transcript after
 * compaction. Match the full current body, not just its name, so edited skills
 * and skills absent from the rebuilt context are delivered again.
 */
export function skillBodyPresentInSession(session, body) {
  if (!session || !body) return false;
  const requested = latestSkillBodies([{ role: 'user', content: body }])[0];
  if (!requested) return false;
  const current = latestSkillBodies(currentSkillContext(session)).find((entry) => entry.name === requested.name);
  return !!current && skillMessageText(current.message.content).trimStart() === body;
}

/**
 * Build the Skill tool-result envelope used by BOTH the agent-loop viewSkill
 * path and the runtime skillToolContent path so behavior matches across main
 * + agent sessions:
 *   - result      = short stub (`Loaded skill: <name>`), no body.
 *   - newMessages = exactly ONE role:'user' message carrying the full
 *                   buildSkillResultEnvelope output (<base-dir> + body).
 * The injected user message is flagged `meta:'skill'` so compaction's
 * "latest human prompt" selection does not mistake the skill body for the
 * human's request.
 *
 * Passing `session` makes an unchanged repeat load body-free. Tool
 * dependencies are still reported, so a
 * repeat call re-arms the skill's deferred tools exactly as before.
 */
export function buildSkillToolEnvelope(
  name,
  content,
  skillDir,
  { source = 'global', toolDependencies = [], dependencyIssues = [] } = {},
  session = null
) {
  const body = buildSkillResultEnvelope(name, content, skillDir);
  const alreadyLoaded = skillBodyPresentInSession(session, body);
  return {
    __toolEnvelope: true,
    result: alreadyLoaded
      ? `${buildSkillStub(name, source)} (already active; instructions unchanged — follow them without calling Skill again)`
      : buildSkillStub(name, source),
    ...(toolDependencies.length ? { skillToolDependencies: toolDependencies } : {}),
    ...(dependencyIssues.length ? { skillDependencyIssues: dependencyIssues } : {}),
    newMessages: alreadyLoaded ? [] : [{ role: 'user', content: body, meta: 'skill' }],
  };
}

// Only selection triggers enter the model's listing. Descriptions belong to
// the UI; operating instructions arrive in the body through Skill().
const SKILL_MANIFEST_TRIGGER_MAX = 250;
const SKILL_MANIFEST_TRIGGER_MIN = 60;
// Whole-manifest ceiling (~1% of a 200k-token window at 4 chars/token).
const SKILL_MANIFEST_CHAR_BUDGET = 8_000;

function compactSkillManifestText(value, max = SKILL_MANIFEST_TRIGGER_MAX) {
  return compactPromptManifestText(value, max);
}

function skillManifestToolNames(skill) {
  const dependencies = Array.isArray(skill?.toolDependencies) ? skill.toolDependencies : [];
  return [
    ...new Set(
      dependencies
        .filter(
          (entry) => ['tool', 'mcp'].includes(entry?.type) && /^[A-Za-z0-9_.:-]+$/.test(String(entry?.value || ''))
        )
        .map((entry) => (entry.type === 'mcp' ? `mcp:${entry.value}` : entry.value))
    ),
  ];
}

/**
 * Build the compact skill manifest shown to the model.
 * Full SKILL.md content is still loaded only through Skill(name).
 */
export function buildSkillManifest(skills, { limit = 80, charBudget = SKILL_MANIFEST_CHAR_BUDGET } = {}) {
  if (skillsDisabled()) return '';
  const list = (Array.isArray(skills) ? skills : [])
    .map((skill) => ({
      name: String(skill?.name || '').trim(),
      trigger: String(skill?.whenToUse || '').trim(),
      linkedTools: skillManifestToolNames(skill),
    }))
    .filter((skill) => skill.name)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (!list.length) return '';
  const max = Math.max(1, Number(limit) || 80);
  const visible = list.slice(0, max);
  // Names are never truncated; the shared budget only shrinks triggers,
  // evenly, down to the readable floor.
  const budget = Math.max(1_000, Number(charBudget) || SKILL_MANIFEST_CHAR_BUDGET);
  const toolSuffix = (skill) => (skill.linkedTools.length ? ` [tools: ${skill.linkedTools.join(', ')}]` : '');
  const nameOverhead = visible.reduce((sum, skill) => sum + skill.name.length + toolSuffix(skill).length + 4, 0);
  const perEntry = Math.floor((budget - nameOverhead) / visible.length);
  const triggerCap = Math.min(
    SKILL_MANIFEST_TRIGGER_MAX,
    Math.max(SKILL_MANIFEST_TRIGGER_MIN, Number.isFinite(perEntry) ? perEntry : SKILL_MANIFEST_TRIGGER_MAX)
  );
  for (const skill of visible) skill.trigger = compactSkillManifestText(skill.trigger, triggerCap);
  const lines = [
    '# available-skills',
    'Selection triggers and linked tools for Skill({"name":"<skill-name>"}). mcp:<server> denotes that server’s tools.',
    '<available_skills>',
    ...visible.map(
      (skill) => (skill.trigger ? `- ${skill.name}: ${skill.trigger}` : `- ${skill.name}`) + toolSuffix(skill)
    ),
    ...(list.length > visible.length ? [`- ... ${list.length - visible.length} more skills omitted`] : []),
    '</available_skills>',
  ];
  return lines.join('\n');
}

/**
 * Build the fixed skill loader meta-tool.
 * A tiny stable schema keeps provider cache keys steady; concrete skill
 * listings/content are resolved at call time.
 *
 * The structure is constant regardless of how many skills are in scope.
 * Non-agent sessions only expose the loader when a skill exists; agent
 * sessions always expose it so the schema shape stays fixed. Memoise so
 * every createSession doesn't rebuild
 * identical objects (trivial work, but the allocation noise shows up in
 * repeated Pool C fan-out).
 */
let _skillToolDefsCache = null;
/**
 * @param {Array} skills       — discovered skill frontmatter list (may be empty)
 * @param {object} [opts]
 * @param {boolean} [opts.ownerIsAgentSession=false]
 *   Agent sessions ALWAYS include the meta-tool regardless of the current
 *   cwd's skill inventory — the concrete skill list is resolved at tool-call
 *   time (cwd-scoped) so the tool schema stays bit-identical across roles /
 *   cwds and the provider cache shard does not fragment.
 *   Non-agent sessions keep the historical "empty when skills.length===0"
 *   behaviour.
 */
export function buildSkillToolDefs(skills, { ownerIsAgentSession = false } = {}) {
  if (skillsDisabled()) return [];
  if (!ownerIsAgentSession && !skills.length) return [];
  if (_skillToolDefsCache) return _skillToolDefsCache;
  _skillToolDefsCache = [
    {
      name: 'Skill',
      title: 'Skill',
      annotations: {
        title: 'Skill',
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        agentHidden: false,
      },
      description:
        'Load or refresh an available skill’s SKILL.md before task actions when its body is missing or needs an update. Reuse a body already in context for matching requests; a later turn or repeated mention is not a reason to call Skill again.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact name from available-skills.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  ];
  return _skillToolDefsCache;
}
