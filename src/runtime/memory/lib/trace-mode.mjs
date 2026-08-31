import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { ensurePgInstance } from './pg/adapter.mjs'

export const TRACE_ENABLE_MARKER = '.trace-enabled'

const enabledValues = new Set(['1', 'true', 'on', 'yes'])
const disabledValues = new Set(['0', 'false', 'off', 'no'])
const cleanupPromises = new Map()

export function traceMarkerPath(dataDir) {
  return join(resolve(dataDir), TRACE_ENABLE_MARKER)
}

export function traceEnabled(
  dataDir,
  { env = process.env, markerExists = existsSync } = {},
) {
  const configured = String(env.MIXDOG_TRACE ?? '').trim().toLowerCase()
  if (enabledValues.has(configured)) return true
  if (disabledValues.has(configured)) return false
  if (configured) return false
  return markerExists(traceMarkerPath(dataDir))
}

export async function cleanupTraceWhenDisabled(
  dataDir,
  {
    enabled = traceEnabled(dataDir),
    ensurePg = ensurePgInstance,
  } = {},
) {
  if (enabled) return { disabled: false, dropped: false }

  const key = resolve(dataDir)
  if (cleanupPromises.has(key)) return cleanupPromises.get(key)

  const cleanup = (async () => {
    const { db } = await ensurePg(dataDir, { schema: 'memory' })
    const result = await db.query(`
      SELECT EXISTS (
        SELECT 1 FROM pg_namespace WHERE nspname = 'trace'
      ) AS present
    `)
    const present = Boolean(result.rows?.[0]?.present)
    if (present) await db.query('DROP SCHEMA trace CASCADE')
    return { disabled: true, dropped: present }
  })()

  cleanupPromises.set(key, cleanup)
  try {
    return await cleanup
  } catch (error) {
    cleanupPromises.delete(key)
    throw error
  }
}
