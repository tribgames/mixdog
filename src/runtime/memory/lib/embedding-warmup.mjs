// Boot-edge embedding warmup queue, extracted from index.mjs (pass 2).
//
// ONNX session creation on the embedding worker thread is CPU-heavy, so it must
// not overlap the worker's own init (DB open, schema, cycle wiring). The warmup
// is queued during _initStore and fired at the _initRuntime completion edge, so
// it starts the instant boot's CPU-heavy work is done — no magic-number delay.
//
// This is a small pure factory: index.mjs owns the DATA_DIR-derived meta path
// and the embedding-provider imports, injecting them here as callbacks. No
// import-time side effects.
export function createEmbeddingWarmup({
  canStart,
  warmup,
  getDims,
  persistMeta,
  log = () => {},
}) {
  let _pending = null

  // Queue the warmup; fireDeferred() runs it once boot completes. Re-queuing
  // overwrites any prior pending closure (matches the original single-slot
  // module var). MIXDOG_EMBED_WARMUP=0 (checked via canStart) disables it.
  function schedule(metaPath, metaKey) {
    if (!canStart()) {
      // Silent skip here previously made "warmup never ran" boots
      // indistinguishable from failed warmups. One line, boot-edge only.
      log('[memory-service] embedding warmup skipped (disabled by env/secondary mode) — recall stays lexical until first embed\n')
      return
    }
    _pending = () => {
      const startedAt = Date.now()
      log('[memory-service] embedding warmup start\n')
      warmup()
        .then(() => {
          log(`[memory-service] embedding warmup ready in ${Date.now() - startedAt}ms\n`)
          const measured = Number(getDims())
          try {
            persistMeta(metaPath, { ...metaKey, dims: measured })
          } catch (e) {
            log(`[memory-service] could not persist embedding-meta: ${e?.message || e}\n`)
          }
        })
        .catch(err => {
          log(`[memory-service] background warmup failed: ${err?.message || err}\n`)
        })
    }
  }

  function fireDeferred() {
    const fire = _pending
    if (!fire) return
    _pending = null
    fire()
  }

  function reset() {
    _pending = null
  }

  return { schedule, fireDeferred, reset }
}
