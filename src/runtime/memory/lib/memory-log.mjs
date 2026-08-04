// Shared memory-daemon stderr logger. The write is captured at import time so
// memory output stays visible even when a TUI log guard swaps
// process.stderr.write later; MIXDOG_QUIET_MEMORY_LOG mutes it entirely.
const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr);
export function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true;
  return __mixdogMemoryStderrWrite(...args);
}
