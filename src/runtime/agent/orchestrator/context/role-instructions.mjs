// Agent-scoped role markdown and 4-BP system prompt composition.
// Extracted from collect.mjs so skill catalog loading is not mixed into
// role-specific prompt assembly.

import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { mixdogRoot } from '../../../shared/plugin-paths.mjs';
import { readMarkdownDocument } from '../../../shared/markdown-frontmatter.mjs';
import { listHiddenAgentsByKind, getAgentCatalogShareAgents } from '../internal-agents.mjs';
import { mixdogGlobalDir, mtimeWithTtl, readSafe } from './skill-catalog.mjs';

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

function hiddenRuleSections(hiddenPairs) {
    return hiddenPairs.map((p) => `## ${p.name}\n\n${p.body}`);
}

function selfHiddenRuleSection(hiddenPairs, agent) {
    const self = hiddenPairs.find((p) => p.name === agent);
    return self ? [`## ${self.name}\n\n${self.body}`] : [];
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
                [...agentSharesCatalog].some((name) => s.startsWith(`## ${name}\n`))),
        };
    }
    if (classification.maintenance.has(agent)) {
        const selfRules = selfHiddenRuleSection(hiddenPairs, agent);
        const fromAgent = agentSections.find((s) => s.startsWith(`## ${agent}\n`));
        return {
            agentRuleSectionsToEmit: selfRules.length ? selfRules : (fromAgent ? [fromAgent] : []),
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
    const cacheKey = useUnified ? '__unified__' : (agent || '__all__');
    const cached = _scopedRoleInstructionsCache.get(cacheKey);
    const pluginRoot = mixdogRoot();
    // Use maxMtimeRecursive so edits to .md files inside agents/ and
    // rules/agent/ propagate — parent dir mtime is unchanged on
    // Linux/macOS when only a nested file's content changes. Gate the stat
    // behind a short TTL so repeated same-turn calls reuse the last mtime
    // instead of re-walking the trees on every invocation.
    const mtime = pluginRoot
        ? mtimeWithTtl(_scopedRoleInstructionsMtimeCache, cacheKey, [
            ...agentSectionDirs(pluginRoot),
            join(pluginRoot, 'rules', 'agent'),
            join(pluginRoot, 'defaults', 'agents.json'),
        ], _ROLE_INSTRUCTIONS_MTIME_TTL_MS)
        : 0;
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
function trimmedPromptSlice(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function joinPromptSlices(parts) {
    return parts.filter(Boolean).join('\n\n---\n\n');
}

export function composeSystemPrompt(opts) {
    const skip = opts.profile?.skip || {};

    // ── BP1: globally shared tool policy ────────────────────────────────
    const baseParts = [];
    if (opts.agentRules) baseParts.push(opts.agentRules);
    const baseRules = baseParts.join('\n\n---\n\n');

    // ── BP2: persistent profile/tool catalog layer ──────────────────────
    // deferredToolManifest: optional BP2 slice; production path is
    // applyInitialDeferredToolManifestToBp2 once after applyDeferredToolSurface.
    const stableSystemContext = joinPromptSlices([
        trimmedPromptSlice(opts.metaContext),
        skip.skills ? '' : trimmedPromptSlice(opts.skillManifest),
        trimmedPromptSlice(opts.deferredToolManifest),
    ]);

    // ── BP3: workflow/role + session environment layer ─────────────────
    const roleInstructionContext = opts.skipRoleCatalog
        ? ''
        : loadScopedRoleInstructions(opts.agent || null, opts.provider || null);
    // Keep the active workflow first within BP3 so it leads the role and
    // environment material that varies with the session.
    const coreMemory = skip.memory ? '' : trimmedPromptSlice(opts.coreMemoryContext);
    const sessionMarkerCore = joinPromptSlices([
        trimmedPromptSlice(opts.workflowContext),
        opts.roleRules || '',
        opts.userPrompt || '',
        roleInstructionContext,
        coreMemory ? `# Core Memory\n${coreMemory}` : '',
    ]);
    // Response language is the LAST system text before the conversation. It
    // rides the environment block (not the tier3 core) because the `# Session`
    // / shell / git lines are English and would otherwise trail it, pulling the
    // pre-tool preamble toward English.
    const environmentParts = [
        opts.sessionStartContext,
        opts.projectInstructionsContext,
        opts.environmentContext,
        opts.languageContext,
    ].map(trimmedPromptSlice);
    // Volatile session/project environment. Kept OUT of sessionMarkerCore so
    // Anthropic providers can leave it as an UNMARKED system block (covered by
    // the messages-tail breakpoint) while prefix-order providers still see it
    // after the stable context. sessionMarker keeps the combined legacy shape
    // for callers that consume a single BP3 string.
    const sessionEnvironment = joinPromptSlices(environmentParts);
    const sessionMarker = joinPromptSlices([sessionMarkerCore, sessionEnvironment]);

    return { baseRules, stableSystemContext, sessionMarkerCore, sessionEnvironment, sessionMarker };
}
