import { readFileSync, existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { maxMtimeRecursive } from '../cache-mtime.mjs';
import { resolvePluginData, mixdogRoot } from '../../../shared/plugin-paths.mjs';
import {
    parseMarkdownFrontmatter,
    readMarkdownDocument,
} from '../../../shared/markdown-frontmatter.mjs';

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
// --- Skill cache (mtime-based, keyed by cwd) ---
const _skillsCache = new Map();
const _mtimeCache = new Map();
const _MTIME_TTL_MS = 2000;
export function collectSkillsCached(cwd) {
    const key = cwd ?? '';
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    // Same mixdog-owned dirs collectSkills() reads, used as the freshness gate.
    const skillsDirs = mixdogAssetDirs(projectDir, 'skills');
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
// --- Role-scoped instruction loader ---
// Emits a BP3 block scoped to the calling role:
//   - Public/custom agents: their own agents/<role>.md when present,
//     plus the public agent-worker contract.
//   - Hidden roles: their own rules/agent/<role>.md section only.
//   - Null role: falls back to the full all-in-one block
//     (explicit-cache unified-shard path).
//
// Role-specific markdown intentionally rides BP3, behind the shared system
// prefix, so cache breakpoints move from common/stable to role-varying.
//
// Classification is dynamic — hidden retrieval/maintenance sets come from the
// `kind` field in internal-roles.mjs. Any other non-null role is public/custom.
import {
    listHiddenRolesByKind,
    isHiddenRole,
    getRoleCatalogShareAgents,
    isInboundEventRole,
} from '../internal-roles.mjs';

function loadRoleClassification() {
    // Not cached — called only on instruction rebuild (mtime-busted), and
    // listHiddenRolesByKind now reads from the mtime-aware cache inside
    // internal-roles.mjs so the classification always reflects the current
    // hidden-roles.json on disk.
    return {
        retrieval: new Set(listHiddenRolesByKind('retrieval')),
        maintenance: new Set(listHiddenRolesByKind('maintenance')),
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

function loadHiddenRoleSnippets(pluginRoot) {
    try {
        const agentRulesDir = join(pluginRoot, 'rules', 'agent');
        if (!existsSync(agentRulesDir)) return [];
        const files = readdirSync(agentRulesDir)
            .filter(f => f.endsWith('.md') && f !== '00-common.md')
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
    const files = readdirSync(agentsDir)
        .filter(f => f.endsWith('.md'))
        .sort();
    for (const f of files) {
        const raw = readSafe(join(agentsDir, f));
        if (!raw) continue;
        const { body } = readMarkdownDocument(raw);
        if (!body) continue;
        const name = f.replace(/\.md$/, '');
        agentSections.push(`## ${name}\n\n${body}`);
    }
    return agentSections;
}

// Empty by design: scoped role markdown no longer rides BP2. Keeping the set
// in place preserves the old branch point for a future provider-specific
// experiment without changing today's cache layout.
const EXPLICIT_CACHE_PROVIDERS = new Set();

// Inbound-event maintenance roles that report results back to Lead are
// declared via `inboundEvent: true` in defaults/hidden-roles.json and read
// through isInboundEventRole(). Such roles must follow
// rules/agent/20-skip-protocol.md so genuine no-ops (label-only events,
// dedup, "nothing to report") prefix their output with `[meta:silent]` and the
// dispatch layer suppresses the Lead inject. Other roles (cycle1/cycle2 memory
// maintenance, retrieval roles) never emit toward Lead.

export function loadScopedRoleInstructions(role, provider = null) {
    const useUnified = !!(provider && EXPLICIT_CACHE_PROVIDERS.has(provider));
    const cacheKey = useUnified ? '__unified__' : (role || '__all__');
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
                join(pluginRoot, 'defaults', 'hidden-roles.json'),
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
    // Compute classification before file loading — internal-roles metadata
    // failures (malformed/missing hidden-roles.json) must propagate, not be
    // silently swallowed by the file-IO catch below.
    const classification = loadRoleClassification();
    const roleSharesCatalog = role && classification.retrieval.has(role)
        ? new Set(getRoleCatalogShareAgents(role))
        : new Set();
    const roleIsInboundEvent = role && classification.maintenance.has(role)
        ? isInboundEventRole(role)
        : false;

    try {
        const agentSections = loadAgentSections(pluginRoot);
        const hiddenPairs = loadHiddenRoleSnippets(pluginRoot);

        // Pick which agent-rule sections + agents/<role>.md sections to emit
        // based on role classification. Self-only emit keeps BP3 minimal.
        let agentRuleSectionsToEmit = null; // null -> drop the agent-rule block entirely
        let agentSectionsToEmit = agentSections; // default: full (unknown-role fallback)
        if (useUnified) {
            // Explicit-cache providers — every role sees the same all-in-one
            // instruction surface. Cross-role calls hit the same provider-side prefix
            // shard, eliminating the role-shard miss seen on Pool C
            // transitions for codex/openai. This branch is disabled by the
            // empty provider set above; BP3 remains the active role surface.
            agentRuleSectionsToEmit = hiddenPairs.map(p => `## ${p.name}\n\n${p.body}`);
            agentSectionsToEmit = agentSections;
        } else if (role && classification.retrieval.has(role)) {
            // Retrieval roles (explorer) get their own contract section
            // (rules/agent/30-explorer.md) in BP3.
            const self = hiddenPairs.find(p => p.name === role);
            agentRuleSectionsToEmit = self ? [`## ${self.name}\n\n${self.body}`] : [];
            agentSectionsToEmit = agentSections.filter(s =>
                [...roleSharesCatalog].some(name => s.startsWith(`## ${name}\n`)));
        } else if (role && classification.maintenance.has(role)) {
            const self = hiddenPairs.find(p => p.name === role);
            agentRuleSectionsToEmit = [];
            if (self) {
                agentRuleSectionsToEmit.push(`## ${self.name}\n\n${self.body}`);
            } else {
                // Fallback: maintenance role without rules/agent/*.md entry —
                // pull self body from agents/<role>.md instead so newly-added
                // hidden roles work without needing a duplicate agent rule file.
                const fromAgent = agentSections.find(s => s.startsWith(`## ${role}\n`));
                if (fromAgent) agentRuleSectionsToEmit.push(fromAgent);
            }
            // Inbound-event roles also need the skip-protocol rule so they
            // can opt their no-op outputs out of the Lead inject (BP1 would
            // waste the bytes on unrelated agents).
            if (roleIsInboundEvent) {
                const skip = hiddenPairs.find(p => p.name === 'skip-protocol');
                if (skip) agentRuleSectionsToEmit.push(`## ${skip.name}\n\n${skip.body}`);
            }
            agentSectionsToEmit = [];
        } else if (role) {
            // Public/custom role — self-only agents/<role>.md when present,
            // not the full hidden/maintenance bundle. The universal agent
            // contract rides BP1 (rules/agent/00-common.md).
            agentRuleSectionsToEmit = [];
            agentSectionsToEmit = agentSections.filter(s => s.startsWith(`## ${role}\n`));
        } else {
            // Null role — full instruction surface emitted (explicit-cache providers that
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
//   BP1 (1h, system block #1) = baseRules      — agent common rules, filtered
//   BP2 (1h, system block #2) = stableSystemContext — reserved stable system layer
//   BP3 (1h, first <system-reminder> user)     = sessionMarker (role md + stable role/session context)
//   BP4 (5m, messages tail)                    = volatileTail (compact memory)
//
// Design note — why volatile per-call context sits in BP4, not BP3:
//   BP3 is reserved for file-authored/user-authored markdown context:
//   scoped role md (agents/<role>.md, rules/agent/<role>.md), skill
//   manifests, and role-specific schedule/webhook instruction md. The live
//   task itself is sent as the actual user turn, so BP4 stays free of task
//   duplicates.
//   Role semantics live in the selected role/rule surface, and permission is
//   enforced by the exposed tool set rather than repeated as prompt text.
//
// BP1 inputs:
//   - opts.agentRules    : rules-builder buildAgentInjectionContent output
//                           (Pool B roles share bit-identical prefix)
//   - opts.userPrompt     : explicit systemPrompt override from callsite
//
// BP3 role-md inputs:
//   - loadScopedRoleInstructions(opts.role, opts.provider)
//
// BP3/BP4 inputs:
//   - opts.workflowContext : active workflow + agent catalog, captured at session start
//   - opts.workspaceContext : cwd + project list snapshot, captured at session start
//   - opts.role           : agent role name or hidden-role registry name
//   - opts.coreMemoryContext : compact core memory context
//
// `profile.skip` still filters specific buckets (claudemd, skills, memory)
// for backward compatibility with existing profiles.
export function composeSystemPrompt(opts) {
    const profile = opts.profile || null;
    const _skip = profile?.skip || {};

    // ── BP1: baseRules (system block #1, 1h cache) ─────────────────────
    // Agent common rules + explicit systemPrompt override. Contains
    // agentRules (MCP instructions, Pool B shared rules, _shared/tool
    // efficiency). Identical across ALL roles — BP1 shared pool-wide.
    const baseParts = [];
    if (opts.agentRules) baseParts.push(opts.agentRules);
    if (opts.userPrompt) baseParts.push(opts.userPrompt);
    const baseRules = baseParts.join('\n\n---\n\n');

    // ── BP2: reserved stable system layer ───────────────────────────────
    // Per-role/user-authored markdown rides in BP3 as user context, matching
    // Claude Code's "memory files are context, not system prompt" behavior.
    // Keep BP2 empty unless we have a truly common/stable system layer.
    const stableSystemContext = '';

    // ── BP3 role markdown context ───────────────────────────────────────
    const roleInstructionContext = opts.skipRoleCatalog
        ? ''
        : loadScopedRoleInstructions(opts.role || null, opts.provider || null);

    // ── BP3: sessionMarker (first <system-reminder> user msg, 1h cache) ─
    // Claude Code-style file/user-authored context, active workflow, plus
    // stable role-specific task instructions. The
    // <!-- bp3-sentinel --> tag is what Anthropic's findTier3Index() matches
    // on to claim a 1h BP3 slot.
    const sessionMarkerParts = [];
    if (roleInstructionContext) {
        sessionMarkerParts.push(roleInstructionContext);
    }
    if (opts.roleSpecific) {
        sessionMarkerParts.push(opts.roleSpecific);
    }
    if (!_skip.skills && opts.skillManifest && typeof opts.skillManifest === 'string' && opts.skillManifest.trim()) {
        sessionMarkerParts.push(opts.skillManifest.trim());
    }
    if (opts.workflowContext && typeof opts.workflowContext === 'string' && opts.workflowContext.trim()) {
        sessionMarkerParts.push(opts.workflowContext.trim());
    }
    const sessionMarker = sessionMarkerParts.length
        ? '<!-- bp3-sentinel -->\n' + sessionMarkerParts.join('\n\n')
        : '';

    // ── BP4-adjacent: volatileTail (second user <system-reminder>, 5m) ──
    // Only compact carry-over context remains here. Raw role, permission, and
    // task labels are intentionally omitted: role selection already shapes the
    // session/rules/tools, permissions are enforced structurally, and the task
    // body is sent as the actual user turn by askSession().
    const volatileParts = [];
    // workspaceContext (current cwd + discovered project list) is intentionally
    // NOT injected: it inlines the cwd/project layout into the prompt, which the
    // model does not need (tools read the live cwd at call time) and which would
    // otherwise re-fragment the cache / go stale after an in-place cwd switch.
    if (opts.coreMemoryContext && typeof opts.coreMemoryContext === 'string' && opts.coreMemoryContext.trim()) {
        volatileParts.push('# Core Memory\n' + opts.coreMemoryContext.trim());
    }
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
// depth cap: marketplaces/<plugin>/skills/ is depth 2 from pluginBase
function walkForSkills(dir, result, depth = 0) {
    if (depth > 3) return;
    try {
        const entries = readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.name === 'node_modules')
                continue;
            const full = join(dir, entry.name);
            if (entry.isDirectory()) {
                if (entry.name === 'skills') {
                    result.push(full);
                }
                else {
                    walkForSkills(full, result, depth + 1);
                }
            }
        }
    }
    catch { /* ignore */ }
}
