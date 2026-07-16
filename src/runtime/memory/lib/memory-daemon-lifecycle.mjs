// Idle and connected-client lifecycle for the shared memory daemon.
// Timer and client state live here; the facade injects shutdown ownership.

export function createMemoryDaemonLifecycle({
  daemonMode,
  idleTtlMs,
  clientGraceMs,
  parsePositivePid,
  isPidAlive,
  isStopping,
  stop,
  log,
}) {
  let _idleShutdownTimer = null
  const _connectedClients = new Map()
  let _everHadClient = false
  let _clientGraceTimer = null
  let _clientSweepTimer = null

  function touchDaemonIdleTimer(reason = 'activity') {
    if (!daemonMode || idleTtlMs <= 0) return
    if (_idleShutdownTimer) {
      try { clearTimeout(_idleShutdownTimer) } catch {}
      _idleShutdownTimer = null
    }
    _idleShutdownTimer = setTimeout(() => {
      log(`[memory-service] daemon idle TTL elapsed after ${reason}; shutting down\n`)
      stop()
        .then(() => process.exit(0))
        .catch((e) => {
          log(`[memory-service] daemon idle shutdown failed: ${e?.message || e}\n`)
          process.exit(1)
        })
    }, idleTtlMs)
    _idleShutdownTimer.unref?.()
  }

  function clientShutdownEnabled() {
    return daemonMode && clientGraceMs > 0
  }

  function pruneDeadClients() {
    for (const pid of [..._connectedClients.keys()]) {
      if (!isPidAlive(pid)) _connectedClients.delete(pid)
    }
  }

  function cancelClientGrace() {
    if (_clientGraceTimer) {
      try { clearTimeout(_clientGraceTimer) } catch {}
      _clientGraceTimer = null
    }
  }

  function armClientGrace(reason = 'last client gone') {
    if (!clientShutdownEnabled() || _clientGraceTimer) return
    _clientGraceTimer = setTimeout(() => {
      _clientGraceTimer = null
      pruneDeadClients()
      if (_connectedClients.size > 0) return
      log(`[memory-service] daemon client grace elapsed (${reason}); shutting down\n`)
      stop()
        .then(() => process.exit(0))
        .catch((e) => {
          log(`[memory-service] daemon client-grace shutdown failed: ${e?.message || e}\n`)
          process.exit(1)
        })
    }, clientGraceMs)
    _clientGraceTimer.unref?.()
  }

  function startClientSweep() {
    if (_clientSweepTimer || !clientShutdownEnabled()) return
    const interval = Math.max(1000, Math.min(clientGraceMs, 5000))
    _clientSweepTimer = setInterval(() => {
      pruneDeadClients()
      if (_everHadClient && _connectedClients.size === 0) armClientGrace('all clients gone (sweep)')
    }, interval)
    _clientSweepTimer.unref?.()
  }

  function registerClient(clientPid) {
    const pid = parsePositivePid(clientPid)
    if (!pid) return true
    if (isStopping()) return false
    _connectedClients.set(pid, Date.now())
    _everHadClient = true
    cancelClientGrace()
    startClientSweep()
    return true
  }

  function deregisterClient(clientPid) {
    const pid = parsePositivePid(clientPid)
    if (pid) _connectedClients.delete(pid)
    pruneDeadClients()
    if (_everHadClient && _connectedClients.size === 0) armClientGrace('last client deregistered')
  }

  function reset() {
    if (_idleShutdownTimer) {
      try { clearTimeout(_idleShutdownTimer) } catch {}
      _idleShutdownTimer = null
    }
    cancelClientGrace()
    if (_clientSweepTimer) {
      try { clearInterval(_clientSweepTimer) } catch {}
      _clientSweepTimer = null
    }
    _connectedClients.clear()
    _everHadClient = false
  }

  return { touchDaemonIdleTimer, registerClient, deregisterClient, reset }
}
