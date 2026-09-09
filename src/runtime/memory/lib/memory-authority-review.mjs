import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPromptSurfaceFile } from './prompt-surface-file.mjs'

// Read the owners of standing instructions, not generated memory itself.
// Keep a full fingerprint even when a review packet cannot fit all the text.
export function collectMemoryAuthority(resourceRoot, dataDir) {
  const parts = []
  const surface = dataDir ? readPromptSurfaceFile(dataDir) : null
  for (const [i, text] of (surface?.rules ?? []).entries()) {
    parts.push(`# Source: live rules ${i + 1}\n${text}`)
  }
  for (const tool of surface?.tools ?? []) {
    parts.push(`# Source: tool ${tool.name}\n${tool.description}\n${JSON.stringify(tool.inputSchema ?? {})}`)
  }
  const append = path => {
    const text = readFileSync(path, 'utf8').trim()
    if (text) parts.push(`# Source: ${path}\n${text}`)
  }
  for (const scope of ['lead', 'shared']) {
    const dir = join(resourceRoot, 'rules', scope)
    if (!existsSync(dir)) continue
    for (const file of readdirSync(dir).sort()) {
      if (file.endsWith('.md')) append(join(dir, file))
    }
  }
  const workflows = join(resourceRoot, 'workflows')
  if (existsSync(workflows)) {
    for (const name of readdirSync(workflows).sort()) {
      const path = join(workflows, name, 'WORKFLOW.md')
      if (existsSync(path)) append(path)
    }
  }
  const skills = new Map()
  for (const base of [join(resourceRoot, 'defaults', 'skills'), ...(dataDir ? [join(dataDir, 'skills')] : [])]) {
    if (!existsSync(base)) continue
    for (const name of readdirSync(base).sort()) {
      const path = join(base, name, 'SKILL.md')
      if (existsSync(path)) skills.set(name, path)
    }
  }
  for (const path of skills.values()) append(path)
  const text = parts.join('\n\n---\n\n')
  return {
    text,
    parts,
    // Versioning queues historical records after review-policy changes too.
    hash: createHash('sha256').update('retrieval-only-v1\0').update(text).digest('hex'),
  }
}

// Allocate the same bounded space to every source rather than silently losing
// all later tools/skills to a prefix cut. Omitted material is explicitly marked.
export function renderMemoryAuthority(authority, maxChars) {
  if (authority.text.length <= maxChars) return authority.text
  const parts = authority.parts
  const separator = '\n\n---\n\n'
  const marker = '\n[Source truncated; absence is not evidence of novelty.]'
  const budget = Math.max(0, Math.floor((maxChars - separator.length * (parts.length - 1)) / parts.length))
  return parts.map(part => part.length <= budget ? part
    : part.slice(0, Math.max(0, budget - marker.length)) + marker.slice(0, budget))
    .join(separator)
}

// Persist an epoch, not a bulk rewrite of entries. Interrupted/failed reviews
// remain eligible, and normal bounded gate batches drain the queue.
export async function pendingAuthorityReview(db, authority, nowMs) {
  const result = await db.query(
    `SELECT value FROM meta WHERE key = $1`, ['memory.authority-review'],
  )
  let state = result.rows[0]?.value
  if (typeof state === 'string') state = JSON.parse(state)
  if (state?.hash !== authority.hash) {
    state = { hash: authority.hash, changedAt: nowMs }
    await db.query(
      `INSERT INTO meta(key, value) VALUES ($1, $2::jsonb)
       ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value`,
      ['memory.authority-review', JSON.stringify(state)],
    )
  }
  const pending = await db.query(
    `SELECT id FROM entries
     WHERE is_root = 1 AND status = 'active'
       AND (reviewed_at IS NULL OR reviewed_at < $1)
     LIMIT 1`, [state.changedAt],
  )
  return pending.rows.length ? state.changedAt : null
}
