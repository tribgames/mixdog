/**
 * pid-cleanup.mjs — Orphaned bridge CLI process cleanup.
 * Used by server.mjs on startup and shutdown.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

const PID_DIR = path.join(os.tmpdir(), 'mixdog-bridge')
const PID_FILE = path.join(PID_DIR, 'bridge-pids.json')

export function cleanupOrphanedPids() {
  let killed = 0
  try {
    const pids = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'))
    for (const pid of pids) {
      try {
        process.kill(pid, 0)
        process.kill(pid, 'SIGTERM')
        process.stderr.write(`[bridge-cleanup] killed orphaned PID ${pid}\n`)
        killed++
      } catch {}
    }
    fs.writeFileSync(PID_FILE, JSON.stringify([]))
  } catch {}
  return killed
}
