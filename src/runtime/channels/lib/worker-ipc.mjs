import { performance } from "perf_hooks";
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
  getBackend,
  getConfig,
  pendingPermRequests,
  refreshToolExecConsumerMarker,
  handleMemoryCallResponse,
  handleToolCallWithBridgeRetry,
  bootProfile,
}) {
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

  // Map of callId → AbortController for in-flight IPC calls.
  const _inFlightChannelCalls = new Map()

  process.on('message', async (msg) => {
    // Parent-initiated graceful shutdown — mirrors memory worker IPC pattern.
    if (msg && msg.type === 'shutdown') {
      process.stderr.write('[channels-worker] received IPC shutdown — calling stop()\n')
      _channelsShutdownHandler('IPC:shutdown')
      return
    }
    // Silent-to-agent lifecycle forward — parent (server.mjs) asks the
    // channels worker to post status pings to the active bridge Discord
    // channel without the Lead-notify hop. Best-effort: unknown channel or
    // getBackend() failure is swallowed; lifecycle pings are non-critical.
    if (msg && msg.type === 'forward_to_discord') {
      try {
        const target = msg.channelId
          || (statusState?.read?.().channelId)
          || null;
        if (target && getBackend()?.sendMessage && typeof msg.content === 'string' && msg.content) {
          await getBackend().sendMessage(target, msg.content).catch(() => {});
        }
      } catch { /* best-effort */ }
      return;
    }
    // Host permission request → Discord Allow/Deny prompt.
    // Parent (server.mjs) receives notifications/claude/channel/permission_request
    // from the MCP host and forwards the params here. We post a buttoned message;
    // button clicks are handled in getBackend().onInteraction and sent back to CC as
    // notifications/claude/channel/permission via sendNotifyToParent.
    if (msg && msg.type === 'permission_request_inbound') {
      try {
        const { request_id, tool_name, description, input_preview } = msg.params || {};
        // tool_input arrives via the passthrough() schema in server.mjs when
        // The host includes it in the permission_request notification.
        // Used to bind the pendingPermRequest to a specific file so two
        // concurrent Edit/Write requests cannot cross-approve via the
        // terminal signal.
        const toolInputParam = (msg.params && (msg.params.tool_input || msg.params.toolInput)) || {};
        const filePathParam = toolInputParam.file_path || '';
        if (!request_id || !tool_name) return;
        if (pendingPermRequests.size > 100) {
          const cutoff = Date.now() - 30 * 60 * 1000;
          for (const [k, v] of pendingPermRequests) {
            if (v.createdAt < cutoff) pendingPermRequests.delete(k);
          }
          refreshToolExecConsumerMarker();
        }
        const target = (statusState?.read?.().channelId)
          || getConfig()?.channelId
          || null;
        if (!target || !getBackend()?.sendMessage) {
          process.stderr.write(`mixdog channels: permission_request dropped, no target channel (request_id=${request_id})\n`);
          return;
        }
        const lines = [`🔐 **Permission Request**`, `Tool: \`${tool_name}\``];
        if (description) lines.push(description);
        if (input_preview) lines.push('```\n' + String(input_preview).slice(0, 800) + '\n```');
        const content = lines.join('\n');
        const components = [{
          type: 1,
          components: [
            { type: 2, style: 3, label: 'Allow', custom_id: `perm-ch-${request_id}-allow` },
            { type: 2, style: 1, label: 'Session Allow', custom_id: `perm-ch-${request_id}-session` },
            { type: 2, style: 4, label: 'Deny', custom_id: `perm-ch-${request_id}-deny` },
          ],
        }];
        let sentIds = null;
        try {
          const sendResult = await getBackend().sendMessage(target, content, { components });
          sentIds = sendResult?.sentIds;
        } catch (err) {
          process.stderr.write(`mixdog channels: permission_request Discord send failed: ${err && err.message || err}\n`);
          return;
        }
        const messageId = Array.isArray(sentIds) && sentIds.length > 0 ? sentIds[0] : null;
        pendingPermRequests.set(request_id, {
          toolName: tool_name,
          filePath: filePathParam,
          createdAt: Date.now(),
          channelId: target,
          messageId,
        });
        refreshToolExecConsumerMarker();
      } catch (err) {
        try { process.stderr.write(`mixdog channels: permission_request handler error: ${err && err.message || err}\n`); } catch {}
      }
      return;
    }
    if (handleMemoryCallResponse(msg)) return;
    if (msg.type === 'cancel' && msg.callId) {
      const entry = _inFlightChannelCalls.get(msg.callId)
      if (entry) {
        entry.abort()
        _inFlightChannelCalls.delete(msg.callId)
      }
      process.send({ type: 'result', callId: msg.callId, error: 'cancelled' })
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
      process.send({ type: 'result', callId: msg.callId, result })
    } catch (e) {
      process.send({ type: 'result', callId: msg.callId, error: e.message })
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
        process.send({ type: 'ready' })
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
    // parent's exit-before-ready path respawns or rejects startRemote instead of
    // silently losing remote output forwarding.
    bootProfile("worker:failed", { ms: (performance.now() - startedAt).toFixed(1), error: lastErr?.message || String(lastErr) })
    process.stderr.write(`[channels-worker] start() giving up after ${MAX_START_ATTEMPTS} attempts: ${lastErr && (lastErr.message || lastErr)}\n`)
    // Exit 2 = terminal (non-transient) start failure: parent must reject, not respawn.
    // Exit 1 = exhausted transient retries: parent may respawn.
    process.exit(isTransientStartErr(lastErr) ? 1 : 2)
  })()
}
