import { createHash } from 'node:crypto'
import { parsePeriod } from '../../src/runtime/memory/lib/recall-format.mjs'

export const CASE_FILES = Object.freeze([
  'recall-bench-cases.json',
  'recall-quality-cases.json',
  'recall-repo-cases.json',
  'recall-usecase-cases.json',
  'recall-event-cases.json',
  'recall-history-cases.json',
])

const RETRIEVAL_INSTRUCTION = 'Given a web search query, retrieve relevant passages that answer the query'

export const MODEL_SPECS = Object.freeze({
  harrier: Object.freeze({
    label: 'Harrier 270M q4',
    modelId: 'onnx-community/harrier-oss-v1-270m-ONNX',
    dtype: 'q4',
    pooling: 'last_token',
    outputName: 'sentence_embedding',
    queryPrefix: `Instruct: ${RETRIEVAL_INSTRUCTION}\nQuery: `,
    documentPrefix: '',
    batchSize: 16,
  }),
  granite97: Object.freeze({
    label: 'Granite 97M quint8',
    modelId: 'ibm-granite/granite-embedding-97m-multilingual-r2',
    dtype: 'fp32',
    modelFileName: 'model_quint8_avx2',
    pooling: 'cls',
    outputName: '',
    queryPrefix: '',
    documentPrefix: '',
    batchSize: 16,
  }),
  e5small: Object.freeze({
    label: 'multilingual-e5-small q8',
    modelId: 'Xenova/multilingual-e5-small',
    dtype: 'q8',
    pooling: 'mean',
    outputName: '',
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    batchSize: 16,
  }),
  embeddinggemma: Object.freeze({
    label: 'EmbeddingGemma 300M q4',
    modelId: 'onnx-community/embeddinggemma-300m-ONNX',
    dtype: 'q4',
    pooling: 'mean',
    outputName: 'sentence_embedding',
    queryPrefix: 'task: search result | query: ',
    documentPrefix: 'title: none | text: ',
    batchSize: 16,
  }),
  bgem3: Object.freeze({
    label: 'BGE-M3 q4',
    modelId: 'Xenova/bge-m3',
    dtype: 'q4',
    pooling: 'cls',
    outputName: '',
    queryPrefix: '',
    documentPrefix: '',
    batchSize: 16,
  }),
  qwen3: Object.freeze({
    label: 'Qwen3-Embedding 0.6B q8',
    modelId: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    dtype: 'q8',
    pooling: 'last_token',
    outputName: '',
    queryPrefix: `Instruct: ${RETRIEVAL_INSTRUCTION}\nQuery:`,
    documentPrefix: '',
    batchSize: 16,
  }),
})

export function documentText(row) {
  return [row?.element, row?.summary].filter(Boolean).join(' — ').trim()
}

export function classifyQueryLanguage(query) {
  const text = String(query || '')
  const hasHangul = /[\uac00-\ud7a3]/u.test(text)
  const hasLatin = /[A-Za-z]/u.test(text)
  if (hasHangul && hasLatin) return 'mixed'
  if (hasHangul) return 'ko'
  if (hasLatin) return 'en'
  return 'other'
}

export function buildEvaluation(caseFile, kase) {
  const query = kase?.args?.query
  const targets = Array.isArray(kase?.expect?.topNContains)
    ? kase.expect.topNContains.map((value) => String(value || '')).filter(Boolean)
    : []
  if (typeof query !== 'string' || !query.trim() || targets.length === 0) return null
  const temporal = parsePeriod(String(kase?.args?.period || ''), true)
  return {
    id: String(kase.id),
    caseFile,
    label: String(kase.label || kase.id),
    query: query.trim(),
    language: classifyQueryLanguage(query),
    targets,
    contractTopN: Number.isInteger(kase?.expect?.topN) ? kase.expect.topN : 5,
    filter: {
      projectScope: String(kase?.args?.projectScope || 'mixdog'),
      categories: (Array.isArray(kase?.args?.category) ? kase.args.category : [kase?.args?.category])
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean),
      startMs: Number.isFinite(Number(temporal?.startMs)) ? Number(temporal.startMs) : null,
      endMs: Number.isFinite(Number(temporal?.endMs)) ? Number(temporal.endMs) : null,
    },
  }
}

export function documentMatchesFilter(document, filter = {}) {
  const scope = String(filter.projectScope || 'mixdog')
  if (scope === 'common' && document.projectId != null) return false
  if (scope !== 'all' && scope !== 'common' && document.projectId != null && document.projectId !== scope) return false
  if (Array.isArray(filter.categories) && filter.categories.length > 0) {
    if (!filter.categories.includes(String(document.category || '').toLowerCase())) return false
  }
  const ts = Number(document.ts)
  if (filter.startMs != null && (!Number.isFinite(ts) || ts < filter.startMs)) return false
  if (filter.endMs != null && (!Number.isFinite(ts) || ts > filter.endMs)) return false
  return true
}

export function attachPositiveIds(evaluation, documents, targetMatches = new Map()) {
  const eligible = documents.filter((document) => documentMatchesFilter(document, evaluation.filter))
  const eligibleIds = new Set(eligible.map((document) => document.id))
  const documentIds = new Set(documents.map((document) => document.id))
  const positiveIdsByTarget = evaluation.targets.map((target) => {
    const needle = target.toLowerCase()
    const positiveIds = new Set(
      eligible
        .filter((document) => document.textLower.includes(needle))
        .map((document) => document.id),
    )
    for (const match of targetMatches.get(needle) || []) {
      if (!documentIds.has(match.rootId)) continue
      if (!documentMatchesFilter(match, evaluation.filter)) continue
      positiveIds.add(match.rootId)
    }
    return [...positiveIds]
  })
  const extraCandidateIds = [...new Set(positiveIdsByTarget.flat())]
    .filter((id) => !eligibleIds.has(id))
  return {
    ...evaluation,
    candidateCount: eligible.length + extraCandidateIds.length,
    extraCandidateIds,
    positiveIdsByTarget,
  }
}

function deterministicIds(ids) {
  return [...new Set(ids)]
    .map((id) => ({
      id,
      digest: createHash('sha256').update(String(id)).digest('hex'),
    }))
    .sort((left, right) => left.digest.localeCompare(right.digest) || left.id - right.id)
    .map((row) => row.id)
}

export function selectDeterministicCorpus(documents, evaluations, limit, positiveCap = 0) {
  const requested = Number(limit)
  const cap = Math.max(0, Math.floor(Number(positiveCap) || 0))
  const targetPositiveIds = evaluations.flatMap((evaluation) => evaluation.positiveIdsByTarget)
  const selectedPositiveIds = cap > 0
    ? targetPositiveIds.flatMap((ids) => deterministicIds(ids).slice(0, cap))
    : targetPositiveIds.flat()
  if (!Number.isInteger(requested) || requested <= 0 || requested >= documents.length) {
    return {
      documents,
      sourceDocuments: documents.length,
      selectedDocuments: documents.length,
      positiveDocuments: new Set(selectedPositiveIds).size,
      method: 'full-corpus',
    }
  }
  const positiveIds = new Set(selectedPositiveIds)
  const remaining = documents
    .filter((document) => !positiveIds.has(document.id))
    .map((document) => ({
      id: document.id,
      digest: createHash('sha256').update(String(document.id)).digest('hex'),
    }))
    .sort((left, right) => left.digest.localeCompare(right.digest) || left.id - right.id)
  const selectedIds = new Set(positiveIds)
  const targetSize = Math.max(requested, selectedIds.size)
  for (const row of remaining) {
    if (selectedIds.size >= targetSize) break
    selectedIds.add(row.id)
  }
  return {
    documents: documents.filter((document) => selectedIds.has(document.id)),
    sourceDocuments: documents.length,
    selectedDocuments: selectedIds.size,
    positiveDocuments: positiveIds.size,
    method: `${cap > 0 ? `up-to-${cap}-positive-roots-per-target` : 'all-positive-roots'} + sha256(document-id) negatives`,
  }
}

export function tokenizeBm25(text) {
  return String(text || '').toLowerCase().match(/[\p{L}\p{N}_-]+/gu) || []
}

export function prepareBm25Documents(documents) {
  return documents.map((document) => {
    const tokens = tokenizeBm25(document.text)
    const termFrequency = new Map()
    for (const token of tokens) termFrequency.set(token, (termFrequency.get(token) || 0) + 1)
    return { length: tokens.length, termFrequency }
  })
}

export function rankBm25(query, candidateIndices, preparedDocuments, k1 = 1.2, b = 0.75) {
  const terms = [...new Set(tokenizeBm25(query))]
  if (terms.length === 0 || candidateIndices.length === 0) return []
  const averageLength = candidateIndices.reduce(
    (sum, index) => sum + preparedDocuments[index].length,
    0,
  ) / candidateIndices.length
  const documentFrequency = new Map(terms.map((term) => [term, 0]))
  for (const index of candidateIndices) {
    const tf = preparedDocuments[index].termFrequency
    for (const term of terms) if (tf.has(term)) documentFrequency.set(term, documentFrequency.get(term) + 1)
  }
  const scored = []
  for (const index of candidateIndices) {
    const document = preparedDocuments[index]
    let score = 0
    for (const term of terms) {
      const frequency = document.termFrequency.get(term) || 0
      if (frequency === 0) continue
      const df = documentFrequency.get(term) || 0
      const idf = Math.log(1 + ((candidateIndices.length - df + 0.5) / (df + 0.5)))
      const denominator = frequency + k1 * (1 - b + b * (document.length / Math.max(1, averageLength)))
      score += idf * ((frequency * (k1 + 1)) / denominator)
    }
    if (score > 0) scored.push({ index, score })
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored
}

export function rankDense(queryVector, documentVectors, dims, candidateIndices) {
  const scored = new Array(candidateIndices.length)
  for (let position = 0; position < candidateIndices.length; position += 1) {
    const index = candidateIndices[position]
    const offset = index * dims
    let score = 0
    for (let dimension = 0; dimension < dims; dimension += 1) {
      score += queryVector[dimension] * documentVectors[offset + dimension]
    }
    scored[position] = { index, score }
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored
}

export function rankEqualRrf(denseRanked, lexicalRanked, k = 60) {
  const scores = new Map()
  for (let index = 0; index < denseRanked.length; index += 1) {
    scores.set(denseRanked[index].index, 1 / (k + index + 1))
  }
  for (let index = 0; index < lexicalRanked.length; index += 1) {
    const documentIndex = lexicalRanked[index].index
    scores.set(documentIndex, (scores.get(documentIndex) || 0) + 1 / (k + index + 1))
  }
  return [...scores.entries()]
    .map(([index, score]) => ({ index, score }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
}

function discountedGain(rank) {
  return 1 / Math.log2(rank + 1)
}

export function scoreRanking(evaluation, ranked, documents, cutoff = 10) {
  const rankById = new Map()
  for (let index = 0; index < ranked.length; index += 1) {
    rankById.set(documents[ranked[index].index].id, index + 1)
  }
  const targetRows = evaluation.targets.map((target, index) => {
    const positiveIds = evaluation.positiveIdsByTarget[index] || []
    let rank = null
    for (const id of positiveIds) {
      const value = rankById.get(id)
      if (value != null && (rank == null || value < rank)) rank = value
    }
    return {
      target,
      positiveCount: positiveIds.length,
      rank,
      rrAt10: rank != null && rank <= cutoff ? 1 / rank : 0,
      recallAt5: rank != null && rank <= 5 ? 1 : 0,
      recallAt10: rank != null && rank <= cutoff ? 1 : 0,
    }
  })
  const relevantIds = new Set(evaluation.positiveIdsByTarget.flat())
  let dcg = 0
  for (let index = 0; index < Math.min(cutoff, ranked.length); index += 1) {
    if (relevantIds.has(documents[ranked[index].index].id)) dcg += discountedGain(index + 1)
  }
  let idealDcg = 0
  for (let rank = 1; rank <= Math.min(cutoff, relevantIds.size); rank += 1) idealDcg += discountedGain(rank)
  const divisor = targetRows.length || 1
  return {
    mrrAt10: targetRows.reduce((sum, row) => sum + row.rrAt10, 0) / divisor,
    recallAt5: targetRows.reduce((sum, row) => sum + row.recallAt5, 0) / divisor,
    recallAt10: targetRows.reduce((sum, row) => sum + row.recallAt10, 0) / divisor,
    ndcgAt10: idealDcg > 0 ? dcg / idealDcg : 0,
    targets: targetRows,
    top3: ranked.slice(0, 3).map((row) => ({
      id: documents[row.index].id,
      score: row.score,
      text: documents[row.index].text.slice(0, 240),
    })),
  }
}

function mean(rows, key) {
  if (rows.length === 0) return 0
  return rows.reduce((sum, row) => sum + Number(row[key] || 0), 0) / rows.length
}

export function aggregateScoredRows(rows) {
  const aggregate = (subset) => ({
    cases: subset.length,
    mrrAt10: mean(subset, 'mrrAt10'),
    recallAt5: mean(subset, 'recallAt5'),
    recallAt10: mean(subset, 'recallAt10'),
    ndcgAt10: mean(subset, 'ndcgAt10'),
  })
  const byLanguage = {}
  for (const language of ['ko', 'en', 'mixed', 'other']) {
    byLanguage[language] = aggregate(rows.filter((row) => row.language === language))
  }
  return { overall: aggregate(rows), byLanguage }
}

export function percentile(values, ratio) {
  if (!Array.isArray(values) || values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))
  return sorted[index]
}
