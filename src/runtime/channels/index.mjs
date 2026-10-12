// Thin facade for the channels worker runtime. The implementation was split
// out into ./lib/worker-main.mjs plus focused lib/ modules; this file preserves
// the current worker API and boot side-effects by re-exporting from worker-main.
// Kept as the channels worker entrypoint the daemon loads.
export {
  handleToolCall,
  isChannelBridgeActive,
  isChannelsDegraded,
  start,
  stop,
} from './lib/worker-main.mjs';
