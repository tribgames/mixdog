const DEFAULT_PASS_PAUSE_MS = 1_000

function throwIfAborted(signal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

function waitForNextPass(ms, signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    if (typeof timer.unref === 'function') timer.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export async function drainEmbeddingReindex({
  flushEntries,
  backfillCore = async () => 0,
  signal,
  pauseMs = DEFAULT_PASS_PAUSE_MS,
  wait = waitForNextPass,
} = {}) {
  if (typeof flushEntries !== 'function') {
    throw new TypeError('drainEmbeddingReindex: flushEntries required')
  }
  let passes = 0
  let attempted = 0
  let succeeded = 0
  let failed = 0

  while (true) {
    throwIfAborted(signal)
    const result = await flushEntries({ signal })
    throwIfAborted(signal)
    passes += 1
    attempted += Number(result?.attempted ?? 0)
    succeeded += Number(result?.succeeded ?? 0)
    failed += Array.isArray(result?.failed) ? result.failed.length : 0
    if (result?.timedOut !== true || Number(result?.succeeded ?? 0) <= 0) break
    await wait(pauseMs, signal)
  }

  throwIfAborted(signal)
  const coreFilled = Number(await backfillCore({ signal }) ?? 0)
  throwIfAborted(signal)
  return { passes, attempted, succeeded, failed, coreFilled }
}
