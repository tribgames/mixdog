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
// recall / agent / task / cwd / tool_search are exploration/meta plumbing.
const NON_PROGRESS_TOOLS = new Set(['Skill', 'recall', 'agent', 'task', 'cwd', 'tool_search']);

// True when a successfully-executed tool represents real edit/progress. A tool
// counts as progress only if its def lacks readOnlyHint (not eager) AND it is
// not in the meta/non-progress set. apply_patch and shell/bash always count.
export function isEditProgressTool(name, isEager) {
    if (isEager) return false;
    const bare = name && name.startsWith('mcp__') ? name.split('__').pop() : name;
    if (bare === 'apply_patch' || bare === 'shell' || bare === 'bash' || bare === 'bash_session') return true;
    return !NON_PROGRESS_TOOLS.has(bare);
}

// Step 1 — level-2 escalation steering. N = cumulative level-1 fires.
// `readOnlyRole` swaps the edit-oriented directive for a report-oriented one:
// read-permission sessions (reviewer-style) cannot apply_patch, so telling
// them to edit is self-contradictory and pushes premature termination.
const LEVEL2_DIMINISHING_RETURNS = ' Further reads add cost, not evidence.';

export function level2SteerMessage(n, readOnlyRole = false, level2Fires = 1) {
    const tail = Number(level2Fires) >= 2 ? LEVEL2_DIMINISHING_RETURNS : '';
    if (readOnlyRole) {
        return `<system-reminder>\nEnough evidence gathered — report findings now; name any gaps.${tail}\n</system-reminder>`;
    }
    return `<system-reminder>\nStop exploring — apply the edit you know, or report blocked with what's missing.${tail}\n</system-reminder>`;
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
