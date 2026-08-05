// Completion-first loop guards: escalation ladder (level-2 steering),
// cross-turn identical read-only call dedup, and hard-cap refusal stubs.
// Pure string/signature helpers extracted from loop.mjs so the loop body only
// wires state + messages. No provider/manager coupling.

// Deterministic, key-sorted stringify for cross-turn call signatures. Mirrors
// _canonicalArgs but exposed by name for the dedup signature contract.
export function stableStringify(value) {
    if (value == null || typeof value !== 'object') {
        try { return JSON.stringify(value); } catch { return String(value); }
    }
    if (Array.isArray(value)) {
        try { return `[${value.map(stableStringify).join(',')}]`; } catch { return String(value); }
    }
    try {
        const keys = Object.keys(value).sort();
        return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
    } catch { return String(value); }
}

export function crossTurnSignature(name, args) {
    return `${name}:${stableStringify(args)}`;
}

// Tool names that are non-eager (no readOnlyHint) but are NOT edits/progress —
// they must not reset the escalation ladder's "zero edit" condition. Skill /
// recall / agent / task / cwd / load_tool are exploration/meta plumbing.
// (tool_search kept as legacy alias for old transcripts.)
const NON_PROGRESS_TOOLS = new Set(['Skill', 'recall', 'agent', 'task', 'cwd', 'load_tool', 'tool_search']);

// True when a successfully-executed tool represents real edit/progress. A tool
// counts as progress only if its def lacks readOnlyHint (not eager) AND it is
// not in the meta/non-progress set. apply_patch and shell/bash always count.
export function isEditProgressTool(name, isEager) {
    if (isEager) return false;
    const bare = name && name.startsWith('mcp__') ? name.split('__').pop() : name;
    if (bare === 'apply_patch' || bare === 'shell' || bare === 'bash' || bare === 'bash_session') return true;
    return !NON_PROGRESS_TOOLS.has(bare);
}

// Step 2 — cross-turn dedup stub. `stuck` appends the escalation tail at the
// 5th+ dedup stub in the session.
export function crossTurnDedupStub(name, firstIteration, stuck) {
    let s = `[cross-turn-dedup] \`${name}\` already ran in iteration ${firstIteration}; result unchanged, already in context.`;
    if (stuck) s += ` You appear stuck — use what you have or report blocked.`;
    return s;
}

// Hard iteration-cap final turn: model may still emit tool calls after tools
// are stripped from the send; refuse without executing.
export const ITERATION_CAP_REFUSAL_STUB = `Iteration cap reached — tools disabled; reply with your final text only.`;
