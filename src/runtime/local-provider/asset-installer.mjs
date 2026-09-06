import { spawn } from 'node:child_process';
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { sha256File } from '../shared/native-asset.mjs';
import { resolvePluginData } from '../shared/plugin-paths.mjs';
import {
  detectLocalProviderHardware,
  exactLocalProviderFile,
  localProviderCatalogStatus,
  localProviderModelEntry,
  localProviderModelPath,
  localProviderRuntimeDirectory,
  localProviderRuntimePlatformEntry,
  localProviderRuntimeRoot,
} from './catalog.mjs';
import { trackLocalInstallation } from './install-progress.mjs';
import { ensureDiskSpace } from './asset-storage.mjs';

const DOWNLOAD_TIMEOUT_MS = 6 * 60 * 60_000;

export { sha256File };

function assertHttpsAsset(asset) {
  let parsed;
  try {
    parsed = new URL(asset?.url);
  } catch {
    throw new Error('[local-provider] invalid asset URL');
  }
  if (parsed.protocol !== 'https:') throw new Error('[local-provider] asset URL must use HTTPS');
  if (!/^[a-f0-9]{64}$/i.test(String(asset?.sha256 || ''))) {
    throw new Error('[local-provider] asset is missing a valid SHA-256');
  }
  if (!Number.isSafeInteger(asset?.size) || asset.size <= 0) {
    throw new Error('[local-provider] asset is missing a valid byte size');
  }
}

export async function downloadVerifiedLocalAsset(asset, destination, {
  fetchFn = fetch,
  onProgress = null,
  timeoutMs = DOWNLOAD_TIMEOUT_MS,
  checkDiskSpace = ensureDiskSpace,
  signal,
  force = false,
} = {}) {
  assertHttpsAsset(asset);
  const deadline = AbortSignal.timeout(timeoutMs);
  const operationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  operationSignal.throwIfAborted();
  mkdirSync(dirname(destination), { recursive: true });
  if (!force && exactLocalProviderFile(destination, asset.size) && await sha256File(destination, operationSignal) === asset.sha256) {
    onProgress?.({ receivedBytes: asset.size, totalBytes: asset.size, percent: 100 });
    return destination;
  }
  const partial = `${destination}.part`;
  let receivedBytes = 0;
  try {
    receivedBytes = statSync(partial).size;
  } catch {
    receivedBytes = 0;
  }
  if (receivedBytes > asset.size) {
    rmSync(partial, { force: true });
    receivedBytes = 0;
  }
  if (receivedBytes === asset.size) {
    const digest = await sha256File(partial, operationSignal);
    if (digest === asset.sha256) {
      renameSync(partial, destination);
      onProgress?.({ receivedBytes: asset.size, totalBytes: asset.size, percent: 100 });
      return destination;
    }
    rmSync(partial, { force: true });
    receivedBytes = 0;
  }
  checkDiskSpace(dirname(destination), asset.size - receivedBytes);
  const response = await fetchFn(asset.url, {
    headers: receivedBytes > 0 ? { Range: `bytes=${receivedBytes}-` } : {},
    redirect: 'follow',
    signal: operationSignal,
  });
  if (!response.ok || !response.body) {
    throw new Error(`[local-provider] download failed: HTTP ${response.status} (${asset.url})`);
  }
  if (response.url && new URL(response.url).protocol !== 'https:') {
    throw new Error('[local-provider] asset redirect must use HTTPS');
  }
  const resumed = receivedBytes > 0 && response.status === 206;
  if (receivedBytes > 0 && !resumed) {
    rmSync(partial, { force: true });
    receivedBytes = 0;
    try {
      checkDiskSpace(dirname(destination), asset.size);
    } catch (error) {
      await response.body.cancel().catch(() => {});
      throw error;
    }
  }
  let total = receivedBytes;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      total += chunk.length;
      if (total > asset.size) {
        callback(new Error(`[local-provider] download exceeded declared size for ${asset.name || destination}`));
        return;
      }
      onProgress?.({
        stage: 'downloading',
        receivedBytes: total,
        totalBytes: asset.size,
        percent: Math.min(99, Math.round((total / asset.size) * 100)),
      });
      callback(null, chunk);
    },
  });
  await pipeline(
    Readable.fromWeb(response.body),
    meter,
    createWriteStream(partial, { flags: resumed ? 'a' : 'w' }),
    { signal: operationSignal },
  );
  if (total !== asset.size) {
    throw new Error(`[local-provider] incomplete download for ${asset.name || destination}: ${total}/${asset.size}`);
  }
  onProgress?.({ stage: 'verifying', receivedBytes: total, totalBytes: asset.size, percent: 99 });
  const digest = await sha256File(partial, operationSignal);
  if (digest !== asset.sha256) {
    rmSync(partial, { force: true });
    throw new Error(`[local-provider] SHA-256 mismatch for ${asset.name || destination}`);
  }
  operationSignal.throwIfAborted();
  renameSync(partial, destination);
  onProgress?.({ stage: 'complete', receivedBytes: total, totalBytes: asset.size, percent: 100 });
  return destination;
}

async function extractZip(zipPath, destination, signal) {
  signal?.throwIfAborted();
  const command = [
    "$ErrorActionPreference = 'Stop'",
    'Expand-Archive -LiteralPath $env:MIXDOG_LOCAL_ARCHIVE -DestinationPath $env:MIXDOG_LOCAL_DESTINATION -Force',
  ].join('; ');
  const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', command], {
    env: {
      ...process.env,
      MIXDOG_LOCAL_ARCHIVE: zipPath,
      MIXDOG_LOCAL_DESTINATION: destination,
    },
    windowsHide: true,
    signal,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const append = (chunk) => { log = `${log}${String(chunk)}`.slice(-16_384); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  await new Promise((resolve, reject) => {
    let failure = null;
    child.once('error', (error) => { failure = error; });
    child.once('close', (code) => failure ? reject(failure) : code === 0 ? resolve()
      : reject(new Error(`[local-provider] runtime extraction failed: ${log || `status ${code}`}`)));
  });
}

async function installRuntimeInternal({ dataDir, onProgress, fetchFn, signal }) {
  signal?.throwIfAborted();
  const hardware = await detectLocalProviderHardware({ refresh: true });
  signal?.throwIfAborted();
  const entry = localProviderRuntimePlatformEntry();
  if (!entry || !localProviderCatalogStatus({ dataDir, hardware }).available) {
    throw new Error('[local-provider] Windows x64 with a compatible NVIDIA RTX GPU is required');
  }
  const target = localProviderRuntimeDirectory(dataDir);
  const executable = join(target, entry.executable);
  if (existsSync(executable)) return localProviderCatalogStatus({ dataDir, hardware });
  ensureDiskSpace(localProviderRuntimeRoot(dataDir), entry.downloadBytes);
  const staging = join(localProviderRuntimeRoot(dataDir), `.staging-${process.pid}`);
  const downloads = join(localProviderRuntimeRoot(dataDir), '.downloads');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  try {
    let completedBytes = 0;
    for (const asset of entry.assets) {
      const archive = join(downloads, asset.name);
      await downloadVerifiedLocalAsset(asset, archive, {
        fetchFn,
        signal,
        onProgress: (progress) => onProgress?.({
          phase: 'runtime',
          stage: progress.stage || 'downloading',
          receivedBytes: completedBytes + progress.receivedBytes,
          totalBytes: entry.downloadBytes,
          percent: Math.round(((completedBytes + progress.receivedBytes) / entry.downloadBytes) * 100),
        }),
      });
      onProgress?.({
        phase: 'runtime', stage: 'extracting',
        receivedBytes: completedBytes + asset.size, totalBytes: entry.downloadBytes,
        percent: Math.min(99, Math.round(((completedBytes + asset.size) / entry.downloadBytes) * 100)),
      });
      await extractZip(archive, staging, signal);
      completedBytes += asset.size;
    }
    if (!existsSync(join(staging, entry.executable))) {
      throw new Error(`[local-provider] runtime archive did not contain ${entry.executable}`);
    }
    signal?.throwIfAborted();
    rmSync(target, { recursive: true, force: true });
    renameSync(staging, target);
    rmSync(downloads, { recursive: true, force: true });
    return localProviderCatalogStatus({ dataDir, hardware });
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function installLocalProviderRuntime({
  dataDir = resolvePluginData(),
  onProgress = null,
  fetchFn = fetch,
} = {}) {
  return trackLocalInstallation(dataDir, { phase: 'runtime' },
    (publish, signal) => installRuntimeInternal({ dataDir, onProgress: publish, fetchFn, signal }), onProgress);
}

export async function installLocalProviderModel(modelId, {
  dataDir = resolvePluginData(),
  onProgress = null,
  fetchFn = fetch,
} = {}) {
  const entry = localProviderModelEntry(modelId, dataDir);
  if (!entry) throw new Error(`[local-provider] unknown model: ${modelId}`);
  return trackLocalInstallation(dataDir, { phase: 'model', modelId: entry.id }, async (publish, signal) => {
      signal.throwIfAborted();
      const hardware = await detectLocalProviderHardware({ refresh: true });
      signal.throwIfAborted();
      const status = localProviderCatalogStatus({ dataDir, hardware });
      if (!status.runtime.installed) throw new Error('[local-provider] install the Local Provider runtime first');
      if (!hardware.supported || Number(hardware.gpu?.memoryBytes || 0) < entry.minimumVramBytes) {
        throw new Error(`[local-provider] ${entry.name} requires at least ${entry.minimumVramBytes} bytes of GPU memory`);
      }
      await downloadVerifiedLocalAsset(entry, localProviderModelPath(entry, dataDir), {
        fetchFn,
        signal,
        onProgress: (progress) => publish({ phase: 'model', modelId: entry.id, ...progress }),
      });
      return localProviderCatalogStatus({ dataDir });
  }, onProgress);
}
