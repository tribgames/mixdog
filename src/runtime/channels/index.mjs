// Thin facade for the channels worker runtime. The implementation was split
// out into ./lib/worker-main.mjs plus focused lib/ modules; this file preserves
// the exact public API and boot side-effects by re-exporting from worker-main.
// Kept as the worker fork entrypoint (mixdog-session-runtime CHANNEL_WORKER_ENTRY).
export {
  TOOL_DEFS,
  handleToolCall,
  handleToolCallWithBridgeRetry,
  init,
  instructions,
  isChannelBridgeActive,
  isChannelsDegraded,
  start,
  stop
} from "./lib/worker-main.mjs";
