// Process lock for the standalone memory MCP entry. Product mode is hosted
// A direct entry (including the isolated daemon child) owns this lock.
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'

export function parsePositivePid(value) {
  const pid = Number(value)
  return Number.isFinite(pid) && pid > 0 ? pid : null
}

export function isPidAliveLocal(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (e) { return e.code !== 'ESRCH' }
}

function killPreviousServer(pid, log = () => {}) {
  if (pid <= 0 || pid === process.pid) return false
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/F', '/T', '/PID', String(pid)], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      log(`[memory-service] Killed previous server PID ${pid}\n`)
      return true
    } catch (e) {
      // Exit code 128 = process not found; treat stale lock as already-dead = success.
      // Status 128 reliably means "process not found" regardless of locale; no text match needed.
      // Status 1 with English text match handles edge cases on some Windows versions.
      const notFoundText = /not found|no running instance/i.test(e.stdout || '')
        || /not found|no running instance/i.test(e.stderr || '')
        || /not found|no running instance/i.test(e.message || '')
      const alreadyDead = e.status === 128 || (e.status === 1 && notFoundText)
      if (alreadyDead) {
        log(`[memory-service] PID ${pid} already dead (stale lock), proceeding\n`)
        return true
      }
      log(`[memory-service] taskkill failed for PID ${pid}: ${e.message}\n`)
      return false
    }
  } else {
    // Pre-flight: if the process is already gone, treat stale lock as success.
    try {
      process.kill(pid, 0)
    } catch (e) {
      if (e.code === 'ESRCH') {
        log(`[memory-service] PID ${pid} already dead (stale lock), proceeding\n`)
        return true
      }
    }
    try { process.kill(pid, 'SIGTERM') } catch {}
    try { process.kill(pid, 'SIGKILL') } catch {}
    // Poll for death up to 2s
    const deadline = Date.now() + 2000
    while (Date.now() < deadline) {
      try {
        process.kill(pid, 0)
      } catch (e) {
        if (e.code === 'ESRCH') {
          log(`[memory-service] Killed previous server PID ${pid}\n`)
          return true
        }
      }
      // Synchronous 50ms sleep via shared buffer spin
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
    }
    log(`[memory-service] PID ${pid} still alive after SIGKILL\n`)
    return false
  }
}

export function acquireLock(lockFile, log = () => {}) {
  // Multi-instance mode is coordinated by the unified daemon, so a direct MCP
  // entry does not evict an already-running peer from another client.
  if (process.env.MIXDOG_MULTI_INSTANCE === '1') return
  try {
    if (fs.existsSync(lockFile)) {
      const lockedPid = Number(fs.readFileSync(lockFile, 'utf8').trim())
      if (lockedPid > 0 && lockedPid !== process.pid) {
        const killed = killPreviousServer(lockedPid, log)
        if (!killed) {
          log(`[memory-service] Could not kill previous server PID ${lockedPid}, aborting\n`)
          process.exit(1)
        }
        try { fs.unlinkSync(lockFile) } catch {}
      }
    }
    const fd = fs.openSync(lockFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    try {
      fs.writeSync(fd, String(process.pid))
    } finally {
      fs.closeSync(fd)
    }
  } catch (e) {
    if (e.code === 'EEXIST') {
      log(`[memory-service] Lock file exists (EEXIST) — another instance is already running, exiting\n`)
      process.exit(0)
    }
    log(`[memory-service] Lock acquisition failed: ${e.message}\n`)
    process.exit(1)
  }
}

export function releaseLock(lockFile) {
  try {
    const content = fs.readFileSync(lockFile, 'utf8').trim()
    if (Number(content) === process.pid) fs.unlinkSync(lockFile)
  } catch {}
}
