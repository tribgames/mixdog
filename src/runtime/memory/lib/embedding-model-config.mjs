const DEFAULT_MODEL_ID = 'ibm-granite/granite-embedding-97m-multilingual-r2'

const MODEL_PROFILES = Object.freeze({
  [DEFAULT_MODEL_ID]: Object.freeze({
    dims: 384,
    defaultDtype: 'fp32',
    defaultDevice: 'cpu',
    modelFileName: 'model_quint8_avx2',
    supportedDtypes: Object.freeze(['fp32']),
  }),
  'Xenova/bge-m3': Object.freeze({
    dims: 1024,
    defaultDtype: 'q4',
    defaultDevice: 'auto',
    supportedDtypes: Object.freeze(['fp32', 'fp16', 'q8', 'q4']),
  }),
})

function clean(value) {
  return String(value ?? '').trim()
}

export function getConfiguredEmbeddingModelId() {
  return clean(process.env.MIXDOG_EMBED_MODEL) || DEFAULT_MODEL_ID
}

export function getEmbeddingModelProfile(modelId = getConfiguredEmbeddingModelId()) {
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
