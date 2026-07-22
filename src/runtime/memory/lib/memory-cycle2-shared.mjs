// Shared low-level helpers for the cycle2 cluster (extracted from
// memory-cycle2.mjs). Logging shim, abort check, and resource-dir resolution.
// No cycle2 business logic; safe to import from any cycle2 sub-module.
import { fileURLToPath } from 'url'

import { __mixdogMemoryLog } from './memory-log.mjs'
export { __mixdogMemoryLog }

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

export function resourceDir() {
  return process.env.MIXDOG_ROOT || fileURLToPath(new URL('../../../..', import.meta.url))
}
