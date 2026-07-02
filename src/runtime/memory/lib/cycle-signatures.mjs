// Scheduled-cycle request-signature helpers extracted from index.mjs.
// Pure functions of the passed `config` object; they call the imported
// makeCycleRequestSignature and touch no module state (no db/timers).
// index.mjs imports these; signatures and behavior are unchanged.

import { makeCycleRequestSignature } from './memory-cycle-requests.mjs'

export function scheduledCycle1Signature(config) {
  return makeCycleRequestSignature('cycle1', config, {
    preset: undefined,
    concurrency: undefined,
    maxConcurrent: undefined,
  })
}

export function scheduledCycle2Signature(config) {
  return makeCycleRequestSignature('cycle2', config, {
    cascadePreset: undefined,
    concurrency: undefined,
  })
}

export function scheduledCycle3ApplyMode(config) {
  const raw = String(config?.cycle3?.applyMode || 'conservative').trim().toLowerCase()
  return (raw === 'proposal' || raw === 'dry-run' || raw === 'dryrun') ? 'proposal' : 'conservative'
}

export function scheduledCycle3Signature(config) {
  const retryConfig = config?.cycle3 || config
  return makeCycleRequestSignature('cycle3', retryConfig, {
    applyMode: scheduledCycle3ApplyMode(config),
    apply: undefined,
  })
}
