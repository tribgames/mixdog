import { createHash, randomUUID } from 'node:crypto';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import { registerLocalModel } from './registered-models.mjs';
import { parseGgufHeader, ggufMemoryPlan } from './gguf-header.mjs';

const ORIGIN = 'https://huggingface.co';
const MAX_JSON = 4 * 1024 * 1024;
const PREVIEW_TTL = 15 * 60_000;

async function boundedBody(response, limit) {
  if (!response.ok || !response.body) throw new Error(`Hugging Face request failed: HTTP ${response.status}`);
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Hugging Face response exceeds the inspection limit');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally { await reader.cancel().catch(() => {}); }
}

export function createHuggingFaceCatalog({ fetchFn = fetch, dataDir = resolvePluginData(), now = Date.now } = {}) {
  const previews = new Map();
  const request = (url, options = {}) => fetchFn(url, { signal: AbortSignal.timeout(30_000), ...options });
  const json = async (url) => JSON.parse((await boundedBody(await request(url, { redirect: 'error' }), MAX_JSON)).toString('utf8'));
  function repositoryId(value) {
    if (typeof value !== 'string' || !/^[\w.-]+\/[\w.-]+$/.test(value) || value.split('/').some((p) => p === '.' || p === '..')) throw new TypeError('repository must be an owner/name Hugging Face model id.');
    return value;
  }
  function prune() {
    for (const [id, preview] of previews) if (preview.expiresAt < now()) previews.delete(id);
    if (previews.size >= 100) throw new Error('Too many pending model inspections; wait for them to expire.');
  }
  return {
    async search(query) {
      if (typeof query !== 'string' || !query.trim() || query.length > 200) throw new TypeError('query must contain 1–200 characters.');
      const params = new URLSearchParams({ search: query.trim(), filter: 'gguf', limit: '20', sort: 'downloads', direction: '-1' });
      const rows = await json(`${ORIGIN}/api/models?${params}`);
      if (!Array.isArray(rows)) throw new Error('Invalid Hugging Face search response');
      return { models: rows.slice(0, 20).filter((row) => /^[\w.-]+\/[\w.-]+$/.test(row.id || '')).map((row) => ({
        repository: row.id, downloads: Number(row.downloads) || 0, source: `${ORIGIN}/${row.id}`,
      })) };
    },
    async inspect({ repository, filename, contextWindow = 8192 } = {}) {
      repositoryId(repository);
      if (!Number.isInteger(contextWindow) || contextWindow < 512 || contextWindow > 32768) throw new TypeError('contextWindow must be between 512 and 32768.');
      const info = await json(`${ORIGIN}/api/models/${repository}?blobs=true`);
      if (info.private || info.gated || info.disabled) throw new Error('Only public, ungated Hugging Face models can be installed.');
      if (!/^[a-f0-9]{40}$/.test(info.sha || '')) throw new Error('Hugging Face did not supply an immutable revision.');
      const license = info.cardData?.license;
      if (typeof license !== 'string' || !license.trim() || license.length > 200) throw new Error('Model license is missing; inspect its license before installation.');
      const files = (info.siblings || []).filter((entry) => typeof entry.rfilename === 'string' && /\.gguf$/i.test(entry.rfilename));
      if (!filename) return { repository, revision: info.sha, license, source: `${ORIGIN}/${repository}`,
        files: files.slice(0, 200).map((entry) => ({ filename: entry.rfilename, sizeBytes: entry.size, sha256: entry.lfs?.sha256 || null })),
        filesTruncated: files.length > 200 };
      if (typeof filename !== 'string' || /[\\\x00-\x1f]/.test(filename)
          || filename.split('/').some((part) => !part || part === '.' || part === '..')
          || /-\d{5}-of-\d{5}\.gguf$/i.test(filename)) throw new TypeError('Select one complete GGUF file; split shards and traversal paths are unsupported.');
      const file = files.find((entry) => entry.rfilename === filename);
      if (!file || !/^[a-f0-9]{64}$/.test(file.lfs?.sha256 || '') || !Number.isSafeInteger(file.size)
          || file.size <= 0 || file.lfs.size !== file.size) throw new Error('Selected GGUF is missing verified LFS size/SHA-256 metadata.');
      const url = `${ORIGIN}/${repository}/resolve/${info.sha}/${filename.split('/').map(encodeURIComponent).join('/')}`;
      let header;
      for (let size = 64 * 1024; size <= 16 * 1024 * 1024; size *= 2) {
        const end = Math.min(file.size, size) - 1;
        const response = await request(url, { headers: { Range: `bytes=0-${end}` } });
        const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
        if (response.status !== 206 || !range || Number(range[1]) !== end || Number(range[2]) !== file.size
            || (response.url && new URL(response.url).protocol !== 'https:')) {
          await response.body?.cancel();
          throw new Error('The GGUF host did not honor the bounded metadata range request.');
        }
        try { header = parseGgufHeader(await boundedBody(response, end + 1)); break; }
        catch (error) { if (error.code !== 'GGUF_NEED_MORE' || end + 1 === file.size) throw error; }
      }
      if (!header) throw new Error('GGUF metadata exceeds the 16 MiB inspection limit.');
      const plan = ggufMemoryPlan(header, file.size, contextWindow);
      const id = `hf-${createHash('sha256').update(`${repository}|${info.sha}|${filename}`).digest('hex').slice(0, 24)}`;
      const model = { id, name: `${repository} · ${filename}`, filename: `${id}.gguf`, remoteFilename: filename,
        repository, revision: info.sha, source: `${ORIGIN}/${repository}/tree/${info.sha}`, url,
        size: file.size, sha256: file.lfs.sha256, license, ...plan,
        supportsFunctionCalling: null, supportsReasoning: null, supportsImages: false, recommended: false,
        compatibility: 'GGUF metadata checked; runtime loading and tool support not yet verified' };
      prune();
      const previewId = randomUUID(), expiresAt = now() + PREVIEW_TTL;
      previews.set(previewId, { model, expiresAt });
      return { previewId, expiresAt, model, downloadBytes: model.size,
        licenseUrl: `${ORIGIN}/${repository}/tree/${info.sha}`,
        note: 'No model was registered or installed. Review license and resource requirements before approval.' };
    },
    register(previewId, licenseAccepted) {
      const preview = previews.get(previewId);
      if (!preview || preview.expiresAt < now()) throw new Error('Model inspection expired; inspect again before registering.');
      if (licenseAccepted !== true) throw new TypeError('Explicit license acceptance is required.');
      const model = registerLocalModel(preview.model, dataDir);
      previews.delete(previewId);
      return { model, registered: true, downloadStarted: false };
    },
  };
}

const services = new Map();
export function huggingFaceCatalog(dataDir = resolvePluginData()) {
  if (!services.has(dataDir)) services.set(dataDir, createHuggingFaceCatalog({ dataDir }));
  return services.get(dataDir);
}
