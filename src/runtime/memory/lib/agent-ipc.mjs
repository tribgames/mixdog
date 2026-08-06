/**
 * Agent-dispatch client for the memory process.
 *
 * PG/embedding/recall remain isolated in the memory process, while the heavy
 * provider/session graph lives exactly once in the machine-global backend
 * daemon. Calls use its authenticated loopback broker, so the memory process
 * can outlive its original fork parent and reconnect after a backend restart.
 */
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const brokerAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 8,
})
let _idSeq = 0

function nextCallId() {
  _idSeq += 1
  return `mem-${process.pid}-${Date.now()}-${_idSeq}`
}

function runtimeRoot() {
  return process.env.MIXDOG_RUNTIME_ROOT
    ? resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : join(tmpdir(), 'mixdog')
}

function isPidAlive(value) {
  const pid = Number(value)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error?.code === 'EPERM' }
}

function readBrokerDiscovery() {
  try {
    const raw = JSON.parse(readFileSync(join(runtimeRoot(), 'channel-daemon.json'), 'utf8'))
    const port = Number(raw?.port)
    if (!Number.isInteger(port) || port <= 0 || port >= 65536 || !raw?.token || !isPidAlive(raw?.pid)) {
      return null
    }
    return { port, token: String(raw.token) }
  } catch {
    return null
  }
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error(String(signal?.reason || 'agent broker request canceled'))
}

function requestBroker(discovery, path, body, { timeoutMs, signal = null } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const payload = JSON.stringify(body || {})
    let settled = false
    let req = null
    const finish = (fn, value) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      try { signal?.removeEventListener?.('abort', onAbort) } catch {}
      fn(value)
    }
    const reject = (error) => finish(
      rejectPromise,
      error instanceof Error ? error : new Error(String(error)),
    )
    const onAbort = () => {
      const error = abortError(signal)
      try { req?.destroy?.(error) } catch {}
      reject(error)
    }
    const deadline = setTimeout(() => {
      const error = new Error(`agent broker request timed out after ${timeoutMs}ms`)
      try { req?.destroy?.(error) } catch {}
      reject(error)
    }, timeoutMs)
    deadline.unref?.()
    if (signal?.aborted) {
      onAbort()
      return
    }
    try { signal?.addEventListener?.('abort', onAbort, { once: true }) } catch {}
    req = http.request({
      hostname: '127.0.0.1',
      port: discovery.port,
      path,
      method: 'POST',
      agent: brokerAgent,
      headers: {
        'X-Mixdog-Daemon-Token': discovery.token,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let data = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => { data += chunk })
      res.on('error', reject)
      res.on('end', () => {
        let parsed = null
        try { parsed = data ? JSON.parse(data) : null } catch {}
        if ((res.statusCode || 0) >= 400) {
          reject(new Error(parsed?.error || data || `HTTP ${res.statusCode}`))
          return
        }
        if (parsed?.ok === false) {
          reject(new Error(parsed.error || 'agent broker dispatch failed'))
          return
        }
        finish(resolvePromise, parsed)
      })
    })
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

function cancelBrokerCall(discovery, callId, reason) {
  return requestBroker(discovery, '/agent/cancel', { callId, reason }, {
    timeoutMs: 1500,
  }).catch(() => {})
}

/**
 * Dispatch through the singleton backend provider/session graph.
 *
 * @param {object} opts           agent-dispatch construction options
 * @param {string} [opts.agent]
 * @param {string} [opts.taskType]
 * @param {string} [opts.mode]
 * @param {string} [opts.preset]   preset id/name (passed at call time)
 * @param {number} [opts.timeout]  ms, defaults 600000
 * @param {string} [opts.cwd]
 * @param {string} prompt          user message
 * @returns {Promise<string>}      raw assistant content
 */
export async function callAgentDispatch(opts = {}, prompt) {
  const discovery = readBrokerDiscovery()
  if (!discovery) {
    throw new Error('agent-broker: backend daemon unavailable')
  }
  const callId = nextCallId()
  const timeoutMs = Math.max(1000, Number(opts.timeout ?? 600000))
  try {
    const response = await requestBroker(discovery, '/agent/dispatch', {
      callId,
      params: {
        agent: opts.agent || null,
        taskType: opts.taskType || null,
        mode: opts.mode || null,
        preset: opts.preset || null,
        cwd: opts.cwd || null,
        prompt: String(prompt ?? ''),
        timeout: timeoutMs,
      },
    }, {
      // Small transport grace after the dispatch's own timeout/watchdog.
      timeoutMs: timeoutMs + 5000,
      signal: opts.signal || null,
    })
    return String(response?.result ?? '')
  } catch (error) {
    await cancelBrokerCall(discovery, callId, error?.message || 'agent broker request failed')
    throw error
  }
}
