// Shared low-level helpers for the cycle2 cluster (extracted from
// memory-cycle2.mjs). Logging shim, abort check, and resource-dir resolution.
// No cycle2 business logic; safe to import from any cycle2 sub-module.
import { fileURLToPath } from 'url'

const __mixdogMemoryStderrWrite = process.stderr.write.bind(process.stderr)
export function __mixdogMemoryLog(...args) {
  if (process.env.MIXDOG_QUIET_MEMORY_LOG) return true
  return __mixdogMemoryStderrWrite(...args)
}

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

export function resourceDir() {
  return process.env.MIXDOG_ROOT || fileURLToPath(new URL('../../../..', import.meta.url))
}
