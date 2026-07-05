// Thin facade. The agent loop implementation moved to ./agent-loop.mjs and the
// pre-send auto-compact pass to ./pre-send-compact.mjs. This module re-exports
// the exact public surface (agentLoop plus the tool/approval/transcript
// helpers) so every existing import path -- scripts/tests, the manager.mjs
// dynamic import('./loop.mjs'), and other runtime modules -- keeps resolving
// unchanged.
export {
    agentLoop,
    preDispatchDenyForSession,
    repairTranscriptBeforeProviderSend,
    normalizeHookUpdatedToolOutput,
    resolveToolResultAfterHook,
    buildAgentBashSessionArgs,
    formatMissingToolApprovalUiDenial,
    resolvePreToolAskApproval,
    approvalGranted,
    approvalReason,
} from './agent-loop.mjs';
