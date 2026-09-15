import { compareRecallNewestFirst } from './recall-order.mjs'
import { assessChunkQuality } from './memory-chunk-quality.mjs'

function finiteTurn(row) {
  const turn = Number(row?.source_turn)
  return Number.isFinite(turn) ? turn : null
}

function chronologicalCompare(a, b) {
  const aTurn = finiteTurn(a)
  const bTurn = finiteTurn(b)
  if (aTurn != null && bTurn != null && aTurn !== bTurn) return aTurn - bTurn
  const aTs = Number(a?.ts) || 0
  const bTs = Number(b?.ts) || 0
  if (aTs !== bTs) return aTs - bTs
  return (Number(a?.id) || 0) - (Number(b?.id) || 0)
}

function rowIdentity(row) {
  if (row?.id != null) return `id:${row.id}`
  if (row?.source_ref) return `ref:${row.source_ref}`
  return [
    row?.session_id ?? '',
    row?.source_turn ?? '',
    row?.role ?? '',
    row?.ts ?? '',
    row?.content ?? '',
  ].join('\u0000')
}

function uniqueRows(rows) {
  const seen = new Set()
  const out = []
  for (const row of rows || []) {
    const key = rowIdentity(row)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(row)
  }
  return out
}

function memberRows(row) {
  return uniqueRows(Array.isArray(row?.members) ? row.members : [])
    .sort(chronologicalCompare)
}

function rawMember(row) {
  const copy = { ...(row || {}), is_root: 0, chunk_root: null, _compactRaw: true }
  delete copy.members
  delete copy.element
  delete copy.summary
  delete copy.chunk_quality
  return copy
}

function transcriptRows(rows) {
  const out = []
  for (const row of rows || []) {
    const members = memberRows(row)
    if (members.length > 0) out.push(...members)
    else if (row?.role === 'user' || row?.role === 'assistant') out.push(row)
  }
  return uniqueRows(out).sort(chronologicalCompare)
}

function tailCutoff(rows, preserveLatestUserTurns) {
  const count = Math.max(0, Math.floor(Number(preserveLatestUserTurns) || 0))
  if (count === 0) return null
  const users = transcriptRows(rows).filter((row) => row?.role === 'user')
  if (users.length === 0) return null
  return users[Math.max(0, users.length - count)]
}

function isBeforeCutoff(row, cutoff) {
  if (!cutoff) return true
  const rowTurn = finiteTurn(row)
  const cutoffTurn = finiteTurn(cutoff)
  if (rowTurn != null && cutoffTurn != null) return rowTurn < cutoffTurn
  return chronologicalCompare(row, cutoff) < 0
}

function canCompressEpisode(row, members, keptMembers, references) {
  return !!String(row?.summary ?? '').trim()
    && members.length > 0
    && keptMembers.length === members.length
    && members.every((member) => references.get(rowIdentity(member)) === 1)
    && assessChunkQuality(row, row.members).usable
}

// Build one complete compact projection for a session:
//   structurally usable, shorter episode (including legacy) -> compressed body
//   malformed, changed or larger episode -> every RAW member
// The latest live user turns are excluded here because the orchestrator emits
// that same range once, with provider roles/tool pairing intact, as the tail.
// No content-based dedupe or count cap is allowed: repeated text can be a real
// repeated instruction and every canonical row must remain represented.
export function compactHandoffRows(rows, { preserveLatestUserTurns = 0 } = {}) {
  const source = Array.isArray(rows) ? rows : []
  const cutoff = tailCutoff(source, preserveLatestUserTurns)
  const projected = []
  const references = new Map()
  for (const row of source) {
    for (const member of memberRows(row)) {
      const key = rowIdentity(member)
      references.set(key, (references.get(key) || 0) + 1)
    }
  }

  for (const row of source) {
    const isRoot = Number(row?.is_root) === 1
    const members = memberRows(row)
    if (!isRoot) {
      if (isBeforeCutoff(row, cutoff)) projected.push(rawMember(row))
      continue
    }

    const keptMembers = members.filter((member) => isBeforeCutoff(member, cutoff))
    if (canCompressEpisode(row, members, keptMembers, references)) {
      const summaryRow = { ...row, element: '', _compactBody: true, _compactMemberIds: members.map(member => String(member.id)) }
      delete summaryRow.members
      projected.push(summaryRow)
      continue
    }
    if (members.length > 0) {
      projected.push(...keptMembers.map(rawMember))
      continue
    }
    if (isBeforeCutoff(row, cutoff)) {
      projected.push(rawMember(row))
    }
  }

  return uniqueRows(projected).sort(compareRecallNewestFirst)
}
