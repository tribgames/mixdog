// Cursor model catalog and usage lookups with their in-memory cache.
import {
  FALLBACK_MODELS,
  normalizeCursorUsage,
  normalizeModels,
  normalizeParameterizedModels,
  withCanonicalAutoModels,
} from './cursor-wire-normalization.mjs';
import { decodeMessage, encodeMessage } from './cursor-wire-protobuf.mjs';
import {
  AVAILABLE_MODELS_PATH,
  END_STREAM_FLAG,
  MODELS_PATH,
  PLAN_PATH,
  USAGE_PATH,
  callCursorUnary,
} from './cursor-wire-transport.mjs';

let cachedModels = null;

function unwrapUnaryBody(body) {
  if (body.length < 5) return body;
  const length = body.readUInt32BE(1);
  if ((body[0] & 1) === 0 && (body[0] & END_STREAM_FLAG) === 0 && body.length >= length + 5) {
    return body.subarray(5, length + 5);
  }
  return body;
}

const MODEL_CATALOG_TIMEOUT_MS = 15_000;
const MODEL_CATALOG_RETRY_DELAYS_MS = [500, 1_500, 3_000];

async function fetchCursorModelsOnce(accessToken) {
  try {
    const response = await callCursorUnary({
      accessToken,
      path: AVAILABLE_MODELS_PATH,
      timeoutMs: MODEL_CATALOG_TIMEOUT_MS,
      body: encodeMessage('AvailableModelsRequest', {
        includeLongContextModels: true,
        useModelParameters: true,
        includeHiddenModels: false,
        doNotUseMarkdown: false,
        variantsWillBeShownInExplodedList: false,
      }),
    });
    const decoded = decodeMessage('AvailableModelsResponse', unwrapUnaryBody(response));
    const discovered = decoded.useModelParameters === true ? normalizeParameterizedModels(decoded.models) : [];
    if (discovered.length) return discovered;
  } catch {}
  const response = await callCursorUnary({
    accessToken,
    path: MODELS_PATH,
    timeoutMs: MODEL_CATALOG_TIMEOUT_MS,
    body: new Uint8Array(),
  });
  return normalizeModels(decodeMessage('GetUsableModelsResponse', unwrapUnaryBody(response)).models);
}

// The live catalog is the only source that carries every model Cursor offers.
// Retry with backoff before giving up, and never cache the static fallback:
// a single slow start must not hide models until the next process restart.
export async function getCursorModels(accessToken) {
  if (cachedModels) return cachedModels;
  let discovered = [];
  for (let attempt = 0; attempt <= MODEL_CATALOG_RETRY_DELAYS_MS.length; attempt += 1) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, MODEL_CATALOG_RETRY_DELAYS_MS[attempt - 1]));
    try {
      discovered = await fetchCursorModelsOnce(accessToken);
    } catch {
      discovered = [];
    }
    if (discovered.length) break;
  }
  if (!discovered.length) {
    return Object.assign(withCanonicalAutoModels(FALLBACK_MODELS), {
      fallback: true,
    });
  }
  cachedModels = withCanonicalAutoModels(discovered);
  return cachedModels;
}

export async function getCursorUsage(accessToken) {
  const [usageBody, planBody] = await Promise.all([
    callCursorUnary({ accessToken, path: USAGE_PATH, body: new Uint8Array() }),
    callCursorUnary({ accessToken, path: PLAN_PATH, body: new Uint8Array() }).catch(() => null),
  ]);
  const usage = decodeMessage('CursorCurrentPeriodUsage', unwrapUnaryBody(usageBody));
  const plan = planBody ? decodeMessage('CursorPlanInfoResponse', unwrapUnaryBody(planBody)) : {};
  return normalizeCursorUsage(usage, plan);
}

export function clearModelCache() {
  cachedModels = null;
}
