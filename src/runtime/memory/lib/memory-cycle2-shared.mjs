// Shared low-level helpers for the cycle2 cluster (extracted from
// memory-cycle2.mjs). Logging shim, abort check, and resource-dir resolution.
// No cycle2 business logic; safe to import from any cycle2 sub-module.
import { fileURLToPath } from 'url'
import { join } from 'path'

import { __mixdogMemoryLog } from './memory-log.mjs'
export { __mixdogMemoryLog }

export function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

// Tiny inline semaphore — bounds cycle fan-out (cycle1 windows, cycle2 gate
// packets). One implementation so the two concurrency caps cannot drift.
export function createSemaphore(limit) {
  const cap = Math.max(1, Number(limit) || 1)
  let active = 0
  const queue = []
  const release = () => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }
  return async (fn) => {
    if (active >= cap) await new Promise(resolve => queue.push(resolve))
    active += 1
    try { return await fn() }
    finally { release() }
  }
}

// Two error classes travel through the cycle2 apply paths and must never be
// confused:
//   * STORE FAULT — the database itself failed the write (transaction rolled
//     back, or its COMMIT outcome is unknown). Nothing about the verdict was
//     wrong, and the store's state is no longer known, so the run stops.
//   * verdict rejection — a guard refused the mutation (stale snapshot, status
//     moved, content changed, floor budget exhausted). The store is healthy;
//     these return normally and are counted as ordinary rejections/errors.
// Only writers raise store faults, via markStoreFault; callers branch on
// isStoreFault before absorbing an error into a per-action counter.
// Classification is TYPE-based, never text-based: the writer raises a dedicated
// error class, and `err instanceof MemoryStoreFault` is the decision. An
// explicit own field (`isMemoryStoreFault` + `code`) corroborates it for the
// cross-realm case where two copies of this module exist. Nothing about the
// error's message or name participates — a foreign provider/DB error is never
// reclassified because of how its text happens to read, and a store fault keeps
// the original message verbatim so logs stay honest.
//
// Boundaries this signal actually crosses: none that serialize. The writer
// (applyMerge) throws and the deciders (the cycle2 apply loop and
// retro_eval_active) catch it in the same process, same module registry, same
// tick. runCycle2 converts it at its own boundary into a plain
// { ok: false, error: <string>, storeFault: <boolean> } result, so the explicit
// boolean — not a re-parsed Error — is what any IPC/worker hop carries onward.
export const MEMORY_STORE_FAULT_CODE = 'MEMORY_STORE_FAULT'

export class MemoryStoreFault extends Error {
  constructor(message, options) {
    super(message, options)
    this.name = 'MemoryStoreFault'
    this.code = MEMORY_STORE_FAULT_CODE
    this.isMemoryStoreFault = true
  }
}

export function markStoreFault(err) {
  if (isStoreFault(err)) return err
  const cause = err instanceof Error ? err : new Error(String(err))
  // The original is never mutated (frozen/sealed store errors are ordinary):
  // it is carried as `cause`, with its message copied verbatim — unprefixed —
  // and its stack preserved so the failing statement stays visible.
  const fault = new MemoryStoreFault(cause.message || String(cause), { cause })
  if (typeof cause.stack === 'string') fault.stack = cause.stack
  return fault
}

export function isStoreFault(err) {
  if (!err || typeof err !== 'object') return false
  if (err instanceof MemoryStoreFault) return true
  return err.isMemoryStoreFault === true && err.code === MEMORY_STORE_FAULT_CODE
}

export function resourceDir() {
  return process.env.MIXDOG_ROOT
    ? join(process.env.MIXDOG_ROOT, 'src')
    : fileURLToPath(new URL('../../..', import.meta.url))
}
