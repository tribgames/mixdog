/**
 * IMPORTANT — cwd model role:
 * pwd() resolves the user's working directory for RELATIVE PATH RESOLUTION only.
 * It is NOT a sandbox boundary. Sandbox decisions are governed by the active
 * Mixdog permission policy.
 */

/**
 * user-cwd.mjs — shared helper to resolve the user's working directory.
 * Inline runtimes use AsyncLocalStorage; an inherited
 * MIXDOG_SESSION_CWD remains only a boot/isolated-process fallback.
 *
 * Single-source-of-truth model:
 *   - captureOriginalUserCwd() reads the async session scope first, then
 *     MIXDOG_SESSION_CWD/user-cwd.txt fresh on every call.
 *   - rawUserCwd() reads ONLY user-cwd.txt (no env consult) — exposed
 *     for the cwd-tool auto-init path so the env-var fallback cannot
 *     become self-referential.
 *   - AsyncLocalStorage override (runWithCwdOverride) isolates concurrent worker cwds.
 *   - pwd() = override ?? originalCwd. Hot lookups short-circuit on the
 *     override, so the no-override fallback path is cold and per-call
 *     disk reads of user-cwd.txt are negligible.
 */

import { AsyncLocalStorage } from 'async_hooks'
import { readFileSync, statSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { homedir } from 'os'
import { resolvePluginData, mixdogRoot } from './plugin-paths.mjs'

const _cwdOverride = new AsyncLocalStorage()

function _activeCwdOverride() {
  const store = _cwdOverride.getStore()
  if (typeof store === 'string') return store
  return store && typeof store.cwd === 'string' ? store.cwd : null
}

function _dataFile(name) {
  return join(resolvePluginData(), name)
}

// process.cwd() is the server's LAUNCH directory. In daemon mode that can be
// MIXDOG_ROOT (the install/resource root), so using it as a
// relative-path base silently resolves into the DEPLOYED plugin copy instead
// of the user's working tree — the exact cause of stale reads in a worker that
// inherited no explicit cwd. Treat that one case as "no usable cwd" and fall
// back to the home dir: a missing session signal then surfaces as ENOENT
// (absolute paths required) rather than a silent stale read. Invariant check
// (exact path equality with the known root), not a path-substring heuristic.
function _safeProcessCwd() {
  const cwd = process.cwd()
  try { if (resolve(cwd) === resolve(mixdogRoot())) return homedir() } catch { /* fall through to cwd */ }
  return cwd
}

// Hook payloads can deliver POSIX paths on Windows (e.g. `/c/Project`); Node's
// path.resolve does not map MSYS-style drive prefixes, so the value must be
// rewritten to the platform-native shape before path resolution.
function _normalizePlatformCwd(p) {
  if (!p || typeof p !== 'string') return p
  if (process.platform !== 'win32') return resolve(p)
  // Map all three POSIX drive-prefix shapes to native Windows paths before
  // resolution, aligned with path-utils.mjs posixPathToWindowsPath:
  //   /cygdrive/c/... (Cygwin), /mnt/c/... (WSL), /c/... (MSYS/Git-Bash) → C:\...
  // Cygwin/WSL prefixes must be tested before the bare single-letter form
  // because their slice offsets differ.
  const cyg = p.match(/^\/cygdrive\/([a-zA-Z])\//)
  const wsl = p.match(/^\/mnt\/([a-zA-Z])\//)
  let native = p
  if (cyg) native = `${cyg[1].toUpperCase()}:\\${p.slice(11).replace(/\//g, '\\')}`
  else if (wsl) native = `${wsl[1].toUpperCase()}:\\${p.slice(7).replace(/\//g, '\\')}`
  else {
    const m = p.match(/^[\/\\]([a-zA-Z])[\/\\](.*)$/)
    if (m) native = `${m[1].toUpperCase()}:\\${m[2].replace(/\//g, '\\')}`
  }
  return resolve(native)
}

/**
 * Resolve the session cwd from EXPLICIT signals only:
 *   1. AsyncLocalStorage — current inline-session scope.
 *   2. process.env.MIXDOG_SESSION_CWD — boot/isolated-process override.
 *   3. user-cwd.txt — persisted fallback maintained by Mixdog
 *      (rewritten at every session start).
 * Returns null when neither is available.
 *
 * Unlike captureOriginalUserCwd()/pwd(), this NEVER falls back to
 * process.cwd(): the server's launch directory is not a session signal,
 * and letting it leak into PROJECT CLASSIFICATION (resolveProjectScope)
 * would misclassify rows under the service/plugin cwd. Use this for
 * project_id resolution; use pwd() for relative-path resolution.
 */
export function explicitSessionCwd() {
  const scoped = _activeCwdOverride()
  if (scoped) return scoped
  const sessionRaw = process.env.MIXDOG_SESSION_CWD
  if (typeof sessionRaw === 'string' && sessionRaw.length > 0) {
    const normalized = _normalizePlatformCwd(sessionRaw)
    if (normalized) {
      try {
        const st = statSync(normalized)
        if (st.isDirectory()) return normalized
      } catch { /* fall through to user-cwd.txt */ }
    }
  }
  try {
    const txt = readFileSync(_dataFile('user-cwd.txt'), 'utf8').trim()
    return (txt && _normalizePlatformCwd(txt)) || null
  } catch {
    return null
  }
}

/**
 * Resolve the session entry root from an explicit project dir.
 */
function startRootCwd() {
  const dir = process.env.MIXDOG_PROJECT_DIR
  if (typeof dir === 'string' && dir.length > 0) {
    const normalized = _normalizePlatformCwd(dir)
    if (normalized) {
      try {
        if (statSync(normalized).isDirectory()) return normalized
      } catch { /* not a live directory — fall through */ }
    }
  }
  return null
}

/**
 * Resolve the user's current working directory for RELATIVE PATH
 * RESOLUTION. Same explicit precedence as explicitSessionCwd(), then the
 * session-entry root (MIXDOG_PROJECT_DIR), with process.cwd() as the final
 * fallback when no explicit session cwd exists.
 *
 * Read fresh on every call: hot lookups inside a worker are short-
 * circuited by runWithCwdOverride AsyncLocalStorage long before reaching
 * this function, so the no-override fallback path is cold and per-call
 * disk reads are negligible.
 */
export function captureOriginalUserCwd() {
  return explicitSessionCwd() ?? startRootCwd() ?? _safeProcessCwd()
}

/**
 * Read the user-cwd.txt sentinel directly, with NO env-var consult.
 * Used by the cwd-tool auto-init path to avoid self-reference when
 * deciding whether to seed MIXDOG_SESSION_CWD from disk.
 */
function rawUserCwd() {
  try {
    const txt = readFileSync(_dataFile('user-cwd.txt'), 'utf8').trim()
    return _normalizePlatformCwd(txt) || startRootCwd() || _safeProcessCwd()
  } catch {
    return startRootCwd() ?? _safeProcessCwd()
  }
}

/**
 * Path of the persisted last-session-cwd sentinel, KEYED by the supervisor
 * (run-mcp) PID injected as MIXDOG_SUPERVISOR_PID. The supervisor is one
 * per terminal/MCP client and is preserved across a dev-sync child restart
 * (only the child is killed + respawned), so its PID is a stable, per-
 * terminal key that survives the restart. Keying by it makes the restore
 * multi-terminal safe: terminal A's `cwd set` writes session-cwd-<pidA>.txt
 * and terminal B writes session-cwd-<pidB>.txt, so a restart in one terminal
 * can never restore the other terminal's cwd. When no supervisor PID is
 * present (direct launch with no respawn lifecycle) a single 'solo' file is
 * used — there is no cross-restart key in that mode, matching the absence of
 * a respawning supervisor.
 */
function _lastSessionCwdFile(keyPid) {
  // Explicit keyPid (a connection's leadPid in daemon mode) wins; otherwise
  // fall back to this process's MIXDOG_SUPERVISOR_PID. Under the shared daemon
  // a single process serves N terminals, so keying writes by the per-connection
  // leadPid is what keeps one terminal's `cwd set` out of another's sentinel.
  const raw = (keyPid != null && keyPid !== '') ? String(keyPid) : process.env.MIXDOG_SUPERVISOR_PID
  const key = (typeof raw === 'string' && /^\d+$/.test(raw)) ? raw : 'solo'
  return _dataFile(`session-cwd-${key}.txt`)
}

/**
 * Best-effort persist the last session cwd to disk (keyed per supervisor —
 * see _lastSessionCwdFile) so the respawned child of the SAME terminal can
 * restore it. Errors are swallowed — a convenience signal, not a contract.
 */
export function writeLastSessionCwd(cwd, keyPid) {
  try {
    writeFileSync(_lastSessionCwdFile(keyPid), String(cwd))
  } catch { /* best-effort */ }
}

/**
 * Read the persisted last session cwd for THIS terminal (keyed per supervisor
 * PID). Returns the normalized path only when the directory still exists;
 * otherwise null. Consulted by the boot-time cwd auto-init (server-main.mjs)
 * ahead of the user-cwd.txt seed so the last `cwd set` survives a dev-sync
 * child restart that dropped MIXDOG_SESSION_CWD.
 */
export function readLastSessionCwd(keyPid) {
  try {
    const content = readFileSync(_lastSessionCwdFile(keyPid), 'utf8')
    const normalized = _normalizePlatformCwd(content.trim())
    if (normalized && statSync(normalized).isDirectory()) return normalized
    return null
  } catch {
    return null
  }
}

/**
 * Run fn inside an async context where pwd() returns cwd.
 * All descendant async calls within fn see cwd as their working directory.
 */
export function runWithCwdOverride(cwd, fn) {
  const normalized = _normalizePlatformCwd(cwd)
  return _cwdOverride.run({ cwd: normalized || String(cwd || '') }, fn)
}

/**
 * Retarget the current async session after an in-turn `cwd set`.
 * Other concurrent sessions hold different AsyncLocalStorage records.
 */
export function updateCurrentCwdOverride(cwd) {
  const store = _cwdOverride.getStore()
  if (!store || typeof store !== 'object') return false
  const normalized = _normalizePlatformCwd(cwd)
  if (!normalized) return false
  store.cwd = normalized
  return true
}

/**
 * Current effective working directory:
 *   override set by runWithCwdOverride (innermost wins) ?? original user cwd.
 */
export function pwd() {
  return _activeCwdOverride() ?? captureOriginalUserCwd()
}
