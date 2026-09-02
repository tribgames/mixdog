import { readFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join } from 'path';
import { maxMtimeRecursive } from '../cache-mtime.mjs';
import { resolvePluginData, mixdogRoot } from '../../../shared/plugin-paths.mjs';
import { readMarkdownDocument } from '../../../shared/markdown-frontmatter.mjs';
import { parseSkillDocument } from '../../../shared/skill-document.mjs';
import { loadConfig, normalizeSkillsConfig } from '../config.mjs';
import { builtinFeatureActive, withGrandfatheredBuiltins } from '../../../../session-runtime/builtin-features.mjs';

function skillsDisabled() {
    return /^(?:1|true|on|yes)$/i.test(String(process.env.MIXDOG_DISABLE_SKILLS || ''));
}

// --- mixdog asset roots (standalone CLI owns its own paths; never .claude) ---
// Skills are machine-global under <mixdogData>/skills. Project-local skill
// directories are intentionally outside the runtime resolution chain.
function mixdogHome() {
    return process.env.MIXDOG_HOME || join(homedir(), '.mixdog');
}

function mixdogGlobalDir(kind) {
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
 * Skills shipped inside the package (src/defaults/skills/<name>/). Read in
 * place, never copied: a release updates them immediately, and a user-global
 * or plugin skill with the same name shadows the built-in one.
 */
export function builtinSkillsDir() {
    return join(mixdogRoot(), 'defaults', 'skills');
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
 * errors) and yield `<root>/skills` for each registered plugin whose `root`
 * exists on disk and has a `skills` subdirectory.
 */
function pluginSkillDirs() {
    const registryPath = pluginRegistryPath();
    if (!registryPath)
        return [];
    let registry;
    try {
        registry = JSON.parse(readFileSync(registryPath, 'utf-8'));
    } catch {
        return [];
    }
    if (!registry || !Array.isArray(registry.plugins))
        return [];
    const dirs = [];
    for (const entry of registry.plugins) {
        if (entry?.enabled === false)
            continue;
        const root = entry && typeof entry.root === 'string' ? entry.root : null;
        if (!root || !existsSync(root))
            continue;
        const skillsDir = join(root, 'skills');
        if (existsSync(skillsDir))
            dirs.push({ dir: skillsDir, plugin: String(entry.id || entry.name || '') || null });
    }
    return dirs;
}
/**
 * Collect available skills (frontmatter only — token efficient).
 * Full content loaded on demand via loadSkillContent().
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
        { dir: builtinSkillsDir(), source: 'builtin', plugin: null },
    ];
    const seen = new Set();
    for (const { dir, source, plugin } of sources) {
        if (!existsSync(dir))
            continue;
        try {
            const files = readdirSync(dir, { recursive: true });
            for (const f of files) {
                if (basename(String(f)) !== 'SKILL.md')
                    continue;
                const filePath = join(dir, String(f));
                const content = readSafe(filePath);
                if (!content)
                    continue;
                let skill;
                try {
                    skill = parseSkillDocument(content);
                } catch {
                    continue;
                }
                // Agent Skills requires the manifest name to match its folder.
                if (basename(dirname(filePath)) !== skill.name)
                    continue;
                if (seen.has(skill.name))
                    continue;
                seen.add(skill.name);
                skills.push({
                    name: skill.name,
                    description: skill.description,
                    filePath,
                    source,
                    plugin,
                    requires: requiredFeatures(skill.frontmatter),
                });
            }
        }
        catch { /* ignore */ }
    }
    return skills;
}

function normalizeSkillNameKey(name) {
    return String(name || '').trim().toLowerCase();
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
    const keys = normalizeSkillsConfig(cfg.skills).disabled
        .map((n) => normalizeSkillNameKey(n))
        .filter(Boolean);
    return new Set(keys);
}

export function isSkillDisabled(name, config = null) {
    const n = normalizeSkillNameKey(name);
    if (!n) return false;
    if (getDisabledSkillNameSet(config).has(n)) return true;
    const skill = collectSkillsCached(null).find((entry) => normalizeSkillNameKey(entry.name) === n);
    return Boolean(skill && missingFeature(skill, featureConfig(config)));
}

/** The built-in feature a skill needs that is not active, or null. */
export function skillMissingFeature(name, config = null) {
    const n = normalizeSkillNameKey(name);
    const skill = collectSkillsCached(null).find((entry) => normalizeSkillNameKey(entry.name) === n);
    return skill ? missingFeature(skill, featureConfig(config)) : null;
}

export function filterSkillsExcludingDisabled(skills, config = null) {
    if (skillsDisabled()) return [];
    const cfg = featureConfig(config);
    const disabled = getDisabledSkillNameSet(cfg);
    return (Array.isArray(skills) ? skills : []).filter((s) => {
        const key = normalizeSkillNameKey(s?.name);
        return key && !disabled.has(key) && !missingFeature(s, cfg);
    });
}

export function collectPromptSkillsCached(cwd, config = null) {
    return filterSkillsExcludingDisabled(collectSkillsCached(cwd), config);
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
    skillsDirs.push(...pluginSkillDirs(), builtinSkillsDir());
    // registry.json itself gates plugin add/remove: removal deletes the
    // plugin's skills dir (so no dir mtime advances), but saveRegistry()
    // always rewrites this file. maxMtimeRecursive stats plain files directly.
    const registryPath = pluginRegistryPath();
    if (registryPath)
        skillsDirs.push(registryPath);
    let mtime;
    const mtimeCached = _mtimeCache.get(key);
    if (mtimeCached && Date.now() - mtimeCached.checkedAt < _MTIME_TTL_MS) {
        mtime = mtimeCached.mtime;
    } else {
        mtime = maxMtimeRecursive(skillsDirs);
        _mtimeCache.set(key, { mtime, checkedAt: Date.now() });
        if (_mtimeCache.size > 16) {
            _mtimeCache.delete(_mtimeCache.keys().next().value);
        }
    }
    const entry = _skillsCache.get(key);
    if (entry && entry.mtime >= mtime) {
        return entry.value;
    }
    const skills = collectSkills(cwd);
    _skillsCache.set(key, { value: skills, mtime });
    if (_skillsCache.size > 16) {
        _skillsCache.delete(_skillsCache.keys().next().value);
    }
    return skills;
}
export function invalidateSkillsCache(cwd) {
    void cwd;
    _skillsCache.clear();
    _mtimeCache.clear();
}
/**
 * Load full skill content by name.
 */
function loadSkillContent(name, cwd) {
    const skills = collectSkillsCached(cwd);
    const skill = skills.find(s => s.name === name);
    if (!skill)
        return null;
    const content = readSafe(skill.filePath);
    if (content == null) return null;
    try {
        return parseSkillDocument(content).body;
    } catch {
        return null;
    }
}

/**
 * Load full skill content plus its on-disk directory (for base-dir + ${MIXDOG_SKILL_DIR}).
 */
export function loadSkillResource(name, cwd) {
    const skillName = String(name || '').trim();
    if (!skillName)
        return null;
    const skills = collectSkillsCached(cwd);
    const skill = skills.find(s => s.name === skillName);
    if (!skill)
        return null;
    const content = readSafe(skill.filePath);
    if (content == null)
        return null;
    try {
        return {
            content: parseSkillDocument(content).body,
            dir: dirname(skill.filePath),
            filePath: skill.filePath,
        };
    } catch {
        return null;
    }
}

function escapeSkillXmlText(value) {
    return String(value || '').replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[ch]));
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
function buildSkillStub(name) {
    return `Loaded skill: ${String(name || '').trim()}`;
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
 */
export function buildSkillToolEnvelope(name, content, skillDir) {
    return {
        __toolEnvelope: true,
        result: buildSkillStub(name),
        newMessages: [
            { role: 'user', content: buildSkillResultEnvelope(name, content, skillDir), meta: 'skill' },
        ],
    };
}

// Listing entries are for MATCHING only (full SKILL.md arrives via Skill()),
// but a mid-word cut at 100 chars ("...gamerscroll.c...") destroyed the very
// trigger phrase the model matches on. Skill descriptions lead with their
// trigger phrase, so a 150-char word-boundary cap keeps the matching core
// while trimming workflow detail the Skill() load supplies anyway.
const SKILL_MANIFEST_DESC_MAX = 150;
const SKILL_MANIFEST_DESC_MIN = 60;
// Whole-manifest ceiling (~1% of a 200k-token window at 4 chars/token).
const SKILL_MANIFEST_CHAR_BUDGET = 8_000;

function compactSkillManifestText(value, max = SKILL_MANIFEST_DESC_MAX) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    const limit = Math.max(1, Math.floor(max));
    if (text.length <= limit) return text;
    const head = text.slice(0, Math.max(1, limit - 1));
    const space = head.lastIndexOf(' ');
    const cut = space >= Math.floor(limit * 0.6) ? head.slice(0, space) : head;
    return `${cut.replace(/[\s,.;:!?/\-]+$/, '')}...`;
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
            description: String(skill?.description || ''),
        }))
        .filter((skill) => skill.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return '';
    const max = Math.max(1, Number(limit) || 80);
    const visible = list.slice(0, max);
    // Names are never truncated; the shared budget only shrinks descriptions,
    // evenly, down to the readable floor.
    const budget = Math.max(1_000, Number(charBudget) || SKILL_MANIFEST_CHAR_BUDGET);
    const nameOverhead = visible.reduce((sum, skill) => sum + skill.name.length + 4, 0);
    const perEntry = Math.floor((budget - nameOverhead) / visible.length);
    const descCap = Math.min(
        SKILL_MANIFEST_DESC_MAX,
        Math.max(SKILL_MANIFEST_DESC_MIN, Number.isFinite(perEntry) ? perEntry : SKILL_MANIFEST_DESC_MAX),
    );
    for (const skill of visible) skill.description = compactSkillManifestText(skill.description, descCap);
    const lines = [
        '# available-skills',
        'Call Skill({"name":"<skill-name>"}) when a skill description matches the task. Load the skill before following its workflow.',
        '<available_skills>',
        ...visible.map((skill) => `- ${skill.name}: ${skill.description || 'No description.'}`),
        ...(list.length > visible.length ? [`- ... ${list.length - visible.length} more skills omitted`] : []),
        '</available_skills>',
    ];
    return lines.join('\n');
}

const DEFERRED_TOOLS_BLOCK_RE = /(\n\n---\n*)?<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>\s*/gi;
const MCP_INSTRUCTIONS_BLOCK_RE = /(\n\n---\n*)?<mcp-instructions>[\s\S]*?<\/mcp-instructions>\s*/gi;
const DEFERRED_TOOL_NAME_SAFE_RE = /^[A-Za-z0-9_.:-]+$/;
const MCP_SERVER_NAME_SAFE_RE = /^[A-Za-z0-9_.:-]+$/;
const MCP_INSTRUCTION_MAX_CHARS = 600;

function sanitizeDeferredToolManifestName(name) {
    const text = String(name || '').trim();
    if (!text || text.includes('<') || text.includes('>')) return '';
    if (!DEFERRED_TOOL_NAME_SAFE_RE.test(text)) return '';
    return text;
}

function hasDeferredToolManifestBlock(text) {
    const raw = String(text || '');
    return /<available-deferred-tools>[\s\S]*?<\/available-deferred-tools>/i.test(raw)
        || /<mcp-instructions>[\s\S]*?<\/mcp-instructions>/i.test(raw);
}

/**
 * Skill-style manifest for tools in the deferred pool (catalog minus active
 * wire tools). Each entry is either a bare name string or `{ name, description }`;
 * output lines are `- name: description` (description omitted when absent),
 * mirroring the available-skills manifest so the model calls deferred tools
 * directly. Descriptions are compacted and stripped of `<`/`>`.
 * Empty pool → '' (caller omits the block).
 */
export function buildDeferredToolManifest(entries) {
    const list = [];
    const seen = new Set();
    for (const entry of Array.isArray(entries) ? entries : []) {
        const rawName = typeof entry === 'string' ? entry : entry?.name;
        const name = sanitizeDeferredToolManifestName(rawName);
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const description = typeof entry === 'string'
            ? ''
            : compactSkillManifestText(String(entry?.description || '').replace(/[<>]/g, ''), 100);
        list.push({ name, description });
    }
    if (!list.length) return '';
    list.sort((a, b) => a.name.localeCompare(b.name));
    return [
        '<available-deferred-tools>',
        'You may call any tool listed below directly by name with its arguments; it auto-loads on first call. When you do not know its exact arguments, call load_tool first to surface the schema.',
        ...list.map((entry) => (entry.description ? `- ${entry.name}: ${entry.description}` : `- ${entry.name}`)),
        '</available-deferred-tools>',
    ].join('\n');
}

function sanitizeMcpManifestServerName(name) {
    const text = String(name || '').trim();
    if (!text || text.includes('<') || text.includes('>')) return '';
    if (!MCP_SERVER_NAME_SAFE_RE.test(text)) return '';
    return text;
}

function sanitizeMcpInstructionText(text, max = MCP_INSTRUCTION_MAX_CHARS) {
    const stripped = String(text || '').replace(/[<>]/g, '').trim();
    if (!stripped) return '';
    const cap = Math.max(1, Number(max) || MCP_INSTRUCTION_MAX_CHARS);
    return stripped.length > cap ? `${stripped.slice(0, Math.max(1, cap - 3))}...` : stripped;
}

/**
 * Per-server MCP initialize instructions for deferred-pool tools only.
 * Empty when no instructions or no matching deferred MCP tools → omit block.
 * Emits ONLY the server heading + instruction body: the per-server tool names
 * are deliberately NOT repeated here — every pool tool is already listed once
 * (with its description) in <available-deferred-tools>, and re-listing ~30
 * names per server doubled the MCP share of the BP2 prefix (2026-08-05 audit).
 * Server membership stays evident from the mcp__<server>__ name prefix.
 */
function buildMcpInstructionsManifest(mcpServerInstructions, poolNames) {
    const map = mcpServerInstructions && typeof mcpServerInstructions === 'object'
        ? mcpServerInstructions
        : {};
    const pool = [...new Set((Array.isArray(poolNames) ? poolNames : [])
        .map((name) => sanitizeDeferredToolManifestName(name))
        .filter(Boolean))];
    const toolsByServer = new Map();
    for (const name of pool) {
        const match = name.match(/^mcp__(.+?)__(.+)$/);
        if (!match) continue;
        const server = match[1];
        if (!toolsByServer.has(server)) toolsByServer.set(server, []);
        toolsByServer.get(server).push(name);
    }
    const servers = [...toolsByServer.keys()]
        .filter((server) => sanitizeMcpManifestServerName(server)
            && sanitizeMcpInstructionText(map[server])
            && toolsByServer.get(server).length)
        .sort((a, b) => a.localeCompare(b));
    if (!servers.length) return '';
    const lines = ['<mcp-instructions>'];
    for (const server of servers) {
        const safeServer = sanitizeMcpManifestServerName(server);
        const body = sanitizeMcpInstructionText(map[server]);
        lines.push(`## ${safeServer}`, body);
    }
    lines.push('</mcp-instructions>');
    return lines.join('\n');
}

export function stripDeferredToolManifestBlock(text) {
    return String(text || '')
        .replace(DEFERRED_TOOLS_BLOCK_RE, '')
        .replace(MCP_INSTRUCTIONS_BLOCK_RE, '')
        .replace(/\n\n---\n*$/,'')
        .trimEnd();
}

// Rebuild path: replace the FIRST previously-injected <available-deferred-tools>
// block (with its leading `---` separator) with the fresh manifest IN PLACE, so
// the block keeps its original position and no sibling BP2 block (skills
// manifest, agent rules, …) is reordered or dropped. The fresh manifest already
// carries the mcp-instructions companion, so any pre-existing standalone one is
// removed first to avoid duplication.
function rebuildDeferredToolManifestBlock(text, manifest) {
    let out = String(text || '').replace(MCP_INSTRUCTIONS_BLOCK_RE, '');
    let replaced = false;
    out = out.replace(DEFERRED_TOOLS_BLOCK_RE, (match, sep) => {
        if (replaced) return '';
        replaced = true;
        return `${sep || ''}${manifest}`;
    });
    if (!replaced) {
        const base = out.trimEnd();
        out = base ? `${base}\n\n---\n\n${manifest}` : manifest;
    }
    return out;
}

/**
 * Inject the skill-style deferred pool (name + description) into BP2 at session
 * start. Normally once; with `{ rebuild: true }` it strips any existing
 * <available-deferred-tools>/<mcp-instructions> block and re-injects the fresh
 * pool in place (used by the first-turn MCP refresh, before the prompt renders,
 * so late-connected MCP tools land in the INITIAL manifest — never duplicated).
 */
export function applyInitialDeferredToolManifestToBp2(session, poolNames, options = {}) {
    const rebuild = options?.rebuild === true;
    if (!session || !Array.isArray(session.messages)) return false;
    if (session.deferredToolBp2Applied && !rebuild) return false;
    const pool = Array.isArray(poolNames) ? poolNames : [];
    const descByName = new Map();
    for (const tool of Array.isArray(session?.deferredToolCatalog) ? session.deferredToolCatalog : []) {
        const name = String(tool?.name || '').trim();
        if (name && !descByName.has(name)) descByName.set(name, String(tool?.description || ''));
    }
    const entries = pool.map((name) => ({ name, description: descByName.get(String(name).trim()) || '' }));
    const parts = [];
    const deferredManifest = buildDeferredToolManifest(entries);
    if (deferredManifest) parts.push(deferredManifest);
    const mcpManifest = buildMcpInstructionsManifest(session.mcpServerInstructions, pool);
    if (mcpManifest) parts.push(mcpManifest);
    const manifest = parts.join('\n\n');
    if (!manifest) {
        for (const message of session.messages) {
            if (message?.role === 'system' && typeof message.content === 'string') {
                message.content = stripDeferredToolManifestBlock(message.content);
            }
        }
        session.messages = session.messages.filter((message) => (
            message?.role !== 'system' || String(message.content || '').trim()
        ));
        session.deferredToolBp2Applied = true;
        delete session.deferredToolBp1Applied;
        session.updatedAt = Date.now();
        return true;
    }

    const existingMessage = session.messages.find((message) => (
        message?.role === 'system'
        && typeof message.content === 'string'
        && hasDeferredToolManifestBlock(message.content)
    ));
    const systemIndexes = session.messages
        .map((message, index) => (message?.role === 'system' ? index : -1))
        .filter((index) => index >= 0);
    if (!systemIndexes.length) return false;
    const tier3Index = systemIndexes.find((index) => session.messages[index]?.cacheTier === 'tier3');
    let idx = systemIndexes.length >= 2 && systemIndexes[1] !== tier3Index
        ? systemIndexes[1]
        : -1;
    if (idx < 0) {
        idx = tier3Index >= 0 ? tier3Index : systemIndexes[0] + 1;
        session.messages.splice(idx, 0, { role: 'system', content: '' });
    }
    if (existingMessage === session.messages[idx] && !rebuild) {
        session.deferredToolBp2Applied = true;
        delete session.deferredToolBp1Applied;
        return true;
    }
    for (let i = 0; i < session.messages.length; i++) {
        if (i === idx || session.messages[i]?.role !== 'system' || typeof session.messages[i].content !== 'string') continue;
        session.messages[i].content = stripDeferredToolManifestBlock(session.messages[i].content);
    }
    const raw = typeof session.messages[idx].content === 'string' ? session.messages[idx].content : '';
    if (rebuild && hasDeferredToolManifestBlock(raw)) {
        // Anchored in-place rebuild: swap the previously injected manifest
        // block for the fresh one at its EXISTING position.
        session.messages[idx].content = rebuildDeferredToolManifestBlock(raw, manifest);
    } else {
        const base = stripDeferredToolManifestBlock(raw);
        session.messages[idx].content = base
            ? `${base}\n\n---\n\n${manifest}`
            : manifest;
    }
    session.deferredToolBp2Applied = true;
    delete session.deferredToolBp1Applied;
    session.updatedAt = Date.now();
    return true;
}

// Compatibility for external callers compiled against the old layer name.
export const applyInitialDeferredToolManifestToBp1 = applyInitialDeferredToolManifestToBp2;

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
            description: 'Load a named SKILL.md into context.',
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
import {
    listHiddenAgentsByKind,
    isHiddenAgent,
    getAgentCatalogShareAgents,
} from '../internal-agents.mjs';

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
// Short-TTL gate for the role-instruction freshness stat. loadScopedRoleInstructions() ran
// maxMtimeRecursive() over agents/ + rules/agent/ on EVERY call (many per
// turn across roles), so even a warm cache paid dozens of statSync per turn.
// Mirror collectSkillsCached(): only re-stat after _ROLE_INSTRUCTIONS_MTIME_TTL_MS, and
// trust the cached mtime within that window. Edits still propagate within ~1
// stat interval, which is well under human-perceptible latency.
const _scopedRoleInstructionsMtimeCache = new Map();
const _ROLE_INSTRUCTIONS_MTIME_TTL_MS = 2000;

function loadHiddenAgentSnippets(pluginRoot) {
    try {
        const agentRulesDir = join(pluginRoot, 'rules', 'agent');
        if (!existsSync(agentRulesDir)) return [];
        const files = readdirSync(agentRulesDir)
            .filter(f => f.endsWith('.md') && f !== '00-common.md' && f !== '00-core.md')
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
    } catch { /* unresolvable data dir — built-in roles still load */ }
    return dirs;
}

function loadAgentSections(pluginRoot) {
    // agents/ accepts both the compatibility flat layout and the current
    // nested agents/<agent>/AGENT.md layout.
    // The previous flat-only readdir silently dropped every nested agent, so a
    // public agent like heavy-worker produced an EMPTY scoped instruction block
    // (BP2) — the model lost its agent contract and the tool smoke's
    // "heavy-worker AGENT.md must be included" assertion failed. Walk both.
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
            if (!name || !raw) continue;
            const { body } = readMarkdownDocument(raw);
            if (!body) continue;
            byName.set(name, `## ${name}\n\n${body}`);
        }
    }
    return [...byName.entries()]
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
        .map(([, text]) => text);
}

// Empty by design: scoped agent markdown already rides BP2 for every provider.
// Keeping the set in place preserves the old branch point for a future
// provider-specific experiment without changing today's cache layout.
const EXPLICIT_CACHE_PROVIDERS = new Set();

export function loadScopedRoleInstructions(agent, provider = null) {
    const useUnified = !!(provider && EXPLICIT_CACHE_PROVIDERS.has(provider));
    const cacheKey = useUnified ? '__unified__' : (agent || '__all__');
    const cached = _scopedRoleInstructionsCache.get(cacheKey);
    const pluginRoot = mixdogRoot();
    // Use maxMtimeRecursive so edits to .md files inside agents/ and
    // rules/agent/ propagate — parent dir mtime is unchanged on
    // Linux/macOS when only a nested file's content changes. Gate the stat
    // behind a short TTL so repeated same-turn calls reuse the last mtime
    // instead of re-walking the trees on every invocation.
    let mtime = 0;
    if (pluginRoot) {
        const mtimeCached = _scopedRoleInstructionsMtimeCache.get(cacheKey);
        if (mtimeCached && Date.now() - mtimeCached.checkedAt < _ROLE_INSTRUCTIONS_MTIME_TTL_MS) {
            mtime = mtimeCached.mtime;
        } else {
            mtime = maxMtimeRecursive([
                ...agentSectionDirs(pluginRoot),
                join(pluginRoot, 'rules', 'agent'),
                join(pluginRoot, 'defaults', 'agents.json'),
            ]);
            _scopedRoleInstructionsMtimeCache.set(cacheKey, { mtime, checkedAt: Date.now() });
            if (_scopedRoleInstructionsMtimeCache.size > 16) {
                _scopedRoleInstructionsMtimeCache.delete(_scopedRoleInstructionsMtimeCache.keys().next().value);
            }
        }
    }
    if (cached && mtime <= cached.mtime) {
        return cached.value;
    }
    // Compute classification before file loading — internal-agents metadata
    // failures (malformed/missing agents.json) must propagate, not be
    // silently swallowed by the file-IO catch below.
    const classification = loadAgentClassification();
    const agentSharesCatalog = agent && classification.retrieval.has(agent)
        ? new Set(getAgentCatalogShareAgents(agent))
        : new Set();
    try {
        const agentSections = loadAgentSections(pluginRoot);
        const hiddenPairs = loadHiddenAgentSnippets(pluginRoot);

        // Pick which agent-rule sections + agents/<agent>.md sections to emit
        // based on agent classification. Self-only emit keeps BP2 minimal.
        let agentRuleSectionsToEmit = null; // null -> drop the agent-rule block entirely
        let agentSectionsToEmit = agentSections; // default: full (unknown-agent fallback)
        if (useUnified) {
            // Explicit-cache providers — every agent sees the same all-in-one
            // instruction surface. Cross-agent calls hit the same provider-side prefix
            // prefix, eliminating the cross-agent cache miss seen on Pool C
            // transitions for openai-oauth/openai. This branch is disabled by the
            // empty provider set above; BP2 remains the active agent surface.
            agentRuleSectionsToEmit = hiddenPairs.map(p => `## ${p.name}\n\n${p.body}`);
            agentSectionsToEmit = agentSections;
        } else if (agent && classification.retrieval.has(agent)) {
            // Retrieval agents get their own contract section in BP2.
            const self = hiddenPairs.find(p => p.name === agent);
            agentRuleSectionsToEmit = self ? [`## ${self.name}\n\n${self.body}`] : [];
            agentSectionsToEmit = agentSections.filter(s =>
                [...agentSharesCatalog].some(name => s.startsWith(`## ${name}\n`)));
        } else if (agent && classification.maintenance.has(agent)) {
            const self = hiddenPairs.find(p => p.name === agent);
            agentRuleSectionsToEmit = [];
            if (self) {
                agentRuleSectionsToEmit.push(`## ${self.name}\n\n${self.body}`);
            } else {
                // Self body from agents/<agent>.md for a maintenance agent
                // without a rules/agent/*.md entry so newly-added hidden agents
                // work without needing a duplicate agent rule file.
                const fromAgent = agentSections.find(s => s.startsWith(`## ${agent}\n`));
                if (fromAgent) agentRuleSectionsToEmit.push(fromAgent);
            }
            agentSectionsToEmit = [];
        } else if (agent) {
            // Public/custom agent — self-only agents/<agent>.md when present,
            // not the full hidden/maintenance bundle. The universal agent
            // contract rides BP2 (rules/agent/00-common.md).
            agentRuleSectionsToEmit = [];
            agentSectionsToEmit = agentSections.filter(s => s.startsWith(`## ${agent}\n`));
        } else {
            // Null agent — full instruction surface emitted (explicit-cache providers that
            // shard by __all__ key).
            agentRuleSectionsToEmit = hiddenPairs.map(p => `## ${p.name}\n\n${p.body}`);
            // agentSectionsToEmit already set to full agentSections above.
        }

        const blocks = [];
        if (agentSectionsToEmit.length) {
            blocks.push(`# Agent Role Catalog\n\n${agentSectionsToEmit.join('\n\n---\n\n')}`);
        }
        if (agentRuleSectionsToEmit && agentRuleSectionsToEmit.length) {
            blocks.push(`# Agent Role Rules\n\n${agentRuleSectionsToEmit.join('\n\n---\n\n')}`);
        }
        const value = blocks.join('\n\n---\n\n');
        _scopedRoleInstructionsCache.set(cacheKey, { mtime, value });
        return value;
    } catch {
        return '';
    }
}

// --- Compose system prompt — 4-BP cache layout ---
// Returns the three stable system blocks and the BP3 core used for refreshes.
// directly to the breakpoint plan:
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
export function composeSystemPrompt(opts) {
    const profile = opts.profile || null;
    const _skip = profile?.skip || {};

    // ── BP1: globally shared tool policy ────────────────────────────────
    const baseParts = [];
    if (opts.agentRules) baseParts.push(opts.agentRules);
    const baseRules = baseParts.join('\n\n---\n\n');

    // ── BP2: persistent profile/tool catalog layer ──────────────────────
    const stableSystemParts = [];
    if (opts.metaContext && typeof opts.metaContext === 'string' && opts.metaContext.trim()) {
        stableSystemParts.push(opts.metaContext.trim());
    }
    if (!_skip.skills && opts.skillManifest && typeof opts.skillManifest === 'string' && opts.skillManifest.trim()) {
        stableSystemParts.push(opts.skillManifest.trim());
    }
    // deferredToolManifest: optional BP2 slice; production path is
    // applyInitialDeferredToolManifestToBp2 once after applyDeferredToolSurface.
    if (opts.deferredToolManifest && typeof opts.deferredToolManifest === 'string' && opts.deferredToolManifest.trim()) {
        stableSystemParts.push(opts.deferredToolManifest.trim());
    }
    const stableSystemContext = stableSystemParts.join('\n\n---\n\n');

    // ── BP3: workflow/role + session environment layer ─────────────────
    const roleInstructionContext = opts.skipRoleCatalog
        ? ''
        : loadScopedRoleInstructions(opts.agent || null, opts.provider || null);
    const sessionMarkerParts = [];
    // Keep the active workflow first within BP3 so it leads the role and
    // environment material that varies with the session.
    if (opts.workflowContext && typeof opts.workflowContext === 'string' && opts.workflowContext.trim()) {
        sessionMarkerParts.push(opts.workflowContext.trim());
    }
    if (opts.roleRules) sessionMarkerParts.push(opts.roleRules);
    if (opts.userPrompt) sessionMarkerParts.push(opts.userPrompt);
    if (roleInstructionContext) sessionMarkerParts.push(roleInstructionContext);
    if (!_skip.memory && opts.coreMemoryContext && typeof opts.coreMemoryContext === 'string' && opts.coreMemoryContext.trim()) {
        sessionMarkerParts.push('# Core Memory\n' + opts.coreMemoryContext.trim());
    }
    // Response language closes the stable core: it must be the last
    // behavioral instruction before the conversation so the pre-tool preamble
    // is not pulled toward the English rule blocks that precede it.
    if (opts.languageContext && typeof opts.languageContext === 'string' && opts.languageContext.trim()) {
        sessionMarkerParts.push(opts.languageContext.trim());
    }
    const sessionMarkerCore = sessionMarkerParts.length
        ? sessionMarkerParts.join('\n\n---\n\n')
        : '';
    const environmentParts = [];
    for (const value of [
        opts.sessionStartContext,
        opts.projectInstructionsContext,
        opts.environmentContext,
    ]) {
        if (typeof value === 'string' && value.trim()) environmentParts.push(value.trim());
    }
    // Volatile session/project environment. Kept OUT of sessionMarkerCore so
    // Anthropic providers can leave it as an UNMARKED system block (covered by
    // the messages-tail breakpoint) while prefix-order providers still see it
    // after the stable context. sessionMarker keeps the combined legacy shape
    // for callers that consume a single BP3 string.
    const sessionEnvironment = environmentParts.join('\n\n---\n\n');
    const sessionMarker = [sessionMarkerCore, sessionEnvironment]
        .filter(Boolean)
        .join('\n\n---\n\n');

    return { baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment, sessionMarker };
}
// --- Helpers ---
function readSafe(path) {
    try {
        if (!existsSync(path))
            return null;
        const content = readFileSync(path, 'utf-8').trim();
        return content || null;
    }
    catch {
        return null;
    }
}
