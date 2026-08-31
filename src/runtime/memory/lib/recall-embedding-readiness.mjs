const _envColdWaitMs = Number(process.env.MIXDOG_RECALL_COLD_EMBED_WAIT_MS)
export const RECALL_COLD_EMBED_WAIT_MS = Number.isFinite(_envColdWaitMs) && _envColdWaitMs >= 0
  ? Math.floor(_envColdWaitMs)
  : 3_000

function abortReason(signal) {
  return signal?.reason ?? new Error('aborted')
}

async function waitForWarmup(warmupPromise, waitMs, signal) {
  let timer = null
  let abortListener = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'timeout' }), waitMs)
  })
  const aborted = new Promise((resolve) => {
    if (!signal) return
    abortListener = () => resolve({ state: 'aborted' })
    signal.addEventListener('abort', abortListener, { once: true })
  })
  try {
    return await Promise.race([warmupPromise, timeout, aborted])
  } finally {
    if (timer) clearTimeout(timer)
    if (abortListener) signal.removeEventListener('abort', abortListener)
  }
}

export async function embedRecallQuery(query, {
  isReady,
  canWarmup,
  warmup,
  embed,
  signal,
  waitMs = RECALL_COLD_EMBED_WAIT_MS,
  onWarmupError = () => {},
} = {}) {
  const clean = String(query ?? '').trim()
  if (!clean) return { vector: null, state: 'empty' }
  if (signal?.aborted) throw abortReason(signal)

  if (isReady()) {
    return {
      vector: await embed(clean, { priority: true, inputType: 'query' }),
      state: 'ready',
    }
  }
  if (!canWarmup()) return { vector: null, state: 'unavailable' }

  const warmupOutcome = Promise.resolve()
    .then(() => warmup())
    .then(
      () => ({ state: 'warmed' }),
      (error) => ({ state: 'failed', error }),
    )
  const outcome = await waitForWarmup(
    warmupOutcome,
    Math.max(0, Math.floor(Number(waitMs) || 0)),
    signal,
  )

  if (outcome.state === 'aborted') throw abortReason(signal)
  if (outcome.state === 'timeout') {
    void warmupOutcome.then((lateOutcome) => {
      if (lateOutcome.state === 'failed') onWarmupError(lateOutcome.error)
    })
    return { vector: null, state: 'timeout' }
  }
  if (outcome.state === 'failed') {
    onWarmupError(outcome.error)
    return { vector: null, state: 'failed', error: outcome.error }
  }
  if (signal?.aborted) throw abortReason(signal)
  return {
    vector: await embed(clean, { priority: true, inputType: 'query' }),
    state: 'warmed',
  }
}
