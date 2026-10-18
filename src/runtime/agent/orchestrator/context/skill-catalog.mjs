// Skill discovery, cache, resource loading, envelopes, manifests, and the
// Skill meta-tool.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, readdirSync, statSync, watch as watch_ } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { maxMtimeRecursive, mtimeSignatureRecursive, mtimeSignatureText } from '../cache-mtime.mjs';
import { mixdogHome, resolvePluginData, mixdogRoot } from '../../../shared/plugin-paths.mjs';
import { PLUGIN_MANIFEST_FILES, pluginSkillsRoots } from '../../../shared/plugin-manifest.mjs';
import {
  parseSkillDocument,
  SKILL_TRIGGER_LISTING_MAX,
  SKILL_TRIGGER_LISTING_MIN,
} from '../../../shared/skill-document.mjs';
import { readSkillToolDependencies, skillToolDependenciesRoot } from '../../../shared/skill-tool-dependencies.mjs';
import { SKILL_LAUNCHER_COMMAND } from '../../../shared/skill-script-runtime.mjs';
import { loadConfig, normalizeSkillsConfig } from '../config.mjs';
import { builtinFeatureActive, withGrandfatheredBuiltins } from '../runtime-core/builtin-features.mjs';
import { SKILL_TOOL } from '../runtime-core/tool-defs.mjs';
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

/** Paths whose own mtime (no recursion) gates the skill list for enabled
 *  registered plugins: every manifest file, plus the nearest existing ancestor
 *  of each candidate skills root (so a skills dir created later is noticed). */
function pluginShallowWatchPaths() {
  const registryPath = pluginRegistryPath();
  let registry;
  try {
    registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
  } catch {
    return [];
  }
  const paths = [];
  for (const entry of Array.isArray(registry?.plugins) ? registry.plugins : []) {
    if (entry?.enabled === false) continue;
    const root = entry && typeof entry.root === 'string' ? entry.root : null;
    if (!root || !existsSync(root)) continue;
    for (const rel of PLUGIN_MANIFEST_FILES) paths.push(join(root, ...rel.split('/')));
    for (const skillsDir of pluginSkillsRoots(root)) {
      let dir = skillsDir;
      while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
      paths.push(dir);
    }
  }
  return paths;
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
    { dir: mixdogGlobalDir('skills'), source: 'global', plugin: null },
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
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (raw != null) list = String(raw).split(',');
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

function findCachedSkillByKey(key, skills = null) {
  return (skills || collectSkillsCached(null)).find((entry) => normalizeSkillNameKey(entry.name) === key);
}

/** `skills`: optional snapshot from one collectSkillsCached() call, reused so a
 *  batch of per-skill checks scans the disk once. */
export function isSkillDisabled(name, config = null, skills = null) {
  const n = normalizeSkillNameKey(name);
  if (!n) return false;
  const skill = findCachedSkillByKey(n, skills);
  if (!followsBuiltinFeature(skill) && getDisabledSkillNameSet(config).has(n)) return true;
  return Boolean(skill && missingFeature(skill, featureConfig(config)));
}

/**
 * `enabled` for every skill of one collectSkillsCached() snapshot, exactly as
 * `!(isSkillDisabled(name, config, skills) || skillMissingFeature(name, config,
 * skills))` per skill — but with ONE config read, one disabled-name set and one
 * name index for the whole list instead of three config reads and a linear
 * lookup per skill (the status listing blocked the event loop on them).
 */
export function skillEnabledFlags(skills, config = null) {
  const list = Array.isArray(skills) ? skills : [];
  const cfg = config || loadConfig({ secrets: false });
  const disabled = getDisabledSkillNameSet(cfg);
  const features = featureConfig(cfg);
  const byKey = new Map();
  for (const entry of list) {
    const key = normalizeSkillNameKey(entry.name);
    if (!byKey.has(key)) byKey.set(key, entry);
  }
  return list.map((entry) => {
    const key = normalizeSkillNameKey(entry.name);
    const skill = byKey.get(key);
    if (key && !followsBuiltinFeature(skill) && disabled.has(key)) return false;
    return !(skill && missingFeature(skill, features));
  });
}

/** The built-in feature a skill needs that is not active, or null. */
export function skillMissingFeature(name, config = null, skills = null) {
  const skill = findCachedSkillByKey(normalizeSkillNameKey(name), skills);
  return skill ? missingFeature(skill, featureConfig(config)) : null;
}

/** True when an installed skill exists but its (or its plugin's) project scope
 *  excludes `cwd` — the same scope rule filterSkillsExcludingDisabled applies. */
export function skillOutsideScope(name, cwd, config = null, skills = null) {
  const skill = findCachedSkillByKey(normalizeSkillNameKey(name), skills);
  if (!skill) return false;
  return !skillAllowedForCwd(extensionScopesFromConfig(featureConfig(config)), skill, cwd);
}

/** The Skill tool result for a skill skillOutsideScope refuses. */
export function skillOutsideScopeError(name) {
  return `Error: skill "${name}" is not available in this project (its project scope excludes the current folder)`;
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
// --- Global skill cache (mtime-based) ---
const _skillsCache = new Map();

// Change watchers over the recursive skill roots. Re-walking every skill
// folder (one stat per entry) on every status/prompt read blocked the event
// loop for tens to hundreds of ms with a large skill set. A root whose
// recursive watcher has reported nothing since its last walk reuses that
// walk's signature text instead; any event, watcher error or explicit
// invalidation re-walks it. A watched root is trusted only once an event-loop
// turn has passed since its walk.
// Freshness contract: every write made through the app (addSkill, saveSkill,
// setDisabledSkills, reloadSkills, settings/plugin mutations, peer-runtime
// announcements) calls invalidateSkillsCache synchronously, which drops every
// watch, so the very next read re-walks and is exact. A passive edit made
// outside the app is eventually consistent: it is seen once the watcher
// delivers its event (watcher latency), or at the next explicit invalidation.
// Roots that cannot be watched (missing, or unsupported by the platform) and
// every plain-file gate path are stat'ed on every call as before.
const _ROOT_WATCH_LIMIT = 64;
const _rootWatches = new Map(); // root -> { watcher, dirty, text, settled }

function _closeRootWatch(root) {
  const watch = _rootWatches.get(root);
  if (!watch) return;
  _rootWatches.delete(root);
  try {
    watch.watcher.close();
  } catch {
    /* already closed */
  }
}

function _closeAllRootWatches() {
  for (const root of [..._rootWatches.keys()]) _closeRootWatch(root);
}

function _openRootWatch(root) {
  let isDir = false;
  try {
    isDir = statSync(root).isDirectory();
  } catch {
    return null;
  }
  if (!isDir) return null;
  if (_rootWatches.size >= _ROOT_WATCH_LIMIT) _closeAllRootWatches();
  const watch = { watcher: null, dirty: true, text: null, settled: false };
  try {
    // A change anywhere below drops the root's reused walk; the watcher is
    // closed with it (a re-walk re-opens one), so a churning folder never
    // keeps a handle on directories being deleted.
    watch.watcher = watch_(root, { recursive: true, persistent: false }, () => _closeRootWatch(root));
    watch.watcher.on('error', () => _closeRootWatch(root));
  } catch {
    return null;
  }
  _rootWatches.set(root, watch);
  return watch;
}

/** Signature text of one recursive gate root (see mtimeSignatureText). */
function _rootSignatureText(root) {
  const current = _rootWatches.get(root);
  if (current && !current.dirty && current.settled) return current.text;
  // Open the watcher BEFORE the walk: a change racing the walk then either
  // shows in it or arrives as an event that drops the reused text.
  const watch = current || _openRootWatch(root);
  const text = mtimeSignatureText([root]);
  if (watch && _rootWatches.get(root) === watch) {
    watch.text = text;
    watch.dirty = false;
    watch.settled = false;
    setImmediate(() => {
      if (_rootWatches.get(root) === watch && watch.text === text) watch.settled = true;
    }).unref?.();
  }
  return text;
}

export function collectSkillsCached(cwd) {
  if (skillsDisabled()) return [];
  void cwd;
  const key = 'global';
  // Same mixdog-owned dirs collectSkills() reads, used as the freshness gate.
  const skillsDirs = [mixdogGlobalDir('skills')];
  skillsDirs.push(skillToolDependenciesRoot());
  skillsDirs.push(...pluginSkillDirs().map(({ dir }) => dir), ...builtinSkillDirs());
  // registry.json itself gates plugin add/remove: removal deletes the
  // plugin's skills dir (so no dir mtime advances), but saveRegistry()
  // always rewrites this file. It is a plain file: stat'ed directly.
  const registryPath = pluginRegistryPath();
  // Exact gate: unwatched roots and plain files are stat'ed every call; a
  // watched root reuses its last walk only while its watcher stayed quiet.
  // The shallow watch list covers manifest edits and skill roots that do not
  // exist yet.
  const rootTexts = skillsDirs.map((dir) => _rootSignatureText(dir));
  if (registryPath) rootTexts.push(mtimeSignatureText([registryPath]));
  const signature = `${createHash('sha1').update(rootTexts.join('\n')).digest('hex')}|${mtimeSignatureRecursive(pluginShallowWatchPaths(), 0)}`;
  const entry = _skillsCache.get(key);
  if (entry && entry.signature === signature) {
    return entry.value;
  }
  const skills = collectSkills(cwd);
  _skillsCache.set(key, { value: skills, signature });
  capMapSize(_skillsCache);
  return skills;
}
export function invalidateSkillsCache(cwd) {
  void cwd;
  _skillsCache.clear();
  _closeAllRootWatches();
}

/**
 * Directory the model hands to external processes for a skill. A packaged
 * desktop runtime reads built-in skills from inside `runtime.asar`, which only
 * Electron can open; the build ships them as real files beside the archive
 * under `runtime.asar.unpacked`, so a built-in skill's directory points there.
 * Every other source keeps its own on-disk directory.
 */
export function skillExecutionDir(dir, source) {
  if (source !== 'builtin') return dir;
  return String(dir).replace(/([\\/])runtime\.asar(?=[\\/]|$)/, '$1runtime.asar.unpacked');
}

/**
 * Load full skill content plus its on-disk directory (for base-dir + ${MIXDOG_SKILL_DIR};
 * ${MIXDOG_SKILL_NODE} is resolved at render time in buildSkillResultEnvelope).
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
      dir: skillExecutionDir(dirname(skill.filePath), skill.source),
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
  // `${MIXDOG_SKILL_NODE}` runs a bundled script on this daemon's own runtime
  // (plain node cannot load runtime internals from a packaged archive). It is
  // one shell-neutral command name that model shells find on their PATH.
  body = body.replace(/\$\{MIXDOG_SKILL_NODE\}/g, SKILL_LAUNCHER_COMMAND);
  if (skillDir) {
    const normDir = String(skillDir).replace(/\\/g, '/');
    body = body.replace(/\$\{MIXDOG_SKILL_DIR\}/g, () => normDir);
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
// Whole-manifest ceiling (~1% of a 200k-token window at 4 chars/token).
const SKILL_MANIFEST_CHAR_BUDGET = 8_000;

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
    SKILL_TRIGGER_LISTING_MAX,
    Math.max(SKILL_TRIGGER_LISTING_MIN, Number.isFinite(perEntry) ? perEntry : SKILL_TRIGGER_LISTING_MAX)
  );
  for (const skill of visible) skill.trigger = compactPromptManifestText(skill.trigger, triggerCap);
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
  _skillToolDefsCache = [SKILL_TOOL];
  return _skillToolDefsCache;
}
