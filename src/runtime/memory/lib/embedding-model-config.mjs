const DEFAULT_MODEL_ID = 'onnx-community/harrier-oss-v1-270m-ONNX'
const HARRIER_QUERY_PREFIX = 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: '

const MODEL_PROFILES = Object.freeze({
  [DEFAULT_MODEL_ID]: Object.freeze({
    dims: 640,
    defaultDtype: 'q4',
    defaultDevice: 'cpu',
    modelFileName: 'model',
    outputName: 'sentence_embedding',
    pooling: 'last_token',
    queryPrefix: HARRIER_QUERY_PREFIX,
    supportedDtypes: Object.freeze(['fp32', 'fp16', 'q8', 'q4']),
  }),
  'ibm-granite/granite-embedding-97m-multilingual-r2': Object.freeze({
    dims: 384,
    defaultDtype: 'fp32',
    defaultDevice: 'cpu',
    modelFileName: 'model_quint8_avx2',
    outputName: '',
    pooling: 'mean',
    queryPrefix: '',
    supportedDtypes: Object.freeze(['fp32']),
  }),
  'Xenova/bge-m3': Object.freeze({
    dims: 1024,
    defaultDtype: 'q4',
    defaultDevice: 'auto',
    outputName: '',
    pooling: 'mean',
    queryPrefix: '',
    supportedDtypes: Object.freeze(['fp32', 'fp16', 'q8', 'q4']),
  }),
})

function clean(value) {
  return String(value ?? '').trim()
}

export function getConfiguredEmbeddingModelId() {
  return clean(process.env.MIXDOG_EMBED_MODEL) || DEFAULT_MODEL_ID
}

function getEmbeddingModelProfile(modelId = getConfiguredEmbeddingModelId()) {
  return MODEL_PROFILES[clean(modelId)] || null
}

export function getKnownEmbeddingDims(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.dims ?? null
}

export function normalizeEmbeddingDtype(modelId, dtype) {
  const profile = getEmbeddingModelProfile(modelId)
  const fallback = profile?.defaultDtype || 'fp32'
  const requested = clean(dtype).toLowerCase()
  if (!requested) return fallback
  const supported = new Set(profile?.supportedDtypes || ['fp32', 'fp16', 'q8', 'q4'])
  return supported.has(requested) ? requested : fallback
}

export function getDefaultEmbeddingDtype(modelId = getConfiguredEmbeddingModelId()) {
  return normalizeEmbeddingDtype(modelId, process.env.MIXDOG_EMBED_DTYPE)
}

export function getDefaultEmbeddingDevice(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.defaultDevice || 'auto'
}

export function getEmbeddingModelLoadOptions(modelId = getConfiguredEmbeddingModelId()) {
  const profile = getEmbeddingModelProfile(modelId)
  return profile?.modelFileName ? { model_file_name: profile.modelFileName } : {}
}

export function getEmbeddingPooling(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.pooling || 'mean'
}

export function getEmbeddingOutputName(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.outputName || ''
}

export function normalizeEmbeddingInputType(inputType) {
  return clean(inputType).toLowerCase() === 'query' ? 'query' : 'document'
}

export function prepareEmbeddingInput(text, inputType = 'document', modelId = getConfiguredEmbeddingModelId()) {
  const cleanText = clean(text)
  if (!cleanText || normalizeEmbeddingInputType(inputType) !== 'query') return cleanText
  const prefix = getEmbeddingModelProfile(modelId)?.queryPrefix || ''
  return `${prefix}${cleanText}`
}
