// HTTP request router extracted from index.mjs.
//
// Owns the memory service's HTTP surface: health/admin/trace/session-start
// routes, the /api/tool + /api/cancel owner-side call plumbing, the /mcp
// StreamableHTTP bridge, the dev-only cycle1 bench, and the /entry +
// /ingest-transcript tail routes. Pure wire helpers, core store, trace store,
// and MCP SDK pieces are imported directly; live DB handle, data dir, the
// cycle scheduler, lifecycle getters, trace-DB slot, and the action/tool
// handlers are injected so the facade keeps ownership of `db`, `_traceDb`,
// `_bootTimestamp`, and the init/stop lifecycle.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import fs from 'node:fs'
import path from 'node:path'

import { TOOL_DEFS } from '../tool-defs.mjs'
import { readBody, sendJson, sendError, isLocalOrigin, normalizeCoreProjectId } from './http-wire.mjs'
import { listCore, addCore, deleteCore } from './core-memory-store.mjs'
import { isBootstrapComplete, cleanMemoryText } from './memory.mjs'
import { resolveProjectScope } from './project-id-resolver.mjs'
import { openTraceDatabase, insertAgentCalls, enqueueTraceEvents, registerTraceExitDrain } from './trace-store.mjs'

const MEMORY_INSTRUCTIONS_TEXT = ''

export function createHttpRouter({
  getDb,
  dataDir,
  log,
  pluginVersion,
  bootPromotionCodeFingerprint,
  touchDaemonIdleTimer,
  entryStats,
  cycleScheduler,
  getInitialized,
  getInitPromise,
  setBootTimestamp,
  handleMemoryAction,
  handleToolCall,
  stop,
  registerClient,
  deregisterClient,
  getDraining,
  getCycle1CallLlm,
  getTraceDb,
  setTraceDb,
  ingestTranscriptFile,
  getTranscriptOffset,
  parseTsToMs,
}) {
  const DATA_DIR = dataDir
  const PLUGIN_VERSION = pluginVersion
  const BOOT_PROMOTION_CODE_FINGERPRINT = bootPromotionCodeFingerprint

  function createHttpMcpServer() {
    const s = new Server(
      { name: 'mixdog-memory', version: PLUGIN_VERSION },
      { capabilities: { tools: {} }, instructions: MEMORY_INSTRUCTIONS_TEXT },
    )
    s.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }))
    s.setRequestHandler(CallToolRequestSchema, (req) => handleToolCall(req.params.name, req.params.arguments ?? {}))
    return s
  }

  async function awaitRuntimeReadyForHttp(res) {
    if (getInitialized()) return true
    const initPromise = getInitPromise()
    if (!initPromise) {
      sendJson(res, { error: 'memory runtime is starting' }, 503)
      return false
    }
    try {
      await initPromise
      return true
    } catch (e) {
      sendJson(res, { error: `memory runtime failed: ${e?.message || e}` }, 503)
      return false
    }
  }

  async function buildSessionCoreMemoryPayload(cwd) {
    const db = getDb()
    const projectId = resolveProjectScope(typeof cwd === 'string' && cwd ? cwd : null)
    const generatedScopeClause = projectId !== null
      ? `project_id IS NULL OR project_id = $1`
      : `project_id IS NULL`
    const dbRows = (await db.query(`
      SELECT core_summary
      FROM entries
      WHERE is_root = 1
        AND status = 'active'
        AND core_summary IS NOT NULL
        AND (${generatedScopeClause})
      ORDER BY score DESC, last_seen_at DESC
    `, projectId !== null ? [projectId] : [])).rows
    const commonRows = (await db.query(
      `SELECT summary FROM core_entries WHERE project_id IS NULL AND (status IS NULL OR status = 'active') ORDER BY id ASC`
    )).rows
    const scopedRows = projectId !== null
      ? (await db.query(
          `SELECT summary FROM core_entries WHERE project_id = $1 AND (status IS NULL OR status = 'active') ORDER BY id ASC`,
          [projectId]
        )).rows
      : []
    return {
      projectId,
      dbLines: dbRows.map(r => String(r.core_summary || '').trim()).filter(Boolean),
      userLines: [
        ...commonRows.map(r => String(r.summary || '').trim()).filter(Boolean),
        ...scopedRows.map(r => String(r.summary || '').trim()).filter(Boolean),
      ],
    }
  }

  // Owner-side /api/tool in-flight controllers keyed by caller-supplied
  // X-Mixdog-Call-Id. /api/cancel aborts the matching AbortSignal so the
  // upstream handleToolCall actually stops when the fork-proxy parent cancels.
  const _ownerInFlightHttpCalls = new Map()

  const requestHandler = async (req, res) => {
    touchDaemonIdleTimer(`${req.method || 'HTTP'} ${req.url || '/'}`)
    // Connected-client lifecycle. Proxies register on first use and
    // deregister on CLI shutdown; the daemon reaps itself shortly after the
    // last client leaves (see registerClient/deregisterClient in index.mjs).
    if (req.method === 'POST' && (req.url === '/client/register' || req.url === '/client/deregister')) {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      let body = {}
      try { body = await readBody(req) } catch {}
      const clientPid = Number(body?.clientPid)
      if (req.url === '/client/register') {
        const accepted = registerClient?.(clientPid)
        if (accepted === false) {
          // Daemon is draining — distinct signal so the proxy respawns a fresh
          // daemon and retries its pending RPC instead of binding to this one.
          sendJson(res, { ok: false, draining: true, error: 'memory worker draining' }, 503)
          return
        }
      } else {
        deregisterClient?.(clientPid)
      }
      sendJson(res, { ok: true })
      return
    }
    if (req.method === 'POST' && req.url === '/session-reset') {
      const ts = Date.now()
      setBootTimestamp(ts)
      sendJson(res, { ok: true, bootTimestamp: ts })
      return
    }
    if (req.method === 'POST' && req.url === '/rebind') {
      setBootTimestamp(Date.now())
      sendJson(res, { ok: true })
      return
    }

    if (req.method === 'GET' && req.url === '/health') {
      if (getDraining?.()) {
        sendJson(res, { status: 'draining' }, 503)
        return
      }
      if (!getInitialized()) {
        sendJson(res, { status: 'starting' }, 503)
        return
      }
      try {
        const db = getDb()
        const stats = await entryStats()
        sendJson(res, {
          status: 'ok',
          worker_pid: process.pid,
          server_pid: Number(process.env.MIXDOG_SERVER_PID) || null,
          owner_lead_pid: Number(process.env.MIXDOG_OWNER_LEAD_PID) || null,
          code_fingerprint: BOOT_PROMOTION_CODE_FINGERPRINT,
          bootstrap: await isBootstrapComplete(db),
          entries: stats.total,
          roots: stats.roots,
          active_roots: stats.active_roots,
          archived_roots: stats.archived_roots,
          unchunked_leaves: stats.unchunked_leaves,
          cycle2_pending_roots: stats.cycle2_pending_roots,
          core_entries: stats.core_entries,
          core_embed_null: stats.core_embed_null,
          active_core_summaries: stats.active_core_summaries,
          active_core_summary_missing: stats.active_core_summary_missing,
          mv_hot_active_populated: stats.mv_hot_active_populated,
          cycle_running: cycleScheduler.getCycleRunning(),
          cycle_health: cycleScheduler.getCycleHealth(),
          cycle_backlog: cycleScheduler.getCycleBacklogSnapshot(),
        })
      } catch (e) { sendError(res, e.message) }
      return
    }

    if (!await awaitRuntimeReadyForHttp(res)) return

    if (req.method === 'GET' && req.url === '/admin/entries/active') {
      try {
        const db = getDb()
        const { rows } = await db.query(`
          SELECT id, element, category, summary, score, last_seen_at
          FROM entries
          WHERE is_root = 1 AND status = 'active'
          ORDER BY score DESC
        `)
        sendJson(res, { ok: true, items: rows })
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
      return
    }

    if (req.method === 'GET' && req.url === '/admin/core/entries') {
      try {
        const rows = await listCore(DATA_DIR, '*')
        sendJson(res, { ok: true, items: rows })
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/core/entries') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        const body = await readBody(req)
        const projectId = normalizeCoreProjectId(body.project_id)
        const entry = await addCore(DATA_DIR, body, projectId)
        sendJson(res, { ok: true, item: entry })
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/core/entries/delete') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        const body = await readBody(req)
        const removed = await deleteCore(DATA_DIR, body.id)
        sendJson(res, { ok: true, item: removed })
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/entries/status') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        const db = getDb()
        const body = await readBody(req)
        const id = Number(body.id)
        const status = String(body.status ?? '').trim().toLowerCase()
        const VALID = ['pending', 'active', 'archived']
        if (!Number.isInteger(id) || id <= 0 || !VALID.includes(status)) {
          sendJson(res, { ok: false, error: 'valid id and status required' }, 400)
          return
        }
        const result = await db.query(
          `UPDATE entries SET status = $1 WHERE id = $2 AND is_root = 1`,
          [status, id]
        )
        sendJson(res, { ok: true, changes: Number(result.rowCount ?? result.affectedRows ?? 0) })
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/entries/add') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        const body = await readBody(req)
        const result = await handleMemoryAction({
          action: 'manage',
          op: 'add',
          element: body.element,
          summary: body.summary,
          category: body.category,
          cwd: body.cwd,
        })
        if (result.isError) {
          sendJson(res, { ok: false, error: result.text }, 400)
          return
        }
        const idMatch = String(result.text || '').match(/id=(\d+)/)
        const newId = idMatch ? Number(idMatch[1]) : null
        sendJson(res, { ok: true, id: newId, text: result.text })
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/backfill') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      let body
      try { body = await readBody(req) }
      catch (e) { sendJson(res, { ok: false, error: e.message }, Number(e?.statusCode) || 500); return }
      try {
        const result = await handleMemoryAction({
          action: 'backfill',
          window: body.window,
          scope: body.scope,
          limit: body.limit,
        })
        if (result.isError) {
          // 'backfill already in progress' → 409, other failures → 500
          const status = result.text === 'backfill already in progress' ? 409 : 500
          sendJson(res, { ok: false, error: result.text }, status)
          return
        }
        sendJson(res, { ok: true, text: result.text })
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, 500)
      }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/purge') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        const db = getDb()
        const body = await readBody(req)
        if (body?.confirm !== 'DELETE ALL MEMORY') {
          sendJson(res, { ok: false, error: 'confirm must be exactly "DELETE ALL MEMORY"' }, 400)
          return
        }
        const { rows: countRows } = await db.query(`SELECT COUNT(*) AS c FROM entries`)
        const preCount = Number(countRows[0].c)
        const { rows: coreCountRows } = await db.query(`SELECT COUNT(*) AS c FROM core_entries`)
        const coreCount = Number(coreCountRows[0].c)
        await db.transaction(async (tx) => {
          await tx.query(`DELETE FROM entries`)
        })
        sendJson(res, { ok: true, deleted: preCount, core_preserved: coreCount })
      } catch (e) { sendJson(res, { ok: false, error: e.message }, 500) }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/trace-record') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      let body
      try { body = await readBody(req) }
      catch (e) { sendJson(res, { ok: false, error: e.message }, 400); return }
      if (!Array.isArray(body?.events)) {
        sendJson(res, { ok: false, error: 'body.events must be an array' }, 400)
        return
      }
      if (body.events.length > 500) {
        sendJson(res, { ok: false, error: 'too many events (max 500)' }, 413)
        return
      }
      let traceDb = getTraceDb()
      if (!traceDb) {
        try {
          traceDb = await openTraceDatabase(DATA_DIR)
          setTraceDb(traceDb)
          registerTraceExitDrain(traceDb)
        } catch (e) {
          sendJson(res, { ok: false, error: `trace DB unavailable: ${e.message}` }, 503)
          return
        }
      }
      try {
        // Enqueue for async batched flush (100ms / 500-row window).
        enqueueTraceEvents(traceDb, body.events)
        // Use `queued` — events are async; `inserted` would imply durability.
        sendJson(res, { ok: true, queued: body.events.length })
        // Fire-and-forget into focused agent analytic tables.
        insertAgentCalls(traceDb, body.events).catch(e =>
          log(`[trace] insertAgentCalls error: ${e?.message}\n`)
        )
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, 500)
      }
      return
    }

    if (req.method === 'POST' && req.url === '/session-start/core-memory') {
      try {
        const body = await readBody(req)
        const { projectId, dbLines, userLines } = await buildSessionCoreMemoryPayload(body.cwd)
        sendJson(res, { ok: true, projectId, dbLines, userLines })
      } catch (e) { sendError(res, e.message) }
      return
    }

    if (req.method === 'POST' && req.url === '/admin/shutdown') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      sendJson(res, { shutting_down: true }, 202)
      setImmediate(() => {
        const watchdog = setTimeout(() => {
          log('[shutdown] watchdog fired — forcing exit after 8s\n')
          process.exit(1)
        }, 8000)
        watchdog.unref?.()
        stop()
          .then(() => { clearTimeout(watchdog); process.exit(0) })
          .catch(e => {
            log(`[shutdown] error ${e.message}\n`)
            clearTimeout(watchdog)
            process.exit(1)
          })
      })
      return
    }

    // DEV-ONLY cycle1 chunking bench. Gated by env MIXDOG_DEV_BENCH=1 so
     // production is untouched (route returns 404 when unset). Mirrors cycle1's
     // exact fetch query + per-session windowing, then runs each window through
     // buildCycle1ChunkPrompt + callAgentDispatch + parseCycle1LineFormat. STRICT
     // read-only — no UPDATE, no transaction, no commit.
    if (req.method === 'POST' && req.url === '/dev/cycle1-bench') {
      const db = getDb()
      // Gate: env MIXDOG_DEV_BENCH=1 OR a runtime flag file, so it can be
      // toggled without restarting the host agent (env only reaches the worker
      // on a full CC restart, not via dev-sync full-restart).
      const _devBenchOn = process.env.MIXDOG_DEV_BENCH === '1'
        || (DATA_DIR && fs.existsSync(path.join(DATA_DIR, '.dev-bench-enabled')))
      if (!_devBenchOn) {
        sendJson(res, { error: 'not found' }, 404)
        return
      }
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        const body = await readBody(req)
        const sets = Math.max(1, Number(body?.sets ?? 5))
        const repeat = Math.max(1, Number(body?.repeat ?? 1))
        // Optional variant matrix. Each variant: {name, rules}. rules=null → default prompt.
        const rawVariants = Array.isArray(body?.variants) ? body.variants : null
        const variants = rawVariants && rawVariants.length > 0
          ? rawVariants.map((v, i) => ({
              name: typeof v?.name === 'string' && v.name ? v.name : `variant-${i + 1}`,
              rules: Array.isArray(v?.rules) ? v.rules : null,
            }))
          : null

        // Lazy-load LLM + chunking helpers so production boot pays nothing.
        // Use the same in-process agent dispatch adapter as real cycle1 — the legacy
        // agent-ipc callAgentDispatch() path is dead in the detached standalone
        // memory daemon (no connected IPC), so the dev bench must mirror prod.
        const [{ buildCycle1ChunkPrompt, parseCycle1LineFormat }, { resolveMaintenancePreset }] = await Promise.all([
          import('./memory-cycle1.mjs'),
          import('../../shared/llm/index.mjs'),
        ])
        const benchCallLlm = getCycle1CallLlm()

        const CYCLE1_MIN_BATCH = 3
        const CYCLE1_SESSION_CAP = 10
        const BATCH_SIZE = 100
        const TIMEOUT_MS = 180_000
        const fetchLimit = CYCLE1_SESSION_CAP * BATCH_SIZE

        const fetchResult = await db.query(
          `SELECT id, ts, role, content, session_id, source_ref, project_id
           FROM entries
           WHERE chunk_root IS NULL AND session_id IS NOT NULL
           ORDER BY ts DESC, id DESC
           LIMIT $1`,
          [fetchLimit],
        )
        const rowsDesc = fetchResult.rows

        if (rowsDesc.length < CYCLE1_MIN_BATCH) {
          sendJson(res, {
            ok: true,
            sets, repeat,
            windowsAvailable: 0,
            note: `not enough pending rows (need >= ${CYCLE1_MIN_BATCH}, got ${rowsDesc.length})`,
            results: [],
          })
          return
        }

        // Partition by session_id — same as memory-cycle1.mjs _runCycle1Impl L207-233.
        const sessionMap = new Map()
        for (const row of rowsDesc.slice().reverse()) {
          const sid = row.session_id
          if (!sessionMap.has(sid)) sessionMap.set(sid, [])
          sessionMap.get(sid).push(row)
        }
        const windows = []
        for (const [sid, sessionRows] of sessionMap) {
          if (sessionRows.length < CYCLE1_MIN_BATCH) continue
          const windowCount = Math.max(1, Math.ceil(sessionRows.length / BATCH_SIZE))
          const baseSize = Math.floor(sessionRows.length / windowCount)
          const remainder = sessionRows.length % windowCount
          let _offset = 0
          for (let i = 0; i < windowCount; i++) {
            const size = baseSize + (i < remainder ? 1 : 0)
            windows.push({ sid, rows: sessionRows.slice(_offset, _offset + size) })
            _offset += size
          }
        }
        const chosen = windows.slice(0, sets)

        const preset = resolveMaintenancePreset('memory')

        function summariseChunks(chunks, totalEntries) {
          const usedIdx = new Set()
          for (const c of chunks) for (const i of (c._idxList || [])) usedIdx.add(i)
          const omitted = []
          for (let i = 1; i <= totalEntries; i++) if (!usedIdx.has(i)) omitted.push(i)
          return { covered: usedIdx.size, omitted }
        }

        // When variants are absent, fall back to a single implicit baseline so the
        // pre-variant call shape (single rows × repeat) keeps producing the same
        // {runs:[…]} payload the trigger already knows how to print.
        const variantList = variants ?? [{ name: 'baseline', rules: null }]

        async function runOnce(rows, customRules) {
          const userMessage = buildCycle1ChunkPrompt(rows, customRules)
          const t0 = Date.now()
          let raw, error
          try {
            raw = await benchCallLlm({
              preset,
              timeout: TIMEOUT_MS,
            }, userMessage)
          } catch (e) {
            error = e?.message ?? String(e)
          }
          const llmMs = Date.now() - t0
          if (error) return { ok: false, llmMs, error }
          const parsed = parseCycle1LineFormat(raw)
          const chunks = Array.isArray(parsed?.chunks) ? parsed.chunks : []
          const { covered, omitted } = summariseChunks(chunks, rows.length)
          const ratio = chunks.length > 0
            ? parseFloat((rows.length / chunks.length).toFixed(2))
            : null
          return {
            ok: true,
            llmMs,
            entries: rows.length,
            chunks: chunks.length,
            ratio,
            covered,
            omitted,
            chunkList: chunks.map(c => ({
              idx: c._idxList,
              element: c.element,
              category: c.category,
              summary: c.summary,
            })),
          }
        }

        const results = []
        for (let s = 0; s < chosen.length; s++) {
          const { sid, rows } = chosen[s]
          const sidShort = String(sid).slice(0, 8)
          if (variants) {
            // Variant mode: same rows, one run per variant per repeat.
            const variantResults = []
            for (const v of variantList) {
              const runs = []
              for (let r = 0; r < repeat; r++) {
                const run = await runOnce(rows, v.rules)
                runs.push({ repIdx: r + 1, ...run })
              }
              variantResults.push({ name: v.name, runs })
            }
            results.push({
              setIdx: s + 1,
              sessionIdShort: sidShort,
              entries: rows.length,
              variants: variantResults,
            })
          } else {
            // Legacy single-baseline payload shape.
            const runs = []
            for (let r = 0; r < repeat; r++) {
              const run = await runOnce(rows, null)
              runs.push({ repIdx: r + 1, ...run })
            }
            results.push({
              setIdx: s + 1,
              sessionIdShort: sidShort,
              entries: rows.length,
              runs,
            })
          }
        }
        sendJson(res, {
          ok: true,
          sets, repeat,
          windowsAvailable: windows.length,
          variants: variants ? variantList.map(v => v.name) : null,
          results,
        })
      } catch (e) {
        sendError(res, e?.message || String(e))
      }
      return
    }

    if (req.method === 'POST' && req.url === '/api/tool') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { content: [{ type: 'text', text: 'forbidden: cross-origin' }], isError: true }, 403)
        return
      }
      // Reject tool calls that arrive after shutdown has begun. The error text
      // carries the "draining" token so the proxy treats it as transient,
      // respawns a fresh daemon, and retries the RPC (including write RPCs).
      if (getDraining?.()) {
        sendJson(res, { content: [{ type: 'text', text: 'memory worker draining' }], isError: true }, 503)
        return
      }
      // Owner-side cancel plumbing: the fork-proxy worker forwards parent
      // 'cancel' IPC by issuing POST /api/cancel with the same callId. Track
      // each in-flight /api/tool by its caller-supplied X-Mixdog-Call-Id so
      // the cancel endpoint can abort the AbortSignal threaded into
      // handleToolCall. Without this the proxy-side fetch aborts but the
      // owner keeps running the upstream tool to completion.
      const callId = String(req.headers['x-mixdog-call-id'] || '').trim() || null
      const ac = new AbortController()
      // Abort only on a genuine mid-flight client disconnect. The req 'close'
      // event fires on every normal request once the request body is consumed
      // (before handleToolCall resolves), so gating on it would mark normal
      // completions as aborted. Use the response side instead: when the
      // socket closes, res.writableFinished is true iff the response was
      // fully written — a real client disconnect closes the socket before
      // the response finishes, leaving writableFinished===false.
      res.on('close', () => {
        if (res.writableFinished) return
        try { ac.abort() } catch {}
      })
      if (callId) _ownerInFlightHttpCalls.set(callId, ac)
      try {
        const body = await readBody(req)
        const result = await handleToolCall(body.name, body.arguments ?? {}, ac.signal)
        sendJson(res, result)
      } catch (e) {
        sendJson(res, { content: [{ type: 'text', text: `api/tool error: ${e.message}` }], isError: true }, Number(e?.statusCode) || 500)
      } finally {
        if (callId) _ownerInFlightHttpCalls.delete(callId)
      }
      return
    }

    if (req.method === 'POST' && req.url === '/api/cancel') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { ok: false, error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        const body = await readBody(req)
        const id = String(body.callId || '').trim()
        if (!id) { sendJson(res, { ok: false, error: 'callId required' }, 400); return }
        const ac = _ownerInFlightHttpCalls.get(id)
        if (ac) {
          try { ac.abort() } catch {}
          _ownerInFlightHttpCalls.delete(id)
          sendJson(res, { ok: true, cancelled: true })
        } else {
          sendJson(res, { ok: true, cancelled: false })
        }
      } catch (e) {
        sendJson(res, { ok: false, error: e.message }, Number(e?.statusCode) || 500)
      }
      return
    }

    if (req.url === '/mcp') {
      if (!isLocalOrigin(req)) {
        sendJson(res, { error: 'forbidden: cross-origin' }, 403)
        return
      }
      try {
        if (req.method === 'POST') {
          const httpMcp = createHttpMcpServer()
          const httpTransport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          })
          res.on('close', () => {
            httpTransport.close()
            void httpMcp.close()
          })
          await httpMcp.connect(httpTransport)
          const body = await readBody(req)
          await httpTransport.handleRequest(req, res, body)
        } else {
          sendJson(res, { error: 'Method not allowed' }, 405)
        }
      } catch (e) {
        log(`[memory-service] /mcp error: ${e.stack || e.message}\n`)
        if (!res.headersSent) sendError(res, e.message, Number(e?.statusCode) || 500)
      }
      return
    }

    if (req.method !== 'POST') {
      sendJson(res, { error: 'Method not allowed' }, 405)
      return
    }

    // Tail block handles /entry and /ingest-transcript — both mutate the DB,
    // so apply the same cross-origin guard as /admin/* routes.
    if (!isLocalOrigin(req)) {
      sendError(res, 'forbidden: cross-origin', 403)
      return
    }

    let body
    try { body = await readBody(req) }
    catch (e) { sendError(res, e.message, Number(e?.statusCode) || 500); return }

    try {
      if (req.url === '/entry') {
        const db = getDb()
        const role = String(body.role ?? 'user')
        const content = String(body.content ?? '')
        const sourceRef = String(body.sourceRef ?? `manual:${Date.now()}-${process.pid}`)
        const sessionId = body.sessionId ?? null
        const tsMs = parseTsToMs(body.ts ?? Date.now())
        if (!content) { sendJson(res, { error: 'content required' }, 400); return }
        // Run the same scrubber used by ingestTranscriptFile so noise markers
        // like "[Request interrupted by user]" and whitespace-only payloads
        // are rejected before they reach the entries table. Match the
        // existing 400 / { error } convention for invalid payloads.
        const cleaned = cleanMemoryText(content)
        if (!cleaned || !cleaned.trim()) {
          sendJson(res, { error: 'empty after clean' }, 400)
          return
        }
        const entryProjectId = resolveProjectScope(typeof body.cwd === 'string' && body.cwd ? body.cwd : null)
        try {
          const result = await db.query(`
            INSERT INTO entries(ts, role, content, source_ref, session_id, project_id)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT DO NOTHING
            RETURNING id
          `, [tsMs, role, cleaned, sourceRef, sessionId, entryProjectId])
          const insertedId = result.rows[0]?.id ?? null
          sendJson(res, { ok: true, id: insertedId !== null ? Number(insertedId) : null, changes: Number(result.rowCount ?? result.affectedRows ?? 0) })
        } catch (e) {
          sendJson(res, { error: e.message }, 500)
        }
        return
      }

      if (req.url === '/ingest-transcript') {
        const filePath = body.filePath
        if (!filePath) { sendJson(res, { error: 'filePath required' }, 400); return }
        try {
          const n = await ingestTranscriptFile(filePath, { cwd: body.cwd })
          sendJson(res, { ok: true, ingested: n })
        } catch (e) {
          sendJson(res, { error: e.message }, 500)
        }
        return
      }

      if (req.url === '/transcript/ingest-sync') {
        const filePath = body.path
        if (!filePath || typeof filePath !== 'string') {
          sendJson(res, { error: 'path required' }, 400)
          return
        }
        try {
          let stat
          try { stat = await fs.promises.stat(filePath) } catch {
            sendJson(res, { ok: true, complete: true, fileSize: 0, offsetBytes: 0 })
            return
          }
          const fileSize = stat.size
          await ingestTranscriptFile(filePath, { cwd: body.cwd })
          const off = getTranscriptOffset(filePath)
          const offsetBytes = off && Number.isFinite(off.bytes) ? off.bytes : 0
          const complete = offsetBytes >= fileSize
          sendJson(res, { ok: true, offsetBytes, fileSize, complete })
        } catch (e) {
          sendJson(res, { error: e.message }, 500)
        }
        return
      }

      sendJson(res, { error: 'Not found' }, 404)
    } catch (e) {
      log(`[memory-service] ${req.url} error: ${e.stack || e.message}\n`)
      sendError(res, e.message)
    }
  }

  return { requestHandler, buildSessionCoreMemoryPayload, createHttpMcpServer }
}
