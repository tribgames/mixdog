// Embedding model files in the transformers.js cache layout
// (<cache>/<model id>/<path>), so copies that library already downloaded are
// reused; a missing file is fetched from the Hugging Face Hub once.
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

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
    await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));
    renameSync(partial, target);
  } catch (error) {
    rmSync(partial, { force: true });
    throw error;
  }
  return true;
}

/** Local path of `file`, downloading it first when absent. */
export async function ensureModelFile(cacheDir, modelId, file) {
  const target = join(cacheDir, ...modelId.split('/'), ...file.split('/'));
  if (!existsSync(target)) await download(modelId, file, target);
  return target;
}

/** Local path of an ONNX graph; a graph published with external weights gets them alongside. */
export async function ensureModelGraph(cacheDir, modelId, file) {
  const target = join(cacheDir, ...modelId.split('/'), ...file.split('/'));
  if (!existsSync(target)) {
    await download(modelId, file, target);
    await download(modelId, `${file}_data`, `${target}_data`, { optional: true });
  }
  return target;
}
