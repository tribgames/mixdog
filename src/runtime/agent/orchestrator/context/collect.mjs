import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { maxMtime, maxMtimeRecursive } from '../cache-mtime.mjs';
import { resolvePluginData } from '../../../shared/plugin-paths.mjs';

// --- mixdog asset roots (standalone CLI owns its own paths; never .claude) ---
// Project-local:  <cwd>/.mixdog/<kind>
// User-global:    <pluginData>/<kind>   (e.g. ~/.mixdog/data/<kind>)
function mixdogGlobalDir(kind) {
    try {
        return join(resolvePluginData(), kind);
    } catch {
        return join(homedir(), '.mixdog', 'data', kind);
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
// Built-in role-identity defaults for the well-known PUBLIC bridge roles.
// Mirrors setup.html's WF_DEFAULT_ROLE_IDENTITY so the role-identity feature
// works on a fresh install (no roles/<role>.md on disk) without forcing the
// user to open the config UI first. A saved custom body in roles/<role>.md
// always overrides these; unknown and hidden roles are absent here and so
// inject nothing, leaving hidden roles fully plugin-managed.
export const DEFAULT_ROLE_IDENTITY = {
    'worker': 'You are an implementation worker. Your job is to make the scoped code change quickly and safely, not to fully verify the product. Run only lightweight, targeted self-checks needed to avoid handing off obviously broken code. Broad verification belongs to the Lead/reviewer.',
    'heavy-worker': 'You are a heavy implementation worker for vague, open-ended, or multi-file changes. Your job is to make the scoped change with enough local design judgment to keep files coherent, while keeping validation lightweight. Do not run broad/full verification unless explicitly requested; report what remains for Lead/reviewer.',
    'reviewer': 'You are a correctness reviewer. Your job is to decide whether the change is ship-ready. Report only blocking correctness issues, or return SHIP-READY. Do not perform style review, broad refactors, or extra implementation.',
    'debugger': 'You are a debugging specialist. Your job is to diagnose root cause, minimal repro, and the smallest safe fix direction. Do not implement. Return evidence-backed cause and proposed fix scope, or clearly state what remains unknown.',
};
// --- Agent template loading ---
/**
 * Load an agent MD file (Worker.md, Reviewer.md, etc.) as session instructions.
 * Strips frontmatter, returns the body.
 */
// Agent template cache — mtime-invalidated per (name, cwd).
const _agentTemplateCache = new Map();
export function loadAgentTemplate(name, cwd) {
    // When cwd is null/missing (bridge maintenance callers like cycle1-agent
    // pass cwd:null on purpose so provider-cache shards don't fork per MCP
    // launch dir), skip the project-scoped template lookup entirely — DO NOT
    // fall back to process.cwd(), which would leak the launcher's working
    // directory into the cache key and fragment the shard per caller workspace.
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    const key = `${name}|${projectDir ?? '__noproject__'}`;
    // Search paths for agent files (mixdog-owned only; never .claude).
    // Project-local <cwd>/.mixdog/agents first, then user-global. When cwd is
    // missing the project entry is skipped; the global dir still applies so the
    // "no template found → null" contract is preserved via the readSafe loop.
    const agentDirs = mixdogAssetDirs(projectDir, 'agents');
    const searchPaths = agentDirs.map((dir) => join(dir, `${name}.md`));
    // Freshness gate: the same agents/ dirs that hold the files.
    const mtimePaths = [...agentDirs];
    const mtime = maxMtimeRecursive(mtimePaths);
    const cached = _agentTemplateCache.get(key);
    if (cached && mtime <= cached.mtime) return cached.value;
    for (const p of searchPaths) {
        const content = readSafe(p);
        if (content) {
            // Strip YAML frontmatter
            const stripped = content.replace(/^---\n[\s\S]*?\n---\n*/, '');
            const body = stripped.trim();
            _agentTemplateCache.set(key, { mtime, value: body });
            return body;
        }
    }
    _agentTemplateCache.set(key, { mtime, value: null });
    return null;
}
/**
 * Collect available skills (frontmatter only — token efficient).
 * Full content loaded on demand via loadSkillContent().
 */
export function collectSkills(cwd) {
    // When cwd is null/missing (e.g. bridge maintenance callers that pass
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
                const fm = parseFrontmatter(content);
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
/**
 * Build slim skill tool definitions (Hermes-style 3-tool split).
 * The skill catalogue is served at runtime via `skills_list` rather than
 * inlined into tool descriptions, keeping per-session schema bytes small.
 *
 * The structure is constant regardless of how many skills are in scope —
 * the 3-tool shape only shows up when `skills.length > 0`, and the slot
 * contents never change. Memoise so every createSession doesn't rebuild
 * identical objects (trivial work, but the allocation noise shows up in
 * repeated Pool C fan-out).
 */
let _skillToolDefsCache = null;
/**
 * @param {Array} skills       — discovered skill frontmatter list (may be empty)
 * @param {object} [opts]
 * @param {boolean} [opts.ownerIsBridge=false]
 *   Bridge sessions ALWAYS include the 3 meta-tools regardless of the current
 *   cwd's skill inventory — the concrete skill list is resolved at tool-call
 *   time (cwd-scoped) so the tool schema stays bit-identical across roles /
 *   cwds and the provider cache shard does not fragment.
 *   Non-bridge sessions keep the historical "empty when skills.length===0"
 *   behaviour.
 */
export function buildSkillToolDefs(skills, { ownerIsBridge = false } = {}) {
    if (!ownerIsBridge && !skills.length) return [];
    if (_skillToolDefsCache) return _skillToolDefsCache;
    _skillToolDefsCache = [
        {
            name: 'skills_list',
            description: 'List available skills with short descriptions. Call before skill_view or skill_execute.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
        },
        {
            name: 'skill_view',
            description: 'Return the full body of a skill by name (without executing).',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                },
                required: ['name'],
            },
        },
        {
            name: 'skill_execute',
            description: 'Load and execute a skill. Skill body is injected into context.',
            inputSchema: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Skill name' },
                    args: { type: 'object', description: 'Optional arguments passed to the skill', additionalProperties: true },
                },
                required: ['name'],
            },
        },
    ];
    return _skillToolDefsCache;
}
// --- Collect project MD (Phase B §5) ---
/**
 * Read <cwd>/PROJECT.md if present. Used to inject project-scoped guidance
 * into Tier 3 `# project-context` without polluting Tier 2 (Pool B prefix).
 */
// PROJECT.md lookup per cwd — mtime-invalidated so edits are visible
// on the very next createSession call.
const _projectMdCache = new Map();
export function collectProjectMd(cwd) {
    // When cwd is null/missing (bridge maintenance calls deliberately pass
    // cwd:null so provider-cache shards don't fork per caller workspace),
    // return empty — DO NOT fall back to process.cwd(). This path feeds
    // manager.mjs BP3 / sessionMarker, so leaking process.cwd() project
    // context into bridge maintenance sessions would fragment shards per
    // MCP launch dir.
    const projectDir = (typeof cwd === 'string' && cwd.length > 0) ? cwd : null;
    if (!projectDir) return '';
    const filePath = join(projectDir, 'PROJECT.md');
    const mtime = maxMtime([filePath]);
    const cached = _projectMdCache.get(projectDir);
    if (cached && mtime <= cached.mtime) return cached.value;
    const content = readSafe(filePath) || '';
    _projectMdCache.set(projectDir, { mtime, value: content });
    return content;
}

// --- Role template loading (Phase B §4 — UI-managed) ---
/**
 * Read <dataDir>/roles/<role>.md, parse frontmatter (name, description,
 * permission) and body. Returns { description, permission, body } or null.
 *
 * The role md is created/edited from the Config UI; runtime parses it on
 * each spawn and injects the result into the Tier 3 system-reminder via
 * composeSystemPrompt's `roleTemplate` slot.
 */
// Role template cache — mtime-invalidated so UI edits are visible
// on the very next createSession call without any TTL delay.
const _roleTemplateCache = new Map();
export function loadRoleTemplate(role, dataDir) {
    if (!role || !dataDir) return null;
    // Hidden/internal roles are plugin-managed and must never read a
    // DATA_DIR/roles/<hidden>.md file: explorer and the maintenance roles get
    // their identity from hidden rules only, so a stray file on disk must be
    // ignored entirely (no body, no permission/description metadata).
    if (isHiddenRole(role)) return null;
    const key = `${role}|${dataDir}`;
    const path = join(dataDir, 'roles', `${role}.md`);
    const mtime = maxMtime([path]);
    const cached = _roleTemplateCache.get(key);
    if (cached && mtime <= cached.mtime) return cached.value;
    // Absent vs present-but-empty: built-in default identity applies ONLY when
    // the role file is ABSENT (loadRoleTemplate returns null). A file that
    // exists — even frontmatter-only or with an empty body — returns a template
    // so composeSystemPrompt injects its (possibly empty) body verbatim instead
    // of falling back to the default.
    if (!existsSync(path)) {
        _roleTemplateCache.set(key, { mtime, value: null });
        return null;
    }
    const content = readSafe(path) || '';
    const fm = parseFrontmatter(content);
    const body = content.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
    const description = (fm.description || '').trim();
    const rawPermission = (fm.permission || '').trim().toLowerCase();
    const VALID_ROLE_PERMISSIONS = new Set(['read', 'read-write', 'mcp', 'full']);
    // Fail closed: unknown permission values are rejected rather than silently
    // falling through as full access.
    const permission = VALID_ROLE_PERMISSIONS.has(rawPermission) ? rawPermission : null;
    const template = {
        description: description || null,
        permission,
        body: body || null,
    };
    _roleTemplateCache.set(key, { mtime, value: template });
    return template;
}

// --- Role-scoped catalog loader ---
// Emits a BP2 block scoped to the calling role:
//   - Public/custom bridge workers: their own agents/<role>.md when present,
//     plus the public bridge-worker contract.
//   - Hidden roles: their own rules/bridge/<role>.md section only.
//   - Null role: falls back to the full all-in-one block
//     (explicit-cache unified-shard path).
//
// BP2 is no longer bit-identical cross-role — the provider cache shards by
// role group (public / each retrieval hidden / each maintenance hidden),
// trading a small number of additional shards for ~68% fewer prefix bytes
// on the public-role hot path. Role identity still rides the sessionMarker
// user message separately (see composeSystemPrompt).
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
    // Not cached — called only on catalog rebuild (mtime-busted), and
    // listHiddenRolesByKind now reads from the mtime-aware cache inside
    // internal-roles.mjs so the classification always reflects the current
    // hidden-roles.json on disk.
    return {
        retrieval: new Set(listHiddenRolesByKind('retrieval')),
        maintenance: new Set(listHiddenRolesByKind('maintenance')),
    };
}

const _scopedRoleCatalogCache = new Map();

function loadHiddenRoleSnippets(pluginRoot) {
    try {
        const bridgeDir = join(pluginRoot, 'rules', 'bridge');
        if (!existsSync(bridgeDir)) return [];
        const files = readdirSync(bridgeDir)
            .filter(f => f.endsWith('.md') && f !== '00-common.md')
            .sort();
        const pairs = [];
        for (const f of files) {
            const raw = readSafe(join(bridgeDir, f));
            if (!raw) continue;
            const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
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
        const body = raw.replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
        if (!body) continue;
        const name = f.replace(/\.md$/, '');
        agentSections.push(`## ${name}\n\n${body}`);
    }
    return agentSections;
}

// Empty by design — measurement (dev/role-shard-probe.mjs +
// dev/prefix-bytes-probe.mjs, 2026-04-29 trace) showed that even on
// providers with explicit cache breakpoints, BP2 hit-cost dominates
// cold-load cost at >10 calls/hr. Per-role scoped catalogs cut the
// average BP2 prefix from 33 KB to <1 KB (~95% reduction), at the
// price of ~5x more cold loads — a clear net win at observed call
// volumes (~791 calls/hr, distinct 5 roles/hr). Implicit-prefix-hash
// providers (deepseek, xai, lmstudio, ollama) prefer the smaller
// scoped prefix anyway. Leaving the set in place (rather than deleting
// the branch) so a future provider with different cache economics can
// be added back without re-introducing the dead code.
const EXPLICIT_CACHE_PROVIDERS = new Set();

// Inbound-event maintenance roles that report results back to Lead are
// declared via `inboundEvent: true` in defaults/hidden-roles.json and read
// through isInboundEventRole(). Such roles must follow
// rules/bridge/20-skip-protocol.md so genuine no-ops (label-only events,
// dedup, "nothing to report") prefix their output with `[meta:silent]` and the
// dispatch layer suppresses the Lead inject. Other roles (cycle1/cycle2 memory
// maintenance, retrieval roles) never emit toward Lead.

export function loadScopedRoleCatalog(role, provider = null) {
    const useUnified = !!(provider && EXPLICIT_CACHE_PROVIDERS.has(provider));
    const cacheKey = useUnified ? '__unified__' : (role || '__all__');
    const cached = _scopedRoleCatalogCache.get(cacheKey);
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT;
    // Use maxMtimeRecursive so edits to .md files inside agents/ and
    // rules/bridge/ propagate — parent dir mtime is unchanged on
    // Linux/macOS when only a nested file's content changes.
    const mtime = pluginRoot ? maxMtimeRecursive([
        join(pluginRoot, 'agents'),
        join(pluginRoot, 'rules', 'bridge'),
        join(pluginRoot, 'defaults', 'hidden-roles.json'),
    ]) : 0;
    if (cached && mtime <= cached.mtime) {
        return cached.value;
    }
    if (!pluginRoot) return '';

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

        // Pick which bridge-rule sections + agents/<role>.md sections to emit
        // based on role classification. Self-only emit keeps BP2 minimal:
        // a public worker only sees its own agents/worker.md, not the full
        // catalog.
        let bridgeRuleSectionsToEmit = null; // null → drop the bridge-rule block entirely
        let agentSectionsToEmit = agentSections; // default: full (unknown-role fallback)
        if (useUnified) {
            // Explicit-cache providers — every role sees the same all-in-one
            // catalog. Cross-role calls hit the same provider-side prefix
            // shard, eliminating the role-shard miss seen on Pool C
            // transitions for codex/openai. BP3 sessionMarker still carries
            // role identity, so behavior parity is preserved.
            bridgeRuleSectionsToEmit = hiddenPairs.map(p => `## ${p.name}\n\n${p.body}`);
            agentSectionsToEmit = agentSections;
        } else if (role && classification.retrieval.has(role)) {
            // Retrieval roles (explorer) get their own contract section
            // (rules/bridge/30-explorer.md) riding BP2 — a deliberate
            // cache-shard split from `worker`: brief-level descriptive-only
            // constraints proved insufficient (haiku still rendered verdicts on
            // evaluative queries), so the contract must sit at system level.
            // The agents/*.md sections shared for tool-use discipline are
            // declared per-role via `catalogShareAgents` in
            // defaults/hidden-roles.json (explorer → worker).
            const self = hiddenPairs.find(p => p.name === role);
            bridgeRuleSectionsToEmit = self ? [`## ${self.name}\n\n${self.body}`] : [];
            agentSectionsToEmit = agentSections.filter(s =>
                [...roleSharesCatalog].some(name => s.startsWith(`## ${name}\n`)));
        } else if (role && classification.maintenance.has(role)) {
            const self = hiddenPairs.find(p => p.name === role);
            bridgeRuleSectionsToEmit = [];
            if (self) {
                bridgeRuleSectionsToEmit.push(`## ${self.name}\n\n${self.body}`);
            } else {
                // Fallback: maintenance role without rules/bridge/*.md entry —
                // pull self body from agents/<role>.md instead so newly-added
                // hidden roles work without needing a duplicate bridge file.
                const fromAgent = agentSections.find(s => s.startsWith(`## ${role}\n`));
                if (fromAgent) bridgeRuleSectionsToEmit.push(fromAgent);
            }
            // Inbound-event roles also need the skip-protocol rule so they
            // can opt their no-op outputs out of the Lead inject (BP1 would
            // waste the bytes on unrelated bridge workers).
            if (roleIsInboundEvent) {
                const skip = hiddenPairs.find(p => p.name === 'skip-protocol');
                if (skip) bridgeRuleSectionsToEmit.push(`## ${skip.name}\n\n${skip.body}`);
            }
            agentSectionsToEmit = [];
        } else if (role) {
            // Public/custom role — self-only agents/<role>.md when present,
            // not the full hidden/maintenance bundle. The universal bridge
            // contract rides BP1 (rules/bridge/00-common.md); the worker tool
            // discipline lives in agents/worker.md.
            bridgeRuleSectionsToEmit = [];
            agentSectionsToEmit = agentSections.filter(s => s.startsWith(`## ${role}\n`));
        } else {
            // Null role — full catalog emitted (explicit-cache providers that
            // shard by __all__ key).
            bridgeRuleSectionsToEmit = hiddenPairs.map(p => `## ${p.name}\n\n${p.body}`);
            // agentSectionsToEmit already set to full agentSections above.
        }

        const blocks = [];
        if (agentSectionsToEmit.length) {
            blocks.push(`# Agent Role Catalog\n\n${agentSectionsToEmit.join('\n\n---\n\n')}`);
        }
        if (bridgeRuleSectionsToEmit && bridgeRuleSectionsToEmit.length) {
            blocks.push(`# Bridge Role Rules\n\n${bridgeRuleSectionsToEmit.join('\n\n---\n\n')}`);
        }
        const value = blocks.join('\n\n---\n\n');
        _scopedRoleCatalogCache.set(cacheKey, { mtime, value });
        return value;
    } catch {
        return '';
    }
}

// --- Compose system prompt — 4-BP cache layout ---
// Returns { baseRules, roleCatalog, sessionMarker, volatileTail } mapping
// directly to the breakpoint plan:
//   BP1 (1h, system block #1) = baseRules      — bridge common rules, filtered
//   BP2 (1h, system block #2) = roleCatalog    — scoped role catalog + project context
//   BP3 (1h, first <system-reminder> user)     = sessionMarker (role-specific task body)
//   BP4 (5m, messages tail)                    = volatileTail (role + permission + task-brief)
//
// Design note — why role/permission sit in BP4, not BP3:
//   BP3 is reserved for role-specific task bodies that are stable within the
//   bridge session (webhook/schedule/hidden retrieval details). A cross-role
//   burst within the same project should still share BP1+BP2, while BP4 picks
//   up the per-call role / permission / task variance. Tool-routing hints are
//   static cross-role, so they live in shared bridge rules rather than being
//   regenerated per call.
//
// BP1 inputs:
//   - opts.bridgeRules    : rules-builder buildBridgeInjectionContent output
//                           (Pool B roles share bit-identical prefix)
//   - opts.userPrompt     : explicit systemPrompt override from callsite
//
// BP2 inputs:
//   - loadScopedRoleCatalog(opts.role, opts.provider)
//   - opts.projectContext : cwd's PROJECT.md content, when present
//
// BP3/BP4 inputs:
//   - opts.role           : role name from user-workflow.json or hidden-role registry
//   - opts.agentTemplate  : agents/<role>.md body when authored
//   - opts.taskBrief      : Lead-issued task description (Sub only)
//   - opts.hasSkills      : true → skills_list hint
//   - opts.coreMemoryContext : compact core memory context
//
// `profile.skip` still filters specific buckets (claudemd, skills, memory)
// for backward compatibility with existing profiles.
export function composeSystemPrompt(opts) {
    const profile = opts.profile || null;
    const _skip = profile?.skip || {};

    // ── BP1: baseRules (system block #1, 1h cache) ─────────────────────
    // Bridge common rules + explicit systemPrompt override. Contains
    // bridgeRules (MCP instructions, Pool B shared rules, _shared/tool
    // efficiency). Identical across ALL roles — BP1 shared pool-wide.
    const baseParts = [];
    if (opts.bridgeRules) baseParts.push(opts.bridgeRules);
    if (opts.userPrompt) baseParts.push(opts.userPrompt);
    const baseRules = baseParts.join('\n\n---\n\n');

    // ── BP2: roleCatalog (system block #2, 1h cache) ────────────────────
    // Cross-role-stable layer: scoped agents/<role>.md catalog + project
    // context. Role / permission markers are emitted in BP4 instead so a
    // cross-role burst within the same project shares BP1+BP2+BP3 entirely
    // (matches the design note above). Without this split, a worker→reviewer
    // hand-off on the same project would churn BP2 every time the role line
    // changed even though the catalog and project context were identical.
    const roleCatalogScoped = opts.skipRoleCatalog
        ? ''
        : loadScopedRoleCatalog(opts.role || null, opts.provider || null);
    const catalogParts = [];
    if (roleCatalogScoped) catalogParts.push(roleCatalogScoped);
    if (opts.projectContext) {
        catalogParts.push('# project-context\n' + opts.projectContext);
    }
    const roleCatalog = catalogParts.join('\n\n');

    // ── BP3: sessionMarker (first <system-reminder> user msg, 1h cache) ─
    // Role-specific task instructions only — webhook event body, schedule
    // task body, hidden retrieval tool detail. The <!-- bp3-sentinel --> tag
    // is what Anthropic's findTier3Index() matches on to claim a 1h BP3
    // slot; without role-specific content, sessionMarker stays empty so the
    // sentinel doesn't pin an empty user message into the 1h shard.
    const sessionMarker = opts.roleSpecific
        ? '<!-- bp3-sentinel -->\n' + opts.roleSpecific
        : '';

    // ── BP4-adjacent: volatileTail (second user <system-reminder>, 5m) ──
    // Per-call variance: role marker, permission, task brief, and compact
    // core memory. Keeping role/permission here (rather than in BP2) means
    // cross-role bursts on the same project share BP1+BP2+BP3 entirely —
    // only this 5m volatile tail picks up the per-call variance.
    const volatileParts = [];
    if (opts.role && !opts.skipRoleReminder) {
        volatileParts.push('# role\n' + opts.role);
    }
    const permission = opts.permission || opts.roleTemplate?.permission || null;
    const permissionName = typeof permission === 'string'
        ? permission.trim().toLowerCase()
        : '';
    if (permission && permissionName !== 'full') {
        let permissionLabel = String(permission);
        let allow =
            permission === 'read'
                ? 'read-only; write/edit/bash rejected'
                : permission === 'read-write'
                    ? 'read + write/edit/bash'
                    : permission === 'mcp'
                        ? 'MCP/internal retrieval tools only; file/shell/edit tools rejected'
                    : permission === 'full'
                        ? 'full — all tools'
                        : 'unknown — treat as read-only';
        if (permission && typeof permission === 'object') {
            const allowList = Array.isArray(permission.allow)
                ? permission.allow.map(v => String(v || '').trim()).filter(Boolean)
                : [];
            const denyList = Array.isArray(permission.deny)
                ? permission.deny.map(v => String(v || '').trim()).filter(Boolean)
                : [];
            const parts = [];
            if (allowList.length) parts.push(`allow: ${allowList.join(', ')}`);
            if (denyList.length) parts.push(`deny: ${denyList.join(', ')}`);
            permissionLabel = parts.length ? parts.join('; ') : 'custom tool permission';
            allow = allowList.length
                ? 'only listed tools are available'
                : denyList.length
                    ? 'listed tools are rejected'
                    : 'custom allow/deny policy';
        }
        volatileParts.push(`permission: ${permissionLabel} — ${allow}.`);
    }
    // Role identity — the role template body (DATA_DIR/roles/<role>.md, edited
    // in the config UI's Custom Workflow panel) is injected immediately ABOVE
    // the task brief and labelled so the model reads "who am I" before "what to
    // do". Empty/absent bodies (legacy role files, hidden roles without a
    // roles/<name>.md) contribute nothing, preserving backward compatibility.
    //
    // Default install has no roles/<role>.md on disk, so loadRoleTemplate
    // returns null and a public role would otherwise get NO identity. Fall back
    // to the built-in default identity for the well-known public roles (kept in
    // sync with setup.html's WF_DEFAULT_ROLE_IDENTITY) so the feature works out
    // of the box; a saved custom body always wins, and unknown/hidden roles get
    // nothing (hidden roles stay plugin-managed via their systemFile rules).
    //
    // Absent vs present-but-empty: when opts.roleTemplate is defined the role
    // file EXISTS on disk — its body (possibly empty for a frontmatter-only or
    // intentionally blanked file) is authoritative and the built-in default is
    // NOT applied. The default applies only when roleTemplate is absent
    // (undefined) — i.e. no role file at all.
    const roleIdentity = opts.roleTemplate
        ? String(opts.roleTemplate.body || '').trim()
        : (DEFAULT_ROLE_IDENTITY[String(opts.role || '').trim().toLowerCase()] || '');
    if (roleIdentity) {
        volatileParts.push('# role-identity\n' + roleIdentity);
    }
    if (opts.taskBrief) volatileParts.push('# task-brief\n' + opts.taskBrief);
    if (opts.coreMemoryContext && typeof opts.coreMemoryContext === 'string' && opts.coreMemoryContext.trim()) {
        volatileParts.push('# Core Memory\n' + opts.coreMemoryContext.trim());
    }
    if (opts.cwd && typeof opts.cwd === 'string' && opts.cwd.trim()) {
        volatileParts.push(`cwd: ${opts.cwd.trim()}`);
    }
    const volatileTail = volatileParts.length > 0
        ? volatileParts.join('\n\n')
        : '';

    return { baseRules, roleCatalog, sessionMarker, volatileTail };
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
function parseFrontmatter(content) {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match)
        return {};
    const fm = match[1];
    const name = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    const description = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    const permission = fm.match(/^permission:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim();
    return { name, description, permission };
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
