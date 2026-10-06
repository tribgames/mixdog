import { execFile } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GPU_FIELDS = 'index,uuid,name,memory.total,memory.free';
const CACHE_MS = 5_000;

/** The manifest runtime this host runs: CUDA on Windows x64, Metal on Apple
 *  Silicon; '' where no llama.cpp build is pinned. */
export function localProviderPlatformKey(platform = process.platform, arch = process.arch) {
  if (platform === 'win32' && arch === 'x64') return 'win32-x64-nvidia';
  if (platform === 'darwin' && arch === 'arm64') return 'darwin-arm64-metal';
  return '';
}

/** Apple Silicon has one GPU on unified memory. Metal caps what it wires for
 *  the GPU: the `iogpu.wired_limit_mb` override when set, else two thirds of
 *  RAM — exactly what llama.cpp's Metal backend reports on a 16 GB M4; larger
 *  Macs may allow more, which this leaves unused. Metal reports that whole
 *  working set as free, so free equals total here as it does in llama.cpp. */
export function appleSiliconGpu({ name, totalBytes, wiredLimitMb }) {
  const memoryBytes = wiredLimitMb > 0 ? wiredLimitMb * 1024 ** 2 : Math.floor((totalBytes * 2) / 3);
  return { index: 0, uuid: 'MTL0', vendor: 'Apple', name, memoryBytes, freeMemoryBytes: memoryBytes };
}

async function queryAppleSilicon() {
  const limit = await execFileAsync('/usr/sbin/sysctl', ['-n', 'iogpu.wired_limit_mb'], {
    encoding: 'utf8',
    timeout: 5_000,
  }).catch(() => ({ stdout: '0' })); // macOS before 14 has no such key
  return { name: cpus()[0]?.model || 'Apple Silicon', totalBytes: totalmem(), wiredLimitMb: Number(limit.stdout) || 0 };
}

export function parseNvidiaGpus(output) {
  return String(output || '')
    .split(/\r?\n/)
    .flatMap((line) => {
      const parts = line.split(',').map((part) => part.trim());
      if (parts.length < 5) return [];
      const index = Number(parts[0]);
      const uuid = parts[1];
      const memoryBytes = Number(parts.at(-2)) * 1024 ** 2;
      const freeMemoryBytes = Number(parts.at(-1)) * 1024 ** 2;
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        !/^GPU-[a-f0-9-]+$/i.test(uuid) ||
        !Number.isSafeInteger(memoryBytes) ||
        memoryBytes <= 0 ||
        !Number.isSafeInteger(freeMemoryBytes) ||
        freeMemoryBytes < 0 ||
        freeMemoryBytes > memoryBytes
      )
        return [];
      return [{ index, uuid, vendor: 'NVIDIA', name: parts.slice(2, -2).join(', '), memoryBytes, freeMemoryBytes }];
    });
}

export function createHardwareProbe({
  queryFn = async () =>
    (
      await execFileAsync('nvidia-smi', [`--query-gpu=${GPU_FIELDS}`, '--format=csv,noheader,nounits'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      })
    ).stdout,
  appleQueryFn = queryAppleSilicon,
  platform = process.platform,
  arch = process.arch,
  now = Date.now,
  cacheMs = CACHE_MS,
} = {}) {
  const platformSupported = Boolean(localProviderPlatformKey(platform, arch));
  const apple = platform === 'darwin';
  let value = {
    platform,
    arch,
    gpu: null,
    gpus: [],
    supported: false,
    checking: platformSupported,
    checkedAt: null,
    error: null,
  };
  let pending = null;
  function refresh({ force = false } = {}) {
    if (pending) return pending;
    if (!force && value.checkedAt !== null && now() - value.checkedAt < cacheMs) return Promise.resolve(value);
    if (!platformSupported) {
      value = { ...value, checking: false, checkedAt: now() };
      return Promise.resolve(value);
    }
    value = { ...value, checking: true };
    const settle = ({ gpu, gpus, supported, error }) => {
      value = { platform, arch, gpu, gpus, supported, checking: false, checkedAt: now(), error };
      return value;
    };
    pending = Promise.resolve()
      .then(apple ? appleQueryFn : queryFn)
      .then(
        (output) => {
          const gpus = apple
            ? [appleSiliconGpu(output)]
            : parseNvidiaGpus(output).sort(
                (a, b) => b.memoryBytes - a.memoryBytes || b.freeMemoryBytes - a.freeMemoryBytes || a.index - b.index
              );
          return settle({
            gpu: gpus[0] || null,
            gpus,
            supported: gpus.length > 0,
            error: gpus.length ? null : 'No compatible NVIDIA GPU detected.',
          });
        },
        (error) => settle({ gpu: null, gpus: [], supported: false, error: String(error?.message || error) })
      )
      .finally(() => {
        pending = null;
      });
    return pending;
  }
  return {
    refresh,
    status() {
      void refresh();
      return { ...value, gpus: value.gpus.map((gpu) => ({ ...gpu })), gpu: value.gpu ? { ...value.gpu } : null };
    },
  };
}

const probe = createHardwareProbe();
export const localProviderHardwareStatus = () => probe.status();
export const detectLocalProviderHardware = ({ refresh = false } = {}) => probe.refresh({ force: refresh });

export function selectLocalProviderGpu(hardware, model) {
  if (!hardware?.supported)
    throw new Error(`[local-provider] GPU detection failed: ${hardware?.error || 'unsupported hardware'}`);
  const requiredBytes = Number(model.estimatedVramBytes);
  if (!Number.isSafeInteger(requiredBytes) || requiredBytes <= 0) {
    throw new Error('[local-provider] model is missing a GPU memory estimate');
  }
  const candidates = (hardware.gpus || [])
    .filter((gpu) => gpu.memoryBytes >= model.minimumVramBytes)
    .sort((a, b) => b.freeMemoryBytes - a.freeMemoryBytes || a.index - b.index);
  const gpu = candidates.find((entry) => entry.freeMemoryBytes >= requiredBytes);
  if (!gpu) {
    throw new Error(
      `[local-provider] insufficient available GPU memory: estimated requirement ${requiredBytes} bytes; best compatible GPU has ${candidates[0]?.freeMemoryBytes || 0} bytes free. Free GPU memory or choose a smaller compatible model.`
    );
  }
  return gpu;
}
