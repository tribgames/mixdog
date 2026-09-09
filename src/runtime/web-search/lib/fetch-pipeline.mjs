import { setTimeout as sleep } from 'node:timers/promises'
import { isFatalHttpPathPolicyError } from './http-fetch.mjs'
import { assertReadableContent } from './document-content.mjs'

export function abortable(promise, signal) {
  if (!signal) return promise
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason || new Error('Fetch cancelled'))
    if (signal.aborted) {
      Promise.resolve(promise).catch(() => {})
      abort()
      return
    }
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

// Serialize document attempts per hostname, without blocking unrelated sites.
// No cookies or user credentials are shared between callers.
export class HostPacer {
  constructor({ intervalMs = 250 } = {}) {
    this.intervalMs = intervalMs
    this.hosts = new Map()
  }

  async run(url, signal, operation) {
    const host = new URL(url).hostname
    let state = this.hosts.get(host)
    if (!state) {
      for (const [key, item] of this.hosts) {
        if (!item.pending && item.readyAt <= Date.now()) this.hosts.delete(key)
      }
      state = { tail: Promise.resolve(), readyAt: 0, pending: 0 }
      this.hosts.set(host, state)
    }
    state.pending++
    const previous = state.tail
    let release
    const turn = new Promise(resolve => { release = resolve })
    state.tail = previous.then(() => turn)
    try {
      await abortable(previous, signal)
      const delay = state.readyAt - Date.now()
      if (delay > 0) await sleep(Math.min(delay, 2147483647), undefined, { signal })
      signal?.throwIfAborted()
      try {
        return await operation()
      } catch (error) {
        if (error.retryAfterMs > 0) state.readyAt = Math.max(state.readyAt, Date.now() + error.retryAfterMs)
        throw error
      } finally {
        state.readyAt = Math.max(state.readyAt, Date.now() + this.intervalMs)
      }
    } finally {
      state.pending--
      release()
    }
  }
}

const pacer = new HostPacer()
const retryableStatuses = new Set([408, 429, 500, 502, 503, 504])
const isChallengeResponse = error => error.code === 'BLOCKED_CONTENT' && ![401, 429].includes(error.status)

export function fetchFailureKind(error) {
  if (isFatalHttpPathPolicyError(error)) return 'POLICY_BLOCKED'
  if (error.code) return error.code
  if (error.status === 429) return 'RATE_LIMITED'
  if (error.status === 401) return 'LOGIN_REQUIRED'
  if (error.status === 403) return 'HTTP_BLOCKED'
  if (error.status) return 'HTTP_ERROR'
  if (error.name === 'TimeoutError') return 'FETCH_TIMEOUT'
  if (error.name === 'AbortError') return 'FETCH_CANCELLED'
  return 'NETWORK_ERROR'
}

export async function runFetchPipeline(url, {
  http, browser, signal, timeoutMs = 30000, hostPacer = pacer, onAttempt = () => {},
} = {}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000
  const deadline = Date.now() + budget
  const controller = new AbortController()
  const timeout = Object.assign(new Error(`Fetch exceeded ${budget}ms total budget`), { code: 'FETCH_TIMEOUT' })
  const timer = setTimeout(() => controller.abort(timeout), budget)
  const overall = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const failures = []
  const triedExtractors = []
  const attempts = []
  const attempt = async (stage, execute) => {
    overall.throwIfAborted()
    const started = Date.now()
    triedExtractors.push(stage)
    try {
      const page = await hostPacer.run(url, overall, async () => {
        const remaining = deadline - Date.now()
        overall.throwIfAborted()
        const stageBudget = stage === 'http' ? Math.max(1, Math.min(12000, Math.floor(remaining * 0.45))) : Math.max(1, remaining)
        const stageController = new AbortController()
        const stageTimer = setTimeout(() => stageController.abort(Object.assign(new Error(`${stage} timed out`), { code: 'STAGE_TIMEOUT' })), stageBudget)
        const stageSignal = AbortSignal.any([overall, stageController.signal])
        try {
          const result = await abortable(execute(stageBudget, stageSignal), stageSignal)
          assertReadableContent(result?.content)
          return result
        } finally { clearTimeout(stageTimer) }
      })
      attempts.push({ stage, status: 'success', elapsedMs: Date.now() - started })
      onAttempt(stage, null)
      return { ...page, requestedUrl: url, triedExtractors, failures, attempts }
    } catch (error) {
      const code = fetchFailureKind(error)
      const failure = { extractor: stage, error: error.message || String(error), code, ...(error.status ? { status: error.status } : {}) }
      failures.push(failure)
      attempts.push({ stage, status: 'error', elapsedMs: Date.now() - started, code })
      onAttempt(stage, error)
      throw error
    }
  }
  try {
    let lastError
    for (let retry = 0; retry < 2; retry++) {
      try { return await attempt('http', http) }
      catch (error) {
        overall.throwIfAborted()
        lastError = error
        if (isFatalHttpPathPolicyError(error)) throw error
        if (isChallengeResponse(error)) break
        if (error.status && !retryableStatuses.has(error.status) && error.status !== 403) throw error
        const transient = retryableStatuses.has(error.status) ||
          /^(?:ECONNRESET|ECONNREFUSED|EAI_AGAIN|UND_ERR_)/.test(error.cause?.code || error.code || '')
        if (!transient || retry === 1) break
        const delay = Math.max(400, error.retryAfterMs || 0)
        if (Date.now() + delay >= deadline) throw error
        await sleep(delay, undefined, { signal: overall })
      }
    }
    // Rendering does not fix a rate limit or a failing upstream server.
    if (lastError.status && lastError.status !== 403 && !isChallengeResponse(lastError)) throw lastError
    if (lastError.code === 'LOGIN_REQUIRED' || !browser) throw lastError
    return await attempt('puppeteer', browser)
  } catch (error) {
    const failure = overall.aborted ? overall.reason : error
    const result = new Error(failure?.message || String(failure))
    result.code = signal?.aborted ? 'FETCH_CANCELLED' : fetchFailureKind(failure)
    if (failure?.status) result.status = failure.status
    result.failures = failures
    result.attempts = attempts
    throw result
  } finally { clearTimeout(timer) }
}
