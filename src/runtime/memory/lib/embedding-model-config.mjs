import { clean } from '../../shared/clean.mjs';

const DEFAULT_MODEL_ID = 'Xenova/multilingual-e5-small';

const MODEL_PROFILES = Object.freeze({
  [DEFAULT_MODEL_ID]: Object.freeze({
    dims: 384,
    defaultDtype: 'q8',
    defaultDevice: 'cpu',
    outputName: '',
    pooling: 'mean',
    queryPrefix: 'query: ',
    documentPrefix: 'passage: ',
    supportedDtypes: Object.freeze(['q8']),
  }),
  'ibm-granite/granite-embedding-97m-multilingual-r2': Object.freeze({
    dims: 384,
    defaultDtype: 'fp32',
    defaultDevice: 'cpu',
    modelFileName: 'model_quint8_avx2',
    outputName: '',
    pooling: 'cls',
    queryPrefix: '',
    documentPrefix: '',
    supportedDtypes: Object.freeze(['fp32']),
  }),
  'Xenova/bge-m3': Object.freeze({
    dims: 1024,
    defaultDtype: 'q4',
    defaultDevice: 'auto',
    outputName: '',
    pooling: 'mean',
    queryPrefix: '',
    documentPrefix: '',
    supportedDtypes: Object.freeze(['fp32', 'fp16', 'q8', 'q4']),
  }),
});

export function getConfiguredEmbeddingModelId() {
  return clean(process.env.MIXDOG_EMBED_MODEL) || DEFAULT_MODEL_ID;
}

function getEmbeddingModelProfile(modelId = getConfiguredEmbeddingModelId()) {
  return MODEL_PROFILES[clean(modelId)] || null;
}

export function getKnownEmbeddingDims(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.dims ?? null;
}

export function normalizeEmbeddingDtype(modelId, dtype) {
  const profile = getEmbeddingModelProfile(modelId);
  const fallback = profile?.defaultDtype || 'fp32';
  const requested = clean(dtype).toLowerCase();
  if (!requested) return fallback;
  const supported = new Set(profile?.supportedDtypes || ['fp32', 'fp16', 'q8', 'q4']);
  return supported.has(requested) ? requested : fallback;
}

export function getDefaultEmbeddingDtype(modelId = getConfiguredEmbeddingModelId()) {
  return normalizeEmbeddingDtype(modelId, process.env.MIXDOG_EMBED_DTYPE);
}

export function getDefaultEmbeddingDevice(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.defaultDevice || 'auto';
}

// transformers.js file naming: onnx/<file name><dtype suffix>.onnx.
const DTYPE_SUFFIX = Object.freeze({ fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4' });

export function getEmbeddingModelGraphFile(modelId = getConfiguredEmbeddingModelId(), dtype) {
  const profile = getEmbeddingModelProfile(modelId);
  const resolved = normalizeEmbeddingDtype(modelId, dtype);
  return `onnx/${profile?.modelFileName || 'model'}${DTYPE_SUFFIX[resolved] ?? ''}.onnx`;
}

export function getEmbeddingPooling(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.pooling || 'mean';
}

export function getEmbeddingOutputName(modelId = getConfiguredEmbeddingModelId()) {
  return getEmbeddingModelProfile(modelId)?.outputName || '';
}

export function normalizeEmbeddingInputType(inputType) {
  return clean(inputType).toLowerCase() === 'query' ? 'query' : 'document';
}

export function prepareEmbeddingInput(text, inputType = 'document', modelId = getConfiguredEmbeddingModelId()) {
  const cleanText = clean(text);
  if (!cleanText) return cleanText;
  const profile = getEmbeddingModelProfile(modelId);
  const prefix =
    normalizeEmbeddingInputType(inputType) === 'query' ? profile?.queryPrefix || '' : profile?.documentPrefix || '';
  return `${prefix}${cleanText}`;
}
