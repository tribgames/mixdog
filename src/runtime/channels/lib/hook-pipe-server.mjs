// Hook IPC daemon — Windows named-pipe server consumed by mixdog-shim.exe.
//
// Replaces the per-spawn cold-start cost of `bun hooks/*.cjs` (≈86ms) with a
// single long-lived listener inside the channels worker. The shim is a tiny
// Rust .exe (~111KB, ~5-10ms cold) that connects, writes one JSON line, reads
// one JSON line back, and exits.
//
// Protocol (line-delimited JSON):
//   client → server : <Mixdog hook payload>\n
//   server → client : <decision-json or "null">\n
//
// Each connection is handled independently. Long-running handlers (Discord
// permission polling, up to 2 minutes) do not block other connections.
//
// Failure model: dispatch errors emit "null" (fail-open). The shim itself
// also fails open when the pipe is unreachable.

import { createServer, createConnection } from 'node:net'
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { join, resolve as pathResolve } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { request as httpsRequest } from 'node:https'
import { createRequire } from 'node:module'
import { resolvePluginData } from '../../shared/plugin-paths.mjs'

const moduleRequire = createRequire(import.meta.url)
const {
  isMixdogDebugEnabled,
  pruneStalePluginDataLogSiblings,
  DEFAULT_STALE_LOG_SIBLING_MAX,
} = moduleRequire('../../../lib/mixdog-debug.cjs')

// IPC transport path. Windows uses a named pipe (`\\.\pipe\…`); Unix uses a
// Unix domain socket under XDG_RUNTIME_DIR (or /tmp as fallback). Node's
// net.createServer().listen() accepts both transparently.
const PIPE_PATH = moduleRequire('../../../lib/hook-pipe-path.cjs')()

// Honor MIXDOG_RUNTIME_ROOT consistently with runtime-paths.mjs (the consumer
// of these tool-exec signals): when the override is set, the signal PRODUCER
// here must write into the same root the channels worker watches, or signals
// are silently dropped. Default stays tmpdir()/mixdog so non-override installs
// are unchanged.
const RUNTIME_ROOT = process.env.MIXDOG_RUNTIME_ROOT
  ? pathResolve(process.env.MIXDOG_RUNTIME_ROOT)
  : join(tmpdir(), 'mixdog')
const SIGNAL_CONSUMER_MARKER = join(RUNTIME_ROOT, '.tool-exec-consumer')
const SUBAGENT_SIGNAL_CONSUMER_MARKER = join(RUNTIME_ROOT, '.tool-exec-subagent-consumer')
const SIGNAL_RE_GENERIC = /^tool-exec-\d+-[0-9a-f]+\.signal$/
const SIGNAL_RE_CAPTURE = /^tool-exec-(\d+)-[0-9a-f]+\.signal$/
const SWEEP_MARKER = join(RUNTIME_ROOT, '.tool-exec-sweep')
const SWEEP_INTERVAL_MS = 30_000
const SIGNAL_TTL_MS = 60_000
// Marketplace installs use two naming shapes for the MCP server name —
// `plugin_mixdog_mixdog__` (legacy / mixdog marketplace) and
// `plugin_mixdog_trib-plugin__` (trib-plugin marketplace). PreToolUse
// sandbox checks must recognise both or sandbox evaluation silently
// misses MCP tool names from the other install layout.
const MCP_PREFIXES = [
  'mcp__plugin_mixdog_mixdog__',
  'mcp__plugin_mixdog_trib-plugin__',
]
const NATIVE_FILE_LOOKUP_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Search', 'LS'])
function isMcpToolName(name) {
  if (!name) return false
  return MCP_PREFIXES.some(p => name.startsWith(p))
}

const POLL_INTERVAL_MS = 2000
const SUBAGENT_TIMEOUT_MS = 120_000
const DEFAULT_DISPATCH_TIMEOUT_MS = 15_000
const SESSION_START_MEMORY_DISPATCH_TIMEOUT_MS = 125_000
const MIXDOG_DEBUG_ENABLED = isMixdogDebugEnabled()
let _hookPipeLogsPruned = false

function hookPipeDebugStderr(line) {
  if (!MIXDOG_DEBUG_ENABLED) return
  try { process.stderr.write(line) } catch {}
}

let _started = false
let _server = null
let _subagentSignalConsumers = 0

function refreshSubagentSignalConsumerMarker() {
  try {
    if (_subagentSignalConsumers > 0) {
      try { mkdirSync(RUNTIME_ROOT, { recursive: true }) } catch {}
      writeFileSync(SUBAGENT_SIGNAL_CONSUMER_MARKER, String(Date.now()))
    } else {
      try { unlinkSync(SUBAGENT_SIGNAL_CONSUMER_MARKER) } catch {}
    }
  } catch {}
}

function formatError(err) {
  const msg = (err && (err.stack || err.message)) || err
  return String(msg || 'unknown').replace(/\s+/g, ' ').slice(0, 2000)
}

function traceSessionStart(message) {
  if (!MIXDOG_DEBUG_ENABLED) return
  const line = `[${new Date().toISOString()}] [hook-pipe][session-start] ${message}\n`
  try { process.stderr.write(line) } catch {}
  try {
    const dataDir = resolvePluginData()
    mkdirSync(dataDir, { recursive: true })
    if (!_hookPipeLogsPruned) {
      _hookPipeLogsPruned = true
      pruneStalePluginDataLogSiblings(dataDir, DEFAULT_STALE_LOG_SIBLING_MAX)
    }
    appendFileSync(join(dataDir, 'session-start.log'), line)
  } catch {}
}

function dispatchTimeoutMsForPayload(payload) {
  const event = payload?.hook_event_name || payload?.hookEventName || ''
  if (event !== 'SessionStart') return DEFAULT_DISPATCH_TIMEOUT_MS
  const argsArr = payload?._args || []
  const partArg = argsArr.find(a => a.startsWith('--part='))
  const part = partArg ? partArg.slice('--part='.length) : ''
  return (part === 'core' || part === 'recap')
    ? SESSION_START_MEMORY_DISPATCH_TIMEOUT_MS
    : DEFAULT_DISPATCH_TIMEOUT_MS
}

// ── post-tool-use handler ────────────────────────────────────────────────────

function sweepStaleSignalsThrottled(now = Date.now()) {
  try {
    let lastSweep = 0
    try { lastSweep = statSync(SWEEP_MARKER).mtimeMs } catch {}
    if (now - lastSweep < SWEEP_INTERVAL_MS) return
    try { writeFileSync(SWEEP_MARKER, String(now)) } catch {}
    const entries = readdirSync(RUNTIME_ROOT)
    for (const name of entries) {
      if (!SIGNAL_RE_GENERIC.test(name)) continue
      const p = join(RUNTIME_ROOT, name)
      try {
        const st = statSync(p)
        if (now - st.mtimeMs > SIGNAL_TTL_MS) unlinkSync(p)
      } catch {}
    }
  } catch {}
}

function handlePostToolUse(payload) {
  const toolName = payload?.tool_name || payload?.toolName || ''
  if (!toolName) return null
  if (_subagentSignalConsumers <= 0 &&
      !existsSync(SIGNAL_CONSUMER_MARKER) &&
      !existsSync(SUBAGENT_SIGNAL_CONSUMER_MARKER)) {
    return null
  }
  const filePath = payload?.tool_input?.file_path || payload?.toolInput?.file_path || ''
  const toolUseId = payload?.tool_use_id || payload?.toolUseId || ''

  try { if (!existsSync(RUNTIME_ROOT)) mkdirSync(RUNTIME_ROOT, { recursive: true }) } catch {}
  sweepStaleSignalsThrottled()

  try {
    const rand = randomBytes(4).toString('hex')
    const signalFile = join(RUNTIME_ROOT, `tool-exec-${Date.now()}-${rand}.signal`)
    writeFileSync(signalFile, JSON.stringify({ toolName, filePath, toolUseId, ts: Date.now() }))
  } catch (err) {
    process.stderr.write(`[hook-pipe] post-tool-use signal write failed: ${err?.message || err}\n`)
  }
  return null
}

// ── pre-mcp-sandbox handler ──────────────────────────────────────────────────

function handlePreMcpSandbox(payload) {
  const toolName = payload?.tool_name || payload?.toolName || ''
  if (!isMcpToolName(toolName)) return null

  const toolInput = payload?.tool_input ?? payload?.toolInput ?? {}

  let userCwdRaw = payload?.cwd || ''
  if (!userCwdRaw) {
    try { userCwdRaw = readFileSync(join(resolvePluginData(), 'user-cwd.txt'), 'utf8').trim() } catch {}
  }
  if (!userCwdRaw) userCwdRaw = process.cwd()

  const userCwd = pathResolve(userCwdRaw)
  const projectDir = payload?.projectDir || payload?.project_dir ||
    process.env.MIXDOG_PROJECT_DIR || userCwd
  const permissionMode = payload?.permissionMode || payload?.permission_mode || undefined

  let settingsPerms, evaluatePermission
  try {
    const settingsLoader = moduleRequire('../../../hooks/lib/settings-loader.cjs')
    settingsPerms = settingsLoader.loadPermissions(projectDir)
  } catch (err) {
    process.stderr.write(`[hook-pipe] pre-mcp-sandbox settings-loader unavailable: ${err?.message || err}\n`)
    return null
  }
  try {
    const ev = moduleRequire('../../../hooks/lib/permission-evaluator.cjs')
    evaluatePermission = ev.evaluatePermission
  } catch (err) {
    process.stderr.write(`[hook-pipe] pre-mcp-sandbox evaluator unavailable: ${err?.message || err}\n`)
    return null
  }

  const evalResult = evaluatePermission({ toolName, toolInput, permissionMode, projectDir, userCwd, permissions: settingsPerms })
  const { decision, reason } = evalResult

  // Pi-like practical: no permission prompts. Only hard-deny and explicit
  // user deny rules block; every other evaluator result is allowed.
  if (decision === 'deny') return makeDecision('deny', reason)
  return null
}

function handleNativeFileLookup(payload) {
  const toolName = payload?.tool_name || payload?.toolName || ''
  if (!NATIVE_FILE_LOOKUP_TOOLS.has(toolName)) return null
  return makeDecision(
    'deny',
    `Native ${toolName} is disabled by Mixdog. Use the Mixdog MCP read/grep/glob/list tools instead.`
  )
}

function makeDecision(decision, reason, updatedInput) {
  const out = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }
  if (updatedInput !== undefined) out.hookSpecificOutput.updatedInput = updatedInput
  return out
}

// ── pre-tool-subagent handler (Discord permission flow, async) ───────────────

function sanitize(value) {
  return String(value).replace(/[^a-zA-Z0-9._-]/g, '_')
}

function readDiscordConfig() {
  try {
    const { readSection } = moduleRequire('../../../lib/config-cjs.cjs')
    return readSection('channels')
  } catch { return {} }
}

function isProtectedPath(filePath, cwd) {
  if (!filePath) return false
  const norm = pathResolve(filePath).replace(/\\/g, '/').toLowerCase()
  const cwdNorm = (cwd || process.cwd()).replace(/\\/g, '/').toLowerCase()
  const insideCwd = cwdNorm && (norm === cwdNorm || norm.startsWith(cwdNorm.endsWith('/') ? cwdNorm : cwdNorm + '/'))
  return !insideCwd
}

function findAndClaimSignal(toolName, filePath, toolUseId, hookStartedAt) {
  let entries
  try { entries = readdirSync(RUNTIME_ROOT) } catch { return null }
  for (const name of entries) {
    const m = SIGNAL_RE_CAPTURE.exec(name)
    if (!m) continue
    const ts = Number(m[1])
    if (!Number.isFinite(ts) || ts < hookStartedAt) continue
    const p = join(RUNTIME_ROOT, name)
    let raw
    try { raw = readFileSync(p, 'utf8') } catch { continue }
    let parsed
    try { parsed = JSON.parse(raw) } catch { continue }
    if (parsed?.toolName !== toolName) continue
    if (parsed?.filePath !== filePath) continue
    if (toolUseId && parsed?.toolUseId !== toolUseId) continue
    try { unlinkSync(p) } catch {}
    return p
  }
  return null
}

function discordApi(method, apiPath, token, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : ''
    const headers = { 'Authorization': 'Bot ' + token, 'Content-Type': 'application/json' }
    if (data) headers['Content-Length'] = Buffer.byteLength(data)
    const req = httpsRequest({ hostname: 'discord.com', path: apiPath, method, headers },
      res => { let out = ''; res.on('data', d => { out += d }); res.on('end', () => { try { resolve(JSON.parse(out)) } catch { resolve({}) } }) })
    req.setTimeout(10_000, () => req.destroy())
    req.on('error', reject)
    if (data) req.write(data)
    req.end()
  })
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function handlePreToolSubagent(payload) {
  if (process.env.MIXDOG_CHANNELS_NO_CONNECT) return null
  // Pi-like practical: Mixdog no longer opens Discord permission popups for
  // subagent Edit/Write outside cwd. Native/role/tool guards still apply in
  // their own layers; this hook simply stops adding an approval workflow.
  return null
}

// ── statusline handler (via dynamic ESM import) ──────────────────────────────

let _statusLineMod = null
let _statusLineLoadPromise = null
let _statusLineModMtimeMs = 0

async function ensureStatusLineMod() {
  let mtimeMs = 0
  try { mtimeMs = statSync(new URL('../../../bin/statusline-lib.mjs', import.meta.url)).mtimeMs } catch {}
  if (_statusLineMod && mtimeMs && mtimeMs === _statusLineModMtimeMs) return _statusLineMod
  if (_statusLineLoadPromise) return _statusLineLoadPromise
  _statusLineLoadPromise = import(`../../../bin/statusline-lib.mjs?mtime=${encodeURIComponent(String(mtimeMs || Date.now()))}`)
    .then(mod => { _statusLineMod = mod; _statusLineModMtimeMs = mtimeMs; _statusLineLoadPromise = null; return mod })
    .catch(err => {
      process.stderr.write(`[hook-pipe] statusline-lib import failed: ${err?.message || err}\n`)
      _statusLineLoadPromise = null
      return null
    })
  return _statusLineLoadPromise
}

async function handleStatusLine(payload) {
  const mod = await ensureStatusLineMod()
  if (!mod || typeof mod.renderStatusLine !== 'function') return null
  try {
    return await mod.renderStatusLine(JSON.stringify(payload || {}))
  } catch (err) {
    process.stderr.write(`[hook-pipe] statusline render failed: ${err?.message || err}\n`)
    return null
  }
}

// ── SessionStart: rules/core/recap handlers (via require'd cjs) ──────────────
//
// session-start.cjs accesses fd 0 at the top level — we gate that behind
// MIXDOG_SKIP_TOP_STDIN so it doesn't consume the daemon's MCP stdio pipe.
// Each SessionStart slot gets a fresh CJS module instance. That keeps the
// module-globals (_event, PART, _emitSink) isolated, so rules/core/recap can
// run concurrently without a daemon-wide lock.
function loadSessionStartMod() {
  const prev = process.env.MIXDOG_SKIP_TOP_STDIN
  process.env.MIXDOG_SKIP_TOP_STDIN = '1'
  const moduleId = moduleRequire.resolve('../../../hooks/session-start.cjs')
  delete moduleRequire.cache[moduleId]
  traceSessionStart('fresh require start path=../../../hooks/session-start.cjs')
  try {
    const mod = moduleRequire(moduleId)
    delete moduleRequire.cache[moduleId]
    traceSessionStart(`fresh require ok exports=${Object.keys(mod || {}).join(',')}`)
    return mod
  } catch (err) {
    process.stderr.write(`[hook-pipe] session-start.cjs require failed: ${err?.message || err}\n`)
    traceSessionStart(`require failed err=${formatError(err)}`)
    return null
  } finally {
    if (prev === undefined) delete process.env.MIXDOG_SKIP_TOP_STDIN
    else process.env.MIXDOG_SKIP_TOP_STDIN = prev
  }
}

async function handleSessionStartPart(args, payload) {
  if (payload?.isSidechain || payload?.is_sidechain) {
    traceSessionStart(`skip reason=sidechain source=${payload?.source || ''}`)
    return null
  }
  if (payload?.agentId || payload?.agent_id) {
    traceSessionStart(`skip reason=agent source=${payload?.source || ''} agent=${payload?.agentId || payload?.agent_id || ''}`)
    return null
  }
  if (payload?.kind && payload.kind !== 'interactive') {
    traceSessionStart(`skip reason=kind source=${payload?.source || ''} kind=${payload.kind}`)
    return null
  }

  const partArg = (args || []).find(a => a.startsWith('--part='))
  const part = partArg ? partArg.slice('--part='.length) : null
  if (!part || (part !== 'rules' && part !== 'core' && part !== 'recap')) {
    traceSessionStart(`skip reason=invalid-part source=${payload?.source || ''} args=${JSON.stringify(args || [])}`)
    return null
  }

  const mod = loadSessionStartMod()
  if (!mod) {
    traceSessionStart(`skip reason=require-null part=${part} source=${payload?.source || ''}`)
    return null
  }

  let buf = ''
  let failed = false
  const t0 = Date.now()
  try {
    traceSessionStart(
      `run start part=${part} source=${payload?.source || ''} cwd=${payload?.cwd || ''} ` +
      `sessionId=${payload?.session_id || payload?.sessionId || ''}`
    )
    try { mod.setEvent(payload || {}) } catch (err) {
      failed = true
      traceSessionStart(`setEvent failed part=${part} err=${formatError(err)}`)
    }
    try {
      if (typeof mod.setPart === 'function') mod.setPart(part)
      else traceSessionStart(`setPart unavailable part=${part}`)
    } catch (err) {
      failed = true
      traceSessionStart(`setPart failed part=${part} err=${formatError(err)}`)
    }
    try { mod.setEmitSink(s => { buf += String(s) }) } catch (err) {
      failed = true
      traceSessionStart(`setEmitSink failed part=${part} err=${formatError(err)}`)
    }
    if (part === 'rules') await mod.runRulesPart()
    else if (part === 'core') await mod.runCorePart()
    else if (part === 'recap') await mod.runRecapPart()
  } catch (err) {
    failed = true
    process.stderr.write(`[hook-pipe] session-start ${part} failed: ${err?.message || err}\n`)
    traceSessionStart(`run failed part=${part} err=${formatError(err)}`)
  } finally {
    try { mod.setEmitSink(null) } catch (err) {
      failed = true
      traceSessionStart(`clearEmitSink failed part=${part} err=${formatError(err)}`)
    }
    traceSessionStart(
      `run done part=${part} source=${payload?.source || ''} ` +
      `bytes=${Buffer.byteLength(buf, 'utf8')} elapsed=${Date.now() - t0}ms failed=${failed}`
    )
  }
  return buf || null
}

// ── SessionStart: clear-active-session handler ───────────────────────────────

function handleSessionStartClear() {
  // Clear the active orchestrator session pointer so each Mixdog session
  // starts fresh. Stored sessions on disk are NOT deleted — only the pointer.
  try {
    const dataDir = resolvePluginData()
    const target = join(dataDir, 'active-session.txt')
    try { unlinkSync(target) } catch {}
  } catch (err) {
    process.stderr.write(`[hook-pipe] session-start clear failed: ${err?.message || err}\n`)
  }
  return null
}

// ── dispatch ─────────────────────────────────────────────────────────────────

async function dispatch(payload) {
  const event = payload?.hook_event_name || payload?.hookEventName || ''
  const tool = payload?.tool_name || payload?.toolName || ''
  const argsArr = payload?._args || []

  // CLI-arg-driven routing (statusline + future entry points without a
  // hook_event_name field).
  const kindArg = argsArr.find(a => a.startsWith('--kind='))
  if (kindArg) {
    const kind = kindArg.slice('--kind='.length)
    if (kind === 'statusline') return await handleStatusLine(payload)
  }

  try {
    if (event === 'PreToolUse') {
      if (NATIVE_FILE_LOOKUP_TOOLS.has(tool)) {
        return handleNativeFileLookup(payload)
      }
      if (tool === 'Edit' || tool === 'Write' || tool === 'MultiEdit') {
        return await handlePreToolSubagent(payload)
      }
      if (isMcpToolName(tool)) {
        return handlePreMcpSandbox(payload)
      }
    } else if (event === 'PostToolUse') {
      return handlePostToolUse(payload)
    } else if (event === 'SessionStart') {
      const argsArr = payload?._args || []
      const hasPart = argsArr.some(a => a.startsWith('--part='))
      if (hasPart) {
        return await handleSessionStartPart(argsArr, payload)
      }
      // No --part: clear-active-session entry.
      return handleSessionStartClear()
    }
  } catch (err) {
    process.stderr.write(`[hook-pipe] dispatch error: ${err?.message || err}\n`)
  }
  return null
}

// ── server ───────────────────────────────────────────────────────────────────

export function startHookPipeServer() {
  if (_server) return _server

  _server = createServer((socket) => {
    let buf = ''
    let handled = false
    // Resource guards: a connection that never sends a newline-terminated
    // payload would otherwise grow buf unbounded and hold the socket open
    // forever. Cap the buffered bytes and idle-close a stalled connection.
    const MAX_BUF_BYTES = 1 << 20 // 1 MiB
    const IDLE_TIMEOUT_MS = 30_000
    socket.setTimeout(IDLE_TIMEOUT_MS, () => {
      if (!handled) { try { socket.destroy() } catch {} }
    })
    socket.on('data', async (chunk) => {
      if (handled) return
      buf += chunk.toString('utf8')
      if (Buffer.byteLength(buf, 'utf8') > MAX_BUF_BYTES) {
        handled = true
        process.stderr.write(`[hook-pipe] payload exceeded ${MAX_BUF_BYTES} bytes without newline; dropping connection\n`)
        try { socket.destroy() } catch {}
        return
      }
      const firstNl = buf.indexOf('\n')
      if (firstNl < 0) return
      const firstLine = buf.slice(0, firstNl)

      // Optional `args=` prefix line. When present, the actual payload is the
      // second line; otherwise the first line IS the payload.
      let args = []
      let payloadLine
      if (firstLine.startsWith('args=')) {
        const secondNl = buf.indexOf('\n', firstNl + 1)
        if (secondNl < 0) return // wait for more
        args = firstLine.slice(5).split(' ').filter(Boolean)
        payloadLine = buf.slice(firstNl + 1, secondNl)
      } else {
        payloadLine = firstLine
      }

      handled = true
      let payload = null
      try { payload = payloadLine ? JSON.parse(payloadLine) : null } catch {}
      if (payload && args.length > 0) payload._args = args

      // Per-request deadline: a hung handler would otherwise hold the hook
      // client waiting for EOF forever, stalling the hook step. Race
      // dispatch against a real timer; on timeout, write the no-op fallback and
      // end the socket so the client unblocks.
      const dispatchTimeoutMs = payload ? dispatchTimeoutMsForPayload(payload) : DEFAULT_DISPATCH_TIMEOUT_MS
      let timedOut = false
      let deadlineTimer = null
      let reply = null
      try {
        if (payload) {
          reply = await new Promise((resolve, reject) => {
            deadlineTimer = setTimeout(() => {
              timedOut = true
              reject(new Error(`dispatch exceeded ${dispatchTimeoutMs}ms`))
            }, dispatchTimeoutMs)
            dispatch(payload).then(resolve, reject)
          })
        }
      } catch (err) {
        if (timedOut) {
          process.stderr.write(`[hook-pipe] dispatch timed out after ${dispatchTimeoutMs}ms; writing no-op fallback\n`)
          try { socket.write('null\n') } catch {}
          try { socket.end() } catch {}
          return
        }
        process.stderr.write(`[hook-pipe] handler threw: ${err?.message || err}\n`)
      } finally {
        if (deadlineTimer) { clearTimeout(deadlineTimer); deadlineTimer = null }
      }

      // Response shape:
      //   • object → JSON-stringified single line (legacy decision protocol)
      //   • string → raw text (multi-line session-start / statusline output)
      //   • null/undefined → "null" (no-op marker)
      let out
      if (reply == null) out = 'null'
      else if (typeof reply === 'string') out = reply
      else out = JSON.stringify(reply)

      try { socket.write(out) } catch {}
      if (!out.endsWith('\n')) { try { socket.write('\n') } catch {} }
      try { socket.end() } catch {}
    })
    socket.on('error', () => {})
  })
  _server.on('error', (err) => {
    const msg = String(err?.message || err || '')
    if (err?.code === 'EADDRINUSE' || msg.includes('EADDRINUSE') || msg.includes('Failed to listen')) {
      hookPipeDebugStderr(`[hook-pipe] ${PIPE_PATH} already owned by a peer daemon; standby for hook IPC\n`)
      _server = null
      _started = false
      return
    }
    process.stderr.write(`[hook-pipe] server error: ${err?.message || err}\n`)
  })

  const beginListen = () => {
    try {
      _server.listen(PIPE_PATH, () => {
        _started = true
        hookPipeDebugStderr(`[hook-pipe] listening on ${PIPE_PATH}\n`)
      })
    } catch (err) {
      process.stderr.write(`[hook-pipe] listen failed: ${err?.message || err}\n`)
      _server = null
    }
  }

  if (process.platform === 'win32') {
    // Windows named pipes refuse a second listener with EADDRINUSE on their
    // own, so no pre-listen probe is needed.
    beginListen()
  } else {
    // Unix: a leftover socket file from a crashed prior daemon would make
    // listen() fail with EADDRINUSE. But blindly unlinking would also steal
    // the socket from a live sibling daemon, leaving it orphaned. Probe the
    // path first — only unlink when nothing answers.
    probeUnixSocketAlive(PIPE_PATH).then((alive) => {
      if (alive) {
        process.stderr.write(
          `[hook-pipe] another mixdog daemon is already listening on ${PIPE_PATH}; refusing to start a second instance\n`
        )
        _server = null
        return
      }
      try { unlinkSync(PIPE_PATH) } catch {}
      beginListen()
    })
  }
  return _server
}

// Best-effort liveness check for a Unix socket path. Resolves true when
// something is listening (connect succeeds), false when the path is dead
// (ECONNREFUSED) or absent (ENOENT). Other errors / timeout resolve true so
// we err on the side of NOT stealing a possibly-live peer's socket.
function probeUnixSocketAlive(socketPath) {
  return new Promise((resolve) => {
    let done = false
    const finish = (alive) => {
      if (done) return
      done = true
      try { client.destroy() } catch {}
      clearTimeout(timer)
      resolve(alive)
    }
    let client
    try {
      client = createConnection(socketPath)
    } catch {
      resolve(false)
      return
    }
    const timer = setTimeout(() => finish(true), 300)
    client.once('connect', () => finish(true))
    client.once('error', (err) => {
      const code = err && err.code
      finish(!(code === 'ECONNREFUSED' || code === 'ENOENT'))
    })
  })
}

export function stopHookPipeServer() {
  if (_server) {
    try { _server.close() } catch {}
    _server = null
    _started = false
  }
}

export function isHookPipeServerStarted() {
  return _started
}
