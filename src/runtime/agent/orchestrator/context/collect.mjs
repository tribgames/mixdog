import { readFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { maxMtimeRecursive } from '../cache-mtime.mjs';
import { resolvePluginData, mixdogRoot } from '../../../shared/plugin-paths.mjs';
import {
    parseMarkdownFrontmatter,
    readMarkdownDocument,
} from '../../../shared/markdown-frontmatter.mjs';
import { loadConfig, normalizeSkillsConfig } from '../config.mjs';

// --- mixdog asset roots (standalone CLI owns its own paths; never .claude) ---
// Project-local:  <cwd>/.mixdog/<kind>
// Data-local:     <mixdogData>/<kind>   (standalone default: ~/.mixdog/data/<kind>)
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
function mixdogProjectDir(projectDir, kind) {
    return projectDir ? join(projectDir, '.mixdog', kind) : null;
}
/** Ordered asset search dirs for a kind: project-local first, then global. */
function mixdogAssetDirs(projectDir, kind) {
    const dirs = [];
    const local = mixdogProjectDir(projectDir, kind);
    if (local) dirs.push(local);
    dirs.push(mixdogGlobalDir(kind));
    return dirs;
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
        const root = entry && typeof entry.root === 'string' ? entry.root : null;
        if (!root || !existsSync(root))
            continue;
        const skillsDir = join(root, 'skills');
        if (existsSync(skillsDir))
            dirs.push(skillsDir);
    }
    return dirs;
}
/**
 * Collect available skills (frontmatter only — token efficient).
 * Full content loaded on demand via loadSkillContent().
 */
export function collectSkills(cwd) {
    // When cwd is null/missing (e.g. agent maintenance callers that pass
    // cwd:null on purpose so provider-cache shards don't fork per caller
    // workspace), skip project-scoped skills entirely — DO NOT fall back
    // to process.cwd(), which would leak the MCP launch dir into the
    // shard key and fragment the cache.
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    const skills = [];
    // mixdog-owned only (never .claude): project-local <cwd>/.mixdog/skills
    // first, then user-global. When cwd is missing, only the global dir is
    // searched.
    const dirs = mixdogAssetDirs(projectDir, 'skills');
    // Plugin-provided skills load last so project-local and global mixdog
    // skill dirs keep precedence; `seen` below dedupes by frontmatter name.
    dirs.push(...pluginSkillDirs());
    const seen = new Set();
    for (const dir of dirs) {
        if (!existsSync(dir))
            continue;
        try {
            const files = readdirSync(dir, { recursive: true });
            for (const f of files) {
                if (!String(f).endsWith('.md'))
                    continue;
                const filePath = join(dir, String(f));
                const content = readSafe(filePath);
                if (!content)
                    continue;
                const fm = parseMarkdownFrontmatter(content);
                if (!fm.name)
                    continue;
                if (seen.has(fm.name))
                    continue;
                seen.add(fm.name);
                skills.push({
                    name: fm.name,
                    description: fm.description || '',
                    filePath,
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

export function getDisabledSkillNameSet(config = null) {
    const cfg = config || loadConfig({ secrets: false });
    const keys = normalizeSkillsConfig(cfg.skills).disabled
        .map((n) => normalizeSkillNameKey(n))
        .filter(Boolean);
    return new Set(keys);
}

export function isSkillDisabled(name, config = null) {
    const n = normalizeSkillNameKey(name);
    if (!n) return false;
    return getDisabledSkillNameSet(config).has(n);
}

export function filterSkillsExcludingDisabled(skills, config = null) {
    const disabled = getDisabledSkillNameSet(config);
    if (!disabled.size) return Array.isArray(skills) ? skills : [];
    return (Array.isArray(skills) ? skills : []).filter((s) => {
        const key = normalizeSkillNameKey(s?.name);
        return key && !disabled.has(key);
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
    const key = cwd ?? '';
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    // Same mixdog-owned dirs collectSkills() reads, used as the freshness gate.
    const skillsDirs = mixdogAssetDirs(projectDir, 'skills');
    skillsDirs.push(...pluginSkillDirs());
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
/**
 * Load full skill content by name.
 */
export function loadSkillContent(name, cwd) {
    const skills = collectSkillsCached(cwd);
    const skill = skills.find(s => s.name === name);
    if (!skill)
        return null;
    return readSafe(skill.filePath);
}

/**
 * Load full skill content plus its on-disk directory (for base-dir + ${MIXDOG_SKILL_DIR}).
 */
export function loadSkillResource(name, cwd) {
    const skills = collectSkillsCached(cwd);
    const skill = skills.find(s => s.name === name);
    if (!skill)
        return null;
    const content = readSafe(skill.filePath);
    if (content == null)
        return null;
    return { content, dir: dirname(skill.filePath), filePath: skill.filePath };
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
export function buildSkillStub(name) {
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

function compactSkillManifestText(value, max = 180) {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, Math.max(1, max - 3))}...` : text;
}

/**
 * Build the compact skill manifest shown to the model.
 * Full SKILL.md content is still loaded only through Skill(name).
 */
export function buildSkillManifest(skills, { limit = 80 } = {}) {
    const list = (Array.isArray(skills) ? skills : [])
        .map((skill) => ({
            name: String(skill?.name || '').trim(),
            description: compactSkillManifestText(skill?.description || ''),
        }))
        .filter((skill) => skill.name)
        .sort((a, b) => a.name.localeCompare(b.name));
    if (!list.length) return '';
    const max = Math.max(1, Number(limit) || 80);
    const visible = list.slice(0, max);
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

export function bp1HasDeferredToolManifestBlock(text) {
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
            : compactSkillManifestText(String(entry?.description || '').replace(/[<>]/g, ''));
        list.push({ name, description });
    }
    if (!list.length) return '';
    list.sort((a, b) => a.name.localeCompare(b.name));
    return [
        '<available-deferred-tools>',
        'You may call any tool listed below directly by name with its arguments; it auto-loads on first call.',
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
 */
export function buildMcpInstructionsManifest(mcpServerInstructions, poolNames) {
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
        const tools = [...toolsByServer.get(server)].sort((a, b) => a.localeCompare(b));
        lines.push(`## ${safeServer}`, body, ...tools.map((tool) => `- ${tool}`));
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
// the block keeps its original position and no sibling BP1 block (skills
// manifest, agent rules, …) is reordered or dropped. The fresh manifest already
// carries the mcp-instructions companion, so any pre-existing standalone one is
// removed first to avoid duplication.
export function rebuildDeferredToolManifestBlock(text, manifest) {
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
 * Inject the skill-style deferred pool (name + description) into BP1 at session
 * start. Normally once; with `{ rebuild: true }` it strips any existing
 * <available-deferred-tools>/<mcp-instructions> block and re-injects the fresh
 * pool in place (used by the first-turn MCP refresh, before the prompt renders,
 * so late-connected MCP tools land in the INITIAL manifest — never duplicated).
 */
export function applyInitialDeferredToolManifestToBp1(session, poolNames, options = {}) {
    const rebuild = options?.rebuild === true;
    if (!session || !Array.isArray(session.messages)) return false;
    if (session.deferredToolBp1Applied && !rebuild) return false;
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
    let idx = -1;
    for (let i = 0; i < session.messages.length; i++) {
        if (session.messages[i]?.role === 'system') {
            idx = i;
            break;
        }
    }
    if (idx === -1) return false;
    const raw = typeof session.messages[idx].content === 'string' ? session.messages[idx].content : '';
    if (bp1HasDeferredToolManifestBlock(raw) && !rebuild) {
        session.deferredToolBp1Applied = true;
        return true;
    }
    if (manifest) {
        if (rebuild && bp1HasDeferredToolManifestBlock(raw)) {
            // Anchored in-place rebuild: swap the previously injected manifest
            // block for the fresh one at its EXISTING position.
            session.messages[idx].content = rebuildDeferredToolManifestBlock(raw, manifest);
        } else {
            const base = stripDeferredToolManifestBlock(raw);
            session.messages[idx].content = base
                ? `${base}\n\n---\n\n${manifest}`
                : manifest;
        }
    }
    session.deferredToolBp1Applied = true;
    session.updatedAt = Date.now();
    return true;
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
    if (!ownerIsAgentSession && !skills.length) return [];
    if (_skillToolDefsCache) return _skillToolDefsCache;
    _skillToolDefsCache = [
        {
            name: 'Skill',
            description: 'Load a named SKILL.md into context.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                },
                required: ['name'],
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
    isInboundEventAgent,
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

function loadAgentSections(pluginRoot) {
    const agentsDir = join(pluginRoot, 'agents');
    const agentSections = [];
    if (!existsSync(agentsDir)) return agentSections;
    // agents/ holds two layouts that must BOTH be loaded:
    //   - flat:    agents/<agent>.md                (legacy: scheduler-task, webhook-handler)
    //   - nested:  agents/<agent>/AGENT.md          (current: worker, heavy-worker, reviewer, …)
    // The previous flat-only readdir silently dropped every nested agent, so a
    // public agent like heavy-worker produced an EMPTY scoped instruction block
    // (BP2) — the model lost its agent contract and the tool smoke's
    // "heavy-worker AGENT.md must be included" assertion failed. Walk both.
    let entries;
    try {
        entries = readdirSync(agentsDir, { withFileTypes: true });
    } catch {
        return agentSections;
    }
    const sections = [];
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
        sections.push({ name, text: `## ${name}\n\n${body}` });
    }
    sections.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const s of sections) agentSections.push(s.text);
    return agentSections;
}

// Empty by design: scoped agent markdown already rides BP2 for every provider.
// Keeping the set in place preserves the old branch point for a future
// provider-specific experiment without changing today's cache layout.
const EXPLICIT_CACHE_PROVIDERS = new Set();

// Inbound-event maintenance agents that report results back to Lead are
// declared via `inboundEvent: true` in defaults/agents.json and read
// through isInboundEventAgent(). Such agents must follow
// rules/agent/20-skip-protocol.md so genuine no-ops (label-only events,
// dedup, "nothing to report") prefix their output with `[meta:silent]` and the
// dispatch layer suppresses the Lead inject. Other agents (cycle1/cycle2 memory
// maintenance, retrieval agents) never emit toward Lead.

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
                join(pluginRoot, 'agents'),
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
    const agentIsInboundEvent = agent && classification.maintenance.has(agent)
        ? isInboundEventAgent(agent)
        : false;

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
            // shard, eliminating the agent-shard miss seen on Pool C
            // transitions for openai-oauth/openai. This branch is disabled by the
            // empty provider set above; BP2 remains the active agent surface.
            agentRuleSectionsToEmit = hiddenPairs.map(p => `## ${p.name}\n\n${p.body}`);
            agentSectionsToEmit = agentSections;
        } else if (agent && classification.retrieval.has(agent)) {
            // Retrieval agents (explorer) get their own contract section
            // (rules/agent/30-explorer.md) in BP2.
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
            // Inbound-event agents also need the skip-protocol rule so they
            // can opt their no-op outputs out of the Lead inject (BP1 would
            // waste the bytes on unrelated agents).
            if (agentIsInboundEvent) {
                const skip = hiddenPairs.find(p => p.name === 'skip-protocol');
                if (skip) agentRuleSectionsToEmit.push(`## ${skip.name}\n\n${skip.body}`);
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
// Returns { baseRules, stableSystemContext, sessionMarker, volatileTail } mapping
// directly to the breakpoint plan:
//   BP1 (1h, system block #1) = baseRules — shared tool policy + compact skill manifest
//   BP2 (1h, system block #2) = stableSystemContext — Lead/agent/hidden role system
//   BP3 (1h, system block #3) = sessionMarker — stable memory/meta context
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

    // ── BP1: shared tool/skill layer ────────────────────────────────────
    const baseParts = [];
    if (opts.agentRules) baseParts.push(opts.agentRules);
    if (!_skip.skills && opts.skillManifest && typeof opts.skillManifest === 'string' && opts.skillManifest.trim()) {
        baseParts.push(opts.skillManifest.trim());
    }
    // deferredToolManifest: optional BP1 slice; production path is applyInitialDeferredToolManifestToBp1 once after applyDeferredToolSurface.
    if (opts.deferredToolManifest && typeof opts.deferredToolManifest === 'string' && opts.deferredToolManifest.trim()) {
        baseParts.push(opts.deferredToolManifest.trim());
    }
    const baseRules = baseParts.join('\n\n---\n\n');

    // ── BP2: role/system layer ─────────────────────────────────────────
    const roleInstructionContext = opts.skipRoleCatalog
        ? ''
        : loadScopedRoleInstructions(opts.agent || null, opts.provider || null);
    const stableSystemParts = [];
    // Active workflow contract leads the role layer: it must outrank the
    // generic role/tool guidance below it, not trail the profile/meta block
    // in BP3 (observed: leads deprioritized delegation rules that sat behind
    // ~3KB of profile/output-style text).
    if (opts.workflowContext && typeof opts.workflowContext === 'string' && opts.workflowContext.trim()) {
        stableSystemParts.push(opts.workflowContext.trim());
    }
    if (opts.roleRules) stableSystemParts.push(opts.roleRules);
    if (opts.userPrompt) stableSystemParts.push(opts.userPrompt);
    if (roleInstructionContext) stableSystemParts.push(roleInstructionContext);
    const stableSystemContext = stableSystemParts.join('\n\n---\n\n');

    // ── BP3: stable memory/meta layer ──────────────────────────────────
    // sessionMarker is injected by session/manager as its own `system` role
    // block (the 3rd system block). It carries the tier3 1h cache_control on
    // the Anthropic providers and pins language/name (Profile Preferences)
    // instructions as a real system directive rather than a user reminder.
    const sessionMarkerParts = [];
    if (opts.metaContext && typeof opts.metaContext === 'string' && opts.metaContext.trim()) {
        sessionMarkerParts.push(opts.metaContext.trim());
    }
    if (!_skip.memory && opts.coreMemoryContext && typeof opts.coreMemoryContext === 'string' && opts.coreMemoryContext.trim()) {
        sessionMarkerParts.push('# Core Memory\n' + opts.coreMemoryContext.trim());
    }
    const sessionMarker = sessionMarkerParts.length
        ? sessionMarkerParts.join('\n\n')
        : '';

    // ── BP4: live message tail ─────────────────────────────────────────
    // Raw role, permission, and task labels are intentionally omitted: role
    // selection already shapes the session/rules/tools, permissions are
    // enforced structurally, and the task body is sent as the actual user turn
    // by askSession().
    const volatileParts = [];
    // workspaceContext (current cwd + discovered project list) is intentionally
    // NOT injected: it inlines the cwd/project layout into the prompt, which the
    // model does not need (tools read the live cwd at call time) and which would
    // otherwise re-fragment the cache / go stale after an in-place cwd switch.
    const volatileTail = volatileParts.length > 0
        ? volatileParts.join('\n\n')
        : '';

    return { baseRules, stableSystemContext, sessionMarker, volatileTail };
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
