// Background cycle scheduling cluster, extracted from index.mjs (pass 3).
//
// This owns the mutually-referential cycle machinery that pass-2 flagged as
// entangled: cycle-health ledger (_cycleHealth), the run-state file, the
// cycle1 outer coalesce layer (_startCycle1Run/_awaitCycle1Run), the scheduled
// enqueue/retry paths for cycle1/2/3, checkCycles(), and the self-rescheduling
// tick loop. index.mjs keeps lifecycle ownership by injecting live getters
// (getDb/getConfig/setConfig) plus the cycle runners and LLM adapters.
//
// Factory contract — everything the extracted functions closed over in the
// facade is passed in:
//   getDb()            -> live db handle (null before _initStore)
//   getConfig()        -> live mainConfig
//   setConfig(cfg)     -> checkCycles re-reads config each tick (poll-on-use)
//   dataDir            -> DATA_DIR
//   log                -> __mixdogMemoryLog
//   getCycleLastRun / setCycleLastRun -> meta-backed cycle timestamps
//   readMainConfig / memoryCyclesEnabled -> config-flag helpers
//   getCycle{1,2,3}CallLlm -> in-process LLM adapters
//   runCycle1 / runCycle2 / runCycle3 / parseInterval / flushRawEmbeddings
//   getInFlightCycle1 -> inner cycle1 guard handle (rebuild drain)
//   claimAndMarkScheduledCycle / resolveCoalesceMaxRetries /
//     scheduleCoalescedCycleRetry -> coalesced queue primitives
//   scheduledCycle{1,2,3}Signature -> queue signatures
//   cycleStateFile -> path to memory-cycle-state.json
import fs from 'node:fs'

const CYCLE1_HEALTH_OVERDUE_MS = 5 * 60_000
const CYCLE1_AUTO_RESTART_COOLDOWN_MS = 5 * 60_000
const CYCLE1_OMITTED_COOLDOWN_MS = 60 * 60 * 1000
const BACKLOG_WARN_COOLDOWN_MS = 10 * 60_000
const BACKLOG_WARN_PENDING = 500
const BACKLOG_WARN_FAILURES = 5
// Max back-to-back cycle2 passes per scheduled slot (config: cycle2.catchup_passes).
const CYCLE2_CATCHUP_PASSES = 4
const CYCLE2_CATCHUP_PASSES_MAX = 10

function resolveCycle2CatchupPasses(config) {
  const raw = Number(config?.catchup_passes ?? CYCLE2_CATCHUP_PASSES)
  if (!Number.isFinite(raw)) return CYCLE2_CATCHUP_PASSES
  return Math.min(CYCLE2_CATCHUP_PASSES_MAX, Math.max(1, Math.floor(raw)))
}

export function createCycleScheduler(deps) {
  const {
    getDb,
    getConfig,
    setConfig,
    dataDir,
    log = () => {},
    getCycleLastRun,
    setCycleLastRun,
    readMainConfig,
    memoryCyclesEnabled,
    getCycle1CallLlm,
    getCycle2CallLlm,
    getCycle3CallLlm,
    runCycle1,
    runCycle2,
    runCycle3,
    parseInterval,
    flushRawEmbeddings,
    getInFlightCycle1,
    claimAndMarkScheduledCycle,
    resolveCoalesceMaxRetries,
    scheduleCoalescedCycleRetry,
    scheduledCycle1Signature,
    scheduledCycle2Signature,
    scheduledCycle3Signature,
    cycleStateFile,
  } = deps

  // ── Cycle health state ────────────────────────────────────────────────────
  const _cycleHealth = {
    cycle1: { last_success_at: 0, last_error_at: 0, last_error: null, consecutive_failures: 0 },
    cycle2: { last_success_at: 0, last_error_at: 0, last_error: null, consecutive_failures: 0 },
    cycle3: { last_success_at: 0, last_error_at: 0, last_error: null, consecutive_failures: 0 },
  }
  let _cycleRunning = null // { cycle, started_at }
  let _cycleBacklogSnapshot = { unchunked: 0, cycle2_pending: 0, at: 0 }
  let _lastBacklogWarnAt = 0

  // ── Cycle1 outer coalesce layer + tick loop state ─────────────────────────
  let _cycle1InFlight = null
  let _cycle2InFlight = false
  let _cycle3InFlight = false
  let _rawEmbedFlushInFlight = false
  let _checkCyclesInFlight = false
  let _cyclesActive = false
  let _cycleInterval = null
  let _startupTimeout = null

  function _writeCycleStateFile() {
    try {
      fs.writeFileSync(cycleStateFile, JSON.stringify({
        running: _cycleRunning,
        backlog: _cycleBacklogSnapshot,
        cycles: _cycleHealth,
        updatedAt: Date.now(),
      }))
    } catch { /* best-effort; statusline just shows nothing */ }
  }

  function markCycleRunning(cycle) {
    _cycleRunning = { cycle, started_at: Date.now() }
    _writeCycleStateFile()
  }

  function markCycleDone(cycle, ok, err = null) {
    const h = _cycleHealth[cycle]
    if (h) {
      const now = Date.now()
      if (ok) { h.last_success_at = now; h.consecutive_failures = 0; h.last_error = null }
      else { h.last_error_at = now; h.consecutive_failures += 1; h.last_error = String(err || 'unknown').slice(0, 200) }
      if (!ok && h.consecutive_failures >= BACKLOG_WARN_FAILURES) {
        _warnCycleHealth(`${cycle} failing repeatedly (consecutive=${h.consecutive_failures}, last="${h.last_error}")`)
      }
    }
    if (_cycleRunning?.cycle === cycle) _cycleRunning = null
    _writeCycleStateFile()
  }

  function _warnCycleHealth(msg) {
    const now = Date.now()
    if (now - _lastBacklogWarnAt < BACKLOG_WARN_COOLDOWN_MS) return
    _lastBacklogWarnAt = now
    log(`[cycle-health] WARN ${msg}\n`)
  }

  async function recordCycle1Result(result) {
    const now = Date.now()
    await setCycleLastRun('cycle1_heartbeat', now)
    const skipped = result?.skippedInFlight === true
    const coalescedNoop = result?.coalescedRetryNoop === true
    const allFailed = !skipped
      && Number(result?.chunks ?? 0) === 0
      && Number(result?.processed ?? 0) === 0
      && Number(result?.skipped ?? 0) > 0
    if (!skipped && !coalescedNoop && !allFailed) {
      await setCycleLastRun('cycle1', now)
    }
    if (!skipped && !coalescedNoop) markCycleDone('cycle1', !allFailed, allFailed ? 'all rows skipped' : null)
  }

  function _startCycle1Run(config = {}, options = {}) {
    if (typeof options?.callLlm !== 'function') {
      options = { ...options, callLlm: getCycle1CallLlm() }
    }
    markCycleRunning('cycle1')
    _cycle1InFlight = (async () => {
      try {
        const result = await runCycle1(getDb(), config, options, dataDir)
        if (typeof options?.onCoalescedSuccess !== 'function') {
          await recordCycle1Result(result)
        }
        return result
      } catch (err) {
        markCycleDone('cycle1', false, err?.message || err)
        throw err
      } finally {
        if (_cycleRunning?.cycle === 'cycle1') { _cycleRunning = null; _writeCycleStateFile() }
        if (_cycle1InFlight === promise) _cycle1InFlight = null
      }
    })()
    const promise = _cycle1InFlight
    return _cycle1InFlight
  }

  async function _awaitCycle1Run(config = {}, options = {}) {
    const target = _cycle1InFlight || _startCycle1Run(config, options)
    const callerDeadlineMs = Number(options.callerDeadlineMs) || 0
    if (callerDeadlineMs <= 0) return await target
    let timer
    const deadlinePromise = new Promise((resolve) => {
      timer = setTimeout(() => {
        resolve({
          processed: 0,
          chunks: 0,
          skipped: 0,
          sessions: 0,
          skippedInFlight: true,
          timedOutWaiting: true,
          callerDeadlineMs,
        })
      }, callerDeadlineMs)
    })
    try {
      return await Promise.race([target, deadlinePromise])
    } finally {
      clearTimeout(timer)
    }
  }

  function periodicCycle1Config() {
    return {
      min_batch: 20,
      session_cap: 2,
      batch_size: 50,
      concurrency: 2,
      ...(getConfig()?.cycle1 || {}),
    }
  }

  async function enqueueScheduledCycle(kind, intervalMs, signature) {
    const claim = await claimAndMarkScheduledCycle(getDb(), kind, intervalMs, signature, { reason: 'scheduled' })
    return claim.claimed === true
  }

  async function enqueueScheduledCycle1(intervalMs, _reason = 'scheduled') {
    const config = periodicCycle1Config()
    const signature = scheduledCycle1Signature(config)
    if (await enqueueScheduledCycle('cycle1', intervalMs, signature)) {
      scheduleScheduledCycle1(config, signature)
    }
  }

  async function enqueueScheduledCycle2(intervalMs, _reason = 'scheduled') {
    const config = getConfig()?.cycle2 || {}
    const signature = scheduledCycle2Signature(config)
    if (await enqueueScheduledCycle('cycle2', intervalMs, signature)) {
      scheduleScheduledCycle2(config, signature)
    }
  }

  async function enqueueScheduledCycle3(intervalMs, _reason = 'scheduled') {
    const config = getConfig() || {}
    const signature = scheduledCycle3Signature(config)
    if (await enqueueScheduledCycle('cycle3', intervalMs, signature)) {
      scheduleScheduledCycle3(config, signature)
    }
  }

  function scheduleScheduledCycle1(config, signature, attempt = 0) {
    const maxRetries = resolveCoalesceMaxRetries(config, 3)
    if (attempt > maxRetries) {
      log('[cycle1] scheduled queue retry cap reached\n')
      return
    }
    scheduleCoalescedCycleRetry(getDb(), 'cycle1', async () => {
      if (!memoryCyclesEnabled()) return
      if (_cycle1InFlight) {
        scheduleScheduledCycle1(config, signature, attempt + 1)
        return
      }
      const result = await _awaitCycle1Run(config, {
        coalescedRetry: true,
        onCoalescedSuccess: recordCycle1Result,
      })
      if (result?.skippedInFlight) scheduleScheduledCycle1(config, signature, attempt + 1)
    }, config, signature)
  }

  function scheduleScheduledCycle2(config, signature, attempt = 0) {
    const maxRetries = resolveCoalesceMaxRetries(config, 3)
    if (attempt > maxRetries) {
      log('[cycle2] scheduled queue retry cap reached\n')
      return
    }
    scheduleCoalescedCycleRetry(getDb(), 'cycle2', async () => {
      if (!memoryCyclesEnabled()) return
      if (_cycle2InFlight) {
        scheduleScheduledCycle2(config, signature, attempt + 1)
        return
      }
      _cycle2InFlight = true
      markCycleRunning('cycle2')
      try {
        // Catch-up drain: one scheduled slot may run several back-to-back
        // passes while pending roots remain, so a backlog above the batch
        // size drains in one interval instead of one batch per hour.
        const drainPasses = resolveCycle2CatchupPasses(config)
        for (let pass = 0; pass < drainPasses; pass++) {
          let c2Options = {
            coalescedRetry: true,
            catchUpDrainPass: pass > 0,
            onCoalescedSuccess: _finalizeCycle2Run,
          }
          if (typeof c2Options?.callLlm !== 'function') {
            c2Options = { ...c2Options, callLlm: getCycle2CallLlm() }
          }
          const result = await runCycle2(getDb(), config, c2Options, dataDir)
          if (result?.skippedInFlight) {
            scheduleScheduledCycle2(config, signature, attempt + 1)
            break
          }
          if (result?.coalescedRetryNoop) {
            log('[cycle2] scheduled queue noop\n')
            break
          }
          if (result?.ok === false) {
            await _finalizeCycle2Run(result)
            break
          }
          // A gate parse/coverage failure marks the run failed even with
          // ok=true; never chain passes on a failing gate.
          if (result?.gate_failed === true) break
          const pendingRes = await getDb().query(
            `SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'pending'`,
          )
          const pendingLeft = Number(pendingRes?.rows?.[0]?.c ?? 0)
          log(
            `[cycle2] catch-up pass ${pass + 1}/${drainPasses}: `
            + `promoted=${Number(result?.promoted ?? 0)} pending=${pendingLeft}\n`,
          )
          if (pendingLeft <= 0) break
          if (pass + 1 >= drainPasses) break
        }
      } catch (err) {
        log(`[cycle2] scheduled queue failed: ${err?.message || err}\n`)
        markCycleDone('cycle2', false, err?.message || err)
      } finally {
        _cycle2InFlight = false
        if (_cycleRunning?.cycle === 'cycle2') { _cycleRunning = null; _writeCycleStateFile() }
      }
    }, config, signature)
  }

  function scheduleScheduledCycle3(config, signature, attempt = 0) {
    const retryConfig = config?.cycle3 || config
    const maxRetries = resolveCoalesceMaxRetries(retryConfig, 3)
    if (attempt > maxRetries) {
      log('[cycle3] scheduled queue retry cap reached\n')
      return
    }
    scheduleCoalescedCycleRetry(getDb(), 'cycle3', async () => {
      if (!memoryCyclesEnabled()) return
      if (_cycle3InFlight) {
        scheduleScheduledCycle3(config, signature, attempt + 1)
        return
      }
      _cycle3InFlight = true
      markCycleRunning('cycle3')
      try {
        let c3Options = {
          coalescedRetry: true,
          onCoalescedSuccess: async (result) => {
            // Only a real, error-free pass persists success; a run that returned
            // an error (LLM/unparseable) must not stamp last_success_at.
            if (result?.error) { markCycleDone('cycle3', false, result.error); return }
            await setCycleLastRun('cycle3', Date.now())
            markCycleDone('cycle3', true)
          },
        }
        if (typeof c3Options?.callLlm !== 'function') {
          c3Options = { ...c3Options, callLlm: getCycle3CallLlm() }
        }
        const result = await runCycle3(getDb(), config, dataDir, c3Options)
        if (result?.skippedInFlight) {
          scheduleScheduledCycle3(config, signature, attempt + 1)
        } else if (result?.coalescedRetryNoop) {
          log('[cycle3] scheduled queue noop\n')
        }
      } catch (err) {
        log(`[cycle3] scheduled queue failed: ${err?.message || err}\n`)
        markCycleDone('cycle3', false, err?.message || err)
      } finally {
        _cycle3InFlight = false
        if (_cycleRunning?.cycle === 'cycle3') { _cycleRunning = null; _writeCycleStateFile() }
      }
    }, retryConfig, signature)
  }

  async function _finalizeCycle2Run(result) {
    if (result?.skippedInFlight) {
      log('[cycle2] skipped: in flight\n')
      return
    }
    const gateFailed = result?.gate_failed === true
    if (result.ok && !gateFailed) {
      await setCycleLastRun('cycle2', Date.now())
      await setCycleLastRun('cycle2_last_error', '')
      log('[cycle2] completed\n')
      markCycleDone('cycle2', true)
    } else {
      const err = gateFailed ? 'gate_failed' : (result.error || 'unknown error')
      await setCycleLastRun('cycle2_last_error', err)
      log(`[cycle2] failed: ${err}\n`)
      markCycleDone('cycle2', false, err)
    }
  }

  async function checkCycles() {
    const mainConfig = readMainConfig()
    setConfig(mainConfig)
    const cyclesOn = memoryCyclesEnabled()
    const db = getDb()

    const cycle1Ms = parseInterval(mainConfig?.cycle1?.interval || '10m')
    const cycle2Ms = parseInterval(mainConfig?.cycle2?.interval || '1h')
    const cycle3Ms = parseInterval(mainConfig?.cycle3?.interval || '24h')

    const now = Date.now()
    const last = await getCycleLastRun()

    if (cyclesOn) {
      const cycle1OverdueMs = last.cycle1 > 0
        ? Math.max(0, now - last.cycle1 - cycle1Ms)
        : 0
      if (cycle1OverdueMs > CYCLE1_HEALTH_OVERDUE_MS) {
        const lastSeen = last.cycle1 ? new Date(last.cycle1).toISOString() : 'never'
        log(
          `[cycle1] overdue by ${Math.floor(cycle1OverdueMs / 60_000)}min `
          + `(last=${lastSeen}). Pool B Anthropic shard may be cold.\n`
        )
        const lastAutoRestart = last.cycle1_autoRestart || 0
        if (now - lastAutoRestart >= CYCLE1_AUTO_RESTART_COOLDOWN_MS) {
          await setCycleLastRun('cycle1_autoRestart_attempt', now)
          try {
            const result = await _awaitCycle1Run(periodicCycle1Config())
            await setCycleLastRun('cycle1_autoRestart', Date.now())
            log(
              `[cycle1] auto-restart completed chunks=${result?.chunks ?? 0} processed=${result?.processed ?? 0}\n`
            )
            return
          } catch (e) {
            log(`[cycle1] auto-restart error: ${e.message}\n`)
            return
          }
        }
      }

      if (now - last.cycle1 >= cycle1Ms) {
        await enqueueScheduledCycle1(cycle1Ms, 'scheduled')
      }

      if (now - last.cycle2 >= cycle2Ms) {
        await enqueueScheduledCycle2(cycle2Ms, 'scheduled')
      }

      if (now - last.cycle3 >= cycle3Ms) {
        await enqueueScheduledCycle3(cycle3Ms, 'scheduled')
      }
    }

    try {
      const unchunked = Number((await db.query(
        `SELECT COUNT(*) c FROM entries WHERE chunk_root IS NULL AND NULLIF(btrim(session_id), '') IS NOT NULL`,
      )).rows[0]?.c ?? 0)
      const unchunkedEligible = Number((await db.query(
        `SELECT COUNT(*) c FROM entries
         WHERE chunk_root IS NULL
           AND NULLIF(btrim(session_id), '') IS NOT NULL
           AND (reviewed_at IS NULL OR reviewed_at < $1)`,
        [now - CYCLE1_OMITTED_COOLDOWN_MS],
      )).rows[0]?.c ?? 0)
      const cycle2Pending = Number((await db.query(
        `SELECT COUNT(*) c FROM entries WHERE is_root = 1 AND status = 'pending'`,
      )).rows[0]?.c ?? 0)
      _cycleBacklogSnapshot = { unchunked, unchunked_eligible: unchunkedEligible, cycle2_pending: cycle2Pending, at: now }
      _writeCycleStateFile()
      if (unchunked > BACKLOG_WARN_PENDING || cycle2Pending > BACKLOG_WARN_PENDING) {
        _warnCycleHealth(`backlog unchunked=${unchunked} eligible=${unchunkedEligible} cycle2_pending=${cycle2Pending}`)
      }
      if (unchunked > 0 && !_rawEmbedFlushInFlight) {
        _rawEmbedFlushInFlight = true
        flushRawEmbeddings(db, { limit: 200 })
          .then((r) => {
            if (r.attempted > 0) log(`[embed] raw fallback flush attempted=${r.attempted} embedded=${r.embedded}\n`)
          })
          .catch((err) => log(`[embed] raw fallback flush failed: ${err?.message || err}\n`))
          .finally(() => { _rawEmbedFlushInFlight = false })
      }
      const SELF_KICK_STALE_MS = 2 * 3600_000
      const c1Stale = (_cycleHealth.cycle1.last_success_at || last.cycle1 || 0) < now - SELF_KICK_STALE_MS
      const c2Stale = (_cycleHealth.cycle2.last_success_at || last.cycle2 || 0) < now - SELF_KICK_STALE_MS
      if (cyclesOn && c1Stale && unchunked > BACKLOG_WARN_PENDING) {
        _warnCycleHealth(`cycle1 self-kick: no success 2h+, unchunked=${unchunked}`)
        await enqueueScheduledCycle1(0, 'self-kick')
      } else if (cyclesOn && c2Stale && cycle2Pending > BACKLOG_WARN_PENDING) {
        _warnCycleHealth(`cycle2 self-kick: no success 2h+, pending=${cycle2Pending}`)
        await enqueueScheduledCycle2(0, 'self-kick')
      }
    } catch { /* counts are best-effort; never fail the tick */ }
  }

  async function _runCheckCyclesGuarded() {
    if (_checkCyclesInFlight) return
    _checkCyclesInFlight = true
    try { await checkCycles() }
    catch (e) { log(`[cycle-tick] error: ${e.message}\n`) }
    finally { _checkCyclesInFlight = false }
  }

  function _scheduleNextCheck() {
    _cycleInterval = setTimeout(async () => {
      _cycleInterval = null
      try {
        await _runCheckCyclesGuarded()
      } catch (e) {
        log(`[cycle-tick] re-arm guard caught: ${e?.message || e}\n`)
      } finally {
        if (_cyclesActive) _scheduleNextCheck()
      }
    }, 60_000)
  }

  function startCycles() {
    if (_cyclesActive) return
    _cyclesActive = true
    // Boot reset: a previous daemon that crashed mid-run leaves the state
    // file's `running` marker set, and the statusline keeps showing a
    // phantom "Memory cycle running" spinner until its 10-minute stale
    // guard kicks in. No cycle can be running when this scheduler starts,
    // so clear the marker (health/backlog reset to this process's state).
    _cycleRunning = null
    _writeCycleStateFile()
    // Hydrate health success timestamps from the persisted per-cycle last-run
    // meta. Without this, a restart re-inits _cycleHealth to last_success_at=0
    // and the state file reports 0 until the next run — for cycle3 that is up
    // to 24h later, so a genuinely-successful cycle3 looks like it never ran.
    Promise.resolve(getCycleLastRun()).then((last) => {
      if (last?.cycle1 > 0 && !_cycleHealth.cycle1.last_success_at) _cycleHealth.cycle1.last_success_at = last.cycle1
      if (last?.cycle2 > 0 && !_cycleHealth.cycle2.last_success_at) _cycleHealth.cycle2.last_success_at = last.cycle2
      if (last?.cycle3 > 0 && !_cycleHealth.cycle3.last_success_at) _cycleHealth.cycle3.last_success_at = last.cycle3
      _writeCycleStateFile()
    }).catch(() => {})
    _scheduleNextCheck()
    _startupTimeout = setTimeout(() => { void _runCheckCyclesGuarded() }, 30_000)
  }

  function stopCycles() {
    _cyclesActive = false
    if (_cycleInterval) { clearTimeout(_cycleInterval); _cycleInterval = null }
    if (_startupTimeout) { clearTimeout(_startupTimeout); _startupTimeout = null }
  }

  // Full-shutdown reset — baseline stop() cleared these module-level flags so
  // a later init() starts from a clean slate instead of coalescing onto (or
  // skipping behind) pre-stop in-flight work / stale running state.
  function resetInFlight() {
    _cycle1InFlight = null
    _cycle2InFlight = false
    _cycle3InFlight = false
    _checkCyclesInFlight = false
    _rawEmbedFlushInFlight = false
    _cycleRunning = null
  }

  return {
    // health/state accessors (HTTP /health, statusline)
    getCycleHealth: () => _cycleHealth,
    getCycleRunning: () => _cycleRunning,
    getCycleBacklogSnapshot: () => _cycleBacklogSnapshot,
    // cycle1 in-flight handle (rebuild drain in index.mjs)
    getCycle1InFlight: () => _cycle1InFlight,
    // run primitives used by MCP action handlers
    startCycle1Run: _startCycle1Run,
    awaitCycle1Run: _awaitCycle1Run,
    finalizeCycle2Run: _finalizeCycle2Run,
    // cycle3 success recorder: MCP-driven runs go through runCycle3 directly
    // (no coalesced onCoalescedSuccess), so callers stamp success here to keep
    // cycles.cycle3.last_success_at honest. Non-mutating/failed runs skipped.
    finalizeCycle3Run: async (result) => {
      if (!result || result.skippedInFlight || result.coalescedRetryNoop) return
      if (result.error) { markCycleDone('cycle3', false, result.error); return }
      await setCycleLastRun('cycle3', Date.now())
      markCycleDone('cycle3', true)
    },
    periodicCycle1Config,
    // lifecycle
    startCycles,
    stopCycles,
    resetInFlight,
    checkCycles,
  }
}
