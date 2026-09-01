import { compareRecallNewestFirst } from './recall-order.mjs'

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
  const copy = { ...(row || {}), is_root: 0, chunk_root: null }
  delete copy.members
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

// Build one complete compact projection for a session:
//   summarized episode -> root summary
//   unsummarized episode -> every RAW member
// The latest live user turns are excluded here because the orchestrator emits
// that same range once, with provider roles/tool pairing intact, as the tail.
// No content-based dedupe or count cap is allowed: repeated text can be a real
// repeated instruction and every canonical row must remain represented.
export function compactHandoffRows(rows, { preserveLatestUserTurns = 0 } = {}) {
  const source = Array.isArray(rows) ? rows : []
  const cutoff = tailCutoff(source, preserveLatestUserTurns)
  const projected = []

  for (const row of source) {
    const isRoot = Number(row?.is_root) === 1
    const members = memberRows(row)
    if (!isRoot) {
      if (isBeforeCutoff(row, cutoff)) projected.push(row)
      continue
    }

    const keptMembers = members.filter((member) => isBeforeCutoff(member, cutoff))
    const hasSummary = !!String(row?.summary ?? '').trim()
    if (hasSummary && members.length > 0 && keptMembers.length === members.length) {
      const summaryRow = { ...row }
      delete summaryRow.members
      projected.push(summaryRow)
      continue
    }
    if (hasSummary && members.length === 0) {
      if (isBeforeCutoff(row, cutoff)) {
        const summaryRow = { ...row }
        delete summaryRow.members
        projected.push(summaryRow)
      }
      continue
    }
    if (members.length > 0) {
      projected.push(...keptMembers.map(rawMember))
      continue
    }
    if (isBeforeCutoff(row, cutoff)) {
      const rawRoot = { ...row }
      delete rawRoot.members
      projected.push(rawRoot)
    }
  }

  return uniqueRows(projected).sort(compareRecallNewestFirst)
}
