// Thin facade over ./agent-loop.mjs (the loop; the pre-send auto-compact pass
// is ./pre-send-compact.mjs). Re-exports the public surface (agentLoop plus the
// tool/approval/transcript helpers) for scripts/tests, the lazy
// import('../loop.mjs') in manager/runtime-loaders.mjs, and other runtime
// modules.
export {
  agentLoop,
  preDispatchDenyForSession,
  repairTranscriptBeforeProviderSend,
  normalizeHookUpdatedToolOutput,
  resolveToolResultAfterHook,
  formatMissingToolApprovalUiDenial,
  resolvePreToolAskApproval,
  approvalGranted,
  approvalReason,
} from './agent-loop.mjs';
