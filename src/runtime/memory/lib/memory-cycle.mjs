// Barrel — original memory-cycle module split into memory-embed / memory-cycle1 / memory-cycle2.
// External callers import from this path; the split is transparent.
export {
  syncRootEmbedding, deleteRootEmbedding, flushEmbeddingDirty, flushRawEmbeddings, inferChunkProjectId,
} from './memory-embed.mjs'
export { runCycle1 } from './memory-cycle1.mjs'
export {
  runCycle2, runUnifiedGate, applySimpleStatus, applyUpdate, applyMerge, CYCLE2_ACTIVE_TARGET_CAP,
  parseInterval,
} from './memory-cycle2.mjs'
export { runCycle3 } from './memory-cycle3.mjs'
