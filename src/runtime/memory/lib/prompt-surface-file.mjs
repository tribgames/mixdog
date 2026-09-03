// prompt-surface-file.mjs — snapshot of the text a live Lead session already
// receives every turn (rule blocks, skill/tool catalog, workflow, role rules,
// and every tool description). The memory service cannot compose a session
// prompt itself, so the session runtime writes this file and the memory cycles
// read it back as the "current rules" authority for restatement detection.
// Without the tool descriptions in that digest, a memory that merely echoes a
// tool contract (e.g. the goal tool's continuous-mode wording) looked novel
// and survived every gate.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { updateJsonAtomic } from '../../shared/atomic-file.mjs'

export const PROMPT_SURFACE_FILE_VERSION = 1
export const PROMPT_SURFACE_FILE_NAME = 'prompt-surface.json'
// Hard ceiling per section so a runaway catalog cannot balloon the digest.
const SECTION_CAP = 120_000

function filePath(dataDir) {
  return join(dataDir, PROMPT_SURFACE_FILE_NAME)
}

function clampText(value) {
  const text = String(value ?? '').trim()
  return text.length > SECTION_CAP ? text.slice(0, SECTION_CAP) + '\n…[truncated]' : text
}

function normalizeTools(tools) {
  if (!Array.isArray(tools)) return []
  const out = []
  const seen = new Set()
  for (const tool of tools) {
    const name = String(tool?.name ?? '').trim()
    const description = String(tool?.description ?? '').replace(/\s+/g, ' ').trim()
    if (!name || !description || seen.has(name)) continue
    seen.add(name)
    out.push({ name, description })
  }
  return out
}

export function buildPromptSurfaceSnapshot({ rules, tools } = {}) {
  const ruleSections = (Array.isArray(rules) ? rules : [rules])
    .map(clampText)
    .filter(Boolean)
  return { rules: ruleSections, tools: normalizeTools(tools) }
}

export function promptSurfaceHash(snapshot) {
  const h = createHash('sha256')
  for (const section of snapshot?.rules ?? []) h.update(section).update('\u0000')
  for (const tool of snapshot?.tools ?? []) h.update(tool.name).update('\u0001').update(tool.description).update('\u0000')
  return h.digest('hex')
}

export function readPromptSurfaceFile(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(filePath(dataDir), 'utf8'))
    if (parsed?.version !== PROMPT_SURFACE_FILE_VERSION) return null
    const snapshot = buildPromptSurfaceSnapshot(parsed)
    return {
      version: PROMPT_SURFACE_FILE_VERSION,
      hash: typeof parsed.hash === 'string' ? parsed.hash : promptSurfaceHash(snapshot),
      updatedAt: Number(parsed.updatedAt) || 0,
      ...snapshot,
    }
  } catch {
    return null
  }
}

// Writes only when the surface actually changed; returns { written, hash }.
export async function writePromptSurfaceSnapshot(dataDir, input, { now = Date.now() } = {}) {
  const snapshot = buildPromptSurfaceSnapshot(input)
  if (snapshot.rules.length === 0 && snapshot.tools.length === 0) return { written: false, hash: null }
  const hash = promptSurfaceHash(snapshot)
  const result = await updateJsonAtomic(filePath(dataDir), (current) => {
    if (current?.version === PROMPT_SURFACE_FILE_VERSION && current?.hash === hash) return undefined
    return { version: PROMPT_SURFACE_FILE_VERSION, hash, updatedAt: now, ...snapshot }
  }, { secret: true, compact: true })
  return { written: result?.hash === hash && result?.updatedAt === now, hash }
}

// Flat text form consumed by the rules digest: one block per rule section,
// then one line per tool description.
export function renderPromptSurfaceDigest(surface) {
  if (!surface) return ''
  const parts = []
  surface.rules.forEach((section, i) => {
    parts.push(`# Source: live session prompt block ${i + 1}\n${section}`)
  })
  if (surface.tools.length > 0) {
    parts.push('# Source: live session tool descriptions\n' +
      surface.tools.map(t => `- ${t.name}: ${t.description}`).join('\n'))
  }
  return parts.join('\n\n---\n\n')
}
