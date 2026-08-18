import { performance } from "perf_hooks";
import { safeIpcSend } from "../../shared/safe-ipc-send.mjs";
// IPC worker-mode message loop extracted from channels/index.mjs
// (behavior-preserving). Installs shutdown handlers, the parent->worker message
// router, and the retrying start() bootstrap. Call once from the worker entry
// when _isWorkerMode && process.send.
export function runWorkerIpc({
  start,
  stop,
  stopVoiceWhisperServer,
  cleanupInstanceRuntimeFiles,
  clearServerPid,
  instanceId,
  statusState,
  getProvider,
  getConfig,
  handleMemoryCallResponse,
  handleToolCallWithBridgeRetry,
  bootProfile,
}) {
  const sendToParent = (message) => safeIpcSend(process, message, {
    onError: (error) => {
      try { process.stderr.write(`[channels-worker] parent IPC send failed: ${error?.message || error}\n`); } catch {}
    },
  });
  // SIGTERM/SIGINT/IPC shutdown handler — mirrors src/memory/index.mjs pattern.
  // Cleans up in-progress webhook/scheduler state, removes runtime files, then exits.
  let _channelsStopInFlight = false
  let _channelsForceExitTimer = null
  const _channelsShutdownHandler = async (sig) => {
    if (_channelsStopInFlight) {
      process.stderr.write(`[channels-worker] ${sig} — shutdown already in flight, ignoring\n`)
      return
    }
    _channelsStopInFlight = true
    for (const controller of _inFlightChannelCalls.values()) {
      try { controller.abort() } catch {}
    }
    _inFlightChannelCalls.clear()
    process.stderr.write(`[channels-worker] received ${sig} — shutting down cleanly\n`)
    _channelsForceExitTimer = setTimeout(() => {
      process.stderr.write(`[channels-worker] stop() timed out after 6000ms — forcing exit(2)\n`)
      process.exit(2)
    }, 6000)
    try { await stopVoiceWhisperServer() } catch (e) {
      process.stderr.write(`[channels-worker] stopVoiceWhisperServer() error on ${sig}: ${e && (e.message || e)}\n`)
    }
    try { await stop() } catch (e) {
      process.stderr.write(`[channels-worker] stop() error on ${sig}: ${e && (e.message || e)}\n`)
    }
    if (_channelsForceExitTimer) clearTimeout(_channelsForceExitTimer)
    try { cleanupInstanceRuntimeFiles(instanceId) } catch {}
    try { clearServerPid() } catch {}
    process.exit(0)
  }
  process.on('SIGTERM', () => _channelsShutdownHandler('SIGTERM'))
  process.on('SIGINT',  () => _channelsShutdownHandler('SIGINT'))
  process.once('disconnect', () => _channelsShutdownHandler('IPC:disconnect'))

  // Map of callId → AbortController for in-flight IPC calls.
  const _inFlightChannelCalls = new Map()

  process.on('message', async (msg) => {
    // Parent-initiated graceful shutdown — mirrors memory worker IPC pattern.
    if (msg && msg.type === 'shutdown') {
      process.stderr.write('[channels-worker] received IPC shutdown — calling stop()\n')
      _channelsShutdownHandler('IPC:shutdown')
      return
    }
    if (handleMemoryCallResponse(msg)) return;
    if (msg.type === 'cancel' && msg.callId) {
      const entry = _inFlightChannelCalls.get(msg.callId)
      if (entry) {
        entry.abort()
        _inFlightChannelCalls.delete(msg.callId)
      }
      sendToParent({ type: 'result', callId: msg.callId, error: 'cancelled' })
      return
    }
    if (msg.type !== 'call' || !msg.callId) return
    try {
      const ac = new AbortController()
      _inFlightChannelCalls.set(msg.callId, ac)
      let result
      try {
        result = await handleToolCallWithBridgeRetry(msg.name, msg.args || {}, ac.signal)
      } finally {
        _inFlightChannelCalls.delete(msg.callId)
      }
      sendToParent({ type: 'result', callId: msg.callId, result })
    } catch (e) {
      sendToParent({ type: 'result', callId: msg.callId, error: e.message })
    }
  })
  void (async () => {
    const startedAt = performance.now()
    const MAX_START_ATTEMPTS = 3
    const BASE_BACKOFF_MS = 250
    const isTransientStartErr = (err) =>
      err?.code === 'ELOCKTIMEOUT' || /atomic lock timeout/i.test(err?.message || '')
    let lastErr
    for (let attempt = 1; attempt <= MAX_START_ATTEMPTS; attempt++) {
      if (_channelsStopInFlight) return
      try {
        await start()
        bootProfile("worker:ready", { ms: (performance.now() - startedAt).toFixed(1), attempt })
        if (!sendToParent({ type: 'ready' })) {
          void _channelsShutdownHandler('IPC:ready-send-failed')
        }
        return
      } catch (e) {
        lastErr = e
        const transient = isTransientStartErr(e)
        bootProfile("worker:start-failed", { attempt, transient, error: e?.message || String(e) })
        process.stderr.write(`[channels-worker] start() failed (attempt ${attempt}/${MAX_START_ATTEMPTS}, transient=${transient}): ${e && (e.message || e)}\n`)
        if (!transient || attempt >= MAX_START_ATTEMPTS) break
        const backoff = BASE_BACKOFF_MS * attempt + Math.floor(Math.random() * BASE_BACKOFF_MS)
        await new Promise((r) => setTimeout(r, backoff))
        if (_channelsStopInFlight) return
      }
    }
    // A stop landed while we were failing — let clean shutdown proceed, never exit over it.
    if (_channelsStopInFlight) return
    // Terminal failure: do NOT mask as a (degraded) ready. Exit non-zero so the
    // parent's exit-before-ready path respawns or rejects the start instead of
    // silently losing remote output forwarding.
    bootProfile("worker:failed", { ms: (performance.now() - startedAt).toFixed(1), error: lastErr?.message || String(lastErr) })
    process.stderr.write(`[channels-worker] start() giving up after ${MAX_START_ATTEMPTS} attempts: ${lastErr && (lastErr.message || lastErr)}\n`)
    // Exit 2 = terminal (non-transient) start failure: parent must reject, not respawn.
    // Exit 1 = exhausted transient retries: parent may respawn.
    process.exit(isTransientStartErr(lastErr) ? 1 : 2)
  })()
}
