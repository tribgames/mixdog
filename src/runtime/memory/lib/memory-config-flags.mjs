// Extracted from index.mjs — env/config flag helpers (pure, poll-on-use).
// These read process.env and the on-disk config section each call so runtime
// toggles (recap, secondary mode, cycle kill-switches) take effect without a
// daemon restart. No module-level mutable state; safe to import anywhere.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { readSection } from '../../shared/config.mjs'
import { readServiceAdvert } from '../../shared/service-discovery.mjs'

export function readMainConfig() {
  return readSection('memory')
}

// Recap toggle lives in the `agent` config section (agent.recap.enabled,
// default true) — the same file the session runtime persists via
// saveConfigAndAdopt. The memory daemon runs as a detached cross-process HTTP
// worker, so it re-reads this section from disk each cycle tick (poll-on-use)
// rather than relying on IPC. A legacy `agent.modules.memory === false` flag is
// still honored as recap off (migration folds it on the session-runtime side).
export function readRecapEnabled() {
  try {
    let agent = readSection('agent')
    // The agent section may be double-wrapped ({ agent: { providers, ... } })
    // in legacy config files; loadConfig() unwraps the same way (config.mjs
    // `raw.agent && raw.agent.providers`). Mirror it here or a migrated/toggled
    // recap flag written inside the wrapper would be invisible to the daemon.
    if (agent?.agent && agent.agent.providers) agent = agent.agent
    const recap = agent?.recap
    if (recap && typeof recap === 'object' && recap.enabled === false) return false
    const legacyMemory = agent?.modules?.memory
    if (legacyMemory === false) return false
    if (legacyMemory && typeof legacyMemory === 'object' && legacyMemory.enabled === false) return false
    return true
  } catch {
    return true
  }
}

export function embeddingWarmupEnabled() {
  const raw = String(process.env.MIXDOG_EMBED_WARMUP ?? '1').trim().toLowerCase()
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no')
}

export function envFlagEnabled(name) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes'
}

export function memorySecondaryMode() {
  return envFlagEnabled('MIXDOG_MEMORY_SECONDARY')
}

export function embeddingWarmupCanStart() {
  return embeddingWarmupEnabled() && !memorySecondaryMode()
}

export function memoryLlmWorkerEnabled() {
  return !memorySecondaryMode() && !envFlagEnabled('MIXDOG_MEMORY_DISABLE_LLM_WORKER')
}

export function memoryCyclesEnabled() {
  // Background cycles run only when: not secondary mode, the env hard-override
  // is not set, AND the user-facing recap toggle is on. The recap flag is
  // re-read from disk here so toggling it at runtime takes effect without a
  // daemon restart (checkCycles polls this each tick). The env override stays a
  // hard kill switch regardless of recap.
  return !memorySecondaryMode()
    && !envFlagEnabled('MIXDOG_MEMORY_DISABLE_CYCLES')
    && readRecapEnabled()
}

export function secondaryPgAdvertised(dataDir) {
  if (!memorySecondaryMode()) return true
  const runtimeRoot = process.env.MIXDOG_RUNTIME_ROOT
    ? path.resolve(process.env.MIXDOG_RUNTIME_ROOT)
    : path.join(os.tmpdir(), 'mixdog')
  // Prefer the single-writer PG discovery advert (discovery/pg.json); fall back
  // to the legacy active-instance.json pg_* fields for cross-version compat.
  const readAdvert = () => {
    const advert = readServiceAdvert('pg')
    if (advert && Number(advert.pg_port) > 0) return advert
    try {
      return JSON.parse(fs.readFileSync(path.join(runtimeRoot, 'active-instance.json'), 'utf8'))
    } catch {
      return advert
    }
  }
  try {
    const cur = readAdvert()
    const port = Number(cur?.pg_port)
    const pgdata = cur?.pg_pgdata ? path.resolve(String(cur.pg_pgdata)) : ''
    return Number.isInteger(port) && port > 0 && pgdata === path.resolve(path.join(dataDir, 'pgdata'))
  } catch {
    return false
  }
}

export function assertSecondaryPgAttachable(dataDir) {
  if (!secondaryPgAdvertised(dataDir)) {
    throw new Error('memory-service: secondary mode requires an existing primary PG instance')
  }
}
