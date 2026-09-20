// Scheduled-cycle request-signature helpers.
// Pure functions of the passed `config` object; they call the imported
// makeCycleRequestSignature and touch no module state (no db/timers).
// index.mjs imports these; signatures and behavior are unchanged.

import { makeCycleRequestSignature } from './memory-cycle-requests.mjs';

export function scheduledCycle1Signature(config) {
  return makeCycleRequestSignature('cycle1', config, {
    preset: undefined,
    concurrency: undefined,
    maxConcurrent: undefined,
  });
}

export function scheduledCycle2Signature(config) {
  return makeCycleRequestSignature('cycle2', config, {
    concurrency: undefined,
  });
}
