// Codex-style turn stop hook (refs/codex core/src/session/turn.rs:372-404).
//
// Codex semantics: a sampling request that needs no follow-up ends the turn.
// Before breaking, the turn runs its stop hooks; a hook may block ONCE by
// returning continuation fragments, which are recorded as a prompt message
// before sampling resumes (`stop_hook_active = true`, never cleared inside the
// turn). Nothing else can force another turn: no mandatory terminal tool, no
// completion strikes, no lexical inspection of the assistant text.
//
// The single hook implemented here preserves the original failed-apply_patch
// protection: while a real tool failure is unresolved, the first terminal
// assistant message is blocked once with a structural continuation prompt.
// Afterwards ordinary final text (or further tool calls) is accepted.

export const STOP_HOOK_SOURCE = 'tool-failure-stop-hook';

import { isInformationalShellExitOne } from '../result-classification.mjs';

// Only a genuinely EXECUTED result resolves a failure, i.e. kind 'normal'.
// Cache hits ('cache-hit' / 'scoped-cache-hit') replay an earlier result
// without running anything, and dedup/guard skips ('skipped') execute nothing
// either, so both are neutral: they neither arm nor clear the hook.
const EXECUTED_SUCCESS_TOOL_KINDS = new Set(['normal']);

function bareToolName(name) {
    const raw = String(name || '');
    return raw.startsWith('mcp__') ? raw.split('__').pop() : raw;
}

export function toolFailureContinuationPrompt(failedTool) {
    const which = failedTool ? `\`${failedTool}\`` : 'a tool call';
    return `[mixdog-runtime] Stop hook: ${which} failed and no tool call has succeeded since.`
        + ' Re-run the fixed action (or a verifying tool) if it is recoverable; otherwise say in your'
        + ' final message that it stays unresolved and why. This hook fires once — your next message ends the turn.';
}

/**
 * Structural unresolved-tool-failure stop hook.
 *  - observeToolResult(message) / endBatch(calls): a batch containing any
 *    failed tool result arms it; a later batch with a genuinely executed
 *    success clears it.
 *  - takeContinuationPrompt(): returns the continuation prompt the FIRST time
 *    a terminal assistant message arrives while a failure is unresolved, then
 *    stays silent for the rest of the turn (Codex `stop_hook_active`).
 */
export function createToolFailureStopHook() {
    let unresolvedFailure = false;
    let lastFailedTool = null;
    let batchFailure = false;
    let batchSuccess = false;
    let failedCallIds = new Set();
    let active = false;
    return {
        get unresolvedFailure() { return unresolvedFailure; },
        get lastFailedTool() { return lastFailedTool; },
        get active() { return active; },
        observeToolResult(message) {
            if (!message || message.role !== 'tool') return;
            // Guard skips (repeat-failure guard) are tagged as errors so every
            // downstream consumer keeps treating the call as unresolved, but
            // nothing was dispatched — they must not arm the hook.
            if (message.guardSkip === true) return;
            if (message.toolKind === 'error') {
                // Informational exit-1 probes (grep-family no-match inside a
                // compound command: useful stdout, blank stderr) stay 'error'
                // for display/history, but blocking the terminal message over
                // them forces a pointless re-verify turn — observed live
                // (kv-store-grpc: /proc PID scan exit 1 → hook misfire, +2
                // turns). Neutral here: neither arms nor clears.
                if (isInformationalShellExitOne(message.content)) return;
                batchFailure = true;
                if (message.toolCallId) failedCallIds.add(message.toolCallId);
            } else if (EXECUTED_SUCCESS_TOOL_KINDS.has(message.toolKind)) {
                batchSuccess = true;
            }
        },
        endBatch(calls) {
            if (batchFailure) {
                unresolvedFailure = true;
                const failed = (Array.isArray(calls) ? calls : [])
                    .find((call) => call?.id && failedCallIds.has(call.id));
                if (failed) lastFailedTool = bareToolName(failed.name);
            } else if (batchSuccess) {
                unresolvedFailure = false;
                lastFailedTool = null;
            }
            batchFailure = false;
            batchSuccess = false;
            failedCallIds = new Set();
        },
        takeContinuationPrompt() {
            if (active || !unresolvedFailure) return null;
            active = true;
            return toolFailureContinuationPrompt(lastFailedTool);
        },
    };
}
