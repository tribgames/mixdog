import { createWriteStream, rmSync } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const MAX_NATIVE_BINARY_DOWNLOAD_BYTES = 256 * 1024 * 1024;
const DEFAULT_RETRY_DELAYS_MS = [1000, 3000, 9000];

export async function readResponseBuffer(
  response,
  { maxBytes, label = 'download' } = {},
) {
  const maximum = Number(maxBytes);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new TypeError(`${label}: a positive byte limit is required`);
  }
  if (!response?.body) throw new Error(`${label}: response has no body`);
  const lengthValue = String(response.headers?.get?.('content-length') || '').trim();
  const advertised = /^\d+$/.test(lengthValue) ? Number(lengthValue) : 0;
  if (advertised > maximum) {
    throw new Error(`${label}: response exceeds the ${maximum} byte limit`);
  }
  const chunks = [];
  let total = 0;
  for await (const value of response.body) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.length;
    if (total > maximum) {
      throw new Error(`${label}: response exceeds the ${maximum} byte limit`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

export async function streamResponseToFile(
  response,
  destPath,
  {
    maxBytes,
    expectedBytes = 0,
    label = 'download',
    onProgress = null,
  } = {},
) {
  const maximum = Number(maxBytes);
  const expected = Number(expectedBytes);
  if (!Number.isSafeInteger(maximum) || maximum <= 0) {
    throw new TypeError(`${label}: a positive byte limit is required`);
  }
  if (expected && (!Number.isSafeInteger(expected) || expected <= 0 || expected > maximum)) {
    throw new TypeError(`${label}: expected byte size is invalid`);
  }
  if (!response?.body) throw new Error(`${label}: response has no body`);

  const lengthValue = String(response.headers?.get?.('content-length') || '').trim();
  const advertised = /^\d+$/.test(lengthValue) ? Number(lengthValue) : 0;
  if (advertised > maximum) {
    throw new Error(`${label}: response exceeds the ${maximum} byte limit`);
  }
  if (expected && advertised && advertised !== expected) {
    throw new Error(`${label}: expected ${expected} bytes, server advertised ${advertised}`);
  }

  let downloaded = 0;
  let lastProgressAt = 0;
  const progressTotal = advertised || expected || 0;
  const emitProgress = (force = false) => {
    if (typeof onProgress !== 'function') return;
    const now = Date.now();
    if (!force && now - lastProgressAt < 200) return;
    lastProgressAt = now;
    onProgress({ downloaded, total: progressTotal });
  };
  const guard = new Transform({
    transform(chunk, _encoding, callback) {
      downloaded += chunk.length;
      if (downloaded > maximum) {
        callback(new Error(`${label}: response exceeds the ${maximum} byte limit`));
        return;
      }
      emitProgress();
      callback(null, chunk);
    },
    flush(callback) {
      emitProgress(true);
      if (expected && downloaded !== expected) {
        callback(new Error(`${label}: expected ${expected} bytes, received ${downloaded}`));
        return;
      }
      callback();
    },
  });

  try {
    await pipeline(response.body, guard, createWriteStream(destPath));
    return downloaded;
  } catch (error) {
    try { rmSync(destPath, { force: true }); } catch {}
    throw error;
  }
}

export async function downloadToFileWithRetry(
  url,
  destPath,
  {
    maxBytes,
    expectedBytes = 0,
    label = 'download',
    httpLabel = label,
    fetchFn = globalThis.fetch,
    timeoutMs = 180_000,
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    onRetry = null,
  } = {},
) {
  let lastError;
  for (let attempt = 0; attempt <= retryDelaysMs.length; attempt += 1) {
    try {
      const response = await fetchFn(url, { signal: AbortSignal.timeout(timeoutMs) });
      const terminal = response.status >= 400 && response.status < 500;
      if (!response.ok) {
        throw new Error(`${httpLabel} HTTP ${response.status}${terminal ? ' (terminal)' : ''} — ${url}`);
      }
      return await streamResponseToFile(response, destPath, {
        maxBytes,
        expectedBytes,
        label,
      });
    } catch (error) {
      lastError = error;
      if (String(error?.message || error).includes('(terminal)')) throw error;
      const delayMs = retryDelaysMs[attempt];
      if (delayMs === undefined) break;
      onRetry?.({ attempt: attempt + 1, delayMs, error });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastError;
}
