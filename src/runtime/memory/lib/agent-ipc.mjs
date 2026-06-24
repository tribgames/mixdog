/**
 * agent-ipc.mjs — IPC client for bridge LLM calls from the memory worker.
 *
 * The memory worker runs in its own fork, while the bridge / provider
 * registry lives in-process in the parent server. cycle1 / cycle2 can't
 * call makeBridgeLlm() locally (provider map is empty here), so we route
 * every LLM call over IPC:
 *
 *   memory → parent :  { type: 'agent_ipc_request',  callId, tool, params }
 *   parent → memory :  { type: 'agent_ipc_response', callId, ok, result | error }
 *
 * Uses a module-level pending map keyed by callId. Parent-side handler
 * lives in server.mjs spawnWorker's message listener.
 */

const pending = new Map()
let listenerInstalled = false
let _idSeq = 0

function installListener() {
  if (listenerInstalled) return
  listenerInstalled = true
  process.on('message', (msg) => {
    if (!msg || msg.type !== 'agent_ipc_response' || !msg.callId) return
    const entry = pending.get(msg.callId)
    if (!entry) return
    pending.delete(msg.callId)
    if (msg.ok) entry.resolve(msg.result)
    else entry.reject(new Error(msg.error || 'agent_ipc_response error'))
  })
}

function nextCallId() {
  _idSeq += 1
  return `mem-${process.pid}-${Date.now()}-${_idSeq}`
}

/**
 * Send an agent-bridge LLM request to the parent. Throws if IPC is
 * unavailable (worker not forked) or the parent reports an error.
 *
 * @param {object} opts           bridge-llm construction options
 * @param {string} [opts.role]
 * @param {string} [opts.taskType]
 * @param {string} [opts.mode]
 * @param {string} [opts.preset]   preset id/name (passed at call time)
 * @param {number} [opts.timeout]  ms, defaults 600000
 * @param {string} [opts.cwd]
 * @param {string} prompt          user message
 * @returns {Promise<string>}      raw assistant content
 */
export function callBridgeLlm(opts = {}, prompt) {
  if (!process.send) {
    return Promise.reject(new Error('agent-ipc: process.send unavailable (not running as worker)'))
  }
  installListener()
  const callId = nextCallId()
  const timeoutMs = Math.max(1000, Number(opts.timeout ?? 600000))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.has(callId)) return
      pending.delete(callId)
      try {
        process.send({ type: 'agent_ipc_cancel', callId })
      } catch {}
      reject(new Error(`agent-ipc: timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(callId, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      process.send({
        type: 'agent_ipc_request',
        callId,
        tool: 'bridge_llm',
        params: {
          role: opts.role || null,
          taskType: opts.taskType || null,
          mode: opts.mode || null,
          preset: opts.preset || null,
          cwd: opts.cwd || null,
          prompt: String(prompt ?? ''),
          timeout: timeoutMs,
        },
      })
    } catch (e) {
      pending.delete(callId)
      clearTimeout(timer)
      reject(e)
    }
  })
}
