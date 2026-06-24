import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const RUNTIME_ROOT = process.env.MIXDOG_RUNTIME_ROOT
  ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
  : path.join(os.tmpdir(), 'mixdog')
const ACTIVE_INSTANCE_FILE = path.join(RUNTIME_ROOT, 'active-instance.json')

let _portCache = null // { port, mtime, ts }

async function getMemoryPort() {
  const now = Date.now()
  if (_portCache && (now - _portCache.ts) < 5_000) return _portCache.port
  try {
    const stat = await fs.promises.stat(ACTIVE_INSTANCE_FILE)
    const mtime = stat.mtimeMs
    if (_portCache && _portCache.mtime === mtime) {
      _portCache.ts = now
      return _portCache.port
    }
    const raw = await fs.promises.readFile(ACTIVE_INSTANCE_FILE, 'utf8')
    const active = JSON.parse(raw)
    const port = Number(active && active.memory_port)
    if (!Number.isFinite(port) || port <= 0) return null
    _portCache = { port, mtime, ts: now }
    return port
  } catch {
    return null
  }
}

async function memoryFetch(method, endpoint, body = null, timeoutMs = 10_000) {
  const port = await getMemoryPort()
  return new Promise((resolve, reject) => {
    if (!port) { reject(new Error('active-instance.json missing memory_port')); return }
    const payload = body ? JSON.stringify(body) : null
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: endpoint,
      method,
      headers: payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {},
      timeout: timeoutMs,
    }, res => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(JSON.parse(data)) }
        catch { resolve({ raw: data }) }
      })
    })
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('memory-service timeout')) })
    if (payload) req.write(payload)
    req.end()
  })
}

const BUFFER_DIR = path.join(RUNTIME_ROOT, 'memory-buffer')

function normalizeTs(ts) {
  if (typeof ts === 'number' && Number.isFinite(ts)) {
    return ts < 1e12 ? ts * 1000 : ts
  }
  const parsed = Date.parse(String(ts ?? ''))
  return Number.isFinite(parsed) ? parsed : Date.now()
}

export async function appendEntry(data) {
  const payload = {
    ts: normalizeTs(data.ts),
    role: String(data.role ?? 'user'),
    content: String(data.content ?? ''),
    sourceRef: String(data.sourceRef ?? `manual:${Date.now()}-${process.pid}`),
    sessionId: data.sessionId ?? null,
    cwd: data.cwd ?? null,
  }
  // Bounded fast attempt. On failure, buffer to disk immediately and let
  // the periodic drainer ship buffered entries when the service is back.
  // Caller is fire-and-forget (channels worker), so capping the tail at
  // ~3s prevents promises from lingering on minute-long timeouts.
  try {
    return await memoryFetch('POST', '/entry', payload, 3_000)
  } catch (e) {
    process.stderr.write(`[memory-client] appendEntry failed (${e.message}) — buffering\n`)
    try {
      fs.mkdirSync(BUFFER_DIR, { recursive: true })
      const random = Math.random().toString(36).slice(2, 10)
      const bufferPath = path.join(BUFFER_DIR, `entry-${Date.now()}-${random}.json`)
      fs.writeFileSync(bufferPath, JSON.stringify(payload, null, 2))
      return { ok: false, buffered: true, path: bufferPath }
    } catch (bufErr) {
      process.stderr.write(`[memory-client] Failed to buffer entry: ${bufErr.message}\n`)
      return { ok: false }
    }
  }
}

export async function ingestTranscript(filePath, { cwd } = {}) {
  try {
    return await memoryFetch('POST', '/ingest-transcript', { filePath, ...(cwd ? { cwd } : {}) })
  } catch (e) {
    process.stderr.write(`[memory-client] ingestTranscript failed: ${e.message}\n`)
    return { ok: false }
  }
}

export async function listCoreMemories(args = {}) {
  const rawProjectId = args && Object.prototype.hasOwnProperty.call(args, 'project_id')
    ? args.project_id
    : args?.projectScope
  const projectId = rawProjectId == null || rawProjectId === 'all' ? '*' : rawProjectId
  const result = await memoryFetch('POST', '/api/tool', {
    name: 'memory',
    arguments: {
      action: 'core',
      op: 'list',
      project_id: projectId,
    },
  }, 30_000)
  if (!result || result.error) {
    throw new Error(result?.error || 'core memory list: empty response')
  }
  return result
}

export async function searchMemories(args = {}) {
  const result = await memoryFetch('POST', '/api/tool', {
    name: 'search_memories',
    arguments: args && typeof args === 'object' ? args : {},
  }, 30_000)
  if (!result || result.error) {
    throw new Error(result?.error || 'memory_search: empty response')
  }
  return result
}

export async function isHealthy() {
  try {
    const result = await memoryFetch('GET', '/health')
    return result.status === 'ok'
  } catch {
    return false
  }
}
