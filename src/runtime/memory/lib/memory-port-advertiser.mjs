// Memory service discovery advertisement lifecycle.
// Owns the retry/periodic timer state so there is exactly one advertise chain.

export function createMemoryPortAdvertiser({
  readServiceAdvert,
  writeServiceAdvert,
  parsePositivePid,
  isPidAliveLocal,
  memoryServerPid,
  log,
}) {
  let _periodicAdvertiseInstalled = false
  let _periodicAdvertiseTimer = null
  // Single module-level advertise retry chain. A newer advertiseMemoryPort call
  // cancels the older chain so a delayed retry never replays a stale boundPort.
  let _advertiseRetryTimer = null
  let _advertiseGeneration = 0
  // Track the most recently advertised port so the periodic tick re-reads it
  // every interval. Without this the setInterval closure binds the FIRST port
  // (the upstream we proxied to) and keeps re-advertising the dead upstream
  // port after fork-proxy promotion swaps in our own locally-bound port.
  let _currentAdvertisedPort = null

  function advertiseMemoryPort(boundPort, attempt = 0) {
    if (!Number.isFinite(boundPort) || boundPort <= 0) return
    // A fresh top-level advertise (attempt 0) supersedes any pending retry chain:
    // last write wins, so a delayed retry never clobbers a newer boundPort.
    if (attempt === 0) {
      _currentAdvertisedPort = boundPort
      _advertiseGeneration++
      if (_advertiseRetryTimer) { try { clearTimeout(_advertiseRetryTimer) } catch {} ; _advertiseRetryTimer = null }
    }
    const generation = _advertiseGeneration
    if (!_periodicAdvertiseInstalled) {
      _periodicAdvertiseInstalled = true
      _periodicAdvertiseTimer = setInterval(() => {
        try {
          if (_currentAdvertisedPort != null) {
            advertiseMemoryPort(_currentAdvertisedPort)
          }
        } catch {}
      }, 30_000)
      _periodicAdvertiseTimer.unref?.()
    }
    try {
      // Single-writer discovery file (discovery/memory.json), plain atomic rename
      // with NO .lock: memory_port discovery can never be starved by the shared
      // active-instance.json lock. Conflict guard preserved: a live OTHER memory
      // owner advertising a different port is not clobbered.
      const cur = readServiceAdvert('memory')
      const curMemPort = Number(cur?.port)
      const curMemPid = parsePositivePid(cur?.pid)
      const portConflict = Number.isFinite(curMemPort) && curMemPort > 0 && curMemPort !== boundPort
      const otherOwnerAlive =
        curMemPid != null &&
        curMemPid !== memoryServerPid &&
        isPidAliveLocal(curMemPid)
      if (portConflict && otherOwnerAlive) {
        log(`[memory-service] skip memory_port advertise port=${boundPort} curMemPort=${curMemPort} curMemPid=${curMemPid} memoryServerPid=${memoryServerPid}\n`)
        if (generation === _advertiseGeneration) _advertiseRetryTimer = null
        return
      }
      writeServiceAdvert('memory', {
        port: boundPort,
        ...(memoryServerPid ? { pid: memoryServerPid } : {}),
      })
      if (generation === _advertiseGeneration) _advertiseRetryTimer = null
    } catch (e) {
      // Boot path must not serially block on the default 8s lock wait: use a short
      // lock timeout and treat lock contention/timeout as transient so pg_port /
      // memory_port still eventually publish via unref'd, backed-off bg retries.
      const transient =
        e?.code === 'EPERM' || e?.code === 'EBUSY' || e?.code === 'EACCES' ||
        e?.code === 'ELOCKTIMEOUT' || e?.code === 'ELOCKCONTENDED'
      if (transient && attempt < 5 && generation === _advertiseGeneration) {
        const delay = Math.min(2000, 50 * 2 ** attempt)
        // Fire-time generation re-check: even if clearTimeout was missed, a
        // retry from a superseded chain must never republish an old boundPort.
        _advertiseRetryTimer = setTimeout(() => {
          if (generation !== _advertiseGeneration) return
          advertiseMemoryPort(boundPort, attempt + 1)
        }, delay)
        _advertiseRetryTimer.unref?.()
        return
      }
      log(`[memory-service] active-instance memory_port advertise failed: ${e?.message || e}\n`)
    }
  }

  function reset() {
    if (_periodicAdvertiseTimer) {
      try { clearInterval(_periodicAdvertiseTimer) } catch {}
      _periodicAdvertiseTimer = null
    }
    if (_advertiseRetryTimer) {
      try { clearTimeout(_advertiseRetryTimer) } catch {}
      _advertiseRetryTimer = null
    }
    _advertiseGeneration++
    _periodicAdvertiseInstalled = false
    _currentAdvertisedPort = null
  }

  return { advertiseMemoryPort, reset }
}
