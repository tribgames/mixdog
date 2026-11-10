// Embedding model files in the transformers.js cache layout
// (<cache>/<model id>/<path>), so copies that library already downloaded are
// reused; a missing file is fetched from the Hugging Face Hub once.
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseJsonText } from '../../shared/atomic-file.mjs';
import { fileHasData } from '../../shared/file-has-data.mjs';

const HUB = 'https://huggingface.co';

async function download(modelId, file, target, { optional = false } = {}) {
  const res = await fetch(`${HUB}/${modelId}/resolve/main/${file}`);
  if (!res.ok) {
    if (optional && res.status === 404) return false;
    throw new Error(`embedding model download failed: ${modelId}/${file} HTTP ${res.status}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.${process.pid}.part`;
  try {
    // flush: fsync before close, so the renamed file cannot be all NUL after a crash.
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial, { flush: true }));
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return true;
}

// A cached file that holds no data (empty, NUL-filled by a crash) or, for
// JSON, does not parse is not present: it is fetched again.
function cachedFileUsable(target) {
  if (!fileHasData(target)) return false;
  if (!target.endsWith('.json')) return true;
  try {
    parseJsonText(readFileSync(target, 'utf8'));
    return true;
  } catch {
    return false;
  }
}

/** Local path of `file`, downloading it first when absent or damaged. */
export async function ensureModelFile(cacheDir, modelId, file) {
  const target = join(cacheDir, ...modelId.split('/'), ...file.split('/'));
  if (!cachedFileUsable(target)) await download(modelId, file, target);
  return target;
}

/** Local path of an ONNX graph; a graph published with external weights gets them alongside. */
export async function ensureModelGraph(cacheDir, modelId, file) {
  const target = join(cacheDir, ...modelId.split('/'), ...file.split('/'));
  const weights = `${target}_data`;
  const graphPresent = fileHasData(target);
  // The weights are checked on their own: an external-weights file a crash
  // left empty or NUL-filled is fetched again even when the graph is intact.
  // They are fetched before the graph, so a cached graph implies its weights
  // finished downloading; a weights file that is absent stays absent (graphs
  // without external data have none).
  if (!graphPresent || (existsSync(weights) && !fileHasData(weights))) {
    await download(modelId, `${file}_data`, weights, { optional: true });
  }
  if (!graphPresent) await download(modelId, file, target);
  return target;
}
