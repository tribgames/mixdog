const DEFAULT_RRF_K = 60

function normalizeRank(value) {
  const rank = Number(value)
  return Number.isInteger(rank) && rank > 0 ? rank : null
}

export function recallLaneRanks(row) {
  const lexicalRanks = [
    row?.sparse_rank,
    row?.trgm_rank,
    row?.exact_rank,
  ].map(normalizeRank).filter((rank) => rank != null)
  return {
    denseRank: normalizeRank(row?.dense_rank),
    lexicalRank: lexicalRanks.length > 0 ? Math.min(...lexicalRanks) : null,
  }
}

export function recallRrfScore(row, k = DEFAULT_RRF_K) {
  const { denseRank, lexicalRank } = recallLaneRanks(row)
  return (denseRank == null ? 0 : 1 / (k + denseRank))
    + (lexicalRank == null ? 0 : 1 / (k + lexicalRank))
}

export function recallEvidenceKind(row) {
  const { denseRank, lexicalRank } = recallLaneRanks(row)
  if (lexicalRank != null) return 'lexical'
  if (denseRank == null) return 'none'
  const similarity = Number(row?.dense_sim)
  return Number.isFinite(similarity) && similarity > 0 ? 'semantic' : 'none'
}

export function isSemanticOnlyRecall(rows) {
  return Array.isArray(rows)
    && rows.length > 0
    && rows.every((row) => row?._retrievalEvidence === 'semantic')
}

export function rankRecallCandidates(rows, k = DEFAULT_RRF_K) {
  return (rows ?? [])
    .map((row) => {
      const id = Number(row?.id)
      const rrf = recallRrfScore(row, k)
      const evidence = recallEvidenceKind(row)
      return { id, row, rrf, retrievalScore: rrf, evidence }
    })
    .filter(({ id, rrf, evidence }) => Number.isFinite(id) && rrf > 0 && evidence !== 'none')
    .sort((left, right) => (
      right.rrf - left.rrf
      || left.id - right.id
    ))
}
