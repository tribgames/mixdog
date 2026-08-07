// Eager in-process memory initialization for remote sessions. Channel ingest
// shares the daemon-owned proxy, so readiness is the isolated process/port
// singleflight returned by getMemoryModule.

export function prewarmMemoryRuntime({ getMemoryModule, bootProfile }) {
  void (async () => {
    try {
      await new Promise((resolve) => setImmediate(resolve))
      await getMemoryModule()
      bootProfile('channels:memory-prewarm-ready')
    } catch (error) {
      bootProfile('channels:memory-prewarm-failed', { error: error?.message || String(error) })
    }
  })()
}
